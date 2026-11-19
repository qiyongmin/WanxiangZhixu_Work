"""Safe rich Working Notes schema and canonical, task-linked clipboard images."""
from __future__ import annotations
import contextlib
import contextvars
import re
import uuid
from html.parser import HTMLParser

MAX_NOTES = 64            # Legacy ceiling (pinned by the Phase 0 characterization tests)
MAX_IMAGE = 8 * 1024 * 1024
MAX_HTML = 110_000        # Legacy per-note limit
V2_MAX_NOTES = 50         # v2 notes-save / Agent limit (Req 19.2)
V2_MAX_TITLE = 200
V2_MAX_HTML = 1024 * 1024
MAX_TOTAL_HTML = 6 * 1024 * 1024   # design assumption A4
_RELAXED = contextvars.ContextVar("work_notes_relaxed", default=False)
FILE_SRC = re.compile(r"/api/file-hub/file\?id=file_[0-9a-f]{32}&mode=inline\Z")
NOTE_ID = re.compile(r"note_[a-z0-9]{8,48}\Z")
ALLOWED_TAGS = {"p","div","br","strong","b","em","i","u","s","ul","ol","li",
                "blockquote","h2","h3","pre","code","a","img","span",
                "table","tbody","thead","tr","td","th"}
VOID_TAGS = {"br","img"}
# User-selectable text colors are semantic class tokens only. Never accept CSS,
# arbitrary class names, inline styles or browser-generated <font> elements.
NOTE_COLOR_CLASSES = frozenset({"note-color-default", "note-color-blue", "note-color-green",
                                "note-color-red", "note-color-amber", "note-color-purple"})
TABLE_BACKGROUNDS = frozenset({"blue", "green", "amber", "rose", "purple", "slate"})
TABLE_BORDER_SIDES = ("top", "right", "bottom", "left")
TABLE_BORDER_ATTRS = frozenset("data-kbw-border-" + side for side in TABLE_BORDER_SIDES)
TABLE_BORDER_TOKEN = re.compile(r"(?:solid|dashed|dotted|double):[123]:(?:default|accent|red|green|amber|purple)|none\Z")
_TREE_KINDS = ("initiative","knowledge_collection","topic","workstream","campaign","task","action")


class _SafeNotesParser(HTMLParser):
    """Reject executable elements, attributes and image URLs at the API boundary."""

    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.depth = 0

    def handle_starttag(self, tag, attrs):
        if tag not in ALLOWED_TAGS:
            raise ValueError("Working Note contains unsupported HTML element")
        if tag not in VOID_TAGS:self.depth += 1
        if self.depth > 120:
            raise ValueError("Working Note nesting too deep")
        valid = {"a": {"href","target","rel"}, "img": {"src","alt","loading"},
                 "span": {"class"}, "td": {"colspan","rowspan","data-kbw-bg","width","colwidth"} | TABLE_BORDER_ATTRS,
                 "th": {"colspan","rowspan","data-kbw-bg","width","colwidth"} | TABLE_BORDER_ATTRS,
                 "tr": {"height","data-kbw-row-height"}}.get(tag, set())
        if len(attrs) > (12 if tag in ("td","th") else 8) or any(key not in valid for key, value in attrs):
            raise ValueError("Working Note contains unsafe HTML attributes")
        attrs = dict(attrs)
        if tag == 'span' and 'class' in attrs and attrs['class'] not in NOTE_COLOR_CLASSES:
            raise ValueError('Working Note text color must use an allowed color token')
        if tag in ('td','th'):
            for name in TABLE_BORDER_ATTRS:
                if name in attrs and not (isinstance(attrs[name], str) and TABLE_BORDER_TOKEN.fullmatch(attrs[name])):
                    raise ValueError("Unsupported table border")
            if 'data-kbw-bg' in attrs and attrs['data-kbw-bg'] not in TABLE_BACKGROUNDS:
                raise ValueError('Unsupported table background')
            for span in ('rowspan','colspan'):
                if span in attrs and (not isinstance(attrs[span], str) or
                    not attrs[span].isdigit() or not 1 <= int(attrs[span]) <= 16):
                    raise ValueError('Invalid table span')
        if tag == "tr":
            for key in ("height","data-kbw-row-height"):
                if key in attrs and (not re.fullmatch(r"[0-9]{2,3}", attrs[key] or "")
                    or not 28 <= int(attrs[key]) <= 800):
                    raise ValueError("Invalid table row height")
            if all(key in attrs for key in ("height","data-kbw-row-height")) and attrs["height"] != attrs["data-kbw-row-height"]:
                raise ValueError("Inconsistent table row height")
        if tag in ("td","th"):
            if "width" in attrs and (not re.fullmatch(r"[0-9]{2,5}", attrs["width"] or "")
                or not 40 <= int(attrs["width"]) <= 38400):
                raise ValueError("Invalid table cell width")
            if "colwidth" in attrs:
                values = attrs["colwidth"].split(",")
                if len(values)>16 or any(not re.fullmatch(r"[0-9]{2,4}",item)
                    or not 40 <= int(item) <= 2400 for item in values):
                    raise ValueError("Invalid table column width")
                if "width" in attrs and int(attrs["width"]) != sum(int(item) for item in values):
                    raise ValueError("Inconsistent table cell width")
        if tag == "a":
            href = attrs.get("href","")
            if not (re.fullmatch(r"https?://[^\s<>\x00-\x1f]+", href, re.I)
                    or re.fullmatch(r"mailto:[^\s<>\x00-\x1f]+", href, re.I)
                    or re.fullmatch(r"#/[-\w/%?.=&]+", href)
                    or re.fullmatch(r"/app/n/[-\w/%?.=&]+", href)):
                raise ValueError("Working Note link must be HTTP(S), mailto or an internal route")
            if attrs.get("target") not in (None, "_blank"):
                raise ValueError("Invalid link target")
            if attrs.get("rel") not in (None, "noopener noreferrer"):
                raise ValueError("Invalid link relation")
        if tag == "img":
            if not FILE_SRC.fullmatch(attrs.get("src","")):
                raise ValueError("Working Note images must reference canonical File Hub IDs")
            if len(attrs.get("alt","")) > 160 or attrs.get("loading") not in (None,"lazy"):
                raise ValueError("Invalid image attributes")

    def handle_startendtag(self, tag, attrs):
        self.handle_starttag(tag, attrs)
        self.handle_endtag(tag)

    def handle_endtag(self, tag):
        if tag not in ALLOWED_TAGS:
            raise ValueError("Working Note contains unsupported closing tag")
        if tag not in VOID_TAGS:self.depth = max(0, self.depth - 1)

    def handle_decl(self, decl):
        raise ValueError("HTML declarations are not permitted in Notes")

    def handle_pi(self, data):
        raise ValueError("HTML processing instructions are not permitted in Notes")

    def unknown_decl(self, data):
        raise ValueError("Unsafe HTML declaration")


@contextlib.contextmanager
def relaxed():
    """v2 limits (design 4.9) for the enclosed saves; the Legacy ``save`` never enters this."""
    token = _RELAXED.set(True)
    try:
        yield
    finally:
        _RELAXED.reset(token)


def validate_entries(data, kind):
    if "noteEntries" not in data:
        return
    wide = _RELAXED.get()
    # Focus Navigator saves Notes on Workstream/Campaign as well as Tasks.
    # Legacy save validation must recognize those already-supported records;
    # otherwise a harmless Workstream no-op save rejects an existing Note.
    if not wide and kind not in ("task", "action", "workstream", "campaign"):
        raise ValueError("Rich Working Notes are only for Tasks and Workstreams")
    entries = data["noteEntries"]
    if not isinstance(entries, list) or len(entries) > MAX_NOTES:
        raise ValueError("Invalid Working Notes list")
    if wide:
        total = sum(len(e["html"].encode("utf-8")) for e in entries
                    if isinstance(e, dict) and isinstance(e.get("html"), str))
        if total > MAX_TOTAL_HTML:
            raise ValueError("Working Notes exceed the 6 MiB total limit")
    max_title, max_html = (V2_MAX_TITLE, V2_MAX_HTML) if wide else (120, MAX_HTML)
    seen = set()
    for entry in entries:
        if not isinstance(entry, dict) or set(entry) != {"id","title","html"}:
            raise ValueError("Invalid Working Note structure")
        note_id, title, html = entry["id"], entry["title"], entry["html"]
        if not isinstance(note_id, str) or not NOTE_ID.fullmatch(note_id) or note_id in seen:
            raise ValueError("Duplicate or invalid Working Note ID")
        seen.add(note_id)
        if not isinstance(title, str) or not 1 <= len(title.strip()) <= max_title:
            raise ValueError("Invalid Working Note title")
        if not isinstance(html, str) or len(html.encode("utf-8")) > max_html:
            raise ValueError("Working Note HTML exceeds limit")
        try:
            parser = _SafeNotesParser()
            parser.feed(html)
            parser.close()
        except (AssertionError, UnicodeError) as exc:
            raise ValueError("Invalid Working Note HTML") from exc


def upload_image(work_id, image_bytes, mime):
    """One canonical File Hub file, with stable note-image provenance for Task."""
    import file_hub
    import work_hub_store
    if not isinstance(image_bytes, bytes) or not 0 < len(image_bytes) <= MAX_IMAGE:
        raise ValueError("Clipboard image exceeds 8 MB limit")
    signatures = {
        "image/png": (".png", image_bytes.startswith(b"\x89PNG\r\n\x1a\n")),
        "image/jpeg": (".jpg", image_bytes.startswith(b"\xff\xd8\xff")),
        "image/webp": (".webp", image_bytes[:4] == b"RIFF" and image_bytes[8:12] == b"WEBP"),
        "image/gif": (".gif", image_bytes[:6] in (b"GIF87a",b"GIF89a"))
    }
    ext, valid = signatures.get(mime,(None,False))
    if not valid:
        raise ValueError("Only valid PNG/JPEG/WebP/GIF image data may be pasted")
    work = work_hub_store.get_record(work_id)
    if work["kind"] not in _TREE_KINDS or work["deleted_at"] or work["archived_at"]:
        raise ValueError("Only active Work Hub items may receive Working Notes images")
    # Canonical Note attachments stay separate from older Materials storage.
    for folder in ("Projects/WorkHub","Projects/WorkHub/Notes"):
        try:file_hub.folder_create(folder)
        except file_hub.Conflict as exc:
            if str(exc)!="Folder exists":raise
    result = file_hub.upload("Projects/WorkHub/Notes",
                             "task-note-" + uuid.uuid4().hex + ext,image_bytes)
    file_id = result["id"]
    file_hub.link(file_id,work["kind"],work_id,relation="note-image")
    return {"fileId":file_id,"mime":mime,"size":len(image_bytes),
            "url":"/api/file-hub/file?id="+file_id+"&mode=inline"}
