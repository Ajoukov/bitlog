"""Bitlog cookie / memory-token authentication, password reset, account settings, and email.

Register with init_account(...) at the end of app.py, before the __main__ guard.
All responses expose saved email addresses only in masked form.

Existing users' normal passwords are intentionally left in the legacy storage
format; this module does not migrate or alter old users until they change one.
"""

import hashlib
import hmac
import os
import re
import secrets
import smtplib
import ssl
from email.message import EmailMessage
from urllib.parse import urlencode
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from botocore.exceptions import ClientError
from curse_words import censor
from flask import abort, jsonify, make_response, request
from itsdangerous import BadSignature, SignatureExpired, URLSafeTimedSerializer


COOKIE_NAME = "bitlog_auth"
COOKIE_LIFETIME = 180 * 24 * 60 * 60
ADMIN_EMAIL = os.environ["BITLOG_ADMIN_EMAIL"]
EMAIL_RE = re.compile(r"[^@\s<>]+@[^@\s<>]+\.[^@\s<>]+")

_users_tbl = None
_get_user = None
_invalidate_cache = None
_serializer = None
_secret = None
_app = None


def mask_email(address):
    if not address:
        return None
    local, domain = address.rsplit("@", 1)

    def mask(fragment):
        if len(fragment) < 2:
            return fragment[:1] + "..."
        return fragment[0] + "..." + fragment[-1]

    pieces = domain.split(".")
    pieces[0] = mask(pieces[0])
    return mask(local) + "@" + ".".join(pieces)


def account_payload(user, **extra):
    email = user.get("email") or ""
    payload = {
        "ok": True,
        "name": user["name"],
        "has_email": bool(email),
        "email_masked": mask_email(email),
        "reminders_enabled": user.get("reminders_enabled") is True,
        "recovery_credits": int(user.get("recovery_credits") or 0),
    }
    payload.update(extra)
    return payload


def _proof(name, password):
    data = (name + "\0" + (password or "")).encode("utf-8")
    return hmac.new(_secret, data, hashlib.sha256).hexdigest()


def _signed_token(user, remember):
    return _serializer.dumps({
        "n": user["name"],
        "p": _proof(user["name"], user.get("password") or ""),
        "r": bool(remember),
    }, salt="bitlog-auth-v1")


def _signed_in_response(user, remember, **extra):
    payload = account_payload(user, mode="signed", **extra)
    token = _signed_token(user, remember)
    if not remember:
        # This token is retained only in the current page's JS closure.
        payload["auth_token"] = token
    response = make_response(jsonify(payload))
    if remember:
        response.set_cookie(
            COOKIE_NAME, token,
            max_age=COOKIE_LIFETIME,
            httponly=True, secure=True, samesite="Lax", path="/",
        )
    else:
        # Replace an existing 180-day cookie, or an older session cookie.
        response.delete_cookie(
            COOKIE_NAME, path="/", secure=True, httponly=True, samesite="Lax",
        )
    return response


def _read_identity():
    # A bearer token takes priority over a cookie: never silently fall back to
    # an existing cookie if a supplied in-memory token fails authentication.
    authorization = request.headers.get("Authorization")
    from_memory = authorization is not None
    if from_memory:
        if not authorization.startswith("Bearer "):
            return None, "token_failed"
        raw = authorization[len("Bearer "):]
        if not raw:
            return None, "token_failed"
    else:
        raw = request.cookies.get(COOKIE_NAME)
        if not raw:
            return None, "no_cookie"
    error = "token_failed" if from_memory else "cookie_failed"
    try:
        token = _serializer.loads(raw, salt="bitlog-auth-v1", max_age=COOKIE_LIFETIME)
    except (BadSignature, SignatureExpired):
        return None, error
    if not isinstance(token, dict):
        return None, error
    name = token.get("n")
    proof = token.get("p")
    remember = token.get("r")
    if not isinstance(name, str) or not isinstance(proof, str):
        return None, error
    # Reject legacy unchecked session cookies. A remembered token belongs
    # in the cookie; an unchecked token belongs in an Authorization header.
    if remember is not (not from_memory):
        return None, error
    user = _get_user(name)
    if user is None or not hmac.compare_digest(
        proof, _proof(name, user.get("password") or "")
    ):
        return None, error
    return (name, user, remember), None


def require_signed_in():
    identity, _error = _read_identity()
    if identity is None:
        abort(401, "not signed in")
    return identity


def _json_data():
    value = request.get_json(silent=True)
    if not isinstance(value, dict):
        abort(400, "JSON object required")
    return value


def _name(value):
    if not isinstance(value, str):
        abort(400, "username required")
    name = censor(value).strip()
    if not name or len(name) > 40:
        abort(400, "invalid username")
    return name


def _password(value):
    if not isinstance(value, str):
        abort(400, "invalid password")
    return value


def _validate_timezone(value):
    if value is None:
        return None
    if not isinstance(value, str) or not value or len(value) > 128:
        abort(400, "invalid time zone")
    try:
        ZoneInfo(value)
    except (ZoneInfoNotFoundError, ValueError, KeyError):
        abort(400, "unknown time zone")
    return value


def update_time_zone(name, user, value):
    """Called on authenticated reads, logins, and successful posts."""
    if value is None:
        return
    zone = _validate_timezone(value)
    if user.get("time_zone") == zone:
        return
    try:
        _users_tbl.update_item(
            Key={"name": name},
            UpdateExpression="SET #tz = :zone",
            ConditionExpression="#password = :password",
            ExpressionAttributeNames={"#tz": "time_zone", "#password": "password"},
            ExpressionAttributeValues={":zone": zone, ":password": user.get("password", "")},
        )
    except ClientError as exc:
        if exc.response.get("Error", {}).get("Code") == "ConditionalCheckFailedException":
            abort(401, "account credentials changed")
        raise
    user["time_zone"] = zone


def _smtp_send(address, subject, body):
    """Use the Purelymail settings already present in /etc/bitlog.env."""
    username = os.environ["SMTP_USERNAME"]
    password = os.environ["SMTP_PASSWORD"]
    msg = EmailMessage()
    msg["From"] = os.getenv("SMTP_FROM") or username
    msg["To"] = address
    msg["Subject"] = subject
    msg.set_content(body)
    with smtplib.SMTP_SSL(
        os.getenv("SMTP_HOST", "smtp.purelymail.com"),
        int(os.getenv("SMTP_PORT", "465")),
        context=ssl.create_default_context(),
        timeout=10,
    ) as connection:
        connection.login(username, password)
        connection.send_message(msg)


def _send_admin_notice(name, old_email, new_email):
    if old_email == new_email:
        return
    if not old_email:
        action = "New email address added"
    elif not new_email:
        action = "Email address removed"
    else:
        action = "Email address changed"
    body = (
        f"Bitlog account: {name}\n"
        f"Action: {action}\n"
        f"Previous email: {old_email or '(none)'}\n"
        f"New email: {new_email or '(none)'}\n"
    )
    try:
        _smtp_send(ADMIN_EMAIL, "Bitlog: " + action, body)
    except Exception:
        # The DynamoDB update has already succeeded; a mail error must not
        # undo the user's settings or expose an SMTP exception to the browser.
        _app.logger.exception("Admin email notification failed for user=%s", name)


def _reset_hash(reset_password):
    return hashlib.sha256(reset_password.encode("utf-8")).hexdigest()


def _verify_reset(user, reset_password):
    expected = user.get("reset_password_hash")
    if not isinstance(expected, str) or not isinstance(reset_password, str):
        return False
    return hmac.compare_digest(expected, _reset_hash(reset_password))


def _auth_failure(code, message):
    return jsonify({"ok": False, "code": code, "message": message}), 401


def _url_auth_failure():
    response = make_response(jsonify({
        "ok": False,
        "code": "url_failed",
        "message": "reset link authentication failed",
    }), 401)
    response.delete_cookie(COOKIE_NAME, path="/", secure=True, httponly=True, samesite="Lax")
    return response


def init_account(app, users_tbl, get_user, invalidate_cache):
    global _users_tbl, _get_user, _invalidate_cache, _serializer, _secret, _app
    _users_tbl = users_tbl
    _get_user = get_user
    _invalidate_cache = invalidate_cache
    _app = app
    secret_text = os.getenv("BITLOG_SESSION_SECRET")
    if not secret_text or len(secret_text) < 32:
        raise RuntimeError("Set BITLOG_SESSION_SECRET (at least 32 random characters) in /etc/bitlog.env")
    _secret = secret_text.encode("utf-8")
    _serializer = URLSafeTimedSerializer(secret_text)

    @app.before_request
    def bitlog_timezone_on_authenticated_fetch():
        # Public GET APIs remain public. An authenticated browser adds this
        # header, allowing timezone updates without a separate network call.
        if request.method != "GET" or not request.path.startswith("/api/"):
            return
        value = request.headers.get("X-Bitlog-Time-Zone")
        if not value:
            return
        identity, _error = _read_identity()
        if identity is None:
            return
        name, user, _remember = identity
        try:
            update_time_zone(name, user, value)
        except Exception:
            app.logger.exception("Timezone update failed for user=%s", name)

    @app.route("/api/account/auth", methods=["POST"])
    def bitlog_account_auth():
        data = _json_data()
        # URL reset credentials take precedence. An invalid URL credential
        # must not fall back to a perfectly valid cookie.
        if "reset_pass" in data or "user" in data:
            username = data.get("user")
            reset_password = data.get("reset_pass")
            if not isinstance(username, str) or not isinstance(reset_password, str):
                return _url_auth_failure()
            user = _get_user(username)
            if user is None or not _verify_reset(user, reset_password):
                return _url_auth_failure()
            update_time_zone(username, user, data.get("time_zone"))
            response = make_response(jsonify({"ok": True, "mode": "reset", "name": username}))
            # A reset-link visit takes priority over an existing cookie.
            response.delete_cookie(COOKIE_NAME, path="/", secure=True, httponly=True, samesite="Lax")
            return response
        identity, reason = _read_identity()
        if identity is None:
            return _auth_failure(reason, "saved login authentication failed")
        username, user, _remember = identity
        update_time_zone(username, user, data.get("time_zone"))
        return jsonify(account_payload(user, mode="signed"))

    @app.route("/api/account/login", methods=["POST"])
    def bitlog_account_login():
        data = _json_data()
        username = _name(data.get("name"))
        provided = _password(data.get("password"))
        remember = data.get("stay_signed_in", True)
        if not isinstance(remember, bool):
            abort(400, "invalid stay signed in option")
        zone = _validate_timezone(data.get("time_zone"))
        user = _get_user(username)
        created = False
        if user is None:
            if not provided:
                abort(400, "password required to create an account")
            item = {"name": username, "password": provided, "reminders_enabled": False}
            if zone:
                item["time_zone"] = zone
            try:
                _users_tbl.put_item(
                    Item=item,
                    ConditionExpression="attribute_not_exists(#name)",
                    ExpressionAttributeNames={"#name": "name"},
                )
                user = item
                created = True
                _invalidate_cache()
            except ClientError as exc:
                if exc.response.get("Error", {}).get("Code") != "ConditionalCheckFailedException":
                    raise
                user = _get_user(username)
        if user is None or user.get("password", "") != provided:
            return _auth_failure("login_failed", "incorrect username or password")
        if not created:
            update_time_zone(username, user, zone)
        return _signed_in_response(user, remember, created=created)

    @app.route("/api/account/logout", methods=["POST"])
    def bitlog_account_logout():
        response = make_response(jsonify({"ok": True}))
        response.delete_cookie(COOKIE_NAME, path="/", secure=True, httponly=True, samesite="Lax")
        return response

    @app.route("/api/account/settings", methods=["POST"])
    def bitlog_account_settings():
        name, user, remember = require_signed_in()
        data = _json_data()
        update_time_zone(name, user, data.get("time_zone"))
        old_email = user.get("email") or ""
        new_email = old_email
        if data.get("remove_email") is True:
            new_email = ""
        elif "email" in data:
            if not isinstance(data["email"], str):
                abort(400, "invalid email")
            candidate = data["email"].strip()
            if candidate:
                if len(candidate) > 254 or not EMAIL_RE.fullmatch(candidate):
                    abort(400, "invalid email")
                new_email = candidate
        reminder = data.get("reminders_enabled", user.get("reminders_enabled") is True)
        if not isinstance(reminder, bool):
            abort(400, "invalid reminder setting")
        if not new_email:
            reminder = False
        new_password = data.get("new_password")
        if new_password is not None and (not isinstance(new_password, str) or not new_password):
            abort(400, "new password must not be empty")

        names = {"#email": "email", "#reminders": "reminders_enabled", "#password": "password"}
        values = {":old_password": user.get("password", ""), ":reminders": reminder}
        set_parts = ["#reminders = :reminders"]
        remove_parts = []
        if new_email:
            values[":email"] = new_email
            set_parts.append("#email = :email")
        else:
            remove_parts.append("#email")
        if new_password is not None:
            names["#reset"] = "reset_password_hash"
            values[":new_password"] = new_password
            set_parts.append("#password = :new_password")
            remove_parts.append("#reset")
        update = "SET " + ", ".join(set_parts)
        if remove_parts:
            update += " REMOVE " + ", ".join(remove_parts)
        try:
            result = _users_tbl.update_item(
                Key={"name": name},
                UpdateExpression=update,
                ConditionExpression="#password = :old_password",
                ExpressionAttributeNames=names,
                ExpressionAttributeValues=values,
                ReturnValues="ALL_NEW",
            )
        except ClientError as exc:
            if exc.response.get("Error", {}).get("Code") == "ConditionalCheckFailedException":
                return _auth_failure("cookie_failed", "saved login authentication failed")
            raise
        updated = result["Attributes"]
        _invalidate_cache()
        _send_admin_notice(name, old_email, new_email)
        if new_password is not None:
            # The password change invalidates the old proof, including a
            # memory-only token. Deliver its replacement in this response.
            return _signed_in_response(updated, remember)
        return jsonify(account_payload(updated, mode="signed"))

    @app.route("/api/account/reset-request", methods=["POST"])
    def bitlog_account_reset_request():
        data = _json_data()
        username = _name(data.get("name"))
        user = _get_user(username)
        if user is not None and user.get("email"):
            reset_password = secrets.token_urlsafe(32)
            try:
                _users_tbl.update_item(
                    Key={"name": username},
                    UpdateExpression="SET #reset = :new",
                    ConditionExpression="#email = :email",
                    ExpressionAttributeNames={"#reset": "reset_password_hash", "#email": "email"},
                    ExpressionAttributeValues={":new": _reset_hash(reset_password), ":email": user["email"]},
                )
                base = os.getenv("BITLOG_URL", "https://bitlog.joukov.com/").rstrip("/") + "/"
                link = base + "?" + urlencode({"user": username, "reset_pass": reset_password})
                _smtp_send(
                    user["email"],
                    "Bitlog: reset your password",
                    "Use this link to choose a new Bitlog password:\n\n" + link + "\n\n"
                    "Your existing password will keep working until you change it.\n",
                )
            except Exception:
                app.logger.exception("Password reset email failed for user=%s", username)
        return jsonify({
            "ok": True,
            "message": "If this username has a saved email address, a reset link was sent.",
        })

    @app.route("/api/account/password", methods=["POST"])
    def bitlog_account_change_password_from_reset():
        data = _json_data()
        username = _name(data.get("user"))
        reset_password = data.get("reset_pass")
        new_password = _password(data.get("new_password"))
        remember = data.get("stay_signed_in", True)
        if not isinstance(remember, bool):
            abort(400, "invalid stay signed in option")
        if not new_password:
            abort(400, "new password required")
        user = _get_user(username)
        if user is None or not _verify_reset(user, reset_password):
            return _url_auth_failure()
        update_time_zone(username, user, data.get("time_zone"))
        try:
            _users_tbl.update_item(
                Key={"name": username},
                UpdateExpression="SET #password = :new REMOVE #reset",
                ConditionExpression="#reset = :expected",
                ExpressionAttributeNames={"#password": "password", "#reset": "reset_password_hash"},
                ExpressionAttributeValues={":new": new_password, ":expected": _reset_hash(reset_password)},
            )
        except ClientError as exc:
            if exc.response.get("Error", {}).get("Code") == "ConditionalCheckFailedException":
                return _url_auth_failure()
            raise
        user["password"] = new_password
        user.pop("reset_password_hash", None)
        return _signed_in_response(user, remember)
