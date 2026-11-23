#!/usr/bin/env python3
"""Create a clean Microsoft Edge Add-ons package from runtime files only.

The file list is not maintained by hand. It is derived by scripts/runtime-files.mjs,
which walks forward from manifest.json through module imports, HTML references and
asset literals. A hand-maintained list fails open: an omitted file still produced a
"successful" build and only broke after a store user installed it.

This script therefore refuses to build when
  - the closure reports an unresolved reference, or
  - the archive would not contain every file in the closure.
"""
from __future__ import annotations

import json
import shutil
import subprocess
import sys
from pathlib import Path
from zipfile import ZIP_DEFLATED, ZipFile

ROOT = Path(__file__).resolve().parents[1]
DIST = ROOT / "dist"
RESOLVER = ROOT / "scripts" / "runtime-files.mjs"


def resolve_runtime_files() -> list[str]:
    node = shutil.which("node")
    if node is None:
        raise SystemExit("Node.js 20+ is required: scripts/runtime-files.mjs cannot be run.")

    completed = subprocess.run(
        [node, str(RESOLVER), "--json"],
        cwd=ROOT,
        capture_output=True,
        text=True,
        check=False,
    )
    if completed.returncode != 0:
        raise SystemExit(
            "Runtime file resolution failed:\n"
            f"{completed.stderr.strip() or completed.stdout.strip()}"
        )

    try:
        report = json.loads(completed.stdout)
    except json.JSONDecodeError as error:
        raise SystemExit(f"Runtime file resolver returned invalid JSON: {error}") from error

    missing = report.get("missing") or []
    if missing:
        raise SystemExit("Unresolved references in the extension:\n  " + "\n  ".join(missing))

    bare_imports = report.get("bareImports") or []
    if bare_imports:
        raise SystemExit(
            "The extension imports packages that would not be packaged:\n  "
            + "\n  ".join(bare_imports)
        )

    files = report.get("files") or []
    if "manifest.json" not in files:
        raise SystemExit("Runtime file closure does not include manifest.json.")
    return files


def main() -> None:
    files = resolve_runtime_files()

    manifest = json.loads((ROOT / "manifest.json").read_text(encoding="utf-8"))
    version = manifest.get("version")
    if not isinstance(version, str) or not version.strip():
        raise SystemExit("manifest.json must define a non-empty version")

    absent = [name for name in files if not (ROOT / name).is_file()]
    if absent:
        raise SystemExit("Missing runtime files: " + ", ".join(absent))

    DIST.mkdir(exist_ok=True)
    output = DIST / f"Alaxee-Proxy-v{version}.zip"
    if output.exists():
        output.unlink()

    with ZipFile(output, "w", compression=ZIP_DEFLATED, compresslevel=9) as archive:
        for name in files:
            archive.write(ROOT / name, arcname=name)

    # Verify the artifact rather than trusting the write loop: the whole point of
    # this check is to catch a package that is quietly incomplete.
    with ZipFile(output, "r") as archive:
        packaged = set(archive.namelist())

    expected = set(files)
    if packaged != expected:
        output.unlink(missing_ok=True)
        omitted = sorted(expected - packaged)
        unexpected = sorted(packaged - expected)
        raise SystemExit(
            "Packaged file set does not match the runtime closure.\n"
            f"  omitted: {omitted}\n"
            f"  unexpected: {unexpected}"
        )

    print(f"Created {output.relative_to(ROOT)}")
    print(f"Included {len(files)} runtime files; manifest version {version}")


if __name__ == "__main__":
    main()
