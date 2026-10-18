"""Independent pandas/numpy oracle for the frozen daily VIX study. No network."""
import json
import math
import subprocess
import sys
from pathlib import Path
from tempfile import TemporaryDirectory
import numpy as np
import pandas as pd

ROOT = Path(__file__).resolve().parents[2]
bundle = json.loads((ROOT / 'data/us_risk_observations.json').read_text())

def latest(key):
    rows = sorted(bundle['series'][key]['records'], key=lambda r: r['observed_at'])
    table = pd.DataFrame([dict(date=r['date'], **r['values']) for r in rows])
    return table.drop_duplicates('date', keep='last').set_index('date').sort_index()

spy, qqq, vix = latest('SPY'), latest('QQQ'), latest('VIX')['value']
axis = spy.index.union(qqq.index).sort_values()

def good(frame):
    return ((frame > 0).all(axis=1) & frame.notna().all(axis=1) & (frame.low <= frame[['open','close']].min(axis=1)) & (frame.high >= frame[['open','close']].max(axis=1)))

checked = []
with TemporaryDirectory() as temp:
    for asset, prices in [('SPY', spy), ('QQQ', qqq)]:
        price = prices.reindex(axis)
        valid = good(price)
        # mask invalid bars BEFORE rolling, so any invalid bar makes its 120-row window unavailable
        dd = (1 - price.close / price.close.where(valid).rolling(120, min_periods=120).max()) * 100
        eligible = (axis >= '2020-01-01') & valid & dd.notna() & vix.reindex(axis).notna()
        for horizon in [5, 10, 20, 60]:
            config = dict(asset=asset, dataMode='historical', mode='vix', threshold=30, gate=8, horizon=horizon)
            output = Path(temp) / 'result.json'
            subprocess.run(['node', 'scripts/research/backtest_us_risk.mjs', '--config', json.dumps(config), '--out', str(output)], cwd=ROOT, check=True, capture_output=True)
            result = json.loads(output.read_text())
            flags = np.flatnonzero(eligible & (dd >= 8) & (vix.reindex(axis) >= 30))
            selected, last = [], -10**9
            for index in flags:
                if index - last >= 10:
                    selected.append(index); last = index
            assert [axis[i] for i in selected] == [e['date'] for e in result['events']]
            assert int(eligible.sum()) == result['coverage']['eligibleDays']
            returns = []
            for index, event in zip(selected, result['events']):
                if index + horizon >= len(axis):
                    assert event['outcome']['status'] == 'rightCensored'; continue
                segment = price.iloc[index + 1:index + 1 + horizon]
                if not valid.iloc[index] or not good(segment).all():
                    assert event['outcome']['status'] == 'badPrice'; continue
                anchor = segment.open.iloc[0]
                ret = (segment.close.iloc[-1] / anchor - 1) * 100
                loss = min(0, (segment.low.min() / anchor - 1) * 100)
                close_path = np.r_[anchor, segment.close.to_numpy()]
                mdd = np.min((close_path / np.maximum.accumulate(close_path) - 1) * 100)
                for key, expected in [('return', ret), ('maxLoss', loss), ('mdd', mdd)]:
                    assert math.isclose(event['outcome'][key], expected, abs_tol=1e-9), (key, event['date'])
                assert event['outcome']['rebreak'] == bool((segment.low < price.low.iloc[index]).any())
                returns.append(ret)
            assert result['stats']['N'] == len(returns)
            assert math.isclose(result['stats']['return']['median'], float(np.median(returns)), abs_tol=1e-9)
            checked.append(dict(asset=asset, horizon=horizon, events=len(selected), complete=len(returns), median=float(np.median(returns))))
    # The real first capture occurred after every trading day in the frozen archive.
    output = Path(temp) / 'strict.json'
    subprocess.run(['node','scripts/research/backtest_us_risk.mjs','--out',str(output)],cwd=ROOT,check=True,capture_output=True)
    strict = json.loads(output.read_text())
    if all(r['date'] < r['observed_at'][:10] for r in bundle['series']['QQQ']['records']):
        assert strict['coverage']['eligibleDays'] == 0
        assert strict['stats']['N'] == 0
print(json.dumps({'pass':True, 'method':'independent pandas rolling / numpy path oracle; historical non-PIT only', 'checks':checked}, ensure_ascii=False, indent=2))
