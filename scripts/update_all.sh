#!/bin/bash
# 本地資料更新（preview 用）— 同步 → 跑所有 fetch 腳本 → 刷新 data/。
# ⚠️ 不 commit / 不 push：data/ 由 GitHub Action 單一寫入，避免本地與 Action 雙寫造成 git 分歧 / detached HEAD。

SCRIPTS_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT_DIR="$(dirname "$SCRIPTS_DIR")"

log() { echo "[$(date '+%Y-%m-%d %H:%M:%S')] $*"; }

log "=== 開始更新 ==="

# 1. 同步到 Action 的最新 data（丟掉上次本地刷新的 data/ 以便乾淨 ff；不動未提交的 code）
cd "$ROOT_DIR"
git checkout main >/dev/null 2>&1 || true        # 永遠在 main 上操作，不要 detached
git checkout -- data/ 2>/dev/null || true        # 丟棄上次本地刷新的 data/（避免擋住 fast-forward）
log "git pull --ff-only..."
git pull --ff-only origin main 2>&1 || log "非 fast-forward（本地有未提交 code？），跳過同步、直接刷新"

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
$PYTHON fetch_taiwan_margin_ratio.py || true
$PYTHON fetch_taiwan_investors.py || true
$PYTHON fetch_taiwan_mktcap_anchor.py || true
$PYTHON compute_taiwan_margin_mktcap.py || true
$PYTHON compute_taiwan_sentiment.py || true
$PYTHON fetch_taiwan_business_signal.py || true
$PYTHON fetch_taiwan_sector_index.py   || true
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
$PYTHON fetch_bullbear.py      || true
$PYTHON fetch_liquidity.py     || true
$PYTHON fetch_taiwan_money_supply.py || true
$PYTHON fetch_vix_skew.py      || true
$PYTHON fetch_fsi.py           || true
$PYTHON fetch_usdtwd.py        || true
$PYTHON compute_taiwan_stress.py || true
$PYTHON fetch_umich.py         || true
$PYTHON fetch_flows.py         || true
$PYTHON fetch_credit.py        || true
$PYTHON fetch_bdc.py           || true
$PYTHON fetch_tw_sector_flow.py || true
$PYTHON fetch_banini.py        || true

# 3. 資料完整性快檢（純警告；本地不 commit 所以不擋流程）
cd "$ROOT_DIR"
$PYTHON scripts/validate_data.py || log "⚠️ 本地資料驗證有問題，請檢查 data/"

# 4. 刻意不 commit / 不 push —— data/ 由 GitHub Action 單一負責發佈（單一寫入者）
log "本地 data/ 已刷新供 preview。"
log "data/ 由 GitHub Action（每日美股 / 台股收盤後）單獨 commit+push；本地不推，避免雙寫分歧。"
log "若真要手動發佈：自行 git add data/ && git commit && git push（確認沒跟 Action 撞）。"

log "=== 完成 ==="
