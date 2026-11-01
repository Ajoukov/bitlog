#!/usr/bin/env python3
"""Email at-risk Bitlog users at approximately 3 PM in their last known timezone.

Run this once every 5 minutes with a systemd timer. Dates use the same 18-hour
absolute shift as the browser's localUnixDay(), including DST behavior. A
missing yesterday becomes unrecoverable when the journal day rolls over.
"""

import argparse
import logging
import os
import smtplib
import ssl
from datetime import date, datetime, timedelta, timezone
from email.message import EmailMessage
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from botocore.exceptions import ClientError
from app import query_user_range, users_tbl

logger = logging.getLogger("bitlog.streak_reminders")
EPOCH_DATE = date(1970, 1, 1)
JOURNAL_SHIFT = timedelta(hours=18)


def journal_day_for_zone(now_utc, zone):
    """Mirror: new Date(Date.now() - 18 * 60 * 60 * 1000) in user's zone."""
    shifted_day = (now_utc - JOURNAL_SHIFT).astimezone(zone).date()
    return (shifted_day - EPOCH_DATE).days


def reminder_context(now_utc, time_zone):
    """Return (journal_day, missing_day) only near 3 PM *in that zone*."""
    try:
        zone = ZoneInfo(time_zone)
    except (ZoneInfoNotFoundError, ValueError, TypeError):
        return None

    local_now = now_utc.astimezone(zone)
    # Allow a short delivery window for scheduler delays, with deduplication.
    if local_now.hour != 15 or local_now.minute >= 15:
        return None

    today_day = journal_day_for_zone(now_utc, zone)
    return today_day, today_day - 1


def iter_subscribed_users():
    """Scan a small deployment's user table, reading no passwords."""
    kwargs = {
        "ProjectionExpression": "#name, #email, #enabled, #tz, #sent",
        "ExpressionAttributeNames": {
            "#name": "name",
            "#email": "email",
            "#enabled": "reminders_enabled",
            "#tz": "time_zone",
            "#sent": "last_streak_reminder_day",
        },
    }
    while True:
        page = users_tbl.scan(**kwargs)
        for user in page.get("Items", []):
            if user.get("reminders_enabled") is True and user.get("email") and user.get("time_zone"):
                yield user
        last = page.get("LastEvaluatedKey")
        if not last:
            break
        kwargs["ExclusiveStartKey"] = last


def at_risk(user_name, today_day, now_utc):
    """The yesterday gap will be unfillable at the next journal rollover.

    For a streak to be at risk, the day before yesterday must exist, while
    yesterday does not. Presence of a current-day post doesn't fix the gap.
    """
    start = int((now_utc - timedelta(days=10)).timestamp())
    posts = query_user_range(user_name, ts_start=start, scan_forward=False)
    days = {int(post["date"]) for post in posts}
    return (today_day - 2) in days and (today_day - 1) not in days


def send_email(destination, subject, body):
    host = os.environ.get("SMTP_HOST", "smtp.purelymail.com")
    port = int(os.environ.get("SMTP_PORT", "465"))
    username = os.environ["SMTP_USERNAME"]
    password = os.environ["SMTP_PASSWORD"]
    sender = os.environ.get("SMTP_FROM", username)

    message = EmailMessage()
    message["From"] = sender
    message["To"] = destination
    message["Subject"] = subject
    message.set_content(body)

    with smtplib.SMTP_SSL(host, port, context=ssl.create_default_context(), timeout=20) as smtp:
        smtp.login(username, password)
        smtp.send_message(message)


def record_sent(user, missing_day):
    """Avoid sending again for the same missing date; respect changed settings."""
    try:
        users_tbl.update_item(
            Key={"name": user["name"]},
            UpdateExpression="SET #sent = :day",
            ConditionExpression=(
                "#enabled = :yes AND #email = :email AND #tz = :tz AND "
                "(attribute_not_exists(#sent) OR #sent <> :day)"
            ),
            ExpressionAttributeNames={
                "#enabled": "reminders_enabled",
                "#email": "email",
                "#tz": "time_zone",
                "#sent": "last_streak_reminder_day",
            },
            ExpressionAttributeValues={
                ":yes": True,
                ":email": user["email"],
                ":tz": user["time_zone"],
                ":day": missing_day,
            },
        )
        return True
    except ClientError as exc:
        if exc.response.get("Error", {}).get("Code") == "ConditionalCheckFailedException":
            logger.warning("Reminder status/preferences changed for user=%s", user["name"])
            return False
        raise


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--dry-run", action="store_true", help="Check eligibility, do not send")
    args = parser.parse_args()
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")

    now_utc = datetime.now(timezone.utc)
    url = os.environ.get("BITLOG_URL", "https://bitlog.us/")
    scanned = eligible = sent = 0

    for user in iter_subscribed_users():
        scanned += 1
        context = reminder_context(now_utc, user["time_zone"])
        if context is None:
            continue
        today_day, missing_day = context
        if int(user.get("last_streak_reminder_day", -1)) == missing_day:
            continue

        try:
            if not at_risk(user["name"], today_day, now_utc):
                continue
            eligible += 1
            if args.dry_run:
                logger.info("DRY RUN: at-risk user=%s zone=%s", user["name"], user["time_zone"])
                continue

            missing_date = (EPOCH_DATE + timedelta(days=missing_day)).isoformat()
            send_email(
                user["email"],
                "Bitlog: protect your streak before tonight's cutoff",
                (
                    f"Your Bitlog streak needs an entry for {missing_date}.\n\n"
                    "You can still backfill that missing day in Bitlog, but the "
                    "opportunity disappears when your journal day rolls over "
                    "this evening.\n\n"
                    f"Post now: {url}\n\n"
                    "You can disable these reminders in your account settings.\n"
                ),
            )
            if record_sent(user, missing_day):
                sent += 1
                logger.info("Sent streak reminder: user=%s zone=%s", user["name"], user["time_zone"])
        except Exception as exc:
            # SMTP errors can contain addresses; do not put exception text in logs.
            logger.error("Streak reminder failed: user=%s error_type=%s", user["name"], type(exc).__name__)

    logger.info("Scanned=%d at_risk=%d sent=%d dry_run=%s", scanned, eligible, sent, args.dry_run)


if __name__ == "__main__":
    main()
