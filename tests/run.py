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
UUID = "split-screen@brohd11"
AR_UUID = "split-screen-ar@brohd11"
EXTENSION = ROOT / "extension" / UUID
AR_FILES = {"base.js", "core.js", "extension.js", "layouts.js", "metadata.json", "settings-schema.json"}


class PackagingTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix="split-screen-test-")
        self.addCleanup(self.temporary.cleanup)
        self.parent = Path(self.temporary.name) / "extensions with spaces"
        self.destination = self.parent / UUID

    def invoke(self, action, success=True, ar=False):
        result = subprocess.run(
            [sys.executable, str(ROOT / "tools/install.py"), action, "--extensions-dir", str(self.parent),
             *(["--ar"] if ar else [])],
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

    def test_ar_install_remove(self):
        destination = self.parent / AR_UUID
        self.invoke("install", ar=True)
        self.assertEqual({file.name for file in destination.iterdir()}, AR_FILES)
        self.assertEqual(json.loads((destination / "metadata.json").read_text())["uuid"], AR_UUID)
        self.assertEqual((destination / "base.js").read_bytes(), (EXTENSION / "extension.js").read_bytes())
        self.invoke("install")
        self.assertTrue(destination.exists(), "variants install side by side")
        self.invoke("uninstall", ar=True)
        self.assertFalse(destination.exists())
        self.assertTrue(self.destination.exists(), "uninstalling one variant keeps the other")
        self.invoke("uninstall", ar=True)

    def test_do_not_replace_other_variant(self):
        self.invoke("install")
        # A base install sitting at the AR path must not be overwritten.
        shutil.copytree(self.destination, self.parent / AR_UUID)
        self.invoke("install", ar=True, success=False)

    def test_settings_defaults(self):
        settings = json.loads((EXTENSION / "settings-schema.json").read_text())
        self.assertNotIn("monitor", settings)
        self.assertNotIn("layout-32", settings)
        self.assertEqual(settings["dwell-ms"]["default"], 250)
        self.invoke("install", ar=True)
        merged = json.loads((self.parent / AR_UUID / "settings-schema.json").read_text())
        self.assertEqual(merged["monitor"]["default"], "auto")
        self.assertEqual(merged["layout-32"]["default"], "dual")
        self.assertEqual(merged["dwell-ms"]["default"], 250)
        self.assertIn("AR glasses", merged["intro"]["description"])
        self.assertEqual(list(merged)[:4], ["intro", "monitor", "layout-32", "layout-info"])


def main():
    if not shutil.which("cjs"):
        sys.exit("Tests require cjs (Cinnamon's JavaScript runtime).")
    build = tempfile.TemporaryDirectory(prefix="split-screen-build-")
    output = Path(build.name)
    for flags in ([], ["--ar"]):
        subprocess.run([sys.executable, str(ROOT / "tools/install.py"), "build", "--output", str(output), *flags],
                       check=True, capture_output=True)
    base, ar = output / UUID, output / AR_UUID
    for name, directory in (("core.js", base), ("adapter.js", base), ("layouts.js", ar), ("adapter-ar.js", ar)):
        subprocess.run(["cjs", str(ROOT / "tests" / name), str(directory)], check=True)
    # Debian/Mint install their private GI modules outside the default search path.
    typelibs = [*Path("/usr/lib").glob("**/muffin/Meta-0.typelib"),
                *Path("/usr/lib").glob("**/cinnamon/Cinnamon-0.1.typelib")]
    directories = list(dict.fromkeys(str(path.parent) for path in typelibs))
    if len(typelibs) >= 2:
        env = os.environ.copy()
        for key in ("GI_TYPELIB_PATH", "LD_LIBRARY_PATH"):
            env[key] = ":".join(directories + ([env[key]] if env.get(key) else []))
        subprocess.run(["cjs", str(ROOT / "tests/api.js"), str(base), str(ar)], env=env, check=True)
    else:
        print("SKIP local API check: Cinnamon/Muffin typelibs not installed.")
    build.cleanup()
    suite = unittest.defaultTestLoader.loadTestsFromTestCase(PackagingTests)
    if not unittest.TextTestRunner(verbosity=2).run(suite).wasSuccessful():
        sys.exit(1)


if __name__ == "__main__":
    main()
