#!/usr/bin/env python3
# /opt/bitlog/app.py

import os
import re
import html
from decimal import Decimal
from datetime import datetime, timezone

from curse_words import censor

from flask import Flask, request, jsonify, abort, make_response
import boto3
from botocore.exceptions import ClientError
from boto3.dynamodb.conditions import Key

import json
from cryptography.fernet import Fernet, InvalidToken

# ==================== Config ====================
USERS_TABLE = os.getenv("USERS_TABLE", "journal_users")
ENTRIES_TABLE = os.getenv("ENTRIES_TABLE", "journal_entries")

region = os.getenv("AWS_REGION") or os.getenv("AWS_DEFAULT_REGION")
if not region:
    raise RuntimeError("AWS region not set; set AWS_REGION or AWS_DEFAULT_REGION")

dynamodb = boto3.resource("dynamodb", region_name=region)
users_tbl = dynamodb.Table(USERS_TABLE)
entries_tbl = dynamodb.Table(ENTRIES_TABLE)

app = Flask(__name__)
APP_VERSION = "date-epoch-day-2026-08-16"
DAY_SECONDS = 86400
MAX_DATE_AGE_SECONDS = 84 * 60 * 60
MAX_DATE_FUTURE_SECONDS = 14 * 60 * 60

LOGIN_COOKIE_NAME = "bitlog_login"
LOGIN_COOKIE_MAX_AGE = 14 * 24 * 60 * 60

login_cookie_key = os.environ.get("LOGIN_COOKIE_KEY")
if not login_cookie_key:
    raise RuntimeError("LOGIN_COOKIE_KEY not set")

login_cipher = Fernet(login_cookie_key.encode())
# ==================== In-memory cache ====================
# Keyed by (endpoint, args_tuple). Cleared on any successful write.
_cache = {}


def cache_key():
    return (request.path, tuple(sorted(request.args.items())))


def invalidate_cache():
    _cache.clear()

# ==================== Text utils ====================
WORD_RE = re.compile(r"\b[\w’'-]+\b")


def count_words(s: str) -> int:
    # Server still enforces <= 10 words, but we do NOT store this count.
    return len(WORD_RE.findall(s or ""))


def safe_text(s: str) -> str:
    # Keep what the user submitted, but escape for safe embedding in HTML UIs.
    # (Frontend can decode if needed.)
    return html.escape(s or "")


# ==================== Time helpers ====================
def now_epoch_utc_seconds() -> int:
    return int(datetime.now(timezone.utc).timestamp())
# ==================== Users ====================
def get_user(name: str):
    r = users_tbl.get_item(Key={"name": name})
    return r.get("Item")


def create_user(name: str, password: str):
    users_tbl.put_item(
        Item={"name": censor(name), "password": (password or "")},
        ConditionExpression="attribute_not_exists(#n)",
        ExpressionAttributeNames={"#n": "name"},
    )


def verify_password(user_item, provided: str) -> bool:
    return user_item.get("password", "") == (provided or "")
# ==================== Entries ====================
def query_user_range(
    name: str,
    ts_start: int = None,
    ts_end: int = None,
    limit: int = None,
    scan_forward: bool = True,
):
    """
    Query items for a user, optionally within a ts range.
    - Assumes entries table has PK: user (S), SK: ts (N).
    - Returns a flat list of items.
    """
    key_expr = Key("user").eq(name)
    if ts_start is not None and ts_end is not None:
        key_expr &= Key("ts").between(Decimal(ts_start), Decimal(ts_end))
    elif ts_start is not None:
        key_expr &= Key("ts").gte(Decimal(ts_start))
    elif ts_end is not None:
        key_expr &= Key("ts").lte(Decimal(ts_end))

    kwargs = {
        "KeyConditionExpression": key_expr,
        "ScanIndexForward": scan_forward,  # True = ascending
    }
    if limit:
        kwargs["Limit"] = limit

    items = []
    while True:
        r = entries_tbl.query(**kwargs)
        items.extend(r.get("Items", []))
        if "LastEvaluatedKey" not in r:
            break
        kwargs["ExclusiveStartKey"] = r["LastEvaluatedKey"]
        if limit and len(items) >= limit:
            items = items[:limit]
            break
    return items


def put_item(user: str, ts_sec: int, date_day: int, text: str):
    entries_tbl.put_item(
        Item={
            "user": user,
            "ts": Decimal(ts_sec),
            "date": Decimal(date_day),
            "text": text,
        }
    )
# ==================== Middleware & Errors ====================
@app.after_request
def mark(resp):
    resp.headers["X-Journal-Version"] = APP_VERSION
    resp.headers["Cache-Control"] = "no-store"
    return resp


@app.errorhandler(400)
@app.errorhandler(401)
@app.errorhandler(403)
@app.errorhandler(404)
@app.errorhandler(409)
@app.errorhandler(500)
def json_err(err):
    msg = getattr(err, "description", str(err))
    return jsonify({"ok": False, "message": msg}), getattr(err, "code", 500)


# ==================== Cookie ====================
def encode_saved_login(name: str, password: str) -> str:
    data = json.dumps(
        {
            "name": name,
            "password": password,
        },
        separators=(",", ":"),
    ).encode()

    return login_cipher.encrypt(data).decode()


def decode_saved_login(token: str):
    try:
        data = login_cipher.decrypt(token.encode())
        login = json.loads(data.decode())

        name = login.get("name")
        password = login.get("password")

        if not isinstance(name, str) or not isinstance(password, str):
            return None

        return name, password
    except (InvalidToken, ValueError, TypeError, json.JSONDecodeError):
        return None


def set_saved_login_cookie(resp, name: str, password: str):
    resp.set_cookie(
        LOGIN_COOKIE_NAME,
        encode_saved_login(name, password),
        max_age=LOGIN_COOKIE_MAX_AGE,
        secure=True,
        httponly=True,
        samesite="Lax",
        path="/",
    )

# ==================== API ====================
@app.route("/api/entry", methods=["POST"])
def create_entry():
    """
    Body: { name, password?, text, date }
      - date is a browser-supplied Unix day.
      - ts is always generated by the server.
      - Server enforces <= 10 words.
    Response: { ok, ts, date }
    """
    data = request.get_json(force=True, silent=False)

    name = censor(data.get("name") or "").strip()
    pwd = data.get("password", "")
    text = censor(data.get("text") or "").strip()
    date_day = data.get("date")

    if not name:
        abort(400, "name required")
    if not text:
        abort(400, "text required")
    if count_words(text) > 10:
        abort(400, "text exceeds 10 words")
    if isinstance(date_day, bool) or not isinstance(date_day, int):
        abort(400, "date must be an integer Unix day")

    ts_sec = now_epoch_utc_seconds()
    date_sec = date_day * DAY_SECONDS

    if date_sec < ts_sec - MAX_DATE_AGE_SECONDS:
        abort(400, "date too old")
    if date_sec > ts_sec + MAX_DATE_FUTURE_SECONDS:
        abort(400, "date too far in the future")

    # user create/verify
    user = get_user(name)
    if user is None:
        try:
            create_user(name, pwd)
        except ClientError as e:
            if e.response["Error"]["Code"] != "ConditionalCheckFailedException":
                abort(500, e.response["Error"]["Message"])
        user = get_user(name)
    else:
        if not verify_password(user, pwd):
            abort(403, "invalid credentials")

    try:
        put_item(name, ts_sec, date_day, text)
    except ClientError as e:
        abort(500, e.response["Error"]["Message"])

    invalidate_cache()

    resp = make_response(jsonify({
        "ok": True,
        "ts": ts_sec,
        "date": date_day,
    }))

    set_saved_login_cookie(resp, name, pwd)

    return resp

@app.route("/api/saved_login", methods=["GET"])
def saved_login():
    token = request.cookies.get(LOGIN_COOKIE_NAME)
    if not token:
        return jsonify({"ok": False}), 404

    login = decode_saved_login(token)
    if login is None:
        return jsonify({"ok": False}), 404

    name, password = login

    user = get_user(name)
    if user is None or not verify_password(user, password):
        return jsonify({"ok": False}), 404

    return jsonify({
        "ok": True,
        "name": name,
        "password": password,
    })

@app.route("/api/user/<name>", methods=["GET"])
def user_entries(name):
    """
    Returns the user's entries sorted ascending by ts.
    Response: { name, entries: [{ts, date, text}, ...] }
    """
    ck = cache_key()
    if ck in _cache:
        return _cache[ck]
    items = query_user_range(name, scan_forward=True)
    out = [
        {
            "ts": int(it["ts"]),
            "date": int(it["date"]),
            "text": censor(safe_text(it.get("text", ""))),
        }
        for it in items
    ]
    resp = jsonify({"name": name, "entries": out})
    _cache[ck] = resp
    return resp


@app.route("/api/calendar/<name>", methods=["GET"])
def calendar(name):
    """
    Returns entries with their explicit Unix day.
    Response: { entries: [{ts, date, text}, ...] }
    """
    ck = cache_key()
    if ck in _cache:
        return _cache[ck]
    items = query_user_range(name, scan_forward=True)
    out = [
        {
            "ts": int(it["ts"]),
            "date": int(it["date"]),
            "text": censor(safe_text(it.get("text", ""))),
        }
        for it in items
    ]
    resp = jsonify({"entries": out})
    _cache[ck] = resp
    return resp


@app.route("/api/users", methods=["GET"])
def list_users():
    ck = cache_key()
    if ck in _cache:
        return _cache[ck]
    names = []
    kwargs = dict(ProjectionExpression="#n", ExpressionAttributeNames={"#n": "name"})
    while True:
        try:
            resp = users_tbl.scan(**kwargs)
        except ClientError as e:
            abort(500, e.response["Error"]["Message"])
        names.extend(censor(it["name"]) for it in resp.get("Items", []))
        if "LastEvaluatedKey" not in resp:
            break
        kwargs["ExclusiveStartKey"] = resp["LastEvaluatedKey"]
    names.sort(key=str.lower)
    result = jsonify({"users": names})
    _cache[ck] = result
    return result


@app.route("/api/all_recent", methods=["GET"])
def all_recent():
    """
    Returns recent entries across all users. Since the table is keyed by (user, ts),
    we do a table scan and sort client-side. (If this gets big, add a GSI.)
    Response: { entries: [{user, ts, date, text}, ...] }
    """
    ck = cache_key()
    if ck in _cache:
        return _cache[ck]

    try:
        limit = int(request.args.get("limit", "200"))
    except ValueError:
        limit = 200

    items = []
    kwargs = {}
    while True:
        try:
            resp = entries_tbl.scan(**kwargs)
        except ClientError as e:
            abort(500, e.response["Error"]["Message"])
        items.extend(resp.get("Items", []))
        if "LastEvaluatedKey" not in resp:
            break
        kwargs["ExclusiveStartKey"] = resp["LastEvaluatedKey"]

    # Sort by ts desc; if tie, by user asc.
    items.sort(key=lambda it: (int(it["ts"]), it.get("user", "")), reverse=True)
    items = items[:limit]

    out = [
        {
            "user": censor(it.get("user", "")),
            "ts": int(it["ts"]),
            "date": int(it["date"]),
            "text": censor(safe_text(it.get("text", ""))),
        }
        for it in items
    ]
    result = jsonify({"entries": out})
    _cache[ck] = result
    return result


@app.route("/api/health")
def health():
    try:
        _ = users_tbl.table_status
        _ = entries_tbl.table_status
        return jsonify({"ok": True})
    except Exception as e:
        return jsonify({"ok": False, "err": str(e)}), 500


@app.route("/api/version")
def version():
    return jsonify({"v": APP_VERSION})


if __name__ == "__main__":
    app.run("127.0.0.1", 8000, debug=False)
