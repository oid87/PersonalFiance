# Local development and checks

Use Node 22 (`.nvmrc`) and Python 3.11 (`.python-version`). Install Python dependencies with `python -m pip install -r requirements-dev.txt` and JavaScript dependencies with `npm ci`.

Run `python scripts/run_checks.py` for the offline manifest, Python, and JavaScript suites. `npm test` runs the JavaScript suite with portable Python based test discovery. Neither command fetches market data. `python scripts/check_pipeline.py` checks the source inventory and workflow/local ordering. `python scripts/validate_data.py` checks current local data; `--data-dir` and `--baseline-dir` support disposable fixtures. The validation command does not repair or rewrite data. `python scripts/validate_forward_pe.py` separately checks the independently scheduled forward P/E series and chart files.

Use `python scripts/refresh_preview.py --dry-run` to inspect the local refresh order. `python scripts/refresh_preview.py` fetches into the current checkout without switching branches or pulling. `--sync-data` explicitly runs `git pull --ff-only origin main` first and refuses to run when `data/` has local changes. Local refresh never commits or pushes. Optional fetch failures are collected; a required source or final integrity failure returns a nonzero exit code.

GitHub Actions `checks.yml` runs only offline checks. `fetch.yml` retains the US/TW sessions and `forward_pe.yml` remains independent at 13:00 Taipei. The scheduled jobs check the source manifest before fetching, then validate data before committing.
