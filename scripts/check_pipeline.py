#!/usr/bin/env python3
"""Read-only agreement check for the source manifest and execution routes."""
from __future__ import annotations

import argparse
import json
import re
from pathlib import Path
from source_contracts import expand_contracts

ROOT = Path(__file__).resolve().parent.parent
SCRIPT_RE = re.compile(r"(?:python(?:3)? scripts/|\"\$PYTHON\" )((?:fetch|prep|compute)_\w+\.py)")


def route_sequences(root: Path = ROOT) -> dict[str, list[str]]:
    workflow = (root / ".github/workflows/fetch.yml").read_text()
    us, tw = workflow.split("\n  tw:\n", 1)
    forward = (root / ".github/workflows/forward_pe.yml").read_text()
    local = (root / "scripts/update_all.sh").read_text()
    routes = {"us": SCRIPT_RE.findall(us), "tw": SCRIPT_RE.findall(tw),
              "forward_pe": SCRIPT_RE.findall(forward), "local": re.findall(r"^run_script (?:required|optional) ((?:fetch|prep|compute)_\w+\.py)(?: \|\| exit 1)?$", local, re.M)}
    # The macro fetch is called by its checked shell pipeline, not a direct YAML step.
    if "bash scripts/run_us_macro_pipeline.sh" not in us or "fetch_us_macro_diagnostic.py" not in (root / "scripts/run_us_macro_pipeline.sh").read_text():
        raise ValueError("US macro pipeline wiring missing")
    routes["us"].append("fetch_us_macro_diagnostic.py")
    return routes


def check(root: Path = ROOT) -> list[str]:
    errors = []
    manifest = json.loads((root / "scripts/source_manifest.json").read_text())
    entries = manifest["sources"]
    paths = [entry["script"] for entry in entries]
    actual = {f"scripts/{p.name}" for p in (root / "scripts").glob("*.py")
              if p.name.startswith(("fetch_", "prep_", "compute_"))}
    if len(paths) != len(set(paths)) or set(paths) != actual:
        errors.append(f"source inventory mismatch: missing={sorted(actual-set(paths))}, stale={sorted(set(paths)-actual)}")
    if manifest.get("source_count") != len(entries):
        errors.append("source_count mismatch")
    try:
        contracts, stock_outputs = expand_contracts(root, manifest)
        if not stock_outputs or not all(contracts[name].get('profile') == 'ohlcv' for name in stock_outputs):
            errors.append(f"stock contracts mismatch: {len(stock_outputs)} named ohlcv outputs")
    except (ValueError, OSError, SyntaxError, KeyError) as exc:
        errors.append(f"stock contracts: {exc}")
    try:
        routes = route_sequences(root)
    except ValueError as exc:
        return errors + [str(exc)]
    for route, sequence in routes.items():
        if len(sequence) != len(set(sequence)) and not (
            route == "forward_pe" and sequence == ["fetch_forward_pe.py"] * 2
            and "--ticker VOO" in (root / ".github/workflows/forward_pe.yml").read_text()
            and "--ticker QQQ" in (root / ".github/workflows/forward_pe.yml").read_text()
        ):
            errors.append(f"{route}: duplicate invocation")
        expected = {Path(e["script"]).name for e in entries if route in e["routes"]}
        if set(sequence) != expected:
            errors.append(f"{route}: missing={sorted(expected-set(sequence))}, unlisted={sorted(set(sequence)-expected)}")
    by_script = {e["script"]: e for e in entries}
    for e in entries:
        name = Path(e["script"]).name
        if not e["outputs"] or not e["validation_profile"] or not e["frequency"]:
            errors.append(f"{name}: output/profile/frequency missing")
        if set(e["outputs"]) != set(e.get("output_contracts", {})):
            errors.append(f"{name}: output contracts do not cover outputs")
        source_text = (root / e["script"]).read_text() if (root / e["script"]).exists() else ""
        for output in e["outputs"]:
            contract = e.get("output_contracts", {}).get(output, {})
            if not output.startswith("data/") or not contract.get("profile") or not contract.get("null_policy"):
                errors.append(f"{name}: invalid output contract {output}")
            basename = Path(output).name
            if ("{" not in basename and "*" not in output and name not in
                    ("fetch_us_macro_diagnostic.py", "fetch_yields.py") and basename not in source_text):
                errors.append(f"{name}: output {basename} not found in source")
        if e["status"] == "manual_research" and e["routes"]:
            errors.append(f"{name}: manual research source entered production route")
        if e["status"] == "scheduled" and not any(r in e["routes"] for r in ("us", "tw")):
            errors.append(f"{name}: scheduled source has no CI route")
        for dep in e["depends_on"]:
            if dep not in by_script:
                errors.append(f"{name}: unknown dependency {dep}")
                continue
            for route in e["routes"]:
                if route not in by_script[dep]["routes"]:
                    continue  # existing committed data is the input on this route
                seq = routes[route]
                if Path(dep).name in seq and name in seq and seq.index(Path(dep).name) > seq.index(name):
                    errors.append(f"{route}: {dep} runs after {name}")
    if "fetch_forward_pe.py" in routes["local"] or "fetch_forward_pe.py" in routes["us"] + routes["tw"]:
        errors.append("forward PE must retain independent schedule")
    return errors


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--root", type=Path, default=ROOT)
    args = parser.parse_args()
    errors = check(args.root)
    for error in errors:
        print("FAIL:", error)
    if not errors:
        print("Pipeline manifest and execution routes agree.")
    return bool(errors)


if __name__ == "__main__":
    raise SystemExit(main())
