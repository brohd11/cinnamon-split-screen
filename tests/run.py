#!/usr/bin/env python3
"""Run headless JS, local API, and isolated packaging tests."""
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[1]
UUID = "vscreen@brohd"
EXTENSION = ROOT / "extension" / UUID


class PackagingTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix="vscreen-test-")
        self.addCleanup(self.temporary.cleanup)
        self.parent = Path(self.temporary.name) / "extensions with spaces"
        self.destination = self.parent / UUID

    def invoke(self, action, success=True):
        result = subprocess.run(
            [sys.executable, str(ROOT / "tools/install.py"), action, "--extensions-dir", str(self.parent)],
            text=True, capture_output=True,
        )
        self.assertEqual(result.returncode == 0, success, result.stdout + result.stderr)
        return result

    def test_install_update_remove(self):
        self.invoke("install")
        self.assertEqual(json.loads((self.destination / "metadata.json").read_text())["uuid"], UUID)
        for file in EXTENSION.iterdir():
            self.assertEqual((self.destination / file.name).read_bytes(), file.read_bytes())
        self.invoke("install")
        self.invoke("uninstall")
        self.assertFalse(self.destination.exists())
        self.invoke("uninstall")

    def test_preserve_unrelated_files(self):
        self.invoke("install")
        notes = self.destination / "local-notes.txt"
        notes.write_text("keep me")
        self.invoke("install")
        self.invoke("uninstall")
        self.assertEqual(notes.read_text(), "keep me")

    def test_do_not_replace_unknown_directory(self):
        self.destination.mkdir(parents=True)
        marker = self.destination / "unknown.txt"
        marker.write_text("keep")
        self.invoke("install", success=False)
        self.invoke("uninstall", success=False)
        self.assertEqual(marker.read_text(), "keep")

    def test_do_not_follow_extension_symlink(self):
        self.parent.mkdir(parents=True)
        self.destination.symlink_to(EXTENSION, target_is_directory=True)
        self.invoke("install", success=False)
        self.invoke("uninstall", success=False)
        self.assertTrue((EXTENSION / "extension.js").exists())

    def test_settings_defaults(self):
        settings = json.loads((EXTENSION / "settings-schema.json").read_text())
        self.assertEqual(settings["monitor"]["default"], "auto")
        self.assertEqual(settings["layout-32"]["default"], "dual")
        self.assertEqual(settings["dwell-ms"]["default"], 250)


def main():
    if not shutil.which("cjs"):
        sys.exit("Tests require cjs (Cinnamon's JavaScript runtime).")
    for name in ("core.js", "adapter.js"):
        subprocess.run(["cjs", str(ROOT / "tests" / name), str(EXTENSION)], check=True)
    # Debian/Mint install their private GI modules outside the default search path.
    typelibs = [*Path("/usr/lib").glob("**/muffin/Meta-0.typelib"),
                *Path("/usr/lib").glob("**/cinnamon/Cinnamon-0.1.typelib")]
    directories = list(dict.fromkeys(str(path.parent) for path in typelibs))
    if len(typelibs) >= 2:
        env = os.environ.copy()
        for key in ("GI_TYPELIB_PATH", "LD_LIBRARY_PATH"):
            env[key] = ":".join(directories + ([env[key]] if env.get(key) else []))
        subprocess.run(["cjs", str(ROOT / "tests/api.js"), str(EXTENSION)], env=env, check=True)
    else:
        print("SKIP local API check: Cinnamon/Muffin typelibs not installed.")
    suite = unittest.defaultTestLoader.loadTestsFromTestCase(PackagingTests)
    if not unittest.TextTestRunner(verbosity=2).run(suite).wasSuccessful():
        sys.exit(1)


if __name__ == "__main__":
    main()
