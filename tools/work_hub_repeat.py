"""Repeat_Rule: parse / format / next_due (pure functions, standard library only).

Normalized rule objects::

    {"type": "daily"}
    {"type": "weekly", "days": [1, 3, 5]}     # ISO weekdays 1=Mon..7=Sun, unique, ascending, 1-7 items
    {"type": "monthly"}
    {"type": "interval", "days": 14}          # 1-365

``parse`` accepts a rule object, a JSON object string, or compact text
(``daily``, ``weekly:1,3,5``, ``monthly``, ``every:14d``). Invalid input raises
``RuleError`` (category ``empty`` / ``too_long`` / ``invalid``, offending
``field`` and character ``position``); no partial result is ever produced.
"""
from __future__ import annotations

import calendar
import datetime as _dt
import json

MAX_TEXT = 1024
MAX_INTERVAL = 365
TYPES = ("daily", "weekly", "monthly", "interval")


class RuleError(ValueError):
    def __init__(self, category, field="repeat", position=0, message=None):
        self.category = category
        self.field = field
        self.position = position
        super().__init__(message or "Repeat_Rule 无效（%s，字段 %s，位置 %d）" % (category, field, position))


def _is_int(value):
    return type(value) is int


def _from_object(obj):
    kind = obj.get("type")
    if kind not in TYPES:
        raise RuleError("invalid", "type", 0, "Repeat_Rule 类型必须是 daily / weekly / monthly / interval")
    allowed = {"type"} | ({"days"} if kind in ("weekly", "interval") else set())
    extra = sorted(set(obj) - allowed)
    if extra:
        raise RuleError("invalid", str(extra[0]), 0, "Repeat_Rule 含有不支持的字段: %s" % extra[0])
    if kind in ("daily", "monthly"):
        return {"type": kind}
    if "days" not in obj:
        raise RuleError("invalid", "days", 0, "Repeat_Rule 缺少 days")
    days = obj["days"]
    if kind == "interval":
        if not _is_int(days) or not 1 <= days <= MAX_INTERVAL:
            raise RuleError("invalid", "days", 0, "interval 的 days 必须是 1 到 %d 的整数" % MAX_INTERVAL)
        return {"type": "interval", "days": days}
    if not isinstance(days, list) or not days:
        raise RuleError("invalid", "days", 0, "weekly 的 days 必须是 1 到 7 个星期")
    for index, day in enumerate(days):
        if not _is_int(day) or not 1 <= day <= 7:
            raise RuleError("invalid", "days", index, "weekly 的星期必须是 1（周一）到 7（周日）的整数")
    return {"type": "weekly", "days": sorted(set(days))}


def _from_compact(text):
    body = text.strip()
    offset = len(text) - len(text.lstrip())
    if body in ("daily", "monthly"):
        return {"type": body}
    if body.startswith("weekly:"):
        start = offset + len("weekly:")
        days, position = [], start
        for part in body[len("weekly:"):].split(","):
            if not part.isascii() or not part.isdigit():
                raise RuleError("invalid", "days", position, "weekly 的星期必须是 1 到 7 的整数")
            days.append(int(part))
            position += len(part) + 1
        return _from_object({"type": "weekly", "days": days})
    if body.startswith("every:") and body.endswith("d"):
        number = body[len("every:"):-1]
        if not number.isascii() or not number.isdigit():
            raise RuleError("invalid", "days", offset + len("every:"), "every 的天数必须是整数")
        return _from_object({"type": "interval", "days": int(number)})
    raise RuleError("invalid", "repeat", offset, "无法识别的 Repeat_Rule 文本")


def parse(value):
    """Return the normalized rule for an object or text; raise ``RuleError`` otherwise."""
    if isinstance(value, dict):
        return _from_object(value)
    if not isinstance(value, str):
        raise RuleError("invalid", "repeat", 0, "Repeat_Rule 必须是对象或文本")
    if len(value) > MAX_TEXT:
        raise RuleError("too_long", "repeat", MAX_TEXT, "Repeat_Rule 不能超过 %d 个字符" % MAX_TEXT)
    if not value.strip():
        raise RuleError("empty", "repeat", 0, "Repeat_Rule 不能为空")
    if value.lstrip().startswith("{"):
        try:
            decoded = json.loads(value)
        except ValueError as exc:
            raise RuleError("invalid", "repeat", getattr(exc, "pos", 0) or 0, "Repeat_Rule 不是有效的 JSON") from None
        if not isinstance(decoded, dict):
            raise RuleError("invalid", "repeat", 0, "Repeat_Rule 必须是对象")
        return _from_object(decoded)
    return _from_compact(value)


def format(rule):  # noqa: A001 (public name required by the spec)
    """Canonical JSON: sorted keys, no whitespace. The rule is validated first."""
    return json.dumps(parse(rule), sort_keys=True, separators=(",", ":"), ensure_ascii=False)


def _as_date(base):
    if isinstance(base, _dt.datetime):
        return base.date()
    if isinstance(base, _dt.date):
        return base
    if isinstance(base, str):
        try:
            return _dt.date.fromisoformat(base)
        except ValueError:
            pass
    raise ValueError("base 必须是日期")


def next_due(rule, base):
    """The next Due_Date strictly after ``base`` (a ``date`` or ``YYYY-MM-DD``)."""
    rule = parse(rule)
    day = _as_date(base)
    kind = rule["type"]
    if kind == "daily":
        return day + _dt.timedelta(days=1)
    if kind == "interval":
        return day + _dt.timedelta(days=rule["days"])
    if kind == "weekly":
        for step in range(1, 8):
            candidate = day + _dt.timedelta(days=step)
            if candidate.isoweekday() in rule["days"]:
                return candidate
    year, month = (day.year + 1, 1) if day.month == 12 else (day.year, day.month + 1)
    return _dt.date(year, month, min(day.day, calendar.monthrange(year, month)[1]))
