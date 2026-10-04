#!/usr/bin/env bash
# Local preview refresh. Never switches branches or discards data.
set -u
SCRIPTS_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(dirname "$SCRIPTS_DIR")"
PYTHON="${PYTHON:-python3}"
DRY_RUN=0
SYNC_DATA=0
for arg in "$@"; do
  case "$arg" in
    --dry-run) DRY_RUN=1 ;;
    --sync-data) SYNC_DATA=1 ;;
    *) echo "Unknown option: $arg" >&2; exit 2 ;;
  esac
done
command -v "$PYTHON" >/dev/null 2>&1 || { echo "Python unavailable: $PYTHON" >&2; exit 2; }
failures=()
run_script() {
  local kind="$1" script="$2"
  if (( DRY_RUN )); then echo "DRY-RUN $kind: $script"; return 0; fi
  if ! (cd "$SCRIPTS_DIR" && "$PYTHON" "$script"); then
    echo "FAILED $kind: $script" >&2
    failures+=("$kind:$script")
    [[ "$kind" == required ]] && return 1
  fi
}
if (( SYNC_DATA )); then
  if [[ "$(git -C "$ROOT_DIR" branch --show-current)" != main ]]; then
    echo "Refusing sync: checkout is not on main" >&2
    exit 2
  fi
  if [[ -n "$(git -C "$ROOT_DIR" status --porcelain --untracked-files=all -- data/)" ]]; then
    echo "Refusing sync: data/ has uncommitted or untracked changes" >&2
    exit 2
  fi
  if (( DRY_RUN )); then
    echo "DRY-RUN sync: git pull --ff-only origin main"
  else
    git -C "$ROOT_DIR" pull --ff-only origin main || exit 1
  fi
fi
run_script required fetch_stocks.py || exit 1
run_script optional prep_relstrength.py
run_script optional prep_vxnvix.py
run_script optional fetch_leverage.py
run_script optional fetch_fear_greed.py
run_script optional fetch_aaii.py
run_script optional fetch_taiwan_pcratio.py
run_script optional fetch_taifex_foreign_oi.py
run_script optional fetch_taiwan_opt_inst.py
run_script optional fetch_taiwan_fut_inst.py
run_script optional fetch_taiwan_retail_ls.py
run_script optional fetch_taiwan_basis.py
run_script optional fetch_taiwan_margin_total.py
run_script optional fetch_tdcc_holders.py
run_script optional fetch_tw_daytrading.py
run_script optional fetch_margin_concentration.py
run_script optional fetch_taiwan_margin_ratio.py
run_script optional fetch_margin_costmap.py
run_script optional fetch_tpex_margin.py
run_script optional fetch_twse_mktcap.py
run_script optional fetch_taiwan_investors.py
run_script optional fetch_taiwan_mktcap_anchor.py
run_script optional compute_taiwan_margin_mktcap.py
run_script optional compute_taiwan_sentiment.py
run_script optional fetch_taiwan_business_signal.py
run_script optional fetch_taiwan_sector_index.py
run_script optional fetch_yields.py
run_script optional fetch_breadth.py
run_script optional fetch_sp500_ad.py
run_script optional fetch_breadth_ndx.py
run_script optional fetch_breadth_xlg.py
run_script optional fetch_breadth_tw50.py
run_script optional fetch_cape.py
run_script optional fetch_sp500_pe.py
run_script optional fetch_qqq_valuation.py
run_script optional fetch_spy_valuation.py
run_script optional fetch_wsj_pe.py
run_script optional fetch_soxx_valuation.py
run_script optional fetch_tw_valuation.py
run_script optional fetch_mags_valuation.py
run_script optional fetch_investor_conf.py
run_script optional fetch_earnings.py
run_script optional fetch_sector_holdings.py
run_script optional compute_sentiment.py
run_script optional fetch_cftc_positions.py
run_script optional fetch_cboe_putcall.py
run_script optional fetch_bullbear.py
run_script optional fetch_liquidity.py
run_script optional fetch_taiwan_money_supply.py
run_script optional fetch_liquidity_leverage.py
run_script optional fetch_vix_skew.py
run_script optional fetch_putcall.py
run_script optional fetch_finra_short.py
run_script optional fetch_fsi.py
run_script optional fetch_nfci.py
run_script optional fetch_stlfsi_kcfsi.py
run_script optional fetch_usdtwd.py
run_script optional compute_taiwan_stress.py
run_script optional fetch_umich.py
run_script optional fetch_flows.py
run_script optional fetch_qqq_sector_flows.py
run_script optional fetch_inflation_exp.py
run_script optional fetch_credit.py
run_script optional fetch_bdc.py
run_script optional fetch_tw_sector_flow.py
run_script optional fetch_banini.py
run_script optional fetch_net_liquidity.py
run_script optional fetch_yield_curve.py
run_script optional fetch_vix_term.py
run_script optional fetch_real_rates.py
run_script optional fetch_money_market.py
run_script optional fetch_usdliq.py
run_script optional fetch_central_banks.py
run_script optional fetch_infl_nowcast.py
run_script optional fetch_cpi.py
run_script optional fetch_margin_cost.py
run_script optional fetch_margin_cn.py
run_script optional fetch_margin_jp.py
run_script optional fetch_margin_us.py
run_script optional fetch_margin_kr.py
run_script optional fetch_gdp_productivity.py
run_script optional fetch_usrec.py
run_script optional fetch_tw_jp_kr_gdp.py
run_script optional fetch_tw_semi_valuation.py
# Macro is an optional atomic source; never clean or restore its archive here.
run_script optional fetch_us_macro_diagnostic.py
if (( DRY_RUN )); then
  echo "DRY-RUN optional: validate_us_macro.py"
  echo "DRY-RUN optional: capture_us_macro_diagnostic.mjs"
  echo "DRY-RUN required: validate_data.py"
  exit 0
fi
(cd "$ROOT_DIR" && "$PYTHON" scripts/validate_us_macro.py) || failures+=("optional:validate_us_macro.py")
if macro_as_of="$(cd "$ROOT_DIR" && "$PYTHON" -c 'import json; print(json.load(open("data/us_macro_diagnostic.json"))["as_of"])')"; then
  (cd "$ROOT_DIR" && node scripts/capture_us_macro_diagnostic.mjs --as-of "$macro_as_of") || failures+=("optional:capture_us_macro_diagnostic.mjs")
else
  failures+=("optional:macro_as_of")
fi
(cd "$ROOT_DIR" && node scripts/validate_us_macro_diagnostic_snapshots.mjs) || failures+=("optional:validate_us_macro_diagnostic_snapshots.mjs")
(cd "$ROOT_DIR" && "$PYTHON" scripts/validate_data.py) || failures+=("required:validate_data.py")
if (( ${#failures[@]} )); then
  printf 'Refresh failures: %s\n' "${failures[@]}" >&2
  for failure in "${failures[@]}"; do [[ "$failure" == required:* ]] && exit 1; done
fi
echo "Local data refresh complete. Optional failures: ${#failures[@]}"
