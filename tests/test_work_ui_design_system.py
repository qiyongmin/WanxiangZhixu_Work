"""Check that the public UI source is independent of the legacy vendor stylesheet.

No user data, local resources or Git history is modified.
"""
from pathlib import Path
import sys
import unittest

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "tools"))
import gitlab_preflight  # noqa: E402


class PublicDesignSystemTests(unittest.TestCase):
    def test_selected_code_uses_only_vendor_neutral_primitive_style(self):
        selected = set(gitlab_preflight.source_paths())
        self.assertIn("web/src/styles/kbw-primitives.css", selected)
        self.assertIn("web/src/styles/tokens.css", selected)
        self.assertIn("web/tests/design-system.test.tsx", selected)
        self.assertIn("UI_DESIGN_SYSTEM.md", selected)
        self.assertIn("THIRD_PARTY_NOTICES.md", selected)
        self.assertNotIn("web/src/styles/" + "eds.css", selected)

    def test_webfont_and_component_licenses_ship_in_public_source(self):
        selected = set(gitlab_preflight.source_paths())
        for name, marker in (
            ('inter-OFL-1.1.txt', 'SIL OPEN FONT LICENSE'),
            ('noto-sans-sc-OFL-1.1.txt', 'SIL OPEN FONT LICENSE'),
            ('jetbrains-mono-OFL-1.1.txt', 'SIL OPEN FONT LICENSE'),
            ('lucide-ISC.txt', 'ISC License'),
            ('radix-dialog-MIT.txt', 'MIT License'),
        ):
            rel = 'web/public/licenses/' + name
            with self.subTest(path=rel):
                self.assertIn(rel, selected)
                self.assertIn(marker, (ROOT / rel).read_text(encoding='utf-8'))

    def test_old_vendor_ui_and_proprietary_font_are_not_imported(self):
        main = (ROOT / "web/src/main.tsx").read_text(encoding="utf-8")
        tokens = (ROOT / "web/src/styles/tokens.css").read_text(encoding="utf-8")
        self.assertIn("kbw-primitives.css", main)
        self.assertNotIn("'./styles/" + "eds.css'", main)
        self.assertNotIn("Hilda", tokens)
        for face in ("Inter Variable", "Noto Sans SC Variable", "JetBrains Mono Variable"):
            self.assertIn(face, tokens)

    def test_pinned_open_font_and_component_deps_no_remote_font_requests(self):
        import json
        package = json.loads((ROOT / "web/package.json").read_text(encoding="utf-8"))
        dependencies = package["dependencies"]
        for key, version in {
            "@fontsource-variable/inter": "5.3.0",
            "@fontsource-variable/noto-sans-sc": "5.3.1",
            "@fontsource-variable/jetbrains-mono": "5.3.0",
            "lucide-react": "1.75.0",
            "@radix-ui/react-dialog": "1.3.1",
        }.items():
            self.assertEqual(dependencies.get(key), version)
        for package in ("inter", "noto-sans-sc", "jetbrains-mono"):
            self.assertIn("@fontsource-variable/" + package + "/wght.css",
                          (ROOT / "web/src/main.tsx").read_text(encoding="utf-8"))
        main = (ROOT / "web/src/main.tsx").read_text(encoding="utf-8")
        self.assertNotIn("fonts.googleapis", main)
        lock = (ROOT / 'web/package-lock.json').read_text(encoding='utf-8')
        self.assertNotIn('registry.npmmirror.com', lock)
        self.assertIn('registry.npmjs.org', lock)


if __name__ == "__main__":
    unittest.main()
