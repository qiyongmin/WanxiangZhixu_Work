"""Optional real LibreOffice PDF conversion acceptance using a synthetic DOCX.

Only temporary, fabricated bytes are created. Skipped automatically when the
host has no LibreOffice, so source-only CI does not require an Office suite.
"""
from __future__ import annotations

from pathlib import Path
import shutil
import sys
import tempfile
import unittest
from unittest import mock
import zipfile

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "tools"))
import office_preview


CONTENT_TYPES = """<?xml version="1.0" encoding="UTF-8"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<Default Extension="xml" ContentType="application/xml"/>
<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
</Types>"""
RELS = """<?xml version="1.0" encoding="UTF-8"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
</Relationships>"""
DOC = """<?xml version="1.0" encoding="UTF-8"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
<w:body><w:p><w:r><w:t>Fabricated Work preview smoke</w:t></w:r></w:p></w:body>
</w:document>"""


@unittest.skipUnless(shutil.which("libreoffice") or shutil.which("soffice"),
                     "LibreOffice optional: unavailable in this environment")
class OfficeHeadlessSmoke(unittest.TestCase):
    def test_fabricated_docx_renders_pdf_without_writing_original(self):
        with tempfile.TemporaryDirectory(prefix="kbw-office-smoke-") as folder:
            root = Path(folder)
            library = root / "library"
            library.mkdir()
            docx = library / "synthetic.docx"
            with zipfile.ZipFile(docx, "w") as package:
                package.writestr("[Content_Types].xml", CONTENT_TYPES)
                package.writestr("_rels/.rels", RELS)
                package.writestr("word/document.xml", DOC)
            before = docx.read_bytes()
            cache = root / "cache"
            with (mock.patch.object(office_preview.file_hub, "LIBRARY", library),
                  mock.patch.object(office_preview.file_hub, "content",
                                    return_value=(docx, docx.name)),
                  mock.patch.object(office_preview, "CACHE_ROOT", cache)):
                preview = office_preview.pdf("synthetic")
                self.assertTrue(preview.is_file())
                self.assertEqual(preview.read_bytes()[:5], b"%PDF-")
                self.assertEqual(before, docx.read_bytes())
                self.assertTrue(office_preview.status("synthetic")["pdfAvailable"])


if __name__ == "__main__":
    unittest.main()
