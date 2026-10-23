// 極端狀態儀表板 — 可重現回測。Usage:
//   node scripts/research/backtest_nonnormal.mjs                 （印到 stdout）
//   node scripts/research/backtest_nonnormal.mjs --out docs/research/nonnormal-dashboard-backtest.md
// 引擎 js/tabs/nonnormal_calc.mjs；只讀 repo 的 data/*.json，不抓資料。參數全部事前固定（課程原文或本專案定義），
// 沒有針對案例調整；課程案例是驗收，不是訓練集。描述性研究，不產生買賣指令。
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import * as N from '../../js/tabs/nonnormal_calc.mjs';

const root = new URL('../../', import.meta.url);
const rows = f => (existsSync(new URL('data/' + f, root)) ? JSON.parse(readFileSync(new URL('data/' + f, root), 'utf8')).data || [] : []);
const raw = Object.fromEntries(N.SERIES.map(s => [s.id, rows(s.file)]));
for (const [k, f] of Object.entries(N.EXTRA_FILES)) raw[k] = rows(f);
const ctx = N.buildContext(raw);

const args = process.argv.slice(2);
const outPath = (i => (i < 0 ? null : args[i + 1]))(args.indexOf('--out'));
const md = [], out = s => md.push(s);
const table = (head, body) => { out(`| ${head.join(' | ')} |`); out(`|${head.map(() => '---').join('|')}|`); for (const r of body) out(`| ${r.join(' | ')} |`); out(''); };
const pct = (x, d = 1) => (Number.isFinite(x) ? `${(x * 100).toFixed(d)}%` : '—');
const label = id => N.SIGNALS.find(s => s.id === id)?.label || id;
const lvl = k => N.LEVELS[k].label;

out('# 極端狀態儀表板 — 回測報告');
out('');
out(`資料截止：${ctx.lastDate}。由 \`scripts/research/backtest_nonnormal.mjs\` 產生，引擎 \`js/tabs/nonnormal_calc.mjs\`。規則來源：${N.COURSE}（另用 1-3、2-3）。描述性研究，不是買賣訊號。`);
out('');

out('## 1. 資料覆蓋');
const span = s => (s?.dates?.length ? `${s.dates[0]} ～ ${s.dates.at(-1)}（${s.dates.length} 筆）` : 'unavailable');
table(['序列', '檔案', '覆蓋'], [
  ...N.SERIES.map(s => [s.label + (s.ref ? '（參考，不計分）' : ''), `data/${s.file}`, span(ctx.s[s.id])]),
  ['融資維持率（上市、含 ETF，重建）', 'data/taiwan_margin_ratio_mm.json + taiwan_margin_ratio.json', span(ctx.s.MARGIN)],
  ['融資維持率（上市、排除 ETF，參考）', 'data/taiwan_margin_ratio_mm.json', span(ctx.s.MARGIN_EX)],
  ['融資維持率（上櫃、含 ETF）', 'data/tpex_margin.json', span(ctx.s.MARGIN_OTC)],
  ['台股多空家數', 'data/tw_breadth_ls.json', span(ctx.s.BREADTH)],
]);

out('## 2. 課程案例');
out('');
out('「事件前一週」＝事件日之前最後一個週評估日。「連續警戒起點」＝事件前一週若已達警戒，往回找這段連續 ≥ 警戒的起點；「提前」＝起點到事件日的週數。');
out('');
const results = N.CASES.map(c => N.caseResult(ctx, c));
table(['案例', '參考事件', '事件前一週', '連續警戒起點（提前）', '窗口內首次警戒', '事件前 8 週最高等級'], results.map(r => [
  r.label, `${r.event}：${r.eventText}`,
  r.lastBefore ? `${r.lastBefore.date}：${lvl(r.lastBefore.level)}（${r.lastBefore.count}/${r.lastBefore.available} 亮）` : '—',
  r.runStart ? `${r.runStart}（${r.leadWeeks} 週）` : '事件前一週未達警戒',
  r.firstAny || '無', lvl(r.maxLevel8w)]));
for (const r of results) {
  out(`### ${r.label}`);
  out('');
  out(`課程描述：${r.course}`);
  out('');
  table(['週評估日', '等級', '亮燈數／可評估', '亮燈訊號'], r.weeks.map(w => [w.date + (w.date >= r.event ? '（事件後）' : ''), lvl(w.level), `${w.count}/${w.available}`, w.lit.map(label).join('、') || '—']));
}

out('## 3. 2013 起的基準比較（櫃買資料起點之後）');
out('');
const br = N.baseRates(ctx, '2013-06-07');
out(`共 ${br.weeks} 個週評估日。各等級週數：${N.LEVELS.map((l, k) => `${l.label} ${br.share[k]}（${pct(br.share[k] / br.weeks)}）`).join('、')}。`);
out('');
out(`之後 ${N.P.horizonWeeks} 週內加權相對起點收盤的最大跌幅 ≥ ${pct(N.P.ddHit, 0)} 的比例：所有週 ${pct(br.hitAll)}（n=${br.nAll}）；警戒以上的週 ${pct(br.hitAlert)}（n=${br.nAlert}）。警戒以上共 ${br.runs.length} 段連續區間，視窗完整的 ${br.runsComplete} 段中，起點後 ${N.P.horizonWeeks} 週內最大跌幅 ≥ ${pct(N.P.ddHit, 0)} 的占 ${pct(br.runHit)}。`);
out('');
out('注意：2024-04 前沒有多空家數、2007-07 前沒有布蘭特，早期可評估的訊號較少，等級天然偏低；同一段下跌會連續多週亮燈，週與週之間不是獨立樣本。');
out('');
table(['警戒起點', '結束', '週數', '最高等級', `起點後 ${N.P.horizonWeeks} 週加權最大跌幅（相對起點收盤）`], br.runs.map(r => [r.start, r.end, String(r.weeks), lvl(r.maxLevel), Number.isFinite(r.fwd) ? pct(r.fwd) : '視窗未完']));

out('## 4. 定義敏感度（探索，不是挑參數）');
out('');
out(`預設＝國際股市轉弱需 ${N.P.maShort} 日線下彎（trendSlope）＋廣度收窄只在加權仍在 ${N.P.maShort} 日線上時成立（breadthDivergence）。下表只換這兩個定義，其他不動。`);
out('');
const combos = [[true, true], [false, true], [true, false], [false, false]];
table(['trendSlope', 'breadthDivergence', '警戒以上週占比', '高度警戒週占比', '警戒區間數', `區間起點後 ${N.P.horizonWeeks} 週跌 ≥ ${pct(N.P.ddHit, 0)}`, ...N.CASES.map(c => `${c.id} 事件前一週／連續警戒起點`)], combos.map(([a, b]) => {
  const cx = N.buildContext(raw, { trendSlope: a, breadthDivergence: b }), r = N.baseRates(cx, '2013-06-07');
  return [a ? '是（預設）' : '否', b ? '是（預設）' : '否', pct((r.share[2] + r.share[3]) / r.weeks), pct(r.share[3] / r.weeks), String(r.runs.length), pct(r.runHit),
    ...N.CASES.map(c => { const k = N.caseResult(cx, c); return `${k.lastBefore ? lvl(k.lastBefore.level) : '—'}／${k.runStart ? `${k.runStart}（${k.leadWeeks} 週）` : '—'}`; })];
}));

out('## 5. 最新一週');
out('');
const now = N.evaluateWeek(ctx, ctx.lastDate);
out(`${now.date}：${lvl(now.level)}，${now.count}/${now.available} 亮（${now.groups} 組）。`);
out('');
table(['訊號', '狀態', '數值', '註記'], now.signals.map(s => [label(s.id), s.state === 'na' ? `unavailable（${s.reason}）` : s.state === 'on' ? '亮' : '—', s.text || '', s.tags.join('；')]));

const text = md.join('\n') + '\n';
if (outPath) { writeFileSync(new URL(outPath, root), text); console.log(`wrote ${outPath}`); } else process.stdout.write(text);
