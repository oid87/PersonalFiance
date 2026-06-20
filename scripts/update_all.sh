#!/bin/bash
# 每日資料更新 — git pull → 跑所有 fetch 腳本 → 有變動就 push

SCRIPTS_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT_DIR="$(dirname "$SCRIPTS_DIR")"

log() { echo "[$(date '+%Y-%m-%d %H:%M:%S')] $*"; }

log "=== 開始更新 ==="

# 1. 先拉最新（GitHub Actions 可能已經 push）
cd "$ROOT_DIR"
log "git pull..."
git pull --rebase --autostash origin main 2>&1 || log "git pull 失敗，繼續執行"

# 2. 跑所有 fetch 腳本
cd "$SCRIPTS_DIR"
log "fetch_stocks..."
PYTHON=/opt/homebrew/Caskroom/miniconda/base/bin/python3
$PYTHON fetch_stocks.py
$PYTHON fetch_leverage.py      || true
$PYTHON fetch_fear_greed.py    || true
$PYTHON fetch_aaii.py          || true
$PYTHON fetch_taiwan_pcratio.py || true
$PYTHON fetch_taiwan_fut_inst.py || true
$PYTHON fetch_taiwan_margin_total.py || true
$PYTHON compute_taiwan_sentiment.py || true
$PYTHON fetch_yields.py        || true
$PYTHON fetch_breadth.py       || true
$PYTHON fetch_cape.py          || true
$PYTHON fetch_sp500_pe.py      || true
$PYTHON fetch_qqq_valuation.py || true
$PYTHON fetch_spy_valuation.py  || true
$PYTHON fetch_soxx_valuation.py || true
$PYTHON fetch_tw_valuation.py   || true
$PYTHON fetch_mags_valuation.py || true
$PYTHON fetch_investor_conf.py || true
$PYTHON fetch_earnings.py      || true
$PYTHON fetch_sector_holdings.py || true
$PYTHON compute_sentiment.py   || true

# 3. 先驗資料完整性（衝突標記 / 壞 JSON / 行數暴跌就擋下，不 commit）
cd "$ROOT_DIR"
if ! $PYTHON scripts/validate_data.py; then
  log "資料驗證失敗，跳過 commit（請人工檢查 data/）"
  exit 1
fi

# 4. 有變動就 commit + push
if ! git diff --quiet data/; then
  log "資料有更新，commit + push..."
  git add data/
  git commit -m "data: local update $(date '+%Y-%m-%d %H:%M')"
  git push origin main 2>&1 || log "push 失敗（可能 Actions 也在推，下次會自動 rebase）"
else
  log "資料無變動，跳過 push"
fi

log "=== 完成 ==="
