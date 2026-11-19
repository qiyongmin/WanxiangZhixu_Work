"""Notes V3.5 · additive structured Page document and local knowledge substrate.

No writes on GET; migration is explicit and idempotent. Work SQLite owns Page
revisions; File Hub stays canonical for file bytes. No cross-project discovery
without a separately established server authorization model.
"""
from __future__ import annotations

import hashlib
import html
import json
import re
import sqlite3
import uuid
from html.parser import HTMLParser
from datetime import datetime, timezone

import work_notebook as nb
import work_hub_nodes as nodes
import work_hub_html

STATUS = "notebook_v35_ready"
MAX_JSON = 2 * 1024 * 1024
FILE_ID = re.compile(r"file_[0-9a-f]{32}\Z")
BLOCK_ID = re.compile(r"blk_[a-zA-Z0-9_-]{8,64}\Z")
IMAGE_SRC = re.compile(r"/api/file-hub/file\?id=(file_[0-9a-f]{32})&mode=inline\Z")
ALLOWED = {
    "doc", "paragraph", "text", "heading", "blockquote", "codeBlock",
    "bulletList", "orderedList", "listItem", "taskList", "taskItem",
    "horizontalRule", "hardBreak", "table", "tableRow", "tableCell",
    "tableHeader", "image", "fileAttachment",
}
MARKS = {"bold", "italic", "underline", "strike", "code", "highlight", "link", "textStyle", "noteColor"}
DDL = (
    """CREATE TABLE IF NOT EXISTS work_note_v35_docs (
      page_id TEXT PRIMARY KEY REFERENCES work_note_pages(id),
      schema_version INTEGER NOT NULL, json_text TEXT NOT NULL,
      source_revision INTEGER NOT NULL, markdown_text TEXT NOT NULL,
      html_text TEXT NOT NULL, content_sha256 TEXT NOT NULL, modified_at TEXT NOT NULL)""",
    """CREATE TABLE IF NOT EXISTS work_note_v35_history (
      page_id TEXT NOT NULL REFERENCES work_note_pages(id),
      revision INTEGER NOT NULL, json_text TEXT NOT NULL,
      markdown_text TEXT NOT NULL, html_text TEXT NOT NULL,
      PRIMARY KEY(page_id, revision))""",
    """CREATE TABLE IF NOT EXISTS work_note_v35_refs (
      page_id TEXT NOT NULL REFERENCES work_note_pages(id),
      ref_id TEXT NOT NULL, file_id TEXT NOT NULL,
      kind TEXT NOT NULL, policy TEXT NOT NULL,
      pinned_revision INTEGER, state TEXT NOT NULL DEFAULT 'pending',
      PRIMARY KEY(page_id, ref_id))""",
    """CREATE TABLE IF NOT EXISTS work_note_v35_staging (
      operation_id TEXT PRIMARY KEY, page_id TEXT NOT NULL REFERENCES work_note_pages(id),
      file_id TEXT NOT NULL, status TEXT NOT NULL, created_at TEXT NOT NULL)""",
    """CREATE TABLE IF NOT EXISTS work_note_v35_file_outbox (
      operation_id TEXT PRIMARY KEY,
      page_id TEXT NOT NULL REFERENCES work_note_pages(id),
      file_id TEXT NOT NULL, operation TEXT NOT NULL, state TEXT NOT NULL DEFAULT 'pending',
      attempts INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL)""",
    """CREATE TABLE IF NOT EXISTS work_note_v35_index_state (
      page_id TEXT PRIMARY KEY REFERENCES work_note_pages(id),
      revision INTEGER NOT NULL, status TEXT NOT NULL,
      content_sha256 TEXT NOT NULL, updated_at TEXT NOT NULL)""",
    """CREATE TABLE IF NOT EXISTS work_note_v35_index_outbox (
      page_id TEXT PRIMARY KEY REFERENCES work_note_pages(id),
      revision INTEGER NOT NULL, status TEXT NOT NULL, updated_at TEXT NOT NULL)""",
    """CREATE INDEX IF NOT EXISTS work_note_v35_refs_file
        ON work_note_v35_refs(file_id)""",
    """CREATE VIRTUAL TABLE IF NOT EXISTS work_note_v35_fts
        USING fts5(page_id UNINDEXED, block_id UNINDEXED, text)""",
)


def _error(message, code="notebook_v35_invalid", status=400):
    nb._err(message, code, status)


def ready(con):
    return con.execute("SELECT 1 FROM work_meta WHERE key=?", (STATUS,)).fetchone() is not None


def migrate(path=None):
    """Explicit additive schema migration; caller must verify a standalone backup."""
    with nodes._writer(path) as con:
        nb._require(con)
        import work_notebook_v34 as v34
        if not v34.ready(con):
            _error("Notes V3.4 must be migrated first", "notebook_v34_migration_required", 409)
        if ready(con):
            return {"ready": True, "changed": False}
        for sql in DDL:
            con.execute(sql)
        con.execute("INSERT INTO work_meta(key,value,updated_at) VALUES(?,?,?)",
                    (STATUS, "1", nb._stamp()))
        return {"ready": True, "changed": True}


def _utf(value, maximum=5000):
    if not isinstance(value, str) or len(value) > maximum or any(
            ord(c) in (0, 0x7f) for c in value):
        _error("Invalid document text")
    return value


def _attrs(value):
    if value is None:
        return {}
    if not isinstance(value, dict) or len(value) > 15:
        _error("Invalid document attributes")
    return value


def _validate_json(raw):
    """Fail closed on unknown document nodes, attrs, marks and duplicate block IDs."""
    if not isinstance(raw, dict):
        _error("Page document must be JSON object")
    encoded = json.dumps(raw, ensure_ascii=False, separators=(",", ":"), sort_keys=True)
    if len(encoded.encode("utf-8")) > MAX_JSON:
        _error("Structured document exceeds 2 MiB", "notebook_v35_too_large", 413)
    block_ids = set()
    attachments = []
    count = 0

    def walk(node, depth=0):
        nonlocal count
        count += 1
        if depth > 40 or count > 10000 or not isinstance(node, dict):
            _error("Document complexity limit exceeded")
        kind = node.get("type")
        if kind not in ALLOWED or not isinstance(kind, str):
            _error("Unsupported document node: " + str(kind))
        att = _attrs(node.get("attrs"))
        children = node.get("content", [])
        if not isinstance(children, list):
            _error("Document content must be an array")
        if kind == "text":
            _utf(node.get("text"), 100_000)
            if children or set(node) - {"type", "text", "marks"}:
                _error("Invalid text node")
        elif set(node) - {"type", "attrs", "content", "marks"}:
            _error("Unknown document node fields")
        if kind == "doc" and depth != 0:
            _error("Nested document root not allowed")
        if depth == 0 and kind != "doc":
            _error("Document root must be doc")
        if kind == "heading":
            level = att.get("level")
            if type(level) is not int or not 1 <= level <= 5:
                _error("Heading level must be 1–5")
            block_id = att.get("blockId")
            if block_id is not None:
                if not isinstance(block_id, str) or not BLOCK_ID.fullmatch(block_id) or block_id in block_ids:
                    _error("Invalid or duplicate block ID")
                block_ids.add(block_id)
        if kind == "image":
            src = att.get("src")
            found=IMAGE_SRC.fullmatch(src) if isinstance(src,str) else None
            if not found:
                _error("Images must use canonical File Hub URLs")
            ref_id=att.get("refId")
            if not isinstance(ref_id,str) or not re.fullmatch(r"ref_[a-zA-Z0-9_-]{8,64}",ref_id):
                _error("Images must have a stable File Hub reference ID")
            attachments.append((ref_id,found.group(1),"image","latest",None))
            for key in ("alt", "title", "caption"):
                if att.get(key) is not None: _utf(att[key], 300)
            if att.get("align") not in (None,"left","center","right"):
                _error("Unsupported image alignment")
            if att.get("width") is not None:
                try: width=int(att["width"])
                except (TypeError,ValueError): _error("Invalid image width")
                if not 40<=width<=2400: _error("Image width out of bounds")
        if kind == "fileAttachment":
            fid = att.get("fileId")
            ref = att.get("refId")
            policy = att.get("policy", "latest")
            pin = att.get("pinnedRevision")
            if (not isinstance(fid, str) or not FILE_ID.fullmatch(fid) or
                not isinstance(ref, str) or not re.fullmatch(r"ref_[a-zA-Z0-9_-]{8,64}", ref) or
                policy not in ("latest", "pinned") or
                (policy == "pinned" and (type(pin) is not int or pin < 1))):
                _error("Invalid File Hub attachment reference")
            name = _utf(att.get("name", ""), 180)
            if not name:
                _error("Attachment needs a display name")
            if att.get("kind", "file") not in ("file", "email"):
                _error("Invalid attachment kind")
            attachments.append((ref, fid, att.get("kind", "file"), policy,
                                pin if policy == "pinned" else None))
        if kind == "tableRow" and att.get("height") is not None:
            height = att["height"]
            if type(height) is not int or not 28 <= height <= 800:
                _error("Invalid table row height")
        if kind == "codeBlock" and att.get("language") is not None:
            if not isinstance(att["language"],str) or not re.fullmatch(r"[a-zA-Z0-9_+.-]{1,30}",att["language"]):
                _error("Unsupported code language")
        if kind == "taskItem" and type(att.get("checked", False)) is not bool:
            _error("Invalid task state")
        if kind in ("tableCell", "tableHeader"):
            for key in ("colspan", "rowspan"):
                val = att.get(key, 1)
                if type(val) is not int or not 1 <= val <= 16:
                    _error("Invalid table cell span")
            if att.get("background") not in (None,"blue","green","amber","rose","purple","slate"):
                _error("Unsupported table background color")
            if att.get("align") not in (None,"left","center","right"):
                _error("Unsupported table cell alignment")
            for side in ("Top","Right","Bottom","Left"):
                token = att.get("border"+side)
                if token is not None and (not isinstance(token,str) or
                    not re.fullmatch(r"(?:solid|dashed|dotted|double):[123]:(?:default|accent|red|green|amber|purple)|none",token)):
                    _error("Unsupported table border style")
            widths = att.get("colwidth")
            if widths is not None and (not isinstance(widths,list) or
                len(widths) > 16 or any(type(w) is not int or not 40 <= w <= 2400 for w in widths)):
                _error("Invalid table column widths")
        if kind in ("paragraph", "blockquote", "codeBlock", "bulletList", "orderedList",
                    "listItem", "taskList", "taskItem", "table", "tableRow", "tableCell",
                    "tableHeader", "horizontalRule", "hardBreak", "doc", "heading", "image",
                    "fileAttachment"):
            # Reject executable and arbitrary styling attributes; only known structural keys.
            allowed_attrs = {
                "doc": set(), "heading": {"level", "blockId"},
                "codeBlock": {"language"},
                "image": {"src", "alt", "title", "caption", "width", "align", "height", "refId"},
                "fileAttachment": {"fileId", "refId", "name", "kind", "policy", "pinnedRevision", "mime"},
                "taskItem": {"checked"}, "orderedList": {"start", "type"},
                "bulletList": {"type"}, "listItem": set(), "taskList": set(),
                "table": {"colwidth"}, "tableRow": {"height"},
                "tableCell": {"colspan", "rowspan", "colwidth", "align", "background", "borderTop", "borderRight", "borderBottom", "borderLeft"},
                "tableHeader": {"colspan", "rowspan", "colwidth", "align", "background", "borderTop", "borderRight", "borderBottom", "borderLeft"},
            }.get(kind, set())
            if set(att) - allowed_attrs:
                _error("Unsupported attributes on " + kind)
        if kind in ("image", "fileAttachment", "horizontalRule", "hardBreak") and children:
            _error("Atomic document node cannot contain children")
        marks = node.get("marks", [])
        if not isinstance(marks, list):
            _error("Invalid document text marks")
        for mark in marks:
            if not isinstance(mark, dict) or mark.get("type") not in MARKS:
                _error("Unsupported text mark")
            mtype = mark["type"]
            mattr = _attrs(mark.get("attrs"))
            if mtype == "link":
                href = mattr.get("href")
                if not work_hub_html.href_ok(href):
                    _error("Unsupported link URL")
                # Tiptap Link 3.x serializes `title: null` even for a plain
                # hyperlink. Match its supported attributes without allowing
                # arbitrary HTML/event-handler attributes through the JSON API.
                if set(mattr) - {"href", "target", "rel", "class", "title"}:
                    _error("Unsupported link attributes")
                if mattr.get("title") is not None:
                    _utf(mattr["title"], 300)
            elif mtype == "highlight":
                if set(mattr) - {"color"} or (mattr.get("color") is not None and mattr["color"] not in
                    ("#fff3aa", "#e0f2fe", "#dcfce7", "#fee2e2")):
                    _error("Unsupported highlight color")
            elif mtype == "noteColor":
                if set(mattr)!={"token"} or mattr["token"] not in (
                    "note-color-blue","note-color-green","note-color-red",
                    "note-color-amber","note-color-purple"):
                    _error("Unsupported semantic text color")
            elif mtype == "textStyle":
                if set(mattr) - {"color"} or (mattr.get("color") is not None and mattr["color"] not in
                    ("#2563eb","#16a34a","#dc2626","#d97706","#7c3aed")):
                    _error("Unsupported text color")
            elif mattr:
                _error("Unsupported mark attributes")
        for child in children:
            walk(child, depth + 1)
    walk(raw)
    if len({r[0] for r in attachments}) != len(attachments):
        _error("Duplicate attachment reference ID")
    return encoded, attachments


def _plain(node):
    if node.get("type") == "text":
        return node.get("text", "")
    return "".join(_plain(child) for child in node.get("content", []))


def _render(node):
    """Safe HTML from validated JSON using existing historical whitelist only."""
    kind = node["type"]
    attrs = node.get("attrs") or {}
    contents = "".join(_render(child) for child in node.get("content", []))
    if kind == "text":
        result = html.escape(node["text"], quote=False)
        for mark in node.get("marks", []):
            name = mark["type"]
            tag = {"bold":"strong", "italic":"em", "underline":"u",
                   "strike":"s", "code":"code", "highlight":"strong"}.get(name)
            if tag:
                result = f"<{tag}>{result}</{tag}>"
            elif name == "link":
                href = html.escape(mark["attrs"]["href"], quote=True)
                result = f'<a href="{href}" target="_blank" rel="noopener noreferrer">{result}</a>'
            elif name == "noteColor":
                token=(mark.get("attrs") or {}).get("token")
                if token in ("note-color-blue","note-color-green","note-color-red",
                             "note-color-amber","note-color-purple"):
                    result=f'<span class="{token}">{result}</span>'
            elif name == "textStyle":
                color=(mark.get("attrs") or {}).get("color")
                tokens={"#2563eb":"note-color-blue","#16a34a":"note-color-green",
                        "#dc2626":"note-color-red","#d97706":"note-color-amber",
                        "#7c3aed":"note-color-purple"}
                if color in tokens:result=f'<span class="{tokens[color]}">{result}</span>'
        return result
    if kind == "doc":
        return contents
    if kind == "paragraph":
        return f"<p>{contents}</p>"
    if kind == "heading":
        tag = "h2" if attrs["level"] <= 2 else "h3"
        return f"<{tag}>{contents}</{tag}>"
    if kind in ("bulletList", "taskList"):
        return f"<ul>{contents}</ul>"
    if kind == "orderedList":
        return f"<ol>{contents}</ol>"
    if kind in ("listItem", "taskItem"):
        box = ("☑ " if attrs.get("checked") else "☐ ") if kind == "taskItem" else ""
        return f"<li>{html.escape(box)}{contents}</li>"
    if kind == "blockquote":
        return f"<blockquote>{contents}</blockquote>"
    if kind == "codeBlock":
        return "<pre><code>" + html.escape(_plain(node)) + "</code></pre>"
    if kind == "hardBreak":
        return "<br>"
    if kind == "horizontalRule":
        return "<p>────────</p>"
    if kind == "image":
        src = html.escape(attrs["src"], quote=True)
        alt = html.escape(str(attrs.get("alt", ""))[:160], quote=True)
        return f'<p><img src="{src}" alt="{alt}" loading="lazy"></p>'
    if kind == "fileAttachment":
        label = "Email" if attrs.get("kind") == "email" else "Attachment"
        return "<p><strong>" + label + ": " + html.escape(attrs["name"]) + "</strong></p>"
    if kind == "table":
        return "<table><tbody>" + contents + "</tbody></table>"
    if kind == "tableRow":
        height = attrs.get("height")
        attributes = f' height="{height}" data-kbw-row-height="{height}"' if height else ""
        return f"<tr{attributes}>" + contents + "</tr>"
    if kind in ("tableCell", "tableHeader"):
        tag = "th" if kind == "tableHeader" else "td"
        attributes = ""
        for key in ("colspan", "rowspan"):
            if attrs.get(key, 1) != 1:
                attributes += f' {key}="{attrs[key]}"'
        widths = attrs.get("colwidth")
        if widths:
            attributes += f' width="{sum(widths)}" colwidth="{",".join(str(w) for w in widths)}"'
        if attrs.get("background"):
            attributes += f' data-kbw-bg="{attrs["background"]}"'
        for side in ("Top","Right","Bottom","Left"):
            token = attrs.get("border"+side)
            if token is not None:
                attributes += f' data-kbw-border-{side.lower()}="{token}"'
        return f"<{tag}{attributes}>" + contents + f"</{tag}>"
    _error("Unsupported render node")


def _markdown(node):
    lines = []
    blocks = []
    current = None

    def emit(n, indent=0):
        nonlocal current
        kind = n["type"]
        att = n.get("attrs") or {}
        if kind == "text":
            out = n.get("text", "")
            for mark in n.get("marks", []):
                t = mark["type"]
                if t == "bold": out = "**" + out + "**"
                elif t == "italic": out = "*" + out + "*"
                elif t == "strike": out = "~~" + out + "~~"
                elif t == "code": out = "`" + out + "`"
                elif t == "link": out = "[" + out + "](" + mark["attrs"]["href"] + ")"
            return out
        children = n.get("content", [])
        if kind == "doc":
            for child in children: emit(child)
            return ""
        inline = "".join(emit(x, indent) or "" for x in children) if kind in (
            "heading", "paragraph", "listItem", "taskItem", "blockquote", "codeBlock",
            "tableCell", "tableHeader") else ""
        if kind == "heading":
            block = att.get("blockId") or ""
            current = block or current
            lines.append("#" * att["level"] + " " + inline)
            if block: blocks.append({"blockId": block, "text": inline})
        elif kind == "paragraph":
            lines.append(" " * indent + inline)
            if current and inline:
                for b in blocks:
                    if b["blockId"] == current:
                        b["text"] += "\n" + inline
                        break
        elif kind in ("bulletList", "orderedList", "taskList"):
            ordered = kind == "orderedList"
            for i, child in enumerate(children):
                prefix = (f"{i+1}. " if ordered else "- ")
                if kind == "taskList":
                    prefix = "- [x] " if (child.get("attrs") or {}).get("checked") else "- [ ] "
                lines.append(" " * indent + prefix + _plain(child))
        elif kind == "blockquote":
            lines.append("> " + inline)
        elif kind == "codeBlock":
            lines.extend(["```", _plain(n), "```"])
        elif kind == "horizontalRule":
            lines.append("---")
        elif kind == "hardBreak":
            return "\n"
        elif kind == "image":
            lines.append("![%s](%s)" % (att.get("alt",""),att["src"]))
        elif kind == "fileAttachment":
            lines.append("- [%s] attachment:%s  (%s%s)" % (
                att["name"], att["fileId"], att.get("kind","file"),
                ", revision " + str(att.get("pinnedRevision")) if att.get("policy")=="pinned" else ", latest"))
        elif kind == "table":
            for row in children:
                cells = [_plain(cell) for cell in row.get("content", [])]
                lines.append("| " + " | ".join(cells) + " |")
        return ""
    emit(node)
    return "\n\n".join(lines), blocks


def _legacy_markdown(raw, title=""):
    """Read-only AI projection for historical HTML, preserving the original bytes.

    Does not turn HTML into an editable JSON document; source remains authoritative.
    """
    class Reader(HTMLParser):
        def __init__(self):
            super().__init__(convert_charrefs=True)
            self.parts=[];self.link_stack=[]
        def handle_starttag(self,tag,attrs):
            values=dict(attrs)
            if tag in ('div','p','blockquote','ul','ol'):
                self.parts.append("\n")
            elif tag=='h2':self.parts.append("\n## ")
            elif tag=='h3':self.parts.append("\n### ")
            elif tag=='li':self.parts.append("\n- ")
            elif tag=='br':self.parts.append("\n")
            elif tag=='img':
                src=values.get('src','')
                if IMAGE_SRC.fullmatch(src):
                    self.parts.append("\n[Image: "+values.get('alt','')[:160]+"] ")
            elif tag=='a':self.link_stack.append(values.get('href',''))
        def handle_endtag(self,tag):
            if tag in ('div','p','blockquote','h2','h3','ul','ol','li'):
                self.parts.append("\n")
            elif tag=='a' and self.link_stack:
                href=self.link_stack.pop()
                if work_hub_html.href_ok(href):
                    self.parts.append(" ("+href+")")
        def handle_data(self,data):self.parts.append(data)
    parser=Reader()
    try:parser.feed(raw);parser.close()
    except (ValueError,UnicodeError):return "# "+title+"\n\n[Legacy HTML could not be parsed]"
    content="".join(parser.parts)
    content=re.sub(r"\n[ \t]*\n[ \t]*\n+", "\n\n", content).strip()
    return ("# "+title+"\n\n" if title else "")+content


def _doc_row(con, pid):
    return con.execute("SELECT * FROM work_note_v35_docs WHERE page_id=?", (pid,)).fetchone() if ready(con) else None


def page_document(params, path=None):
    with nodes._reader(path) as con:
        nb._require(con)
        owner = params.get("id")
        nb._node(con, owner)
        pg = nb._page(con, params.get("page") or "")
        if pg["owner_id"] != owner: _error("Wrong notebook", "notebook_owner_mismatch", 403)
        d = _doc_row(con, pg["id"])
        if not d:
            return {"pageId":pg["id"],"pageRevision":pg["revision"],
                    "format":"legacy-html","html":pg["html"],
                    "markdown":_legacy_markdown(pg["html"],pg["title"]),
                    "contentSha256":hashlib.sha256(pg["html"].encode()).hexdigest()}
        return {"pageId":pg["id"],"pageRevision":pg["revision"],"format":"json",
                "schemaVersion":d["schema_version"],"json":json.loads(d["json_text"]),
                "markdown":d["markdown_text"],"html":d["html_text"],
                "contentSha256":d["content_sha256"],"sourceRevision":d["source_revision"]}


def _same_scope(con, pg, fid):
    """Require staged Page upload or existing same-root File Hub association.

    This is a Work-level scope guard, NOT a substitute for future corporate SSO.
    """
    import file_hub
    data = file_hub.details(fid)
    if data["deleted"]:
        _error("Attachment is in File Hub trash", "notebook_file_missing", 409)
    if con.execute("SELECT 1 FROM work_note_v35_staging WHERE page_id=? AND file_id=?",
                   (pg["id"],fid)).fetchone():return data
    _,root=nb._node(con,pg["owner_id"])
    for link in data.get("links",[]):
        target=link.get("target_id")
        if link.get("target_type")=="note-page":
            try:
                linked=nb._page(con,target,active=False)
                if nb._node(con,linked["owner_id"])[1]==root:return data
            except (nodes.NodeError,KeyError):continue
        elif link.get("target_type") in ("initiative","knowledge_collection","topic",
                "workstream","campaign","task","action"):
            try:
                if nb._node(con,target)[1]==root:return data
            except (nodes.NodeError,KeyError):continue
    _error("File Hub item is not linked to this Project; upload or link an authorized file",
           "notebook_v35_file_scope",403)


def _legacy_signature(source):
    """Conservative source preservation check before first JSON conversion."""
    class Inspect(HTMLParser):
        def __init__(self):
            super().__init__(convert_charrefs=True)
            self.text=[];self.images=[];self.links=[];self.colors=[]
        def handle_starttag(self,tag,attrs):
            a=dict(attrs)
            if tag=='img':self.images.append(a.get('src',''))
            if tag=='a':self.links.append(a.get('href',''))
            if tag=='span' and str(a.get('class','')).startswith('note-color-'):
                self.colors.append(a['class'])
        def handle_data(self,value):self.text.append(value)
    result=Inspect();result.feed(source);result.close()
    normalized=re.sub(r'\s+','', ''.join(result.text))
    return normalized,result.images,result.links,result.colors


def document_save(body, path=None):
    doc = body.get("json")
    encoded, refs = _validate_json(doc)
    html_text = _render(doc)
    markdown, blocks = _markdown(doc)
    if len(html_text.encode("utf-8")) > nb.MAX_PAGE_HTML:
        _error("HTML projection exceeds existing 1 MiB limit", "notebook_v35_too_large", 413)
    nb._validate_html(html_text)
    page_id = body.get("pageId")
    revision = body.get("baseRevision")
    title = nb._validate_title(body.get("title"))
    if type(revision) is not int: _error("Expected Page revision", "revision_conflict", 409)
    content_hash = hashlib.sha256(encoded.encode()).hexdigest()
    with nodes._writer(path) as con:
        if not ready(con): _error("Notes V3.5 migration required", "notebook_v35_migration_required", 409)
        pg = nb._page(con, page_id)
        nb._node(con, pg["owner_id"])
        if pg["revision"] != revision:
            _error("Page Revision conflict", "revision_conflict", 409)
        section = con.execute("SELECT archived_at FROM work_note_sections WHERE id=?", (pg["section_id"],)).fetchone()
        if not section or section["archived_at"]:
            _error("Cannot edit an archived Section", "notebook_section_archived", 409)
        # Canonical files are not copied; File Hub existence + pinned revision validated before commit.
        for ref_id, fid, kind, policy, pin in refs:
            f = _same_scope(con, pg, fid)
            if kind=='image' and not f.get('path','').lower().endswith(
                ('.png','.jpg','.jpeg','.webp','.gif')):
                _error('Only File Hub image files may be embedded','notebook_v35_image_type',409)
            if policy == "pinned" and pin != f["revision"]:
                # Historical locked revisions are independently addressable; verify their blob exists.
                import file_hub
                try: file_hub.content(fid, pin)
                except Exception: _error("Pinned File Hub revision is unavailable", "notebook_file_revision_missing", 409)
        old = _doc_row(con, page_id)
        if not old and pg["html"].strip():
            source_text,source_images,source_links,source_colors=_legacy_signature(pg["html"])
            target_text,target_images,target_links,target_colors=_legacy_signature(html_text)
            if (source_text not in target_text or not set(source_images).issubset(set(target_images))
                or not set(source_links).issubset(set(target_links))
                or not set(source_colors).issubset(set(target_colors))):
                _error("Legacy HTML cannot be upgraded without losing content; keep Legacy Editor",
                       "notebook_v35_conversion_loss",409)
        if old and old["json_text"] == encoded and pg["title"] == title:
            return {"page":nb._page_detail(con,pg),"changed":False}
        now = nb._stamp()
        new_rev = revision + 1
        con.execute("UPDATE work_note_pages SET title=?,html=?,revision=?,updated_at=? WHERE id=?",
                    (title, html_text, new_rev, now, page_id))
        con.execute("INSERT INTO work_note_page_revisions "
                    "(page_id,revision,title,html,actor,source,occurred_at) VALUES(?,?,?,?,?,?,?)",
                    (page_id,new_rev,title,html_text,"user","notebook:v35-document-save",now))
        con.execute("INSERT INTO work_note_v35_docs "
                    "(page_id,schema_version,json_text,source_revision,markdown_text,html_text,content_sha256,modified_at)"
                    " VALUES(?,1,?,?,?,?,?,?) ON CONFLICT(page_id) DO UPDATE SET "
                    "json_text=excluded.json_text,source_revision=excluded.source_revision,"
                    "markdown_text=excluded.markdown_text,html_text=excluded.html_text,"
                    "content_sha256=excluded.content_sha256,modified_at=excluded.modified_at",
                    (page_id,encoded,new_rev,markdown,html_text,content_hash,now))
        con.execute("INSERT INTO work_note_v35_history VALUES(?,?,?,?,?)",
                    (page_id,new_rev,encoded,markdown,html_text))
        before = {r["ref_id"]:(r["file_id"],r["kind"],r["policy"],r["pinned_revision"])
                  for r in con.execute("SELECT * FROM work_note_v35_refs WHERE page_id=?", (page_id,))}
        after = {ref[0]:(ref[1],ref[2],ref[3],ref[4]) for ref in refs}
        if len(after) > 80: _error("Too many Page attachments")
        for ref in refs:
            con.execute("INSERT INTO work_note_v35_refs "
                        "(page_id,ref_id,file_id,kind,policy,pinned_revision,state)"
                        " VALUES(?,?,?,?,?,?,'pending') ON CONFLICT(page_id,ref_id) DO UPDATE SET "
                        "file_id=excluded.file_id,kind=excluded.kind,policy=excluded.policy,"
                        "pinned_revision=excluded.pinned_revision,state='pending'",
                        (page_id,*ref))
        for ref_id in before.keys() - after.keys():
            con.execute("DELETE FROM work_note_v35_refs WHERE page_id=? AND ref_id=?", (page_id,ref_id))
        changes = {(fid, "link") for fid in (value[0] for k,value in after.items()
                                             if k not in before or before[k] != value)}
        changes |= {(fid, "unlink") for fid in (value[0] for k,value in before.items()
                                               if k not in after or before[k] != after[k])}
        for fid, operation in sorted(changes):
            con.execute("INSERT INTO work_note_v35_file_outbox "
                        "(operation_id,page_id,file_id,operation,state,created_at) VALUES(?,?,?,?,'pending',?)",
                        (uuid.uuid4().hex,page_id,fid,operation,now))
        con.execute("UPDATE work_note_v35_staging SET status='linked' WHERE page_id=? AND file_id IN "
                    "(SELECT file_id FROM work_note_v35_refs WHERE page_id=?)",(page_id,page_id))
        con.execute("INSERT INTO work_note_v35_index_outbox VALUES(?,?,?,?) "
                    "ON CONFLICT(page_id) DO UPDATE SET revision=excluded.revision,"
                    "status=excluded.status,updated_at=excluded.updated_at",
                    (page_id,new_rev,"pending",now))
        result = {"page":nb._page_detail(con,nb._page(con,page_id)), "changed":True,
                  "contentSha256":content_hash,"indexStatus":"pending",
                  "attachmentSyncStatus":"pending" if changes else "unchanged"}
    try: index_page(page_id,path)
    except (sqlite3.Error,ValueError): pass
    try: reconcile_file_links(path)
    except (sqlite3.Error,ValueError,OSError): pass
    return result


def legacy_write_allowed(con, page_id, html_text):
    if not ready(con): return
    if _doc_row(con,page_id) and _doc_row(con,page_id)["html_text"] != html_text:
        _error("Structured Page cannot be overwritten with legacy HTML",
               "notebook_v35_upgrade_required",409)


def attach_upload(page_id, file_id, operation_id, path=None):
    if not isinstance(operation_id,str) or not re.fullmatch(r"[a-zA-Z0-9_-]{8,80}",operation_id):
        _error("Invalid attachment operation ID")
    if not FILE_ID.fullmatch(file_id):
        _error("Invalid File ID")
    with nodes._writer(path) as con:
        if not ready(con): _error("Notes V3.5 not initialized","notebook_v35_migration_required",409)
        pg = nb._page(con,page_id);nb._node(con,pg["owner_id"])
        import file_hub
        source=file_hub.details(file_id)
        if source["deleted"] or not source["path"].startswith("Projects/WorkHub/Notes/Attachments/"):
            _error("Uploaded file is outside the Notes attachment staging folder",
                   "notebook_v35_file_scope",403)
        con.execute("INSERT INTO work_note_v35_staging VALUES(?,?,?,?,?) "
                    "ON CONFLICT(operation_id) DO NOTHING",
                    (operation_id,page_id,file_id,"staged",nb._stamp()))
        old=con.execute("SELECT page_id,file_id FROM work_note_v35_staging WHERE operation_id=?",
                        (operation_id,)).fetchone()
        if old["page_id"]!=page_id or old["file_id"]!=file_id:
            _error("Attachment operation ID reused","notebook_v35_upload_conflict",409)
    return {"fileId":file_id,"operationId":operation_id,"status":"staged"}


def knowledge_history(params,path=None):
    """Opt-in Page Revision reading; never mixed into default current FTS."""
    owner=params.get("id");pid=params.get("page")
    archived=params.get("includeArchived") in ("1","true",True)
    wanted=params.get("revision")
    with nodes._reader(path) as con:
        nb._require(con);nb._node(con,owner)
        pg=nb._page(con,pid,active=not archived)
        if pg["owner_id"]!=owner:
            _error("Page is outside authorized Notebook","notebook_owner_mismatch",403)
        if con.execute("SELECT archived_at FROM work_note_sections WHERE id=?",
                       (pg["section_id"],)).fetchone()[0] and not archived:
            _error("Section is archived; opt in to historical mode","notebook_v35_archived",404)
        if wanted is not None:
            try:want=int(wanted)
            except (TypeError,ValueError):_error("Revision must be an integer")
            if want<1:_error("Revision must be positive")
            history=con.execute(
                "SELECT revision,html,actor,source,occurred_at FROM work_note_page_revisions "
                "WHERE page_id=? AND revision=?",(pid,want)).fetchone()
            if history is None:_error("Revision not found","notebook_revision_not_found",404)
            doc=con.execute("SELECT * FROM work_note_v35_history WHERE page_id=? AND revision=?",
                            (pid,want)).fetchone() if ready(con) else None
            return {"pageId":pid,"revision":want,"historical":want!=pg["revision"],
                    "archived":bool(pg["archived_at"]),"source":history["source"],
                    "occurredAt":history["occurred_at"],"format":"json" if doc else "legacy-html",
                    "markdown":doc["markdown_text"] if doc else _legacy_markdown(history["html"],pg["title"]),
                    "html":doc["html_text"] if doc else history["html"],
                    "json":json.loads(doc["json_text"]) if doc else None}
        rows=con.execute(
            "SELECT revision,source,occurred_at FROM work_note_page_revisions "
            "WHERE page_id=? ORDER BY revision DESC LIMIT 100",(pid,)).fetchall()
        return {"pageId":pid,"latestRevision":pg["revision"],
                "archived":bool(pg["archived_at"]),"revisions":[dict(r) for r in rows]}


def staged_files(params,path=None):
    """Recoverable pending attachments for a single authorized Page."""
    owner=params.get('id');page_id=params.get('page')
    with nodes._reader(path) as con:
        if not ready(con):_error('Notes V3.5 not initialized','notebook_v35_migration_required',409)
        nb._node(con,owner)
        pg=nb._page(con,page_id)
        if pg['owner_id']!=owner:_error('Wrong Page owner','notebook_owner_mismatch',403)
        rows=con.execute('SELECT * FROM work_note_v35_staging WHERE page_id=? AND status=? '
                         'ORDER BY created_at DESC LIMIT 80',(page_id,'staged')).fetchall()
    import file_hub
    items=[]
    for row in rows:
        try:
            data=file_hub.details(row['file_id'])
            if data['deleted']:continue
            prefix=row['operation_id']+'_'
            label=data['name'][len(prefix):] if data['name'].startswith(prefix) else data['name']
            items.append({'id':data['id'],'name':label,'revision':data['revision'],
                          'size':data['size'],'staged':True})
        except (file_hub.Missing,OSError):continue
    return {'items':items}


def page_options(params,path=None):
    """Same-L1 Page picker; does not reveal other projects or archived Pages."""
    owner=params.get("id")
    q=params.get("q") or ""
    if not isinstance(q,str) or len(q)>100:_error("Invalid search text")
    with nodes._reader(path) as con:
        nb._require(con)
        _,root=nb._node(con,owner)
        index=nodes._Index(con)
        rows=con.execute("SELECT p.id,p.owner_id,p.section_id,p.title,p.revision "
                         "FROM work_note_pages p JOIN work_note_sections s ON s.id=p.section_id "
                         "WHERE p.archived_at IS NULL AND s.archived_at IS NULL AND p.title LIKE ? "
                         "ORDER BY p.updated_at DESC LIMIT 150",("%"+q+"%",)).fetchall()
        items=[]
        for pg in rows:
            try:
                chain=index.chain(pg["owner_id"])
                if not chain or chain[0]!=root or any(
                    index.rows[i]["archived_at"] or index.rows[i]["deleted_at"] for i in chain):continue
            except (KeyError,ValueError):continue
            items.append({"id":pg["id"],"ownerId":pg["owner_id"],
                         "sectionId":pg["section_id"],"title":pg["title"],
                         "revision":pg["revision"],
                         "sourcePath":[index.rows[i]["title"] for i in chain]})
            if len(items)>=60:break
        return {"items":items,"scopeRootId":root}


def email_preview(params,path=None):
    """Read-only safe plain-text .eml preview. .msg remains downloadable fallback."""
    import email
    from email.header import decode_header, make_header
    from email import policy
    from email.parser import BytesParser
    import file_hub
    page_id=params.get("page")
    fid=params.get("fileId")
    owner=params.get("id")
    with nodes._reader(path) as con:
        if not ready(con): _error("Notes V3.5 migration required","notebook_v35_migration_required",409)
        nb._node(con,owner)
        page=nb._page(con,page_id)
        if page["owner_id"] != owner:_error("Page does not belong to notebook","notebook_owner_mismatch",403)
        ref=con.execute("SELECT * FROM work_note_v35_refs WHERE page_id=? AND file_id=? AND kind=?",
                        (page_id,fid,"email")).fetchone()
        if ref is None: _error("Email is not attached to this Page","notebook_v35_file_scope",403)
        revision=ref["pinned_revision"] if ref["policy"]=="pinned" else None
    source,name=file_hub.content(fid,revision)
    ext=source.suffix.lower()
    if not ext==".eml" and not name.lower().endswith(".eml"):
        return {"status":"unavailable","reason":"MSG preview requires a reviewed local parser",
                "fileId":fid,"name":name,"downloadable":True}
    if source.stat().st_size > 12*1024*1024:
        return {"status":"unavailable","reason":"Email too large for safe preview",
                "fileId":fid,"name":name,"downloadable":True}
    try:
        message=BytesParser(policy=policy.default).parsebytes(source.read_bytes())
        def decode(value):
            if value is None:return ""
            return str(make_header(decode_header(str(value))))[:500]
        body=message.get_body(preferencelist=("plain",)) if message.is_multipart() else message
        preview=""
        if body and body.get_content_type()=="text/plain":
            preview=str(body.get_content())[:16000]
        return {"status":"preview","fileId":fid,"name":name,
                "subject":decode(message.get("Subject")),"from":decode(message.get("From")),
                "to":decode(message.get("To")),"date":decode(message.get("Date")),
                "body":preview,"downloadable":True,"revision":revision}
    except (ValueError,UnicodeError,OSError,TypeError,LookupError):
        return {"status":"unavailable","reason":"Cannot safely parse this email",
                "fileId":fid,"name":name,"downloadable":True}


def index_page(page_id,path=None):
    """Idempotent post-commit FTS refresh, never invoked from a GET."""
    with nodes._writer(path) as con:
        if not ready(con): return {"ready":False}
        pg=nb._page(con,page_id,active=False)
        d=_doc_row(con,page_id)
        markdown,blocks=(_markdown(json.loads(d["json_text"])) if d else
                         (_legacy_markdown(pg["html"],pg["title"]),[]))
        content_sha=d["content_sha256"] if d else hashlib.sha256(pg["html"].encode()).hexdigest()
        con.execute("DELETE FROM work_note_v35_fts WHERE page_id=?",(page_id,))
        # Include full Page text and Block excerpts with stable IDs.
        if not pg["archived_at"]:
            con.execute("INSERT INTO work_note_v35_fts(page_id,block_id,text) VALUES(?,?,?)",
                        (page_id,"",pg["title"]+"\n"+markdown))
            for block in blocks:
                con.execute("INSERT INTO work_note_v35_fts(page_id,block_id,text) VALUES(?,?,?)",
                            (page_id,block["blockId"],block["text"][:20000]))
        con.execute("INSERT INTO work_note_v35_index_state VALUES(?,?,?,?,?) "
                    "ON CONFLICT(page_id) DO UPDATE SET revision=excluded.revision,status=excluded.status,"
                    "content_sha256=excluded.content_sha256,updated_at=excluded.updated_at",
                    (page_id,pg["revision"],"ok",content_sha,nb._stamp()))
        con.execute("DELETE FROM work_note_v35_index_outbox WHERE page_id=?",(page_id,))
        return {"indexed":True,"revision":pg["revision"],"blocks":len(blocks)}


def search(params,path=None):
    """Scoped knowledge query. No cross-Project API until identity+authorization is implemented."""
    owner=params.get("id")
    q=params.get("q")
    if not isinstance(q,str) or not q.strip() or len(q)>160:
        _error("Search query must contain 1–160 characters")
    if params.get("crossProject") in ("1","true",True):
        _error("Cross-project knowledge search requires corporate authorization",
               "notebook_v35_cross_project_disabled",403)
    if params.get("history") in ("1","true",True):
        _error("Knowledge history search not enabled", "notebook_v35_history_disabled",403)
    tokens=re.findall(r"[\w-]+",q.strip(),flags=re.UNICODE)
    if not tokens:_error("Search must contain a word or phrase")
    match=" AND ".join('"'+token+'"' for token in tokens[:12])
    with nodes._reader(path) as con:
        if not ready(con): _error("Notes V3.5 not initialized","notebook_v35_migration_required",409)
        _, root=nb._node(con,owner)
        # All results bound to requested L1 owner only; future enterprise ACL gates go here.
        expected_root=owner if owner==root else root
        rows=con.execute(
            "SELECT DISTINCT f.page_id,f.block_id, p.title,p.owner_id,p.revision,p.section_id,"
            " coalesce(d.source_revision,p.revision) source_revision,"
            " coalesce(d.content_sha256,s.content_sha256) content_sha256,"
            " s.revision indexed_revision,s.status indexed_status,"
            " snippet(work_note_v35_fts,2,'[',']','…',16) as excerpt "
            "FROM work_note_v35_fts f JOIN work_note_pages p ON p.id=f.page_id "
            "LEFT JOIN work_note_v35_docs d ON d.page_id=p.id "
            "LEFT JOIN work_note_v35_index_state s ON s.page_id=p.id "
            "JOIN work_note_sections section ON section.id=p.section_id "
            "WHERE work_note_v35_fts MATCH ? AND p.archived_at IS NULL AND section.archived_at IS NULL "
            "ORDER BY CASE WHEN f.block_id = '' THEN 1 ELSE 0 END, p.updated_at DESC "
            "LIMIT 120", (match,)).fetchall()
        index=nodes._Index(con)
        matches=[]
        for row in rows:
            try:
                chain=index.chain(row["owner_id"])
                if not chain or chain[0] != expected_root: continue
                if any(index.rows[i]["archived_at"] or index.rows[i]["deleted_at"] for i in chain):continue
            except (ValueError,KeyError):continue
            if row["indexed_revision"] != row["revision"] or row["indexed_status"] != "ok":
                continue # Never serve stale content as fresh.
            matches.append({
                "pageId":row["page_id"],"blockId":row["block_id"] or None,
                "title":row["title"],"ownerId":row["owner_id"],"sectionId":row["section_id"],
                "revision":row["revision"],"snippet":row["excerpt"],
                "sourcePath":[{"id":i,"title":index.rows[i]["title"]} for i in chain],
                "deepLink":"/app/n/"+row["owner_id"]+"/notes?page="+row["page_id"]+
                    ("&block="+row["block_id"] if row["block_id"] else ""),
                "freshness":"current","contentSha256":row["content_sha256"]})
            if len(matches)>=30:break
        return {"items":matches,"scopeRootId":expected_root,"crossProject":False,
                "total":len(matches)}


def state(path=None):
    with nodes._reader(path) as con:
        if not ready(con):return {"ready":False}
        counts={}
        for key,sql in {
            "documents":"SELECT count(*) FROM work_note_v35_docs",
            "pendingIndex":"SELECT count(*) FROM work_note_v35_index_outbox",
            "pendingFileSync":"SELECT count(*) FROM work_note_v35_file_outbox WHERE state='pending'",
            "stagedFiles":"SELECT count(*) FROM work_note_v35_staging WHERE status='staged'",
            "indexedPages":"SELECT count(*) FROM work_note_v35_index_state WHERE status='ok'",
            "legacyIndexedPages":"SELECT count(*) FROM work_note_v35_index_state s "
                                 "LEFT JOIN work_note_v35_docs d ON d.page_id=s.page_id "
                                 "WHERE s.status='ok' AND d.page_id IS NULL",
        }.items():
            counts[key]=con.execute(sql).fetchone()[0]
        return {"ready":True,"schemaVersion":1,**counts,"crossProjectDiscovery":False}


def reconcile_pending(path=None,limit=40):
    """Bounded crash-recovery pass for FTS and File Hub outboxes.

    Invoke from the Work-local server maintenance loop, never from a GET API.
    The outboxes remain durable after process crash, so retries are idempotent.
    """
    with nodes._reader(path) as con:
        if not ready(con):return {'ready':False}
        pages=[r['page_id'] for r in con.execute(
            "SELECT page_id FROM work_note_v35_index_outbox WHERE status='pending' LIMIT ?",
            (limit,))]
        if len(pages)<limit:
            rows=con.execute("SELECT p.id FROM work_note_pages p "
                             "LEFT JOIN work_note_v35_index_state s ON s.page_id=p.id "
                             "WHERE s.page_id IS NULL OR s.revision<>p.revision "
                             "LIMIT ?",(limit-len(pages),)).fetchall()
            pages.extend(r['id'] for r in rows if r['id'] not in pages)
    indexed=0;failed=0
    for pid in pages:
        try:
            if index_page(pid,path).get('indexed'):indexed+=1
        except (ValueError,sqlite3.Error,OSError,nodes.NodeError):failed+=1
    links=reconcile_file_links(path,limit)
    return {'ready':True,'indexed':indexed,'indexFailed':failed,'links':links}


def reconcile_file_links(path=None,limit=50):
    """Explicit maintenance operation, never run on read; cross-DB links are idempotent."""
    import file_hub
    synced=0;failed=0
    with nodes._reader(path) as con:
        if not ready(con):return {"ready":False}
        work=[dict(r) for r in con.execute(
            "SELECT * FROM work_note_v35_file_outbox WHERE state='pending' ORDER BY created_at LIMIT ?",
            (limit,))]
    for row in work:
        try:
            # Avoid removing a file's Page link if any other ref in this Page still uses it.
            with nodes._reader(path) as con:
                has=con.execute("SELECT 1 FROM work_note_v35_refs WHERE page_id=? AND file_id=?",
                                (row["page_id"],row["file_id"])).fetchone() is not None
            file_hub.link(row["file_id"],"note-page",row["page_id"],relation="page-attachment",
                          remove=not has)
            with nodes._reader(path) as con:
                pins=[dict(r) for r in con.execute(
                    "SELECT * FROM work_note_v35_refs WHERE page_id=? AND file_id=?",
                    (row["page_id"],row["file_id"]))]
            for pin in pins:
                if pin["policy"] == "pinned":
                    file_hub.pin_note_page_revision(pin["file_id"],row["page_id"],pin["ref_id"],
                                                    pin["pinned_revision"])
            with nodes._writer(path) as con:
                con.execute("UPDATE work_note_v35_file_outbox SET state='synced',attempts=attempts+1 "
                            "WHERE operation_id=?",(row["operation_id"],))
                con.execute("UPDATE work_note_v35_refs SET state='synced' "
                            "WHERE page_id=? AND file_id=?",(row["page_id"],row["file_id"]))
            synced+=1
        except (ValueError,OSError,sqlite3.Error):
            failed+=1
            with nodes._writer(path) as con:
                con.execute("UPDATE work_note_v35_file_outbox SET attempts=attempts+1 "
                            "WHERE operation_id=?",(row["operation_id"],))
    return {"synced":synced,"failed":failed,"processed":len(work)}
