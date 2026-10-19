#!/usr/bin/env node
// 台股融資維持率壓力推估 — 可重現歷史 Beta 與 walk-forward 回測 CLI。
//   node scripts/backtest_margin_stress.mjs                                  # 印出報告
//   node scripts/backtest_margin_stress.mjs --out docs/research/margin-stress-projection-backtest.md
// 引擎與網頁共用 js/tabs/marginstress_calc.mjs（單一來源）。離線，只讀 data/*.json，不寫 data/。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { mergeRatio, buildDataset } from '../js/tabs/marginalert_calc.mjs';
import { analyzeHistory, scenarioView, signalOverlap, MANUAL_BETAS, KEY_DROP_PTS } from '../js/tabs/marginstress_calc.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const readData = f => JSON.parse(fs.readFileSync(path.join(ROOT, 'data', `${f}.json`), 'utf8'));

const isNum = v => typeof v === 'number' && Number.isFinite(v);
const f = (x, d = 1) => (isNum(x) ? x.toFixed(d) : '—');
const sg = (x, d = 1) => (isNum(x) ? (x > 0 ? '+' : '') + x.toFixed(d) : '—');
const row = cells => `| ${cells.join(' | ')} |`;
const table = (head, rows) => ['', row(head), row(head.map(() => '---')), ...rows.map(row)].join('\n');

export function loadData() {
  const tw = readData('TWII'), mg = readData('taiwan_margin_total');
  const mm = readData('taiwan_margin_ratio_mm'), rc = readData('taiwan_margin_ratio');
  const merged = mergeRatio(mm.data, rc.data);
  // 2001-2007 融資餘額補遺檔與主檔以日期合併（主檔優先）
  const early = fs.existsSync(path.join(ROOT, 'data', 'taiwan_margin_total_early.json')) ? readData('taiwan_margin_total_early').data : [];
  const have = new Set(mg.data.map(r => r.date));
  const margin = [...early.filter(r => !have.has(r.date)), ...mg.data].sort((a, b) => (a.date < b.date ? -1 : 1));
  return {
    data: { twii: tw.data, margin, ratio: merged.rows },
    meta: { twii: tw.updated, margin: mg.updated, ratio: [mm.updated, rc.updated], overlap: merged.overlap, maxAbsDiff: merged.maxAbsDiff, note: rc.note },
  };
}

export function buildReport(data, meta) {
  const h = analyzeHistory(data);
  const L = [];
  const lastDate = data.twii.at(-1)?.date;
  L.push('# 台股融資維持率壓力推估 — 歷史 Beta 與回測報告');
  L.push('\n> 由 `node scripts/backtest_margin_stress.mjs --out …` 產生，勿手改。所有結果是「歷史敏感度情境推估」，不是支撐位、底部或預測低點；沒有修改任何既有警報規則。');
  L.push(`> 資料：加權指數收盤 ${data.twii[0]?.date}～${lastDate}（更新 ${meta.twii}）｜上市融資餘額（更新 ${meta.margin}）｜維持率＝TWSE MI_MARGN×MI_INDEX 逐檔重建（非官方、非券商整戶口徑；上市 only、含 ETF；拼接兩檔重疊 ${meta.overlap} 日最大差 ${meta.maxAbsDiff}）。`);

  L.push('\n## 1. 定義');
  L.push('\n- IndexDecline＝(P0-P1)/P0；MarginDecline＝(M0-M1)/M0（維持率的**相對**跌幅，不是百分點）；**Beta＝MarginDecline ÷ IndexDecline**，高點日→低點日的區間累計值（不是迴歸斜率）。');
  L.push('- 反推指數：RequiredDecline＝(M0-Mt)/M0/Beta；ProjectedIndex＝P0×(1-RequiredDecline)。反推維持率：M0×(1-Beta×IndexDecline)。');
  L.push('- 波段：指數收盤相對過去 120 日最高收盤回撤 ≥10% 進入、<5% 結束（與警報頁 findWaves 同定義，測試比對一致）；P0、M0 取波段高點日，P1、M1 取波段低點日，**同一日期**，缺值就略過。同一高點先後兩段只留最深一段。');

  const c = h.coverage;
  L.push('\n## 2. 資料覆蓋');
  L.push(`\n指數波段 ${c.waves} 段（1997 起）；有維持率者 ${c.withRatio} 段（重建資料自 2004-02-11，更早不補造）；可用於統計的獨立、已結束、回撤≥10% 波段 **${c.usable} 段**（${c.firstUsable}～${c.lastUsable}）。融資餘額自 2001-01-03（2001–2007 為 FinMind 補遺檔，與 TWSE 彙總 964 日逐日核對差 0）。使用者要求的 2018／2020／2022／2025／2026 全部在內。`);

  L.push('\n## 3. 逐波段 Beta');
  L.push(table(['波段（高點→低點）', '指數回撤', '維持率 高→低點', '相對跌幅', '下降點數', 'Beta', '融資餘額變化', '期間融資最大跌幅', '抵押品市值變化(推算)', '期間最低維持率'],
    h.history.filter(w => w.independent && w.ok).map(w => [`${w.peakDate}→${w.lowDate}${w.open ? '（未結束）' : ''}`, `-${f(w.maxDd)}%`, `${f(w.m0, 1)} → ${f(w.m1, 1)}`,
      `-${f(w.marginDecline * 100)}%`, `-${f(w.ptsDrop, 1)}`, `**${f(w.beta, 2)}**`, isNum(w.marginChange) ? `${sg(w.marginChange)}%` : '—',
      w.marginMaxBurn ? `${sg(w.marginMaxBurn.pct)}%` : '—', isNum(w.collateralChange) ? `${sg(w.collateralChange, 0)}%` : '—', `${f(w.ratioMin, 1)}（${w.ratioMinDate}）`])));
  L.push('\n抵押品市值＝維持率×融資餘額（維持率定義反推），包含融資戶賣股還款造成的減少，不是單純股價跌幅。「期間融資最大跌幅」是餘額自身的峰谷。');

  const s = h.stats;
  L.push('\n## 4. Beta 統計');
  L.push(table(['統計', '值'], [['波段數', s.n], ['中位數', f(s.median, 2)], ['平均', f(s.mean, 2)], ['最小～最大', `${f(s.min, 2)}～${f(s.max, 2)}`], ['P25～P75', `${f(s.p25, 2)}～${f(s.p75, 2)}`], ['變異係數', f(s.cv, 2)]]));
  L.push('\n**不同回撤深度（波段中第一次回撤到該深度那天量到的 Beta，用當天實際跌幅）：**');
  L.push(table(['回撤到', '波段數', '中位數', '最小', '最大'], h.depth.map(d => [`≥${d.depth}%`, d.n, f(d.median, 2), f(d.min, 2), f(d.max, 2)])));
  const rg = h.betaRegime;
  L.push(`\n**依融資是否大幅去槓桿分群（期間融資最大跌幅 ≤ ${rg.heavyAt}% 為大幅）：**`);
  L.push(table(['群', '波段數', 'Beta 中位數', '範圍', '波段'], [
    ['融資未大幅去槓桿', rg.light.n, f(rg.light.median, 2), `${f(rg.light.min, 2)}～${f(rg.light.max, 2)}`, rg.lightWaves.map(d => d.slice(0, 7)).join('、')],
    ['融資大幅去槓桿', rg.heavy.n, f(rg.heavy.median, 2), `${f(rg.heavy.min, 2)}～${f(rg.heavy.max, 2)}`, rg.heavyWaves.map(d => d.slice(0, 7)).join('、')],
  ]));
  L.push('\n**回答：**');
  const dp = h.depthPaired;
  L.push(`1. 大盤跌幅越大，維持率**沒有**加速下滑：Beta 中位數隨深度 ${h.depth.map(d => `${d.depth}%→${f(d.median, 2)}`).join('、')} 下降；排除組成效應，同一批 ${dp.n} 個回撤達 ${dp.depths.at(-1)}% 的波段在 ${dp.depths.map((d, i) => `${d}%→${f(dp.medians[i], 2)}`).join('、')}，其中 ${dp.declined}/${dp.n} 波從 ${dp.depths[0]}% 到 ${dp.depths.at(-1)}% 的 Beta 變低。深度修正時融資戶減碼、賣股還款把維持率拉回（這是與融資減少一致的解釋，不是已證實的因果）。`);
  L.push(`2. 不同階段的 Beta **沒有固定關係**（${f(s.min, 2)}～${f(s.max, 2)}，變異係數 ${f(s.cv, 2)}）。與「融資有沒有大量去槓桿」高度相關：融資未大幅去槓桿的波段中位 ${f(rg.light.median, 2)}，大幅去槓桿的 ${f(rg.heavy.median, 2)}。`);
  const w26 = h.history.find(w => w.peakDate === '2026-06-22' && w.ok);
  L.push(`3. **2026 這一波（高點日 6/22）Beta＝${f(w26?.beta, 2)}，是 ${s.n} 波中的最高端（歷史最大 ${f(s.max, 2)}）；使用者案例 1.47（以 6/23 為起點）同屬這一端，不宜當固定值。**起點日選 6/22 或 6/23 就差 0.05。`);

  const e = h.errors;
  L.push('\n## 5. Walk-forward 回測（無 look-ahead）');
  L.push('\n第 k 波只用「在第 k 波高點日之前已結束」的波段估計 Beta（中位數；另列「只用上一波」），再套用該波實際指數跌幅預測低點維持率。誤差＝預測−實際（點）。目標維持率（高點-30 點、150%）若該波從未觸及，標「未觸及」，不計成功也不計失敗。');
  const tg = (r, key) => { const t = r.predictions.median.targets.find(x => x.key === key); if (!t) return '—'; if (t.status === 'not-touched') return '未觸及'; if (t.status !== 'ok') return t.status; return `${f(t.projected, 0)} vs ${f(t.actualIndex, 0)}（${sg(t.errPct)}%）`; };
  const wf = h.walkForward.filter(r => !r.skipped);
  L.push(table(['波段', '所用 Beta(中位/前n波)', '實際低點維持率', '預測', '誤差(點)', '上一波 Beta → 誤差(點)', '反推低點指數誤差', '高點-30 點：推估 vs 實際', '150%：推估 vs 實際'],
    wf.map(r => [`${r.wave.peakDate.slice(0, 7)}（-${f(r.wave.maxDd, 0)}%）`, `${f(r.betas.median, 2)}（${r.priorN}）`, f(r.wave.m1, 1), f(r.predictions.median.predMargin, 1), sg(r.predictions.median.errMarginPts),
      `${f(r.betas.prev, 2)} → ${sg(r.predictions.prev.errMarginPts)}`, `${sg(r.predictions.median.errIndexPct)}%`, tg(r, 'm0-30'), tg(r, '150')])));
  L.push(`\n**誤差摘要（n=${e.median.n}）**\n`);
  L.push(table(['方法', 'n', '維持率絕對誤差中位(點)', '±5 點內', '平均偏差(點)', '反推指數絕對誤差中位'], [
    ['前序波段中位數 Beta', e.median.n, f(e.median.marginErrPtsMedAbs, 1), `${e.median.within5pts}/${e.median.n}`, sg(e.median.marginErrPtsMean), `${f(e.median.indexErrPctMedAbs, 1)}%`],
    ['只用上一波 Beta', e.prev.n, f(e.prev.marginErrPtsMedAbs, 1), `${e.prev.within5pts}/${e.prev.n}`, sg(e.prev.marginErrPtsMean), `${f(e.prev.indexErrPctMedAbs, 1)}%`],
  ]));
  const g = h.regime;
  L.push(`\n偏差環境：融資期間大幅去槓桿（最大跌幅 ≤ ${g.heavyAt}%，${g.heavy.n} 波）平均誤差 ${sg(g.heavy.meanErr)} 點（模型高估跌幅）；其餘 ${g.light.n} 波平均 ${sg(g.light.meanErr)} 點。最大的失誤在上一波 Beta 與下一波差距很大的轉換（例如 2021→2022）。`);
  L.push('\n**結論：**前序中位數 Beta 比只用上一波穩定，但仍有數個波段誤差超過 10 點；Beta 在不同週期**不穩定**，樣本是波段級別且彼此不獨立，這個模型只能當粗略的情境範圍。');

  L.push('\n## 6. 目前情境（參考日＝120 日指數收盤高點）');
  const scen = [['全部歷史波段 P25／中位／P75', scenarioView(data, h, { scenario: 'hist' })], ['融資未大幅去槓桿波段 P25／中位／P75', scenarioView(data, h, { scenario: 'light' })], [`手動 ${MANUAL_BETAS.low}／${MANUAL_BETAS.base}／${MANUAL_BETAS.high}（使用者案例，非統計區間）`, scenarioView(data, h, { beta: { ...MANUAL_BETAS } })]];
  const v0 = scen[0][1];
  if (v0.ref.ok) {
    L.push(`\n參考日 ${v0.ref.date}：指數 ${f(v0.ref.p0, 0)}、維持率 ${f(v0.ref.m0, 2)}%；最新 ${v0.ref.latestDate}：指數 ${f(v0.ref.latestP, 0)}、維持率 ${f(v0.ref.latestM, 2)}%。參考日→最新實際倍數 ${f(v0.realized.beta, 2)}（指數 -${f(v0.realized.indexDecline * 100)}%、維持率 -${f(v0.realized.marginDecline * 100)}%）。`);
    for (const [name, v] of scen) {
      L.push(`\n**${name}**（低／基準／高 Beta＝${f(v.betas.low, 2)}／${f(v.betas.base, 2)}／${f(v.betas.high, 2)}）`);
      L.push(table(['目標維持率', '推估指數（基準）', '區間（高 Beta→低 Beta）', '自參考高點回撤', '自目前再跌'], v.targets.map(t => t.status === 'ok'
        ? [t.label, f(t.projected, 0), `${f(t.rangeLow, 0)}～${f(t.rangeHigh, 0)}`, `${sg(t.fromRefPct)}%`, `${sg(t.fromNowPts, 0)}（${sg(t.fromNowPct)}%）`] : [t.label, t.status, '', '', ''])));
    }
    L.push('\n**均線（基準 Beta＝全部歷史波段中位數；最新日固定值，未來會移動）**');
    L.push(table(['均線', '點位', '距目前', '推估維持率（基準）', '範圍'], v0.ma.rows.map(m => [`${m.period}MA`, f(m.ma, 0), `${sg(m.fromNowPct)}%`, m.status === 'ok' ? `${f(m.base, 1)}%` : m.status, m.status === 'ok' ? `${f(m.rangeLow, 1)}%～${f(m.rangeHigh, 1)}%` : ''])));
    const d = v0.delever;
    L.push(`\n**融資去槓桿觀察（${d.date}）**：融資餘額 ${f(d.margin, 0)} 億；單日 ${sg(d.d1.pct, 2)}%、5 日 ${sg(d.d5.pct, 2)}%、10 日 ${sg(d.d10.pct, 2)}%；自參考日 ${sg(d.sinceRef.pct, 2)}%（${sg(d.sinceRef.amt, 0)} 億）。維持率自參考日 ${sg(d.ratioPts, 1)} 點。${d.flag ? '維持率下降但融資餘額沒有減少——只表示下降主要來自股價，不能據此認定「還沒殺完」，融資下降也不等於斷頭。' : ''}`);
  }

  L.push('\n## 7. 訊號相關性（規則 A 回撤≥15%、B 維持率自 120 日高點降≥30 點；只研究，不改規則）');
  const ds = buildDataset(data, { start: '2004-02-11', end: lastDate, lookback: 120 });
  const o = signalOverlap(ds);
  L.push(table(['有維持率的交易日', 'A', 'B', 'A∧B', 'A 不含 B', 'B 不含 A', 'P(B∣A)', 'P(A∣B)', 'Jaccard'], [[o.counts.days, o.counts.A, o.counts.B, o.counts.both, o.counts.Aonly, o.counts.Bonly, `${f(o.pBgivenA, 0)}%`, `${f(o.pAgivenB, 0)}%`, `${f(o.jaccard, 0)}%`]]));
  L.push(`\nA∧B 事件（冷卻 20 日）${o.events.length} 件，其中融資沒有明顯下降（較 120 日高點降幅 <10%）${o.eventsNoClearMarginDrop} 件：`);
  L.push(table(['事件首日', '指數回撤', '維持率降幅(點)', '融資 vs 120 日高點', '融資', 'A/B 先後相隔(日)'], o.events.map(x => [x.date, `-${f(x.dd)}%`, `-${f(x.ratioDrop, 1)}`, `${sg(-x.marginDropPct)}%`, x.noClearMarginDrop ? '**沒有明顯下降**' : '有下降', isNum(x.lagDays) ? x.lagDays : '—'])));
  L.push('\n維持率＝抵押品市值÷融資餘額，與指數下跌同源，A、B 常同時成立；兩項一起成立時「三選二」可能是同一件事算兩次，應再看融資餘額（C）是否真的下降。');

  L.push('\n## 8. 限制');
  L.push('\n- 維持率是民間重建值（TWSE 逐檔融資張×收盤÷融資金額，上市 only、含 ETF），不是證交所整戶維持率；與券商整戶口徑不同（偏高），不同口徑不拼接。130% 是個別帳戶追繳門檻，不等於全市場斷頭；150% 不是固定底部。');
  L.push(`- 樣本：獨立波段 ${c.usable} 段，彼此不獨立，且 2004 年以前無維持率；2008 與 2020/3 這類極端行情主導尾端。Beta 是描述而非預測。`);
  L.push('- 未做 rolling regression（避免與「區間累計跌幅比值」的 Beta 混淆）；沒有成交量資料。');
  L.push(`- 使用者案例數字（6/23＝47,101／201.91%、7/30＝39,933／156.75%、10/7＝49,806／198.92%）只做公式回歸測試；重建資料中 6/23 的實際值以 data 為準。KEY：高點-${KEY_DROP_PTS} 點為使用者既有觀察條件。`);
  L.push('\n## 重現\n\n```bash\nnode scripts/backtest_margin_stress.mjs --out docs/research/margin-stress-projection-backtest.md\nnode --test js/tabs/marginstress_calc.test.mjs\n```\n網頁版：「融資去槓桿警報」頁上方「融資壓力情境推估」可調參考日與 Beta。');
  return L.join('\n') + '\n';
}

function parseArgs(argv) {
  const a = {};
  for (let i = 0; i < argv.length; i++) if (argv[i].startsWith('--')) a[argv[i].slice(2)] = argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : true;
  return a;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = parseArgs(process.argv.slice(2));
  const { data, meta } = loadData();
  const md = buildReport(data, meta);
  if (args.out) { fs.mkdirSync(path.dirname(path.resolve(args.out)), { recursive: true }); fs.writeFileSync(args.out, md); console.log(`wrote ${args.out}`); }
  else process.stdout.write(md);
}
