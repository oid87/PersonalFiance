"""Fetch eight FRED monthly series into immutable, system-seen macro archive."""
from __future__ import annotations

import argparse
import subprocess
from pathlib import Path

import _common
import _macro_data as macro

ROOT = Path(__file__).resolve().parent.parent


def fetch_one(series_id, *, downloader=None):
    """Downloaded bytes are parsed strictly before the system-seen UTC stamp is taken."""
    use_api = bool(_common.get_fred_api_key()) if downloader is None else False
    source = macro.api_source_url(series_id) if use_api else macro.source_url(series_id)
    if downloader is None:
        if use_api:
            def downloader(_url):
                try:
                    return _common.fred_csv_text(series_id, headers={"User-Agent": "PersonalFiance macro data"}, timeout=30)
                except Exception as exc:
                    # Requests errors can contain the credential-bearing URL. Never persist them.
                    raise macro.SourceError(f"FRED API request failed for {series_id} ({type(exc).__name__})") from None
        else:
            def downloader(url):
                return subprocess.run(["curl", "--fail", "--location", "--silent", "--show-error",
                                       "--max-time", "30", url], check=True, capture_output=True,
                                      timeout=35).stdout

    def attempt():
        rows = macro.parse_csv(series_id, downloader(source), source=source)
        return rows, macro.now_utc()

    def final(exc, result):
        raise exc if exc else macro.SourceError("empty response")

    return _common.retry_call(attempt, attempts=3, backoff=lambda n: 2 ** n,
                              retry_on=(subprocess.CalledProcessError, subprocess.TimeoutExpired, macro.SourceError),
                              on_final=final)


def run(data_dir, *, fetcher=fetch_one, attempt_at=None):
    data_dir = Path(data_dir)
    # The manifest and every referenced event must be valid before touching the output.
    old, latest, _ = macro.load_archive(data_dir)
    macro.recover_summary(data_dir, old, latest)
    accepted, failures = {}, {}
    for series_id in macro.IDS:
        print(f"Fetching {series_id}...", flush=True)
        try:
            rows, retrieved_at = fetcher(series_id)
            existing = latest[series_id]
            months = {row["reference_month"] for row in rows}
            if not set(existing).issubset(months):
                raise macro.SourceError("committed historical month disappeared")
            if existing and max(months) < max(existing):
                raise macro.SourceError("source endpoint regressed")
            changed = any(row["reference_month"] not in existing or row["raw_value"] != existing[row["reference_month"]]["raw_value"] for row in rows)
            previous = old["source_status"][series_id]["last_accepted_retrieved_at"] if old else None
            if changed and previous and retrieved_at <= previous:
                raise macro.SourceError("timestamp collision or time regression")
            accepted[series_id] = rows, retrieved_at
        except (subprocess.CalledProcessError, subprocess.TimeoutExpired, macro.SourceError, ValueError) as exc:
            failures[series_id] = f"{type(exc).__name__}: {exc}"
    manifest = macro.commit_batch(data_dir, accepted, failures, attempt_at=attempt_at)
    for series_id in macro.IDS:
        status = manifest["source_status"][series_id]
        print(f"{series_id}: {status['last_attempt_status']}; missing={len(status['missing_months'])}; error={status['error']}")
    return manifest


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--data-dir", type=Path, default=ROOT / "data")
    args = parser.parse_args()
    run(args.data_dir)


if __name__ == "__main__":
    main()
