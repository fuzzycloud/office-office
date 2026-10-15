#!/usr/bin/env python3
"""Check the shared product version, lockfile and optional release tag."""
import argparse
import json
from pathlib import Path
import sys
import tomllib

ROOT = Path(__file__).resolve().parents[1]


def check(root: Path, tag: str | None = None) -> str:
    manifest = tomllib.loads((root / "Cargo.toml").read_text())
    version = manifest["workspace"]["package"]["version"]
    server = tomllib.loads((root / "apps/server/Cargo.toml").read_text())
    if server["package"]["version"] != {"workspace": True}:
        raise ValueError("apps/server must inherit workspace.package.version")
    for filename in ("package.json", "apps/web/package.json"):
        actual = json.loads((root / filename).read_text())["version"]
        if actual != version:
            raise ValueError(f"{filename}: {actual} differs from workspace version {version}")
    lock = tomllib.loads((root / "Cargo.lock").read_text())
    packages = [item for item in lock["package"] if item["name"] == "office-server"]
    if len(packages) != 1 or packages[0]["version"] != version:
        raise ValueError(f"Cargo.lock office-server version must be {version}")
    if tag is not None and tag != f"v{version}":
        raise ValueError(f"release tag {tag!r} must match v{version}")
    return version


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--tag", help="Require this exact vVERSION tag to match the manifests")
    args = parser.parse_args()
    try:
        version = check(ROOT, args.tag)
    except (ValueError, KeyError, OSError) as error:
        print(f"Version check failed: {error}", file=sys.stderr)
        return 1
    print(f"Office Office version: {version}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
