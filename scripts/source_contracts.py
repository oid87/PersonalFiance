"""Expand manifest output contracts without importing fetch modules or fetching data."""
from __future__ import annotations

import ast
from pathlib import Path
import re

STOCK_TEMPLATE = "data/{stock_stem}.json"
SAFE_STEM = re.compile(r"[A-Za-z0-9][A-Za-z0-9._-]*\Z")


def stock_stems(root: Path) -> tuple[str, ...]:
    source = root / "scripts/fetch_stocks.py"
    tree = ast.parse(source.read_text(), filename=str(source))
    matches = [node for node in tree.body if isinstance(node, (ast.Assign, ast.AnnAssign)) and
               (any(isinstance(target, ast.Name) and target.id == "TICKERS" for target in node.targets)
                if isinstance(node, ast.Assign) else isinstance(node.target, ast.Name) and node.target.id == "TICKERS")]
    if len(matches) != 1:
        raise ValueError("fetch_stocks.py must define one literal TICKERS mapping")
    try:
        tickers = ast.literal_eval(matches[0].value)
    except (ValueError, TypeError, SyntaxError, MemoryError, RecursionError) as exc:
        raise ValueError("fetch_stocks.py TICKERS must be a literal mapping") from exc
    if not isinstance(tickers, dict) or not tickers:
        raise ValueError("fetch_stocks.py TICKERS must be a nonempty mapping")
    stems = []
    for ticker, pair in tickers.items():
        if not isinstance(ticker, str) or not isinstance(pair, tuple) or len(pair) != 2 or not all(isinstance(x, str) for x in pair):
            raise ValueError("fetch_stocks.py TICKERS has an invalid literal entry")
        stem = pair[0]
        if not SAFE_STEM.fullmatch(stem) or stem in (".", ".."):
            raise ValueError(f"fetch_stocks.py unsafe output stem: {stem!r}")
        stems.append(stem)
    if len(stems) != len(set(stems)):
        raise ValueError("fetch_stocks.py TICKERS has duplicate output stems")
    return tuple(stems)


def expand_contracts(root: Path, manifest: dict) -> tuple[dict[str, dict], set[str]]:
    """Return known root-file contracts and required stock filenames."""
    contracts: dict[str, dict] = {}
    required: set[str] = set()
    stock_entries = [entry for entry in manifest["sources"] if entry["script"] == "scripts/fetch_stocks.py"]
    if len(stock_entries) != 1:
        raise ValueError("manifest must contain one fetch_stocks.py entry")
    stock_contract = stock_entries[0]["output_contracts"].get(STOCK_TEMPLATE)
    if not isinstance(stock_contract, dict) or stock_contract.get("profile") != "ohlcv":
        raise ValueError("stock template needs an ohlcv output contract")
    for entry in manifest["sources"]:
        for output, contract in entry["output_contracts"].items():
            if output == STOCK_TEMPLATE:
                continue
            if output.startswith("data/") and "{" not in output and "*" not in output and len(Path(output).parts) == 2:
                filename = Path(output).name
                if filename in contracts and contracts[filename] != contract:
                    raise ValueError(f"conflicting contracts for {filename}")
                contracts[filename] = contract
    for stem in stock_stems(root):
        filename = f"{stem}.json"
        if filename in contracts and contracts[filename] != stock_contract:
            raise ValueError(f"stock output collides with another contract: {filename}")
        contracts[filename] = stock_contract
        required.add(filename)
    return contracts, required
