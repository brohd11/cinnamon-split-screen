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

ROOT = Path(__file__).resolve().parents[1]
BASE = ROOT / "extension" / "split-screen@brohd11"
AR = ROOT / "ar"
DEFAULT_DEST = Path.home() / ".local/share/cinnamon/extensions"


class Variant:
    def __init__(self, uuid, name, sources, schemas):
        self.uuid, self.name = uuid, name
        self.sources = sources  # installed filename -> source path
        self.schemas = schemas  # merged into settings-schema.json, in order
        self.files = (*sources, "settings-schema.json")


def merged_schema(paths):
    """Later schemas add keys; earlier ones win (such as the intro text)."""
    merged = {}
    for path in paths:
        for key, value in json.loads(path.read_text()).items():
            merged.setdefault(key, value)
    return merged


BASE_VARIANT = Variant(
    "split-screen@brohd11", "Split Screen",
    {name: BASE / name for name in ("core.js", "extension.js", "metadata.json")},
    (BASE / "settings-schema.json",),
)
# Built flat so the base's require('./core') and the overlay's require('./base') resolve.
AR_VARIANT = Variant(
    "split-screen-ar@brohd11", "Split Screen for AR Glasses",
    {"core.js": BASE / "core.js", "base.js": BASE / "extension.js",
     "layouts.js": AR / "layouts.js", "extension.js": AR / "extension.js",
     "metadata.json": AR / "metadata.json"},
    (AR / "settings-schema.json", BASE / "settings-schema.json"),
)
VARIANTS = (BASE_VARIANT, AR_VARIANT)


def stage(variant, directory):
    """Write the variant's files into directory."""
    for filename, source in variant.sources.items():
        shutil.copyfile(source, directory / filename)
    schema = directory / "settings-schema.json"
    if len(variant.schemas) == 1:
        shutil.copyfile(variant.schemas[0], schema)
    else:
        schema.write_text(json.dumps(merged_schema(variant.schemas), indent=4, ensure_ascii=False) + "\n")
    for filename in variant.files:
        (directory / filename).chmod(0o644)


def disable_if_enabled(uuid):
    if not shutil.which("gsettings"):
        return
    result = subprocess.run(
        ["gsettings", "get", "org.cinnamon", "enabled-extensions"],
        capture_output=True, text=True,
    )
    if result.returncode:
        raise RuntimeError("Cannot read Cinnamon's enabled extensions. Run this from your desktop session.")
    enabled = ast.literal_eval(result.stdout.strip().removeprefix("@as "))
    remaining = [entry for entry in enabled if entry.lstrip("!") != uuid]
    if remaining != enabled:
        subprocess.run(
            ["gsettings", "set", "org.cinnamon", "enabled-extensions", repr(remaining)],
            check=True,
        )


def validate_destination(variant, destination):
    if destination.is_symlink():
        raise RuntimeError(f"Refusing to replace a symlink: {destination}")
    if destination.exists():
        metadata = destination / "metadata.json"
        if not metadata.is_file() or json.loads(metadata.read_text()).get("uuid") != variant.uuid:
            raise RuntimeError(f"Directory is not an installed {variant.name} extension: {destination}")


def install(variant, destination, manage_activation):
    validate_destination(variant, destination)
    if manage_activation:
        # Variants each take over tiling, so only one may be enabled.
        for other in VARIANTS:
            if other is not variant:
                disable_if_enabled(other.uuid)
    destination.mkdir(parents=True, exist_ok=True)
    # Replace individual known files, preserving any unrelated local files.
    # Stage everything before replacing, with metadata last.
    with tempfile.TemporaryDirectory(prefix=".split-screen-", dir=destination.parent) as staging:
        staging = Path(staging)
        stage(variant, staging)
        for filename in sorted(variant.files, key=lambda name: name == "metadata.json"):
            os.replace(staging / filename, destination / filename)
    print(f"Installed {variant.name} to {destination}")
    for other in VARIANTS:
        if other is not variant and (destination.parent / other.uuid).exists():
            flag = " --ar" if other is AR_VARIANT else ""
            print(f"{other.name} is also installed; only one can be enabled. Remove it with ./uninstall.sh{flag}.")
    print(f"Open System Settings → Extensions and enable {variant.name}.")
    print(f"Enabled extensions load at login. Disable/re-enable {variant.name} after an update.")


def build(variant, output):
    if output.absolute() == DEFAULT_DEST:
        raise RuntimeError("Build output cannot be the extensions directory; use install instead.")
    destination = output.absolute() / variant.uuid
    if destination.exists():
        shutil.rmtree(destination)
    destination.mkdir(parents=True)
    stage(variant, destination)
    print(f"Built {variant.name} in {destination}")


def uninstall(variant, destination, manage_activation):
    if not destination.exists() and not destination.is_symlink():
        print(f"{variant.name} is not installed.")
        return
    validate_destination(variant, destination)
    if manage_activation:
        # Disabling lets the running extension restore Cinnamon's edge tiling.
        disable_if_enabled(variant.uuid)
    for filename in variant.files:
        (destination / filename).unlink(missing_ok=True)
    try:
        destination.rmdir()
    except OSError:
        print(f"Preserved other files in {destination}")
    print(f"Uninstalled {variant.name}. Saved Cinnamon extension preferences were preserved.")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("action", choices=("install", "uninstall", "build"))
    parser.add_argument("--ar", action="store_true",
                        help="Use the AR glasses variant (split-screen-ar@brohd11).")
    parser.add_argument("--extensions-dir", type=Path, default=DEFAULT_DEST,
                        help="Override the extension parent directory (for packaging/tests).")
    parser.add_argument("--output", type=Path, default=ROOT / "dist",
                        help="Directory for build output.")
    args = parser.parse_args()
    variant = AR_VARIANT if args.ar else BASE_VARIANT
    destination = args.extensions_dir.absolute() / variant.uuid
    manage_activation = args.extensions_dir.absolute() == DEFAULT_DEST
    try:
        if args.action == "install":
            install(variant, destination, manage_activation)
        elif args.action == "build":
            build(variant, args.output)
        else:
            uninstall(variant, destination, manage_activation)
    except (OSError, ValueError, RuntimeError, subprocess.CalledProcessError) as error:
        parser.exit(1, f"{error}\n")


if __name__ == "__main__":
    main()
