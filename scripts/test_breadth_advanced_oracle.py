"""Independent stdlib oracle; synthetic fixtures only, no network or market data writes.
Run from repository root: python3 scripts/test_breadth_advanced_oracle.py
"""
import copy
import json
import math
from pathlib import Path
import statistics
import subprocess

ROOT = Path(__file__).resolve().parents[1]
HORIZONS = [5, 10, 21, 42, 63, 126, 252]


def node_json(code, data=None):
    result = subprocess.run(['node', '--input-type=module', '-e', code], cwd=ROOT,
                            input=None if data is None else json.dumps(data), text=True,
                            capture_output=True, check=True)
    return json.loads(result.stdout)


def expected_context(bundle):
    prices = bundle['benchmark']['data']
    sp = {r['date']: r for r in bundle.get('sp500', {}).get('data', [])}
    ny = {r['date']: r for r in bundle.get('nyse', {}).get('data', [])}
    seed = bundle.get('nyse', {}).get('seed')
    ratio = bundle.get('nyse', {}).get('variant') == 'ratio'
    fast = seed['ema19'] if seed else None
    slow = seed['ema39'] if seed else None
    summation = seed['summation'] if seed else None
    started = broken = False
    observations = 0
    ad_segment = []
    sessions = []
    for price in prices:
        row = sp.get(price['date'])
        valid = row is not None and row['advances'] is not None
        if valid:
            ad_segment.append((ad_segment[-1] if ad_segment else 0) + row['advances'] - row['declines'])
            ad = ad_segment[-1]
            ma = statistics.mean(ad_segment[-200:]) if len(ad_segment) >= 200 else None
        else:
            ad_segment = []
            ad = ma = None
        row = ny.get(price['date'])
        valid = row is not None and row['advances'] is not None
        if valid and ratio and row['advances'] + row['declines'] == 0:
            valid = False
        # Series start is its first recorded date, including explicit missing rows.
        first_date = bundle.get('nyse', {}).get('data', [{}])[0].get('date') if ny else None
        if first_date is not None and price['date'] >= first_date:
            started = True
        osc = si = None
        if started and not valid:
            broken = True
        if started and valid and not broken:
            net = row['advances'] - row['declines']
            if ratio:
                net = 1000 * net / (row['advances'] + row['declines'])
            if fast is None:
                fast = slow = net
                summation = 0
            else:
                fast = .1 * net + .9 * fast
                slow = .05 * net + .95 * slow
                summation += fast - slow
            observations += 1
            osc, si = fast - slow, summation
        ready = si is not None and observations >= 252
        sessions.append(dict(date=price['date'], close=price['close'], ad=ad, adMA200=ma,
                             oscillator=osc, summation=si, mcReady=ready,
                             mcCalibrated=bool(seed) and ready))
    eligible = {k: [] for k in ['ad', 'mc', 'joint']}
    signals = {k: [] for k in eligible}
    ad_idx, mc_idx = [], []
    for i, s in enumerate(sessions):
        window = sessions[i-252:i+1] if i >= 252 else []
        if len(window) == 253 and s['close'] is not None:
            if all(x['adMA200'] is not None for x in window):
                eligible['ad'].append(s['date'])
                if s['ad'] < s['adMA200'] and all(x['ad'] > x['adMA200'] for x in window[:-1]):
                    ad_idx.append(i)
                    signals['ad'].append(s['date'])
            if all(x['mcCalibrated'] for x in window):
                eligible['mc'].append(s['date'])
                if s['summation'] < -500 and all(x['summation'] >= -500 for x in window[:-1]):
                    mc_idx.append(i)
                    signals['mc'].append(s['date'])
    eligible_sets = {k: set(v) for k, v in eligible.items()}
    joint_evidence = []
    for i, s in enumerate(sessions):
        if i < 5 or s['close'] is None:
            continue
        if all(x['date'] in eligible_sets['ad'] and x['date'] in eligible_sets['mc'] for x in sessions[i-5:i+1]):
            eligible['joint'].append(s['date'])
            ads = [j for j in ad_idx if j <= i]
            mcs = [j for j in mc_idx if j <= i]
            if (i in ad_idx or i in mc_idx) and ads and mcs and abs(ads[-1] - mcs[-1]) <= 5:
                signals['joint'].append(s['date'])
                joint_evidence.append((s['date'], sessions[ads[-1]]['date'], sessions[mcs[-1]]['date'], abs(ads[-1]-mcs[-1])))
    # Independently count absent/invalid observations only within each supplied
    # series' observed coverage start through the benchmark tail. Empty series
    # have no start. Count every actual hole, not the invalidated calculation tail.
    first_sp = min(sp) if sp else None
    first_ny = min(ny) if ny else None
    missing_sp = sum(
        r['date'] >= first_sp and
        (r['date'] not in sp or sp[r['date']]['advances'] is None)
        for r in prices) if sp else 0
    missing_ny = sum(
        r['date'] >= first_ny and
        (r['date'] not in ny or ny[r['date']]['advances'] is None or
         (ratio and ny[r['date']]['advances'] + ny[r['date']]['declines'] == 0))
        for r in prices) if ny else 0
    diagnostics = {'missingSp500': missing_sp, 'missingNyse': missing_ny,
                   'mcInvalidated': broken}
    return sessions, eligible, signals, joint_evidence, diagnostics


def outcomes(prices, index, horizon):
    if index + horizon >= len(prices):
        return None
    values = [r['close'] for r in prices[index:index+horizon+1]]
    if any(v is None for v in values):
        return None
    peak, mdd = values[0], 0
    for price in values:
        peak = max(peak, price)
        mdd = min(mdd, 100 * (price/peak-1))
    return (100 * (values[-1]/values[0]-1), min(0, *[100 * (v/values[0]-1) for v in values]), mdd)


def stats(values):
    good = [x for x in values if x is not None]
    result = {'n': len(good), 'winRate': 100 * sum(x[0] > 0 for x in good) / len(good) if good else None}
    for index, avg, med, worst in [(0,'mean','median',None),(1,'meanMaxLoss','medianMaxLoss','worstMaxLoss'),(2,'meanMdd','medianMdd','worstMdd')]:
        column = [x[index] for x in good]
        result[avg] = statistics.mean(column) if column else None
        result[med] = statistics.median(column) if column else None
        if worst:
            result[worst] = min(column) if column else None
    return result


def same(actual, expected, label):
    if isinstance(expected, float):
        assert isinstance(actual, (float,int)) and math.isclose(actual, expected, abs_tol=1e-8, rel_tol=1e-10), (label, actual, expected)
    else:
        assert actual == expected, (label, actual, expected)


def verify(bundle, label):
    actual = node_json("""
import fs from 'node:fs';
import {buildAdvancedContext} from './js/tabs/breadthAdvanced.mjs';
import {evaluateEventStudy} from './js/utils/eventStudy.mjs';
const bundle=JSON.parse(fs.readFileSync(0,'utf8'));
const context=buildAdvancedContext(bundle);
const studies=Object.fromEntries(['ad','mc','joint'].map(key=>[key,evaluateEventStudy({prices:context.prices,events:context.signals[key],eligibleDates:context.eligibleDates[key]})]));
console.log(JSON.stringify({context,studies}));
""", bundle)
    sessions, eligible, signals, joint, diagnostics = expected_context(bundle)
    for field in ['missingSp500', 'missingNyse', 'mcInvalidated']:
        same(actual['context']['diagnostics'][field], diagnostics[field], f'{label}/diagnostics/{field}')
    for i, expected in enumerate(sessions):
        for key, value in expected.items():
            same(actual['context']['sessions'][i][key], value, f'{label}/session{i}/{key}')
    for key in signals:
        same([e['date'] for e in actual['context']['signals'][key]], signals[key], f'{label}/{key}/dates')
        same(actual['context']['eligibleDates'][key], eligible[key], f'{label}/{key}/eligible')
    same([(e['date'],e['adDate'],e['mcDate'],e['lagSessions']) for e in actual['context']['signals']['joint']], joint, f'{label}/joint/evidence')
    prices = bundle['benchmark']['data']
    indexes = {r['date']: i for i,r in enumerate(prices)}
    for key in signals:
        kept, previous = [], -100000
        for date in signals[key]:
            if indexes[date] - previous >= 20:
                kept.append(date)
                previous = indexes[date]
        study = actual['studies'][key]
        same([e['date'] for e in study['events']], kept, f'{label}/{key}/cooldown')
        for horizon, found in zip(HORIZONS, study['stats']):
            expected_stats = stats([outcomes(prices,indexes[d],horizon) for d in kept])
            baseline = stats([outcomes(prices,indexes[d],horizon) for d in eligible[key]])
            for field, value in expected_stats.items():
                same(found[field], value, f'{label}/{key}/{horizon}/{field}')
            for field, value in baseline.items():
                same(found['baseline'][field], value, f'{label}/{key}/{horizon}/baseline/{field}')
    return {'case': label, 'sessions': len(sessions), 'rawEvents': {k: len(v) for k,v in signals.items()},
            'eventDates': signals, 'jointEvidence': joint, 'diagnostics': diagnostics,
            'stats63': {k: next(s for s in actual['studies'][k]['stats'] if s['horizon']==63) for k in signals}}


def main():
    fixture = node_json("import {makeAdvancedFixture} from './scripts/fixtures/breadth_advanced_fixture.mjs'; console.log(JSON.stringify(makeAdvancedFixture()));")
    cases = [('ratio',fixture)]
    raw = copy.deepcopy(fixture)
    raw['nyse']['variant'] = 'raw'
    cases.append(('raw',raw))
    no_seed = copy.deepcopy(fixture)
    no_seed['nyse']['seed'] = None
    cases.append(('uncalibrated',no_seed))
    gap = copy.deepcopy(fixture)
    gap['nyse']['data'][600].update(advances=None, declines=None, unchanged=None)
    gap['sp500']['data'][600].update(advances=None, declines=None, unchanged=None)
    cases.append(('missing-session',gap))
    staggered = copy.deepcopy(fixture)
    staggered['benchmark']['data'] = staggered['benchmark']['data'][:300]
    staggered['sp500']['data'] = staggered['sp500']['data'][100:300]
    staggered['nyse']['data'] = staggered['nyse']['data'][250:300]
    staggered['nyse']['seed']['date'] = staggered['benchmark']['data'][249]['date']
    cases.append(('staggered-starts', staggered))
    staggered_gaps = copy.deepcopy(staggered)
    for key in ['sp500', 'nyse']:
        staggered_gaps[key]['data'][0].update(advances=None, declines=None, unchanged=None)
        del staggered_gaps[key]['data'][10]
        staggered_gaps[key]['data'].pop()
    cases.append(('staggered-starts-with-gaps', staggered_gaps))
    empty_series = copy.deepcopy(staggered)
    for key in ['sp500', 'nyse']:
        empty_series[key]['data'] = []
    empty_series['nyse']['seed'] = None
    cases.append(('empty-series', empty_series))
    absent_series = copy.deepcopy(staggered)
    del absent_series['nyse']
    cases.append(('absent-nyse', absent_series))
    zero_ratio = copy.deepcopy(staggered)
    zero_ratio['nyse']['data'][10].update(advances=0, declines=0, unchanged=2000)
    cases.append(('ratio-zero-denominator', zero_ratio))
    zero_raw = copy.deepcopy(zero_ratio)
    zero_raw['nyse']['variant'] = 'raw'
    cases.append(('raw-all-unchanged', zero_raw))
    results = [verify(bundle,label) for label,bundle in cases]
    by_case = {result['case']: result['diagnostics'] for result in results}
    for label in ['staggered-starts', 'empty-series', 'absent-nyse', 'raw-all-unchanged']:
        assert by_case[label] == {'missingSp500': 0, 'missingNyse': 0, 'mcInvalidated': False}
    assert by_case['staggered-starts-with-gaps'] == {'missingSp500': 3, 'missingNyse': 3, 'mcInvalidated': True}
    assert by_case['ratio-zero-denominator'] == {'missingSp500': 0, 'missingNyse': 1, 'mcInvalidated': True}
    assert all(results[0]['rawEvents'][k] > 0 for k in ['ad','mc','joint']), 'fixture must exercise all signals'
    print(json.dumps({'result':'PASS','scope':'synthetic independent Python oracle; not real market evidence','cases':results},ensure_ascii=False,indent=2))


if __name__ == '__main__':
    main()
