#!/usr/bin/env node
// 台股融資去槓桿警報 — 可重現回測 CLI。
//   node scripts/backtest_margin_delever.mjs                       # 依預設參數印出摘要
//   node scripts/backtest_margin_delever.mjs --out docs/research/margin-delever-alert-backtest.md
//   node scripts/backtest_margin_delever.mjs --json /tmp/r.json --lookback 252 --entry nextClose
// 引擎與網頁 tab 共用 js/tabs/marginalert_calc.mjs（單一來源）。離線，只讀 data/*.json，不寫 data/。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runFullBacktest, mergeRatio, DEFAULTS, CASES, fearAnalysis, singleDayFlags } from '../js/tabs/marginalert_calc.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const readData = f => JSON.parse(fs.readFileSync(path.join(ROOT, 'data', `${f}.json`), 'utf8'));

export function loadRaw() {
  const tw = readData('TWII'), mg = readData('taiwan_margin_total');
  const mm = readData('taiwan_margin_ratio_mm'), rc = readData('taiwan_margin_ratio');
  const merged = mergeRatio(mm.data, rc.data);
  // 2001-2007 融資餘額補遺檔與主檔以日期合併（主檔優先）；預設回測區間 2020 起，不受影響
  const earlyPath = path.join(ROOT, 'data', 'taiwan_margin_total_early.json');
  const early = fs.existsSync(earlyPath) ? readData('taiwan_margin_total_early').data : [];
  const have = new Set(mg.data.map(r => r.date));
  const margin = [...early.filter(r => !have.has(r.date)), ...mg.data].sort((a, b) => (a.date < b.date ? -1 : 1));
  return {
    raw: { twii: tw.data, margin, ratio: merged.rows, fearGreed: readData('fear_greed').data },
    meta: {
      twii: { updated: tw.updated, source: 'data/TWII.json（yfinance ^TWII 原始收盤，不含股息）' },
      margin: { updated: mg.updated, source: mg.source },
      ratio: { overlap: merged.overlap, maxAbsDiff: merged.maxAbsDiff, sources: [mm.source, rc.source], note: rc.note },
      marginRatioCross: crossCheck(mg.data, mm.data, rc.data),
    },
  };
}

function crossCheck(total, mm, rc) {
  const t = new Map(total.map(r => [r.date, r.margin_money]));
  let n = 0, bad = 0;
  for (const r of mm) if (t.has(r.date)) { n++; if (Math.abs(t.get(r.date) - r.margin_yi) > 1) bad++; }
  for (const r of rc) if (t.has(r.date)) { n++; if (Math.abs(t.get(r.date) - r.margin_yi) > 1) bad++; }
  return { compared: n, mismatched: bad };
}

// ── markdown helpers ────────────────────────────────────────────────
const f = (x, d = 1) => (x === null || x === undefined || !Number.isFinite(x) ? '—' : x.toFixed(d));
const sg = (x, d = 1) => (x === null || x === undefined || !Number.isFinite(x) ? '—' : (x > 0 ? '+' : '') + x.toFixed(d));
const neg = (x, d = 1) => (x === null || x === undefined || !Number.isFinite(x) ? '—' : `-${x.toFixed(d)}%`);
const row = cells => `| ${cells.join(' | ')} |`;
const table = (head, rows) => ['', row(head), row(head.map(() => '---')), ...rows.map(row)].join('\n');

function fwdCells(fw, hs = [5, 10, 20, 60]) {
  const out = [];
  for (const h of hs) {
    const s = fw[h];
    out.push(s && s.n ? `${sg(s.retMedian)}/${sg(s.retMean)}` : '—');
  }
  return out;
}

export function buildReport(res, meta) {
  const c = res.cfg, ds = res.ds, L = [];
  const th = c.thresholds;
  L.push(`# 台股融資去槓桿警報 — 歷史回測報告`);
  L.push(`\n> 由 \`node scripts/backtest_margin_delever.mjs --out …\` 產生，勿手改；結論見 [margin-delever-alert-recommendation.md](margin-delever-alert-recommendation.md)。`);
  L.push(`> 參數：區間 ${c.start}～${c.end}｜滾動高點 ${c.lookback} 日（敏感度另跑 252）｜事件冷卻 ${c.cooldown} 日｜進場 ${c.entry === 'nextOpen' ? '訊號隔日開盤' : '訊號隔日收盤'}｜R 最低指數跌幅 ${c.minIdxDrop}%`);

  // A
  L.push(`\n## A. 資料完整性與來源`);
  L.push(table(['項目', '內容'], [
    ['TAIEX', `${meta.twii.source}；${res.gaps.twiiRange.join('～')}；原 ${ds.rawCounts.twii} 列、有效 ${ds.rawCounts.twiiKept} 列；updated ${meta.twii.updated}`],
    ['上市融資餘額（億元）', `${meta.margin.source}；${res.gaps.marginRange.join('～')}；原 ${ds.rawCounts.margin} 列、有效 ${ds.rawCounts.marginKept} 列；updated ${meta.margin.updated}`],
    ['融資維持率（重建）', `TWSE MI_MARGN×MI_INDEX 逐檔重建（上市 only，含 ETF，非官方公布、非券商整戶口徑）；${res.gaps.ratioRange.join('～')}；兩個重建檔重疊 ${meta.ratio.overlap} 日，最大差 ${meta.ratio.maxAbsDiff}`],
    ['融資餘額交叉驗證', `與兩個維持率檔內的 margin_yi（TWSE MI_MARGN 彙總）逐日比對 ${meta.marginRatioCross.compared} 筆，差異 >1 億者 ${meta.marginRatioCross.mismatched} 筆`],
    ['成交量／金額', 'data/TWII.json 的 volume 欄為 0（yfinance 不提供），**無可靠成交量資料，本研究未使用**；資料缺口，不補造'],
    ['日期對齊', `TWII 缺而融資有：${res.gaps.marginOnly.join(', ') || '無'}；融資缺而 TWII 有：${res.gaps.twiiOnly.join(', ') || '無'}。缺口日不進入訊號日，也不補值`],
    ['訊號日數', `${ds.days.length} 個交易日（TWII ∩ 融資 ∩ 區間）`],
    ['上櫃', '完全不混入（data/tpex_margin.json 未使用）'],
  ]));
  L.push(`\n日期對齊註記：1 日變動各自在自己的交易日曆上計算（融資對前一個融資日、指數對前一個指數日）；N 日窗各自回推 N 個交易日；2021-04-06 TWII 缺一根，只影響該日前後少數窗口，且該日不當訊號日。`);

  // B
  L.push(`\n## B. 2020～2026 每年警報統計`);
  L.push(`門檻為**巢狀**：減 5% 的日子同時計入 2/3/4%。「日」＝觸發日數；「事」＝獨立事件（相隔超過 ${c.cooldown} 個交易日才算新事件）；「多日」＝該年內連續觸發≥2 日的事件數。`);
  L.push(table(['年', '交易日', ...th.map(t => `≥${t}% 日/事/多日`), '年內最大單日減幅', '當日指數', '當日距高點回撤'],
    res.annual.map(a => [a.year, a.tradingDays, ...th.map(t => `${a.byTh[t].days}/${a.byTh[t].events}/${a.byTh[t].multiDay}`),
      a.maxDrop ? `${f(a.maxDrop.pct, 2)}%（${a.maxDrop.date}）` : '—', a.maxDrop ? `${sg(a.maxDrop.idx1, 2)}%` : '—', a.maxDrop ? `-${f(a.maxDrop.dd)}%` : '—'])));
  L.push(`\n觸發日的指數表現（全部觸發日，不是只看事件首日）：`);
  L.push(table(['門檻', '觸發日', '獨立事件', '連續≥2日事件', '當日指數均值', '當日指數中位', '當日指數上漲數', `距${c.lookback}日高點回撤 均值/中位`, '事件首日回撤 均值/中位', '事件首日回撤<10% 的事件'],
    th.map(t => { const v = res.thresholds[t]; return [`≥${t}%`, v.flagDays, v.events.length, v.clusters2plus, `${sg(v.idx1Mean, 2)}%`, `${sg(v.idx1Median, 2)}%`, v.idxUpDays, `${f(v.ddMean)}%/${f(v.ddMedian)}%`, `${f(v.ddFirstEventMean)}%/${f(v.ddFirstEventMedian)}%`, v.ddFirstEventLt10]; })));
  const ext = ds.days.filter(d => d.m[1] <= -5);
  L.push(`\n單日減幅 ≥5% 的極端日（${ext.length} 日）：` + ext.map(d => `${d.date}（${f(d.m[1], 2)}%，指數${sg(d.x[1], 2)}%，回撤-${f(d.dd)}%）`).join('；'));

  // C D E
  const caseBlock = k => {
    const cs = res.cases.find(x => x.id === k);
    if (!cs) return;
    L.push(`\n### ${cs.label}（${cs.from}～${cs.to}）`);
    L.push(`- ${c.lookback}日高點 ${cs.peak.date} 收 ${f(cs.peak.close, 0)} → 區間最低收盤 ${cs.low.date} 收 ${f(cs.low.close, 0)}（回撤 -${f(cs.low.dd)}%，高→低 ${f(cs.peakToLowPct)}%）；最低盤中 ${cs.low.intradayLowDate} ${f(cs.low.intradayLow, 0)}`);
    if (cs.lowDateMatchesHint !== null) L.push(`- 指定低點 ${cs.lowHint}：${cs.lowDateMatchesHint ? '**資料驗證一致**（區間最低收盤即該日）' : `**與資料不一致**，資料低點為 ${cs.low.date}`}`);
    L.push(`- 融資高點 ${cs.marginHigh.date} ${f(cs.marginHigh.v, 0)} 億 → 其後最低 ${cs.marginLow.date} ${f(cs.marginLow.v, 0)} 億（${f(cs.marginPeakToLowPct)}%）`);
    L.push(`- 回撤首次達 5/10/15/20%：` + [5, 10, 15, 20].map(l => cs.ddCross[l] ? `${l}%＝${cs.ddCross[l].date}（距低點${cs.ddCross[l].td}日）` : `${l}%＝未達`).join('；'));
    const head = ['警報', '首次日期', '當日融資', '當日指數', '回撤', '距區間低點(交易日)', '觸發日收盤→低點收盤', '隔日進場 20日報酬', '進場後 60日最大回撤', '跌破警報日低點(20日內)'];
    const firstRows = (obj, tag) => [2, 3, 4, 5].map(t => { const v = obj[t]; if (!v) return [`${tag}≥${t}%`, '未觸發', '', '', '', '', '', '', '', '']; const h20 = v.fwd?.h?.[20], h60 = v.fwd?.h?.[60];
      return [`${tag}≥${t}%`, v.date, `${f(v.m1, 2)}%`, `${sg(v.idx1, 2)}%`, `-${f(v.dd)}%`, v.tdBeforeLow, `${sg(v.closeToLowPct)}%`, h20 ? `${sg(h20.ret)}%` : '—', h60 ? `${f(h60.mdd)}%` : '—', h20 ? (h20.breakLow ? '是' : '否') : '—']; });
    const wRows = Object.entries(cs.firstW).map(([k2, v]) => [k2 === '3d' ? '3日累積≤-5%' : '5日累積≤-8%', v ? v.date : '未觸發', v ? `${f(v.val, 2)}%` : '', '', v ? `-${f(v.dd)}%` : '', v ? v.tdBeforeLow : '', v ? `${sg(v.closeToLowPct)}%` : '', '', '', '']);
    L.push(table(head, [...firstRows(cs.first, '窗口內 '), ...(Object.keys(cs.firstSincePeak).length ? firstRows(cs.firstSincePeak, `自高點${cs.peak.date}起 `) : []), ...wRows]));
    if (Object.keys(cs.firstSincePeak).length) L.push(`- 注意：指定窗口起點 ${cs.from} 晚於波段高點 ${cs.peak.date}，窗口外（高點～窗口起點）已先出現警報，兩組都列出。`);
    const cv = cs.converge;
    L.push(`- 跌幅收斂（以 -3% 首次警報日 t 比較）：${cv ? `警報前 5 日（t-4..t）指數日跌幅均值 ${sg(cv.beforeMean, 2)}%、最差 ${f(cv.beforeWorst, 2)}%、≤-2% 的日數 ${cv.beforeDown2}；警報後 ${cv.afterN} 日（t+1..t+${cv.afterN}）均值 ${sg(cv.afterMean, 2)}%、最差 ${f(cv.afterWorst, 2)}%、≤-2% 的日數 ${cv.afterDown2}` : '無 -3% 警報'}`);
    L.push(`\n逐日（日期｜收盤｜指數日變動｜回撤｜融資億｜融資日變動%｜日變動億｜3日%｜5日%｜重建維持率）：\n`);
    L.push(table(['日期', '收盤', '指數%', '回撤%', '融資億', '融資%', '融資Δ億', '3日%', '5日%', '維持率'],
      cs.rows.map(r => [r.date, f(r.close, 0), sg(r.x1, 2), f(r.dd), f(r.margin, 0), sg(r.m1, 2), sg(r.dm1, 0), sg(r.m3, 1), sg(r.m5, 1), f(r.ratio, 1)])));
  };
  L.push(`\n## C. 2024/7～8 詳細事件分析`); caseBlock('A');
  L.push(`\n## D. 2026/7～8 詳細事件分析`); caseBlock('B');
  L.push(`\n## E. 壓力測試：2020/3 與 2025/4（不用於門檻設計）`); caseBlock('S1'); caseBlock('S2');

  // F
  L.push(`\n## F. 2%／3%／4%（及 5%）門檻比較`);
  L.push(`事件後表現欄位為「隔日${c.entry === 'nextOpen' ? '開盤' : '收盤'}進場」之持有報酬 中位/均值（%）。基準＝所有訊號日以相同規則進場。`);
  const baseRow = (name, b) => [name, b.n, '—', '—', ...fwdCells(b.forward), f(b.forward[60].mddMedian), '—'];
  L.push(table(['訊號', '觸發日', '獨立事件', '連續事件', '5日', '10日', '20日', '60日', '60日最大回撤中位', '20日內再破警報日低點'],
    [...th.map(t => { const v = res.thresholds[t]; return [`單日≤-${t}%`, v.flagDays, v.events.length, v.clusters2plus, ...fwdCells(v.forward), f(v.forward[60].mddMedian), `${f(v.forward[20].breakLowPct, 0)}%`]; }),
      baseRow('基準：所有交易日', res.baseline.all), baseRow('基準：回撤≥10%的日子', res.baseline.dd10), baseRow('基準：回撤≥15%的日子', res.baseline.dd15)]));
  L.push(`\n### F-1. 融資減幅 × 指數回撤閘門（警報日當時已知的 ${c.lookback} 日回撤 ≥ 閘門才算）`);
  L.push(`「波段命中」＝${res.waves.length} 個客觀下跌波段（見 F-2 末表）中，在「波段高點→波段結束」之間有觸發；距低點＝首次觸發到波段最低收盤的交易日數（負＝已過低點）；剩餘＝首次觸發日收盤→波段最低收盤。`);
  L.push(table(['融資', '回撤閘門', '觸發日', '獨立事件', '波段命中', '距低點 中位(日)', '剩餘跌幅 中位', '20日報酬 中/均', '60日最大回撤中位', '20日再破低'],
    res.gated.map(g => [`單日≤-${g.th}%`, g.gate ? `≥${g.gate}%` : '無', g.flagDays, g.events, `${g.waveHit}/${g.waveTotal}`, f(g.leadMedian, 0), sg(g.remainingMedian) + '%', fwdCells(g.forward, [20])[0], f(g.forward[60].mddMedian) + '%', f(g.forward[20].breakLowPct, 0) + '%'])));
  L.push(`\n### F-2. 指數回撤區間 vs 融資清洗（回撤用過去 ${c.lookback} 日最高收盤，當時已知）`);
  const bandTable = rows => table(['回撤區間', '交易日', '單日≤-2%', '單日≤-3%', '單日≤-4%', '連續2日≤-2%', '3日≤-5%', '5日≤-8%', '之後60日內再下跌(中位)', '(均值)', '距低點交易日(中位)'],
    rows.map(r => [r.label, r.n, ...[r.p2, r.p3, r.p4, r.consec2, r.m3_5, r.m5_8].map(v => `${f(v)}%`), `${f(r.remainMedian)}%`, `${f(r.remainMean)}%`, f(r.daysToLowMedian, 0)]));
  L.push(bandTable(res.bands120));
  L.push(`\n敏感度：252 日高點${c.lookback === 252 ? '（與上表相同）' : ''}\n`);
  L.push(bandTable(res.bands252));
  L.push(`\n客觀下跌波段（回撤≥${c.waveEnter}% 進入、<${c.waveExit}% 結束；${c.lookback}日高點）：`);
  L.push(table(['波段高點', '進入日', '波段低點', '結束日', '最大回撤'], res.waves.map(w => [w.peakDate, w.startDate, w.lowDate, w.endDate + (w.open ? '(未結束)' : ''), `-${f(w.maxDd)}%`])));

  // G
  L.push(`\n## G. 1～5 日融資快速收縮`);
  L.push(table(['窗口', '門檻', '觸發日', '獨立事件', '事件首日回撤中位', '5日', '10日', '20日', '60日', '60日最大回撤中位', '20日再破低'],
    res.windows.map(w => [`${w.N}日`, `≤-${w.th}%`, w.flagDays, w.events, `${f(w.ddFirstEventMedian)}%`, ...fwdCells(w.forward), f(w.forward[60].mddMedian), `${f(w.forward[20].breakLowPct, 0)}%`])));
  for (const md of [1, 0.5]) {
    L.push(`\nR／D（指數跌幅下限 ${md}%）— R=|融資變動|/|指數變動|，D=差（百分點）；指數上漲而融資下降＝「反彈中的去槓桿」，不套用 R：`);
    L.push(table(['窗口', '有效下跌樣本', 'R中位', 'D中位', 'R≥1', 'R≥1.5', 'R≥2', '反彈中去槓桿(日)', '20日報酬中位：全部有效/R≥1/R≥1.5/反彈中', '基準(全日)20日中位'],
      res.cfg.windows.map(N => { const v = res.rd[md][N]; return [`${N}日`, v.validFall, f(v.RMedian, 2), f(v.DMedian, 2), v.R_ge1, v.R_ge15, v.R_ge2, v.rebound, [v.fwd20_all, v.fwd20_R1, v.fwd20_R15, v.fwd20_rebound].map(x => sg(x)).join(' / '), sg(res.baseline.all.forward[20].retMedian)]; })));
  }

  // H
  L.push(`\n## H. 警報後 5/10/20/60 日市場表現（各獨立事件首日）`);
  L.push(`進場＝訊號日收盤後的下一交易日${c.entry === 'nextOpen' ? '開盤' : '收盤'}；最大回撤／反彈相對進場價；「再破底」＝持有期間任一日最低價 < 警報日最低價。`);
  for (const t of th) {
    const v = res.thresholds[t];
    L.push(`\n**單日融資≤-${t}%（獨立事件 ${v.events.length}）**\n`);
    L.push(table(['持有', 'n', '報酬均值', '報酬中位', '勝率', '最大回撤均值', '最大回撤中位', '最差回撤', '最大反彈中位', '再破底比例', '最低點距警報日(中位交易日)'],
      c.horizons.map(h => { const s = v.forward[h]; return [`${h}日`, s.n, sg(s.retMean) + '%', sg(s.retMedian) + '%', f(s.winRate, 0) + '%', f(s.mddMean) + '%', f(s.mddMedian) + '%', f(s.mddWorst) + '%', f(s.rallyMedian) + '%', f(s.breakLowPct, 0) + '%', f(s.daysToLowMedian, 0)]; })));
  }
  const t3 = res.thresholds[3];
  L.push(`\n**單日≤-3% 全部獨立事件明細**\n`);
  L.push(table(['事件首日', '融資%', '當日指數%', '回撤', '連續觸發日', '20日報酬', '20日最大回撤', '60日報酬', '60日最大回撤', '20日內再破低'],
    t3.events.map(e => { const h20 = e.fwd?.h?.[20], h60 = e.fwd?.h?.[60]; return [e.date, f(e.day.m[1], 2) + '%', sg(e.day.x[1], 2) + '%', '-' + f(e.day.dd) + '%', e.triggerDays, h20 ? sg(h20.ret) + '%' : '—', h20 ? f(h20.mdd) + '%' : '—', h60 ? sg(h60.ret) + '%' : '—', h60 ? f(h60.mdd) + '%' : '—', h20 ? (h20.breakLow ? '是' : '否') : '—']; })));

  // I
  L.push(`\n## I. 與原始 2/3 進場規則比較`);
  L.push(`A＝${c.lookback}日高點回撤≥${c.ruleDd}%；B＝重建維持率自${c.lookback}日高點降≥${c.ruleRatioDrop}個百分點（**重建值，非官方，僅供參考**）；C＝依列變體。≥2 項成立才列入候選。事件冷卻 ${c.ruleCooldown} 日。`);
  const ruleTable = rs => table(['變體', '候選日', '獨立事件', '重複度(日/事)', '波段命中', '首次觸發距波段低點(交易日 中位)', '首次觸發後到低點剩餘 中位', '首次觸發回撤 中位', '事件後20日報酬 中/均', '60日最大回撤中位', '20日再破低'],
    rs.map(r => [r.label, r.flagDays, r.events, f(r.dupRatio, 1), `${r.waveHit}/${r.waveTotal}`, f(r.leadMedian, 0), sg(r.remainingMedian) + '%', f(r.ddAtFirstMedian) + '%', fwdCells(r.forward, [20])[0], f(r.forward[60].mddMedian) + '%', f(r.forward[20].breakLowPct, 0) + '%']));
  L.push(`\n**2/3 規則（含重建 B）**\n`); L.push(ruleTable(res.rules2of3));
  L.push(`\n**僅 A∧C（不用 B，免依賴重建維持率）**\n`); L.push(ruleTable(res.rulesAC));
  L.push(`\n逐波段首次觸發（2/3 規則）：\n`);
  const waves = res.waves;
  L.push(table(['波段(高點→低點)', ...res.rules2of3.map(r => r.label)],
    waves.map((w, i) => [`${w.peakDate}→${w.lowDate}（-${f(w.maxDd)}%）`, ...res.rules2of3.map(r => { const p = r.perWave[i]; return p.hit ? `${p.date}（距低${p.daysBeforeLow}日，剩${sg(p.remainingPct)}%）` : '未觸發'; })])));
  L.push(`\n逐波段首次觸發（A∧C，無 B）：\n`);
  L.push(table(['波段(高點→低點)', ...res.rulesAC.map(r => r.label)],
    waves.map((w, i) => [`${w.peakDate}→${w.lowDate}（-${f(w.maxDd)}%）`, ...res.rulesAC.map(r => { const p = r.perWave[i]; return p.hit ? `${p.date}（距低${p.daysBeforeLow}日，剩${sg(p.remainingPct)}%）` : '未觸發'; })])));

  // K
  L.push(`\n## K. 恐懼貪婪指數（CNN）× 融資去槓桿`);
  L.push(`F&G 0–100，< 門檻視為恐懼區（預設 15，可調 5～25）；只用當日值、缺值日不計；範圍 ${res.gaps.fgRange.join('～')}（CNN 2011 起，無法更早）。警報＝單日融資≤-3%。「相對」＝恐懼日裡警報發生率是否明顯高於非恐懼日（lift>1）。`);
  const sweep = [5, 10, 15, 20, 25].map(thr => fearAnalysis(ds, thr, singleDayFlags(ds, 3), c));
  L.push(table(['F&G <', '恐懼日', '占比', 'P(警報|恐懼)', 'P(警報|非恐懼)', 'lift', '警報日在恐懼區', '警報事件首日已在恐懼區(含前5日)', '事件首日 F&G 中位'],
    sweep.map(a => [`<${a.thr}`, a.fearDays, f(a.fearShare) + '%', f(a.pAlarmGivenFear) + '%', f(a.pAlarmGivenNot) + '%', f(a.lift, 1), `${a.alarmDaysInFear}/${a.alarmDays}（${f(a.pFearGivenAlarm, 0)}%）`, `${a.eventsNearFear}/${a.eventsKnown}`, f(a.fgMedianAtEvent, 1)])));
  const fa = res.fear;
  L.push(`\n逐波段（F&G<${fa.thr}；回撤≥${c.waveEnter}% 波段）：F&G 最低點與波段低點的時間差（負＝F&G 先到底）、首次進入恐懼區與首次 -3% 警報距波段低點幾個交易日：\n`);
  L.push(table(['波段(高點→低點)', '最大回撤', 'F&G 最低(日期)', '最低日距波段低點(交易日)', '首次進恐懼區(日期)', '距低點(日)', '首次-3%警報(日期)', '距低點(日)', '波段內恐懼日', '波段內警報日'],
    fa.waves.map(w => [`${w.peakDate}→${w.lowDate}`, neg(w.maxDd), w.fgMin === null ? '—' : `${f(w.fgMin, 1)}（${w.fgMinDate}）`, w.fgMinToLowTd ?? '—', w.firstFearDate ?? '未進入', w.firstFearToLowTd ?? '—', w.firstAlarmDate ?? '未觸發', w.firstAlarmToLowTd ?? '—', w.fearDaysInWave, w.alarmDaysInWave])));
  L.push(`\n## 重現\n\n\`\`\`bash\nnode scripts/backtest_margin_delever.mjs --out docs/research/margin-delever-alert-backtest.md\nnpm test   # 含引擎單元測試\n\`\`\`\n網頁版：導覽「融資去槓桿警報」可調參數即時重跑。`);
  return L.join('\n') + '\n';
}

function parseArgs(argv) {
  const a = {};
  for (let i = 0; i < argv.length; i++) if (argv[i].startsWith('--')) a[argv[i].slice(2)] = argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : true;
  return a;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = parseArgs(process.argv.slice(2));
  const cfg = {};
  for (const k of ['start', 'end', 'entry']) if (args[k]) cfg[k] = args[k];
  for (const k of ['lookback', 'cooldown', 'minIdxDrop']) if (args[k]) cfg[k] = Number(args[k]);
  const { raw, meta } = loadRaw();
  const res = runFullBacktest(raw, cfg);
  const md = buildReport(res, meta);
  if (args.out) { fs.mkdirSync(path.dirname(path.resolve(args.out)), { recursive: true }); fs.writeFileSync(args.out, md); console.log(`wrote ${args.out}`); }
  else process.stdout.write(md);
  if (args.json) {
    const slim = { ...res, ds: undefined };
    fs.writeFileSync(args.json, JSON.stringify(slim, null, 1));
    console.log(`wrote ${args.json}`);
  }
}
void DEFAULTS; void CASES;
