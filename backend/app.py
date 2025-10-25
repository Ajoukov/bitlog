#!/usr/bin/env python3
# /opt/journal_api/app.py

import os
import re
import html
from decimal import Decimal
from datetime import datetime, timezone, timedelta

from curse_words import censor

from flask import Flask, request, jsonify, abort
import boto3
from botocore.exceptions import ClientError
from boto3.dynamodb.conditions import Key

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
APP_VERSION = "ts-only-epoch-utc-2025-10-18"

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


def coerce_ts_to_epoch_seconds(ts_val):
    """
    Accepts either:
      - number-like (int/float/Decimal) epoch seconds (UTC), or
      - ISO-8601 string ("2025-10-18T02:00:00Z", with or without offset)
    Returns an int (epoch seconds).
    """
    if ts_val is None or ts_val == "":
        return now_epoch_utc_seconds()

    # number-like
    if isinstance(ts_val, (int, float, Decimal)):
        return int(ts_val)

    # str: try ISO 8601
    if isinstance(ts_val, str):
        iso = ts_val.strip()
        try:
            dt = datetime.fromisoformat(iso.replace("Z", "+00:00"))
            if dt.tzinfo is None:
                # treat naive as UTC
                dt = dt.replace(tzinfo=timezone.utc)
            return int(dt.timestamp())
        except Exception:
            # maybe it is a numeric string
            try:
                return int(float(iso))
            except Exception:
                pass

    abort(400, "invalid ts (expected epoch seconds or ISO-8601)")


def utc_day_bounds_for_ts(ts_sec: int):
    """
    Given epoch seconds (UTC), return (start_sec, end_sec) for that UTC day.
    End is inclusive (i.e., last second of the day).
    """
    dt = datetime.fromtimestamp(ts_sec, tz=timezone.utc)
    start = datetime(dt.year, dt.month, dt.day, tzinfo=timezone.utc)
    end = start + timedelta(days=1) - timedelta(seconds=1)
    return (int(start.timestamp()), int(end.timestamp()))


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


# ==================== Entries (pure ts schema) ====================
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


def delete_item(user: str, ts_sec: int):
    entries_tbl.delete_item(Key={"user": user, "ts": Decimal(ts_sec)})


def put_item(user: str, ts_sec: int, text: str):
    entries_tbl.put_item(Item={"user": user, "ts": Decimal(ts_sec), "text": text})


# ==================== Middleware & Errors ====================
@app.after_request
def mark(resp):
    resp.headers["X-Journal-Version"] = APP_VERSION
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


# ==================== API ====================
@app.route("/api/entry", methods=["POST"])
def create_or_update_entry():
    """
    Body: { name, password?, text, ts? }
      - ts may be epoch seconds or ISO-8601; if omitted, server uses now (UTC).
      - Server enforces ≤ 10 words (but does not store the count).
      - "One per UTC day" upsert behavior:
           * We find any existing entry for that user in the same UTC day (by ts range),
             delete it (if exists), then put the new item at the provided ts.
    Response: { ok, overwritten, ts }
    """
    data = request.get_json(force=True, silent=False)

    name = censor(data.get("name") or "").strip()
    pwd = data.get("password", "")
    text = censor(data.get("text") or "").strip()
    ts_in = data.get("ts", None)

    if not name:
        abort(400, "name required")
    if not text:
        abort(400, "text required")
    if count_words(text) > 10:
        abort(400, "text exceeds 10 words")

    # normalize timestamp (epoch seconds, UTC)
    ts_sec = coerce_ts_to_epoch_seconds(ts_in)

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

    # upsert: delete any existing item in same UTC day
    day_start, day_end = utc_day_bounds_for_ts(ts_sec)
    # existing = query_user_range(name, day_start, day_end, limit=1, scan_forward=True)
    overwritten = False
    # if existing:
    #     try:
    #         delete_item(name, int(existing[0]["ts"]))
    #         overwritten = True
    #     except ClientError as e:
    #         abort(500, e.response["Error"]["Message"])

    # put the new item
    try:
        put_item(name, ts_sec, text)
    except ClientError as e:
        abort(500, e.response["Error"]["Message"])

    return jsonify({"ok": True, "overwritten": overwritten, "ts": ts_sec})


@app.route("/api/user/<name>", methods=["GET"])
def user_entries(name):
    """
    Returns the user's entries strictly as timestamps + text, sorted ascending by ts.
    Response: { name, entries: [{ts, text}, ...] }
    """
    items = query_user_range(name, scan_forward=True)
    out = [
        {"ts": int(it["ts"]), "text": censor(safe_text(it.get("text", "")))}
        for it in items
    ]
    return jsonify({"name": name, "entries": out})


@app.route("/api/calendar/<name>", methods=["GET"])
def calendar(name):
    """
    Returns pure timestamped entries (no derived 'day', no counts).
    The frontend can bucket by any local cutoff (e.g., +5h) and compute word counts.
    Response: { entries: [{ts, text}, ...] }
    """
    items = query_user_range(name, scan_forward=True)
    out = [
        {"ts": int(it["ts"]), "text": censor(safe_text(it.get("text", "")))}
        for it in items
    ]
    return jsonify({"entries": out})


@app.route("/api/users", methods=["GET"])
def list_users():
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
    return jsonify({"users": names})


@app.route("/api/all_recent", methods=["GET"])
def all_recent():
    """
    Returns recent entries across all users. Since the table is keyed by (user, ts),
    we do a table scan and sort client-side. (If this gets big, add a GSI.)
    Response: { entries: [{user, ts, text}, ...] }
    """
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
            "text": censor(safe_text(it.get("text", ""))),
        }
        for it in items
    ]
    return jsonify({"entries": out})


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
