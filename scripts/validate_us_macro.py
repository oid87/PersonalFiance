"""Read-only validator for the committed US macro archive and public summary."""
from __future__ import annotations

import argparse
from pathlib import Path

import _macro_data as macro

ROOT = Path(__file__).resolve().parent.parent


def validate(data_dir):
    data_dir = Path(data_dir)
    manifest, latest, _ = macro.load_archive(data_dir)
    if manifest is None:
        raise macro.IntegrityError("macro manifest missing")
    path = macro.summary_path(data_dir)
    if not path.exists():
        raise macro.IntegrityError("macro summary missing")
    expected = macro.summary_bytes(macro.build_summary(manifest, latest))
    actual = path.read_bytes()
    if actual != expected:
        raise macro.IntegrityError("summary differs from committed manifest generation/content")
    summary = macro.build_summary(manifest, latest)
    if summary["generation_id"] != manifest["generation_id"]:
        raise macro.IntegrityError("summary generation mismatch")
    return {"generation_id": manifest["generation_id"], "segments": len(manifest["segments"]),
            "events": sum(part["rows"] for part in manifest["segments"]),
            "bytes": sum(part["byte_size"] for part in manifest["segments"]),
            "source_status": {series_id: manifest["source_status"][series_id]["last_attempt_status"] for series_id in macro.IDS}}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--data-dir", type=Path, default=ROOT / "data")
    args = parser.parse_args()
    result = validate(args.data_dir)
    print(f"PASS generation={result['generation_id']} segments={result['segments']} events={result['events']} bytes={result['bytes']}")
    for series_id, state in result["source_status"].items():
        print(f"{series_id}: {state}")


if __name__ == "__main__":
    main()
