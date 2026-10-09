#!/usr/bin/env python3
"""Install extension files for one user; Cinnamon owns activation and settings."""

import argparse
import ast
import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile

UUID = "split-screen@brohd11"
NAME = "Split Screen"
ROOT = Path(__file__).resolve().parents[1]
SOURCE = ROOT / "extension" / UUID
FILES = ("core.js", "extension.js", "metadata.json", "settings-schema.json")
DEFAULT_DEST = Path.home() / ".local/share/cinnamon/extensions"


def disable_if_enabled():
    if not shutil.which("gsettings"):
        return
    result = subprocess.run(
        ["gsettings", "get", "org.cinnamon", "enabled-extensions"],
        capture_output=True, text=True,
    )
    if result.returncode:
        raise RuntimeError("Cannot read Cinnamon's enabled extensions. Run this from your desktop session.")
    enabled = ast.literal_eval(result.stdout.strip().removeprefix("@as "))
    remaining = [entry for entry in enabled if entry.lstrip("!") != UUID]
    if remaining != enabled:
        subprocess.run(
            ["gsettings", "set", "org.cinnamon", "enabled-extensions", repr(remaining)],
            check=True,
        )


def validate_destination(destination):
    if destination.is_symlink():
        raise RuntimeError(f"Refusing to replace a symlink: {destination}")
    if destination.exists():
        metadata = destination / "metadata.json"
        if not metadata.is_file() or json.loads(metadata.read_text()).get("uuid") != UUID:
            raise RuntimeError(f"Directory is not an installed {NAME} extension: {destination}")


def install(destination):
    validate_destination(destination)
    destination.mkdir(parents=True, exist_ok=True)
    # Replace individual known files, preserving any unrelated local files.
    # Stage everything before replacing, with metadata last.
    with tempfile.TemporaryDirectory(prefix=".split-screen-", dir=destination.parent) as staging:
        staging = Path(staging)
        for filename in FILES:
            shutil.copyfile(SOURCE / filename, staging / filename)
            (staging / filename).chmod(0o644)
        for filename in sorted(FILES, key=lambda name: name == "metadata.json"):
            os.replace(staging / filename, destination / filename)
    print(f"Installed {NAME} to {destination}")
    print(f"Open System Settings → Extensions and enable {NAME}.")
    print(f"Enabled extensions load at login. Disable/re-enable {NAME} after an update.")


def uninstall(destination, manage_activation):
    if not destination.exists() and not destination.is_symlink():
        print(f"{NAME} is not installed.")
        return
    validate_destination(destination)
    if manage_activation:
        # Disabling lets the running extension restore Cinnamon's edge tiling.
        disable_if_enabled()
    for filename in FILES:
        (destination / filename).unlink(missing_ok=True)
    try:
        destination.rmdir()
    except OSError:
        print(f"Preserved other files in {destination}")
    print(f"Uninstalled {NAME}. Saved Cinnamon extension preferences were preserved.")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("action", choices=("install", "uninstall"))
    parser.add_argument("--extensions-dir", type=Path, default=DEFAULT_DEST,
                        help="Override the extension parent directory (for packaging/tests).")
    args = parser.parse_args()
    destination = args.extensions_dir.absolute() / UUID
    try:
        if args.action == "install":
            install(destination)
        else:
            uninstall(destination, args.extensions_dir.absolute() == DEFAULT_DEST)
    except (OSError, ValueError, RuntimeError, subprocess.CalledProcessError) as error:
        parser.exit(1, f"{error}\n")


if __name__ == "__main__":
    main()
