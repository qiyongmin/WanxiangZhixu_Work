"""Phase 2 side-table helpers: ``work_task_ext`` (remind / repeat), ``work_tags`` and value validators.

Low level and dependency-free (no import of the store) so that both
``work_hub_store`` (recurrence hook) and ``work_hub_nodes`` (views/actions) can use it.
Every writer expects an open write transaction owned by the caller.
"""
from __future__ import annotations

import datetime as _dt
import json
import re
import unicodedata

import work_hub_repeat as repeat

PRIORITIES = ("Urgent", "High", "Medium", "Low")
DEFAULT_PRIORITY = "Medium"
MAX_TAGS = 20
MAX_TAG_LEN = 32
MIN_LINK_RELATION = 1
MAX_LINK_RELATION = 32
_DATE = re.compile(r"[0-9]{4}-[0-9]{2}-[0-9]{2}")
_MINUTE = re.compile(r"[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}")
_UNSET = object()
UNSET = _UNSET


def available(con):
    """True when the three side tables exist (database migrated)."""
    found = {r[0] for r in con.execute(
        "SELECT name FROM sqlite_master WHERE type='table' AND name IN "
        "('work_task_ext','work_tags','work_recurrences')")}
    return len(found) == 3


# --------------------------------------------------------------------------
# Validators: return ``(value, reason)``; ``reason`` is None when valid
# --------------------------------------------------------------------------
def check_priority(value):
    if value == "":
        return "", None  # Explicit clear; preserves the existing None rejection.
    if value not in PRIORITIES:
        return None, "必须是 %s 之一" % " / ".join(PRIORITIES)
    return value, None


def check_due_date(value):
    """``''`` clears; ``None`` also clears. Returns the stored string."""
    if value is None or value == "":
        return "", None
    if not isinstance(value, str) or not _DATE.fullmatch(value):
        return None, "必须是 YYYY-MM-DD"
    try:
        _dt.date.fromisoformat(value)
    except ValueError:
        return None, "不是存在的日期"
    return value, None


def check_remind_at(value):
    """Returns ``(minute-string | None, reason)``; ``None`` / ``''`` clear."""
    if value is None or value == "":
        return None, None
    if not isinstance(value, str) or not _MINUTE.fullmatch(value):
        return None, "必须是 YYYY-MM-DDTHH:MM"
    try:
        _dt.datetime.strptime(value, "%Y-%m-%dT%H:%M")
    except ValueError:
        return None, "不是存在的日期时间"
    return value, None


def check_repeat(value):
    """Returns ``(rule dict | None, reason)``; ``None`` / ``''`` clear."""
    if value is None or value == "":
        return None, None
    try:
        return repeat.parse(value), None
    except repeat.RuleError as exc:
        return None, str(exc)


def check_tags(value):
    """NFC + trim, 1-32 chars, no control characters, de-duplicated, at most 20."""
    if value is None:
        return [], None
    if not isinstance(value, list):
        return None, "必须是文本列表"
    clean, seen = [], set()
    for item in value:
        if not isinstance(item, str):
            return None, "每个标签必须是文本"
        tag = unicodedata.normalize("NFC", item).strip()
        if not 1 <= len(tag) <= MAX_TAG_LEN:
            return None, "每个标签必须是 1 到 %d 个字符" % MAX_TAG_LEN
        if any(unicodedata.category(ch) == "Cc" for ch in tag):
            return None, "标签不能包含控制字符"
        if tag not in seen:
            seen.add(tag)
            clean.append(tag)
    if len(clean) > MAX_TAGS:
        return None, "最多 %d 个标签" % MAX_TAGS
    return clean, None


def check_relation(value):
    if not isinstance(value, str):
        return None, "必须是文本"
    text = value.strip()
    if not MIN_LINK_RELATION <= len(text) <= MAX_LINK_RELATION:
        return None, "必须是 1 到 %d 个字符" % MAX_LINK_RELATION
    return text, None


def minute_now(value=None):
    """Normalize a client clock (``YYYY-MM-DDTHH:MM[:SS]``) to minute precision, or ``None``."""
    if not isinstance(value, str):
        return None
    text = value[:16]
    if (len(value) == 16 or (len(value) == 19 and value[16] == ":")) and check_remind_at(text)[0]:
        return text
    return None


def local_minute():
    return _dt.datetime.now().strftime("%Y-%m-%dT%H:%M")


# --------------------------------------------------------------------------
# Readers
# --------------------------------------------------------------------------
def get_ext(con, record_id):
    row = con.execute("SELECT remind_at,repeat_rule,handled_for FROM work_task_ext WHERE record_id=?",
                      (record_id,)).fetchone()
    if row is None:
        return {"remind_at": None, "repeat": None, "handled_for": None}
    rule = None
    if row[1]:
        try:
            rule = json.loads(row[1])
        except ValueError:
            rule = None
    return {"remind_at": row[0], "repeat": rule, "handled_for": row[2]}


def get_tags(con, record_id):
    return [r[0] for r in con.execute("SELECT tag FROM work_tags WHERE record_id=? ORDER BY tag", (record_id,))]


def snapshot(con, record_id, force=False):
    """``{"tags", "remindAt", "repeat"}`` for Revision snapshots; ``None`` when empty and not forced."""
    ext, tags = get_ext(con, record_id), get_tags(con, record_id)
    if not force and not tags and ext["remind_at"] is None and ext["repeat"] is None:
        return None
    return {"tags": tags, "remindAt": ext["remind_at"], "repeat": ext["repeat"]}


def pending(remind_at, handled_for, status, now):
    """The pending-reminder predicate (design 4.7) for already-visible tasks."""
    return bool(remind_at) and remind_at <= now and handled_for != remind_at and status != "Done"


# --------------------------------------------------------------------------
# Writers (caller owns the transaction)
# --------------------------------------------------------------------------
def set_ext(con, record_id, *, remind_at=_UNSET, repeat_rule=_UNSET):
    """Upsert ``remind_at`` / ``repeat_rule`` (rule dict or ``None``); handled_* columns are kept."""
    current = con.execute("SELECT remind_at,repeat_rule FROM work_task_ext WHERE record_id=?",
                          (record_id,)).fetchone()
    new_remind = current[0] if current else None
    new_rule = current[1] if current else None
    if remind_at is not _UNSET:
        new_remind = remind_at
    if repeat_rule is not _UNSET:
        new_rule = repeat.format(repeat_rule) if repeat_rule else None
    if current is None:
        if new_remind is None and new_rule is None:
            return
        con.execute("INSERT INTO work_task_ext(record_id,remind_at,repeat_rule) VALUES(?,?,?)",
                    (record_id, new_remind, new_rule))
    else:
        con.execute("UPDATE work_task_ext SET remind_at=?,repeat_rule=? WHERE record_id=?",
                    (new_remind, new_rule, record_id))


def set_tags(con, record_id, tags, now):
    """Replace the whole tag set of a record."""
    con.execute("DELETE FROM work_tags WHERE record_id=?", (record_id,))
    con.executemany("INSERT INTO work_tags(record_id,tag,created_at) VALUES(?,?,?)",
                    [(record_id, tag, now) for tag in tags])
