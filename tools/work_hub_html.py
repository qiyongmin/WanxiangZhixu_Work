"""Controlled HTML and Markdown kernel for Work Hub (standard library only).

Three entry points (design 4.9 / 4.10):

``validate_strict(html)``
    The Notes validator (``work_hub_notes._SafeNotesParser``): anything outside
    the whitelist rejects the *whole* input with ``ValueError``.
``sanitize_html(html)``
    Lenient canonicaliser. Drops what is not whitelisted and always emits one
    canonical form, so ``sanitize(sanitize(x)) == sanitize(x)`` byte for byte
    and ``validate_strict(sanitize(x))`` never raises.
``markdown_to_html(md)`` / ``render_summary(text)``
    A deliberate CommonMark subset. Raw HTML in the input is *always* treated
    as text (escaped). The result goes through ``sanitize_html``.

Not supported on purpose (degraded to escaped text): indented code blocks,
reference links, setext headings, nested emphasis edge cases. Tables become a
``<pre>`` block and horizontal rules are dropped.
"""
from __future__ import annotations

import html as _html
import re
import string
from functools import lru_cache
from html.parser import HTMLParser

import work_hub_notes

ALLOWED_TAGS = frozenset(work_hub_notes.ALLOWED_TAGS)
VOID_TAGS = frozenset(work_hub_notes.VOID_TAGS)
FILE_SRC = work_hub_notes.FILE_SRC
DROP_WITH_CONTENT = frozenset({"script", "style", "iframe", "object", "embed", "svg", "math"})
MAX_DEPTH = 120
MAX_MARKDOWN_BYTES = 1024 * 1024
MAX_SUMMARY = 5000
MAX_ALT = 160
MAX_WARNINGS = 20

_HREF_OK = (
    re.compile(r"https?://[^\s<>\x00-\x1f]+", re.I),
    re.compile(r"mailto:[^\s<>\x00-\x1f]+", re.I),
    re.compile(r"#/[-\w/%?.=&]+"),
    re.compile(r"/app/n/[-\w/%?.=&]+"),
)
_MD_HREF_OK = _HREF_OK[:2]  # Markdown links: http(s) and mailto only


class ContentError(ValueError):
    """Rejected content (HTTP 400). ``code`` is the machine-readable error code."""

    status = 400

    def __init__(self, code, message, details=None):
        super().__init__(message)
        self.code = code
        self.details = details or {}


def _esc_text(value):
    return _html.escape(value, quote=False)


def _esc_attr(value):
    return _html.escape(value, quote=True)


def href_ok(href, patterns=_HREF_OK):
    return isinstance(href, str) and any(p.fullmatch(href) for p in patterns)


def _clean_alt(value):
    cleaned = re.sub(r"[\x00-\x1f\x7f\s]+", " ", value or "").strip()
    return cleaned[:MAX_ALT].strip()


# --------------------------------------------------------------------------
# validate_strict
# --------------------------------------------------------------------------
def validate_strict(html, max_bytes=None):
    """Raise ``ValueError`` unless ``html`` fits the Note whitelist exactly."""
    if not isinstance(html, str):
        raise ValueError("Working Note HTML must be text")
    if max_bytes is not None and len(html.encode("utf-8")) > max_bytes:
        raise ValueError("Working Note HTML exceeds limit")
    try:
        parser = work_hub_notes._SafeNotesParser()
        parser.feed(html)
        parser.close()
    except (AssertionError, UnicodeError) as exc:
        raise ValueError("Invalid Working Note HTML") from exc


# --------------------------------------------------------------------------
# sanitize_html
# --------------------------------------------------------------------------
class _Sanitizer(HTMLParser):
    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.out = []
        self.stack = []
        self.skip = None  # [tag, nesting] while inside a drop-with-content element

    # -- helpers ----------------------------------------------------------
    def _open(self, tag, attrs):
        if tag == "a":
            href = dict(attrs).get("href")
            if not href_ok(href):
                return  # drop the tag, keep its text
            self.out.append('<a href="%s" target="_blank" rel="noopener noreferrer">' % _esc_attr(href))
        elif tag == "img":
            attrs = dict(attrs)
            src = attrs.get("src") or ""
            if not FILE_SRC.fullmatch(src):
                return
            self.out.append('<img src="%s" alt="%s" loading="lazy">'
                            % (_esc_attr(src), _esc_attr(_clean_alt(attrs.get("alt")))))
            return
        elif tag in VOID_TAGS:
            self.out.append("<%s>" % tag)
            return
        elif tag == "tr":
            values = dict(attrs)
            height = values.get("height", "")
            source_height = values.get("data-kbw-row-height", "")
            if (isinstance(height,str) and height.isdigit() and
                28 <= int(height) <= 800 and
                (not source_height or source_height == height)):
                self.out.append('<tr height="%s" data-kbw-row-height="%s">' % (height,height))
            else:
                self.out.append("<tr>")
        elif tag in ("td", "th"):
            values = dict(attrs)
            safe = ""
            for span in ("colspan", "rowspan"):
                raw = values.get(span, "")
                if isinstance(raw, str) and raw.isdigit() and 1 <= int(raw) <= 16:
                    safe += ' %s="%s"' % (span, raw)
            colwidth = values.get("colwidth", "")
            if isinstance(colwidth,str):
                pieces=colwidth.split(",")
                if 1 <= len(pieces) <= 16 and all(part.isdigit() and
                    40 <= int(part) <= 2400 for part in pieces):
                    total=sum(int(part) for part in pieces)
                    if values.get("width") in (None,str(total)):
                        safe += ' width="%s" colwidth="%s"' % (total,colwidth)
            shade = values.get("data-kbw-bg")
            if shade in work_hub_notes.TABLE_BACKGROUNDS:
                safe += ' data-kbw-bg="%s"' % shade
            for side in work_hub_notes.TABLE_BORDER_SIDES:
                key = "data-kbw-border-" + side
                token = values.get(key)
                if isinstance(token,str) and work_hub_notes.TABLE_BORDER_TOKEN.fullmatch(token):
                    safe += ' %s="%s"' % (key,token)
            self.out.append("<%s%s>" % (tag, safe))
        else:
            self.out.append("<%s>" % tag)
        self.stack.append(tag)

    # -- parser callbacks -------------------------------------------------
    def handle_starttag(self, tag, attrs):
        if self.skip:
            if tag == self.skip[0]:
                self.skip[1] += 1
            return
        if tag == "embed":  # void element: nothing to skip past
            return
        if tag in DROP_WITH_CONTENT:
            self.skip = [tag, 1]
            return
        if tag not in ALLOWED_TAGS:
            return
        if tag not in VOID_TAGS and len(self.stack) >= MAX_DEPTH:
            return
        self._open(tag, attrs)

    def handle_endtag(self, tag):
        if self.skip:
            if tag == self.skip[0]:
                self.skip[1] -= 1
                if self.skip[1] <= 0:
                    self.skip = None
            return
        if tag in VOID_TAGS or tag not in self.stack:
            return
        while self.stack:
            top = self.stack.pop()
            self.out.append("</%s>" % top)
            if top == tag:
                break

    def handle_data(self, data):
        if not self.skip:
            self.out.append(_esc_text(data))

    def finish(self):
        while self.stack:
            self.out.append("</%s>" % self.stack.pop())
        return "".join(self.out)


def sanitize_html(html):
    """Canonical, whitelist-only HTML; idempotent (Req 38.8)."""
    if not isinstance(html, str):
        raise ValueError("HTML must be text")
    parser = _Sanitizer()
    try:
        parser.feed(html)
        parser.close()
    except (AssertionError, UnicodeError, RecursionError):
        # Never fail open: fall back to the input as plain text.
        return "<p>%s</p>" % _esc_text(html) if html else ""
    return parser.finish()


# --------------------------------------------------------------------------
# Markdown subset
# --------------------------------------------------------------------------
_FENCE = re.compile(r"^ {0,3}(`{3,}|~{3,})[^`]*$")
_HEADING = re.compile(r"^ {0,3}(#{1,6})(?:[ \t]+(.*?))?[ \t]*$")
_HR = re.compile(r"^ {0,3}([-*_])(?:[ \t]*\1){2,}[ \t]*$")
_QUOTE = re.compile(r"^ {0,3}>[ ]?(.*)$")
_LIST = re.compile(r"^( *)([-*+]|\d{1,9}[.)])[ \t]+(.*)$")
_TABLE_SEP = re.compile(r"^ {0,3}\|?[ \t]*:?-+:?[ \t]*(?:\|[ \t]*:?-+:?[ \t]*)*\|?[ \t]*$")
_SPECIAL = re.compile(r"\\|`|!\[|\[|\*|_|~~|[ ]{2,}\n")
_LINK_TAIL = re.compile(
    r"""\(\s*(<[^<>\n]*>|[^\s()]*(?:\([^\s()]*\)[^\s()]*)*)(?:\s+(?:"[^"\n]*"|'[^'\n]*'))?\s*\)""")
_PUNCT = frozenset(string.punctuation)
MAX_QUOTE_DEPTH = 6
MAX_LIST_LEVELS = 3
MAX_INLINE_DEPTH = 6
WINDOW = 1000      # lookahead for link labels / urls
WINDOW_EMPH = 2000  # lookahead for emphasis and code span closers


def _warn(ctx, message):
    if len(ctx) < MAX_WARNINGS and message not in ctx:
        ctx.append(message)


@lru_cache(maxsize=16)
def _code_closer(size):
    return re.compile("(?<!`)`{%d}(?!`)" % size)


def _inline(text, warnings, depth=0):
    if depth >= MAX_INLINE_DEPTH:
        return _esc_text(text)
    out = []
    n = len(text)
    i = 0
    while i < n:
        match = _SPECIAL.search(text, i)
        if match is None:
            out.append(_esc_text(text[i:]))
            break
        j = match.start()
        if j > i:
            out.append(_esc_text(text[i:j]))
        token = match.group()
        i = j
        if token[0] == " ":  # hard line break: two or more spaces before a newline
            out.append("<br>")
            i = match.end()
        elif token == "\\":
            nxt = text[j + 1] if j + 1 < n else ""
            if nxt == "\n":
                out.append("<br>")
                i = j + 2
            elif nxt and nxt in _PUNCT:
                out.append(_esc_text(nxt))
                i = j + 2
            else:
                out.append("\\")
                i = j + 1
        elif token == "`":
            k = 1
            while j + k < n and text[j + k] == "`":
                k += 1
            closer = _code_closer(k).search(text, j + k, min(n, j + k + WINDOW_EMPH))
            if closer is None:
                out.append("`" * k)
                i = j + k
            else:
                code = text[j + k:closer.start()].replace("\n", " ")
                if len(code) > 2 and code[0] == " " and code[-1] == " " and code.strip():
                    code = code[1:-1]
                out.append("<code>%s</code>" % _esc_text(code))
                i = closer.end()
        elif token == "![":
            parsed = _parse_link(text, j + 1)
            if parsed is None:
                out.append("!")
                i = j + 1
            else:
                label, url, end = parsed
                out.append(_image(label, url, warnings, depth))
                i = end
        elif token == "[":
            parsed = _parse_link(text, j)
            if parsed is None:
                out.append("[")
                i = j + 1
            else:
                label, url, end = parsed
                inner = _inline(label, warnings, depth + 1)
                if href_ok(url, _MD_HREF_OK):
                    out.append('<a href="%s">%s</a>' % (_esc_attr(url), inner))
                else:
                    out.append(inner)
                    _warn(warnings, "链接已移除（仅支持 http/https/mailto）: " + url[:80])
                i = end
        else:  # * _ ~~
            rendered = _emphasis(text, j, warnings, depth)
            if rendered is None:
                run = 2 if token == "~~" else 1
                out.append(_esc_text(token[:run]))
                i = j + run
            else:
                html_part, i = rendered
                out.append(html_part)
    return "".join(out)


def _parse_link(text, start):
    """Parse ``[label](url "title")`` starting at ``text[start] == '['``."""
    close = text.find("]", start + 1, start + 1 + WINDOW)
    if close < 0 or close + 1 >= len(text) or text[close + 1] != "(":
        return None
    tail = _LINK_TAIL.match(text, close + 1, min(len(text), close + 1 + WINDOW * 2))
    if tail is None:
        return None
    url = tail.group(1)
    if url.startswith("<") and url.endswith(">"):
        url = url[1:-1]
    return text[start + 1:close], url, tail.end()


def _image(label, url, warnings, depth):
    if FILE_SRC.fullmatch(url):
        return '<img src="%s" alt="%s" loading="lazy">' % (_esc_attr(url), _esc_attr(_clean_alt(label)))
    inner = _esc_text(label) if label else _esc_text(url)
    if href_ok(url, _MD_HREF_OK):
        _warn(warnings, "外部图片已降级为链接: " + url[:80])
        return '<a href="%s">%s</a>' % (_esc_attr(url), inner)
    _warn(warnings, "图片已移除（仅支持 File Hub 内联图片）: " + url[:80])
    return inner


def _emphasis(text, j, warnings, depth):
    """Try ``**x**``, ``__x__``, ``*x*``, ``_x_`` and ``~~x~~`` at ``text[j]``."""
    n = len(text)
    char = text[j]
    if char == "~":
        delim = "~~"
    elif text.startswith(char * 2, j):
        delim = char * 2
    else:
        delim = char
    size = len(delim)
    after = j + size
    if after >= n or text[after].isspace():
        return None
    if char == "_" and j > 0 and text[j - 1].isalnum():
        return None
    limit = min(n, after + WINDOW_EMPH)
    pos = after
    attempts = 0
    while True:
        k = text.find(delim, pos, limit)
        attempts += 1
        if k < 0 or attempts > 16:  # bounded work on pathological input
            return None
        if k == after or text[k - 1].isspace():
            pos = k + 1
            continue
        if size == 1 and (text[k - 1] == char or (k + 1 < n and text[k + 1] == char)):
            pos = k + 1
            continue
        if char == "_" and k + size < n and text[k + size].isalnum():
            pos = k + 1
            continue
        break
    if size == 2 and char != "~":  # closing run longer than the delimiter: use its tail
        run_end = k
        while run_end < n and text[run_end] == char:
            run_end += 1
        k = run_end - size
    inner = _inline(text[after:k], warnings, depth + 1)
    tag = "s" if char == "~" else ("strong" if size == 2 else "em")
    return "<%s>%s</%s>" % (tag, inner, tag), k + size


def _leading_tabs(line):
    stripped = line.lstrip("\t")
    return "    " * (len(line) - len(stripped)) + stripped


def _is_list_item(line):
    match = _LIST.match(line)
    return bool(match) and not _HR.match(line)


def _starts_block(line):
    return bool(_FENCE.match(line) or _HEADING.match(line) or _HR.match(line) or _QUOTE.match(line))


def _interrupts_paragraph(line):
    if _starts_block(line):
        return True
    match = _LIST.match(line)
    if not match:
        return False
    marker = match.group(2)
    return marker in ("-", "*", "+") or marker[:-1] == "1"


class _List:
    __slots__ = ("indent", "ordered", "items")

    def __init__(self, indent, ordered):
        self.indent = indent
        self.ordered = ordered
        self.items = []  # [text, [child _List, ...]]


def _build_lists(entries):
    roots, stack = [], []
    for indent, ordered, text in entries:
        while len(stack) > 1 and indent < stack[-1].indent:
            stack.pop()
        top = stack[-1] if stack else None
        if top is None:
            top = _List(indent, ordered)
            roots.append(top)
            stack = [top]
        elif indent > top.indent and len(stack) < MAX_LIST_LEVELS and top.items:
            child = _List(indent, ordered)
            top.items[-1][1].append(child)
            stack.append(child)
            top = child
        elif top.ordered != ordered and indent <= top.indent:
            stack.pop()
            top = _List(indent, ordered)
            if stack and stack[-1].items:
                stack[-1].items[-1][1].append(top)
            else:
                roots.append(top)
            stack.append(top)
        top.items.append([text, []])
    return roots


def _render_list(lst, warnings):
    tag = "ol" if lst.ordered else "ul"
    parts = ["<%s>" % tag]
    for text, children in lst.items:
        parts.append("<li>%s%s</li>" % (_inline(text.strip(), warnings),
                                         "".join(_render_list(c, warnings) for c in children)))
    parts.append("</%s>" % tag)
    return "".join(parts)


def _collect_list(lines, i):
    entries = []
    n = len(lines)
    while i < n:
        line = lines[i]
        if not line.strip():
            j = i + 1
            while j < n and not lines[j].strip():
                j += 1
            if entries and j < n and (_is_list_item(lines[j]) or lines[j].startswith("  ")) \
                    and not _starts_block(lines[j]):
                i = j
                continue
            break
        if _is_list_item(line):
            match = _LIST.match(line)
            entries.append([len(match.group(1)), not match.group(2)[0] in "-*+", match.group(3)])
            i += 1
            continue
        if _starts_block(line) or not entries:
            break
        entries[-1][2] += "\n" + line.strip()
        i += 1
    return entries, i


def _blocks(lines, warnings, depth=0):
    out = []
    i, n = 0, len(lines)
    while i < n:
        line = lines[i]
        if not line.strip():
            i += 1
            continue
        fence = _FENCE.match(line)
        if fence:
            marker = fence.group(1)
            closer = re.compile("^ {0,3}%s{%d,}[ \\t]*$" % (re.escape(marker[0]), len(marker)))
            buf = []
            i += 1
            while i < n:
                if closer.match(lines[i]):
                    i += 1
                    break
                buf.append(lines[i])
                i += 1
            out.append("<pre><code>%s</code></pre>" % _esc_text("\n".join(buf)))
            continue
        heading = _HEADING.match(line)
        if heading:
            content = re.sub(r"[ \t]+#+[ \t]*$", "", heading.group(2) or "").strip()
            tag = "h2" if len(heading.group(1)) == 1 else "h3"
            if content:
                out.append("<%s>%s</%s>" % (tag, _inline(content, warnings), tag))
            i += 1
            continue
        if _HR.match(line):
            i += 1
            continue
        if _QUOTE.match(line):
            inner = []
            while i < n and _QUOTE.match(lines[i]):
                inner.append(_QUOTE.match(lines[i]).group(1))
                i += 1
            if depth + 1 >= MAX_QUOTE_DEPTH:
                body = "<p>%s</p>" % _inline("\n".join(x.strip() for x in inner).strip(), warnings)
            else:
                body = "".join(_blocks(inner, warnings, depth + 1))
            out.append("<blockquote>%s</blockquote>" % body)
            continue
        if _is_list_item(line):
            entries, i = _collect_list(lines, i)
            out.extend(_render_list(lst, warnings) for lst in _build_lists(entries))
            continue
        if "|" in line and i + 1 < n and _TABLE_SEP.match(lines[i + 1]) and "-" in lines[i + 1]:
            buf = []
            while i < n and lines[i].strip():
                buf.append(lines[i].rstrip())
                i += 1
            out.append("<pre>%s</pre>" % _esc_text("\n".join(buf)))
            continue
        buf = [line.lstrip()]
        i += 1
        while i < n and lines[i].strip() and not _interrupts_paragraph(lines[i]):
            buf.append(lines[i].lstrip())
            i += 1
        out.append("<p>%s</p>" % _inline("\n".join(buf).strip(), warnings))
    return out


def markdown_to_html(md):
    """Convert the supported Markdown subset to controlled HTML.

    Returns ``{"html": str, "warnings": [str]}``. Raises ``ContentError`` with
    code ``markdown_too_large`` above 1 MiB (UTF-8 bytes).
    """
    if not isinstance(md, str):
        raise ContentError("invalid_markdown", "Markdown 必须是文本")
    size = len(md.encode("utf-8", errors="surrogatepass"))
    if size > MAX_MARKDOWN_BYTES:
        raise ContentError("markdown_too_large", "Markdown 超过 1 MiB 上限",
                           {"bytes": size, "maxBytes": MAX_MARKDOWN_BYTES})
    text = md.replace("\x00", "\ufffd").replace("\r\n", "\n").replace("\r", "\n")
    lines = [_leading_tabs(line) for line in text.split("\n")]
    warnings = []
    raw = "".join(_blocks(lines, warnings))
    return {"html": sanitize_html(raw), "warnings": warnings}


def render_summary(text):
    """Summary_Block value: ``{"text", "html"}``; ``html`` is always server-rendered.

    0 characters (or whitespace only) clears the summary; more than 5000
    characters raises ``ContentError('summary_too_long')``.
    """
    if not isinstance(text, str):
        raise ContentError("invalid_summary", "摘要必须是文本", {"field": "text"})
    if len(text) > MAX_SUMMARY:
        raise ContentError("summary_too_long", "摘要不能超过 %d 个字符" % MAX_SUMMARY,
                           {"field": "text", "length": len(text), "maxLength": MAX_SUMMARY})
    if not text.strip():
        return {"text": "", "html": ""}
    return {"text": text, "html": markdown_to_html(text)["html"]}
