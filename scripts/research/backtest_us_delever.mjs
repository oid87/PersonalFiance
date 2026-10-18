#!/usr/bin/env node
// 美股去槓桿三層研究：可重現回測 CLI。
//   node scripts/research/backtest_us_delever.mjs --out docs/research/us-delever-weekly-backtest.md
//   node scripts/research/backtest_us_delever.mjs --finra-bound upper --cftc-lag 1 --out /tmp/x.md   # 敏感度
//   node scripts/research/backtest_us_delever.mjs --json /tmp/us.json
// 離線，只讀 data/*.json 與 data/research/us_delever/*.json；不寫 data/。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadRaw, ROOT } from './us_delever_data.mjs';
import { runStudy } from '../../js/research/usdelever_study.mjs';
import { finraLagStats, DEFAULTS } from '../../js/research/usdelever_calc.mjs';

const f = (x, d = 1) => (x === null || x === undefined || !Number.isFinite(x) ? '—' : x.toFixed(d));
const sg = (x, d = 1) => (x === null || x === undefined || !Number.isFinite(x) ? '—' : (x > 0 ? '+' : '') + x.toFixed(d));
const row = c => `| ${c.join(' | ')} |`;
const table = (head, rows) => ['', row(head), row(head.map(() => '---')), ...rows.map(row)].join('\n');
const ms = (s, h) => (s?.[h]?.n ? `${sg(s[h].retMedian)}/${sg(s[h].retMean)}` : '—');

export function buildReport(R, meta, probe, sens = []) {
  const c = R.cfg, A = R.A, mk = A.mk, L = [];
  const date = i => mk.cal[i];
  L.push('# 美股去槓桿三層研究：FINRA 月 × CFTC／NFCI 週 × 日頻（2020～2026）');
  L.push(`\n> 由 \`node scripts/research/backtest_us_delever.mjs --out …\` 產生，勿手改。結論與建議見 [us-delever-weekly-recommendation.md](us-delever-weekly-recommendation.md)。`);
  L.push(`> 參數：${mk.cal[mk.si]}～${mk.cal[mk.ei]}｜進場＝可得日的下一交易日${c.entry === 'nextOpen' ? '開盤' : '收盤'}｜事件冷卻 ${c.cooldown} 交易日｜美股波段＝回撤≥${c.waveEnter}% 進入、<${c.waveExit}% 結束（${c.lookback} 日高點）｜FINRA 公布日 ${c.finraBound}｜CFTC 額外延遲 ${c.cftcExtraLagTd} 日、NFCI ${c.nfciExtraLagTd} 日`);
  L.push('\n**本研究沒有修改任何正式交易策略；不預設任何指標有效；樣本小，數字是描述，不是統計顯著性。**');

  // ── A 資料與可得性
  const lag = finraLagStats(meta.finraRelease);
  L.push('\n## 0. 資料來源、可得性假設與限制');
  L.push(table(['層', '資料', '來源', '範圍', '可得性（本研究採用）'], [
    ['M', 'FINRA margin debt（USD 百萬）', `data/margin_global_us.json（${meta.finraSource.slice(0, 40)}…，第三方轉載，非 FINRA 直連；與 FINRA 頁面快照逐月核對）`, '1997～2026-09（月）', `公布日用 Wayback 快照推得：${meta.finraCaptures.parsed}/${meta.finraCaptures.total} 個快照可解析；緊括號月份公布延遲 ${f(lag.min, 0)}～${f(lag.max, 0)} 天（中位 ${f(lag.median, 0)}，p75 ${f(lag.p75, 0)}，n=${lag.n}）→ 模型取月底+${c.finraLagDays} 天，夾在快照括號內；另測 upper／lower 兩端`],
    ['W', 'CFTC TFF futures-only（Leveraged Funds long/short、OI）', 'data/cftc_positions.json（2022+）＋ data/research/us_delever/cftc_tff_2019_2021.json（本研究回補，同解析器）', '2019-01～2026-10-13（週二報告日）', '報告日週二 → 公開日週五（假日順延）→ 之後第一個交易日可用；進場再隔日'],
    ['W', 'Chicago Fed NFCI／NFCIRISK／NFCICREDIT／NFCILEVERAGE', 'data/nfci.json（FRED，最新版）', '1971～2026-10-09（週五）', '週五資料於下週三公布 → 週三之後可用；**無 ALFRED 歷史版本**（見下）'],
    ['D', 'VIX、VXN、VIX/VIX3M', 'data/VIX.json、VXN.json、vix_term.json（CBOE）', '2000/2001～2026-10', '當日收盤'],
    ['D', 'HY 信用', 'data/credit_spread.json（ICE BofA HY OAS，FRED）僅 2023-06 起；之前用 HYG/LQD 比價 20 日變動當**代理**（非利差）', 'OAS 2023-06～；代理 2007～', '當日收盤'],
    ['D', 'SPY、QQQ', 'data/SPY.json、QQQ.json（原始收盤、不含股息）', '2000～2026-10-16', '當日收盤；進場用隔日開盤'],
    ['D', '市場廣度（S&P500 站上 50 日線比例）', 'data/breadth.json', '2019-11～2026-10-15', '當日；**成分股用目前快照回填，有倖存者偏誤**，僅輔助'],
    ['D', 'CNN 恐懼貪婪', 'data/fear_greed.json', '2011～2026-10-16', '當日'],
  ]));
  L.push('\n限制（誠實揭露）：');
  L.push('- **美國沒有可靠的全市場每週融資維持率；NFCI-leverage 不是融資維持率**，它是金融狀況指數的槓桿子指數（含銀行、證券商、避險基金槓桿等指標，各自標準化），只能當「槓桿相關金融條件」的代理。');
  L.push('- **CFTC 持倉收縮不等於強制平倉**，也可能是主動降曝險、到期、換倉、跨商品對沖調整；TFF 的 Leveraged Funds 分類只含 CTA／避險基金等，不含全市場槓桿。');
  L.push('- **期貨轉倉**：季度到期週（第三個週五）與其後一週的 gross 曝險有機械性波動（實測：到期後一週 ES 槓桿基金 gross 中位 -14.5%、OI 中位 -20%）。本研究把這兩週的報告標記為轉倉污染、**不發訊號**，變動量改以「前一個乾淨報告 → 本報告」計算（跨週數記錄為 span，轉倉後第一個乾淨報告為 3 週變動）。CFTC consolidated 合約代碼（13874+、20974+、239742）混合不同契約規模，故全程用張數的**百分比變動**，不換算名目金額。');
  L.push('- **NFCI 歷史版本**：NFCI 每週重估整段歷史。本環境連不上 FRED／ALFRED（`fredgraph.csv` 逾時、官方 API 需 key），**無法取得 2020 起的逐期 vintage**，回測吃的是最新版；僅用 repo git 歷史做事後量測（下表），所以週資料的回測有「後見重估」風險，無法完全排除。');
  if (probe) {
    L.push(`\nNFCI 重估量測（git 歷史 ${probe.oldest_date} 的版本 vs ${probe.newest_date} 的版本，${probe.common_weeks} 個共同週，${probe.commits} 次提交）：`);
    L.push(table(['序列', '水準 平均|修訂|', '水準 最大|修訂|（週）', '被修訂週數', '週變動 平均|修訂|', '週變動 最大|修訂|', '週變動標準差', '最大修訂/標準差'],
      Object.entries(probe.series).map(([k, v]) => [k, v.level_mean_abs_revision, `${v.level_max_abs_revision}（${v.level_max_week}）`, v.level_revised_weeks, v.weekly_change_mean_abs_revision, v.weekly_change_max_abs_revision, v.weekly_change_std, v.max_revision_in_std])));
    L.push('\n只涵蓋 3 個月的版本差：NFCI／RISK／CREDIT 週變動的修訂很小（≤0.16 個標準差）；**NFCILEVERAGE 例外**（水準最大被改 0.206、週變動最大修訂約 0.46 個標準差），其週訊號最容易受後見重估影響。無法保證早期（2020～2024）的版本差也同樣小。');
  }
  L.push('- **FINRA 月資料**：repo 只有月份，沒有公布日；公布日由 Wayback 快照括號推得（上界＝首次被看到、下界＝前一個快照），括號在稀疏期可寬達數個月，故預設用「月底+25 天、夾在括號內」，並測 upper／lower。');
  L.push(`- 回測區間內 SPY 波段 ${R.waves.SPY.length} 個、QQQ 波段 ${R.waves.QQQ.length} 個；單一事件的結論等同個案，不是統計檢定。`);

  // ── 1 Layer1
  L.push('\n## 1. Layer 1 月頻：FINRA margin debt 月變動 vs SPY／QQQ 同月漲跌');
  const lead1 = R.lead;
  L.push(`\n月變動% 與同月（k=0）、前一月（k=-1，融資落後市場）、下一月（k=+1，融資領先市場）報酬的相關：`);
  L.push(table(['市場', 'k=-2', 'k=-1', 'k=0', 'k=+1', 'k=+2', 'n(k=0)'], ['SPY', 'QQQ'].map(s => [s, ...[-2, -1, 0, 1, 2].map(k => f(lead1[`finra_${s}`][k].r, 2)), lead1[`finra_${s}`][0].n])));
  const months = A.finra.filter(r => r.date >= c.start.slice(0, 7) + '-01' && Number.isFinite(r.mom) && (r.mom <= -3 || r.mom >= 6));
  L.push('\n月減≥3% 或月增≥6% 的月份（公布日為模型估計，括號為快照給的 not_yet～known_by）：');
  L.push(table(['月份', '餘額(百萬)', '月變動%', '同月 SPY%', '同月 QQQ%', '模型公布日', '快照括號'], months.map(r => [r.month, r.debit, sg(r.mom), sg(r.retSPY), sg(r.retQQQ), r.knownDate ?? '—', r.unbracketed ? '快照缺此月（純模型）' : `${r.notYet ?? '—'}～${meta.finraRelease[r.month]?.known_by ?? '—'}`])));

  // ── 2 Layer 2 記分卡
  L.push('\n## 2. 每個訊號 vs 客觀下跌波段（研究重點 A、B）');
  L.push(`SPY 波段：${R.waves.SPY.map(w => `${w.peakDate}→${w.lowDate}（-${f(w.maxDd)}%）`).join('；')}`);
  L.push(`\nQQQ 波段：${R.waves.QQQ.map(w => `${w.peakDate}→${w.lowDate}（-${f(w.maxDd)}%）`).join('；')}`);
  L.push(`\n命中＝波段（高點→結束）內出現過事件；領先＝首次事件距波段低點的交易日（正＝早於低點，**事件日＝資料可得日**）；精確度＝事件落在任一波段窗內的比例，括號為「隨機一天落在波段窗內」的基準（SPY ${f(R.score[0].per.SPY.baseShare, 0)}%、QQQ ${f(R.score[0].per.QQQ.baseShare, 0)}%）——精確度不高於基準代表沒有鑑別力；近底＝事件落在低點前 10 日內的波段數。`);
  L.push(table(['訊號', '層', '事件', 'SPY 命中', 'SPY 領先', 'SPY 精確度', 'SPY 近底', 'QQQ 命中', 'QQQ 領先', 'QQQ 精確度', 'QQQ 近底', '20日 SPY 中/均', '20日 QQQ 中/均', 'SPY 60日MDD中位'],
    R.score.map(r => [r.label, r.layer, r.events, `${r.per.SPY.hit}/${r.per.SPY.total}`, f(r.per.SPY.leadMedian, 0), `${f(r.per.SPY.precision, 0)}%`, r.per.SPY.nearLow,
      `${r.per.QQQ.hit}/${r.per.QQQ.total}`, f(r.per.QQQ.leadMedian, 0), `${f(r.per.QQQ.precision, 0)}%`, r.per.QQQ.nearLow, ms(r.sum.SPY, 20), ms(r.sum.QQQ, 20), `${f(r.sum.SPY[60].mddMedian)}%`])));
  const bs = R.base;
  L.push(`\n基準（同一進場規則）：所有交易日 20 日報酬中位 SPY ${ms(bs.all.SPY, 20)}、QQQ ${ms(bs.all.QQQ, 20)}；SPY 回撤≥5% 的日子 ${ms(bs.dd5.SPY, 20)}；SPY 回撤≥8% 的日子 ${ms(bs.dd8.SPY, 20)}；QQQ 回撤≥10% 的日子 ${ms(bs.qdd10.QQQ, 20)}。60 日最大回撤中位：所有日 SPY ${f(bs.all.SPY[60].mddMedian)}%、SPY 回撤≥8% ${f(bs.dd8.SPY[60].mddMedian)}%。`);

  // ── 3 領先落後
  L.push('\n## 3. 領先或落後市場？（研究重點 A、3）');
  L.push('### 3a. 週頻相關（指標變動 vs 同期／前後 k 週市場報酬；k>0＝指標領先市場）');
  const ks = [-4, -3, -2, -1, 0, 1, 2, 3, 4];
  const lagRows = [];
  for (const s of ['SPY', 'QQQ']) for (const [key, name] of [['cftc_sp', 'ES gross 變動%'], ['cftc_nq', 'NQ gross 變動%'], ['cftc_avg', '三商品平均 gross 變動%'], ['cftc_net', 'ES 淨部位變動占OI(pt)'], ['nfci_lev', 'NFCI-leverage 週變動'], ['nfci_risk', 'NFCI-risk 週變動'], ['nfci_credit', 'NFCI-credit 週變動']]) {
    const o = R.lead[`${key}_${s}`]; lagRows.push([`${name} vs ${s}`, ...ks.map(k => f(o[k].r, 2)), o[0].n]);
  }
  L.push(table(['指標 vs 市場', ...ks.map(k => `k=${k}`), 'n(k=0)'], lagRows));
  L.push('\n|r|<0.1 在此樣本數下與 0 無法區分。CFTC 的 k=0 為同週（週二→週二）報酬，不可交易；NFCI 為週五→週五。');
  L.push('\n### 3b. 每個波段內各指標「最極端」出現在何時（週，正＝波段低點之後）與資料可得日（交易日，正＝低點之後才知道）');
  L.push(table(['市場', '波段', '最大-%', 'CFTC 最大收縮週', 'CFTC 可得距低點(日)', 'NFCI-lev 最大升', '週差', '可得(日)', 'NFCI-risk 最大升', '週差', 'FINRA 最大月減(月)', '公布(模型)距低點(日)'],
    R.extremes.map(e => [e.sym, `${e.peakDate}→${e.lowDate}`, `-${f(e.maxDd)}`, e.cftc ? `${e.cftc.date}（${f(e.cftc.val)}%）` : '—', e.cftc?.availTd ?? '—',
      e.nfciLev ? `${e.nfciLev.date}（${sg(e.nfciLev.val, 3)}）` : '—', e.nfciLev?.weeksFromLow ?? '—', e.nfciLev?.availTd ?? '—', e.nfciRisk ? `${e.nfciRisk.date}（${sg(e.nfciRisk.val, 3)}）` : '—', e.nfciRisk?.weeksFromLow ?? '—',
      e.finra ? `${e.finra.month}（${f(e.finra.val)}%）` : '—', e.finra?.availTd ?? '—'])));

  // ── B 週 vs 月
  const w = id => R.score.find(r => r.id === id), by = id => w(id);
  L.push('\n## 4. 週頻是否比 FINRA 月資料更早發現風險？（研究重點 B）');
  L.push(`結構性延遲：CFTC 資料期間（週二）→ 可用約 3 天；NFCI 週五資料 → 5 天；FINRA 月底資料 → 約 ${c.finraLagDays} 天（括號 ${f(lag.min, 0)}～${f(lag.max, 0)} 天），且月資料描述的是整個月的累積變化。`);
  L.push(table(['比較', 'SPY 近底命中', 'QQQ 近底命中', 'SPY 領先中位(日)', 'QQQ 領先中位(日)', 'SPY 精確度', 'QQQ 精確度'],
    ['cftc_both_g6', 'cftc_three_g6', 'nfci_lev_up', 'finra_mom2', 'finra_mom3', 'vix25', 'vix30'].map(id => { const r = by(id); return [r.label, `${r.per.SPY.nearLow}/${r.per.SPY.total}`, `${r.per.QQQ.nearLow}/${r.per.QQQ.total}`, f(r.per.SPY.leadMedian, 0), f(r.per.QQQ.leadMedian, 0), `${f(r.per.SPY.precision, 0)}%`, `${f(r.per.QQQ.precision, 0)}%`]; })));

  // ── C 收縮放緩
  L.push('\n## 5. CFTC 收縮放緩 ∧ VIX 回落之後（研究重點 C、E）');
  L.push(`「收縮放緩」＝前一個乾淨週的三商品（ES/NQ/RTY）平均 gross 變動 ≤-${c.slowdownGross}%，且本週較前週好、≥-1%；「VIX 回落」＝VIX ≤ 近 ${c.vixCalmWin} 日高×${c.vixCalmFrac} 且低於 5 日前。事件日＝CFTC 公開日。時點：before＝在該波段低點之前、after＝低點之後、outside＝不在波段窗內。`);
  L.push(table(['條件', '事件', 'SPY 時點 before/after/outside', 'QQQ 時點', 'SPY 20日 中/均', 'SPY 60日 中/均', 'SPY 60日MDD中位', 'SPY 20日再破低', 'QQQ 20日 中/均', 'QQQ 60日MDD中位'],
    R.stab.rows.map(r => [r.label, r.events, `${r.timing.SPY.before}/${r.timing.SPY.after}/${r.timing.SPY.outside}`, `${r.timing.QQQ.before}/${r.timing.QQQ.after}/${r.timing.QQQ.outside}`, ms(r.sum.SPY, 20), ms(r.sum.SPY, 60), `${f(r.sum.SPY[60].mddMedian)}%`, `${f(r.sum.SPY[20].breakPct, 0)}%`, ms(r.sum.QQQ, 20), `${f(r.sum.QQQ[60].mddMedian)}%`])));
  const sv = R.stab.rows.find(r => r.id === 'slow_vix_dd5');
  if (sv) L.push('\n「放緩∧VIX回落∧SPY回撤≥5%」事件明細：\n' + table(['日期', 'SPY回撤', 'QQQ回撤', 'VIX', 'SPY 20日報酬', 'SPY 20日MDD', 'QQQ 20日報酬'], sv.list.map(e => [e.date, `-${f(e.spyDd)}%`, `-${f(e.qqqDd)}%`, f(e.vix), e.f20 ? sg(e.f20.ret) + '%' : '—', e.f20 ? f(e.f20.mdd) + '%' : '—', e.q20 ? sg(e.q20.ret) + '%' : '—'])));
  L.push(`\n基準：SPY 回撤≥5% 的日子 20日中位 ${ms(bs.dd5.SPY, 20)}、60日MDD中位 ${f(bs.dd5.SPY[60].mddMedian)}%；回撤≥8% ${ms(bs.dd8.SPY, 20)}、${f(bs.dd8.SPY[60].mddMedian)}%。`);

  // ── D 三層 vs VIX
  L.push('\n## 6. 日／週／月三層模型 vs 單獨 VIX（研究重點 D）');
  L.push(`L3 日頻壓力＝下列 5 項中至少 ${c.stressCount} 項成立：VIX≥${c.vixHi}、VXN≥${c.vxnHi}、VIX/VIX3M≥${c.tsBack}、HY（OAS 5日+0.5pp，無 OAS 時 HYG/LQD 20日≤${c.hyProxy20}%）、S&P500 站上 50 日線比例≤${c.breadth50Lo}%。L2＝ES 與 NQ 同週 gross 收縮≥6% 或 NFCI-leverage 週變動 z≥${c.nfciZ}（10 日內有效）；L1＝FINRA 最近一次公布的月減≥3%（最長 45 日）。門檻在看結果前固定，沒有最佳化。亮燈日數：L1 ${R.layers.shares.L1}、L2 ${R.layers.shares.L2}、L2b ${R.layers.shares.L2b}、L3 ${R.layers.shares.L3}／${R.layers.shares.days}。`);
  L.push(table(['警報', '層', '亮燈日', '事件', 'SPY 命中', 'SPY 領先', 'SPY 精確度(基準)', '波段外事件', 'SPY 近底', 'QQQ 命中', 'QQQ 精確度', 'SPY 20日 中/均', 'SPY 60日MDD中位', 'QQQ 20日 中/均', 'QQQ 60日MDD中位'],
    R.layers.rows.map(r => [r.label, r.layers, r.flagDays, r.events, `${r.per.SPY.hit}/${r.per.SPY.total}`, f(r.per.SPY.leadMedian, 0), `${f(r.per.SPY.precision, 0)}%（${f(r.per.SPY.baseShare, 0)}%）`, r.per.SPY.outside, r.per.SPY.nearLow,
      `${r.per.QQQ.hit}/${r.per.QQQ.total}`, `${f(r.per.QQQ.precision, 0)}%`, ms(r.sum.SPY, 20), `${f(r.sum.SPY[60].mddMedian)}%`, ms(r.sum.QQQ, 20), `${f(r.sum.QQQ[60].mddMedian)}%`])));

  // ── F&G
  const fg = R.fear;
  L.push(`\n## 7. 恐懼貪婪（F&G<${fg.thr}）× 去槓桿訊號`);
  L.push(`F&G<${fg.thr} 共 ${fg.fearDays}/${fg.fgDays} 日；L3 壓力在恐懼日的比例 ${f(fg.pStressGivenFear)}%、非恐懼日 ${f(fg.pStressGivenNot)}%。`);
  L.push(table(['週／月訊號', '事件', '事件日（含前5日）已在恐懼區'], fg.sigStats.map(s => [s.label, s.events, s.nearFear])));
  L.push('\n逐波段：F&G 最低點與首次進入恐懼區 vs 波段低點（交易日；fgMin 負＝F&G 早於低點到底）：');
  L.push(table(['市場', '波段', '最大-%', 'F&G 最低(日期)', '最低日−低點(日)', '首次進恐懼區', '距低點(日)'], fg.waves.map(w2 => [w2.sym, `${w2.peakDate}→${w2.lowDate}`, `-${f(w2.maxDd)}`, w2.fgMin === null ? '—' : `${f(w2.fgMin, 1)}（${w2.fgMinDate}）`, w2.fgMinToLow ?? '—', w2.firstFearDate ?? '未進入', w2.firstFearToLow ?? '—'])));

  // ── 個案
  const caseBlock = (key, title) => {
    const t = R.cases[key];
    L.push(`\n## ${title}`);
    L.push('\n**CFTC（週二報告日；公開日＝週五起可用；轉倉週標示且不發訊號）**');
    L.push(table(['報告日', '公開日(可用)', '轉倉', 'span(週)', 'ES gross%', 'NQ gross%', 'RTY gross%', 'ES 淨部位', 'ES 多單', 'ES 空單'], t.cftc.map(r => [r.report, r.release ?? '—', r.roll ? '轉倉週' : '', r.span ?? '—', sg(r.spG), sg(r.nqG), sg(r.ruG), r.spNet ?? '—', r.spLong ?? '—', r.spShort ?? '—'])));
    L.push('\n**NFCI（週五；週三公布；最新版數值）**');
    L.push(table(['週', '可用日', 'leverage', 'Δlev', 'z(Δlev)', 'risk', 'Δrisk', 'credit', 'Δcredit'], t.nfci.map(r => [r.date, r.avail ?? '—', f(r.lev, 3), sg(r.dLev, 3), sg(r.zLev, 2), f(r.risk, 3), sg(r.dRisk, 3), f(r.credit, 3), sg(r.dCredit, 3)])));
    L.push('\n**FINRA（月；公布日為模型估計）**');
    L.push(table(['月份', '餘額(百萬)', '月變動%', '同月 SPY%', '同月 QQQ%', '模型公布日', 'Wayback not_yet', ], t.finra.map(r => [r.month, r.debit, sg(r.mom), sg(r.retSPY), sg(r.retQQQ), r.knownModel ?? '—', r.notYet ?? '—'])));
    L.push('\n**日頻**');
    L.push(table(['日期', 'SPY', 'SPY回撤', 'QQQ', 'QQQ回撤', 'VIX', 'VXN', 'VIX/3M', 'HY OAS', 'HYG/LQD 20日%', '廣度50', 'F&G', 'L3項數'], t.daily.map(d => [d.date, f(d.spy, 2), `-${f(d.spyDd)}%`, f(d.qqq, 2), `-${f(d.qqqDd)}%`, f(d.vix), f(d.vxn), f(d.ts, 2), f(d.oas, 2), sg(d.hyp20), f(d.br50, 0), f(d.fg, 0), d.stress])));
  };
  caseBlock('A', '8. 個案：2024/7～8');
  caseBlock('B', '9. 個案：2026/7～8');
  if (sens.length) {
    L.push('\n## 10. 敏感度：可得性假設與進場規則（主要結論是否被假設推翻）');
    L.push('每列重跑整個研究。重點看「週訊號 vs 月訊號的領先」與「三層確認」的方向是否改變。');
    L.push(table(['假設', 'FINRA 月減≥3% 事件', '… SPY 近底', '… 20日 SPY 中/均', 'ES∧NQ 收縮≥6% 事件', '… SPY 近底', '… 20日 SPY 中/均', 'NFCI-lev 急升 事件', 'L3∧(L2∨L1) 事件', '… SPY 精確度', '… 20日 SPY 中/均', 'VIX≥30 20日 SPY 中/均'],
      sens.map(s2 => { const g = id => s2.R.score.find(r => r.id === id); const lay = s2.R.layers.rows.find(r => r.id === 'L3_L2orL1');
        return [s2.label, g('finra_mom3').events, `${g('finra_mom3').per.SPY.nearLow}/${g('finra_mom3').per.SPY.total}`, ms(g('finra_mom3').sum.SPY, 20), g('cftc_both_g6').events, `${g('cftc_both_g6').per.SPY.nearLow}/${g('cftc_both_g6').per.SPY.total}`, ms(g('cftc_both_g6').sum.SPY, 20),
          g('nfci_lev_up').events, lay.events, `${f(lay.per.SPY.precision, 0)}%`, ms(lay.sum.SPY, 20), ms(g('vix30').sum.SPY, 20)]; })));
  }
  L.push('\n## 重現\n\n```bash\nnode scripts/research/backtest_us_delever.mjs --out docs/research/us-delever-weekly-backtest.md\nnode scripts/research/backtest_us_delever.mjs --finra-bound upper --out /tmp/us-upper.md   # FINRA 公布日最晚\nnode scripts/research/backtest_us_delever.mjs --finra-bound lower --out /tmp/us-lower.md   # 最早\nnode scripts/research/backtest_us_delever.mjs --cftc-lag 1 --nfci-lag 1                      # 多等一個交易日\npython3 scripts/research/verify_us_delever.py       # 用 Python 獨立重算並比對\nnpm test                                            # 含 js/research/*.test.mjs\n```\n資料補抓：`python3 scripts/research/fetch_cftc_tff_history.py`、`fetch_finra_release_dates.py`（Wayback）、`nfci_revision_probe.py`（git 歷史）。');
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
  if (args['finra-bound']) cfg.finraBound = args['finra-bound'];
  if (args['cftc-lag']) cfg.cftcExtraLagTd = Number(args['cftc-lag']);
  if (args['nfci-lag']) cfg.nfciExtraLagTd = Number(args['nfci-lag']);
  if (args.entry) cfg.entry = args.entry;
  if (args.start) cfg.start = args.start;
  if (args.end) cfg.end = args.end;
  const { raw, meta } = loadRaw();
  const R = runStudy(raw, cfg);
  const probePath = path.join(ROOT, 'data/research/us_delever/nfci_revision_probe.json');
  const probe = fs.existsSync(probePath) ? JSON.parse(fs.readFileSync(probePath, 'utf8')) : null;
  const variants = [['主設定（FINRA 模型、CFTC/NFCI 0 日延遲、隔日開盤）', {}], ['FINRA 公布日取上界（最晚）', { finraBound: 'upper' }], ['FINRA 公布日取下界（最早）', { finraBound: 'lower' }],
    ['CFTC 多等 1 個交易日', { cftcExtraLagTd: 1 }], ['NFCI 多等 1 個交易日', { nfciExtraLagTd: 1 }], ['進場改隔日收盤', { entry: 'nextClose' }], ['事件冷卻 5 日', { cooldown: 5 }], ['事件冷卻 20 日', { cooldown: 20 }]];
  const sens = args['no-sens'] ? [] : variants.map(([label, o]) => ({ label, R: runStudy(raw, { ...cfg, ...o }) }));
  const md = buildReport(R, meta, probe, sens);
  if (args.out) { fs.mkdirSync(path.dirname(path.resolve(args.out)), { recursive: true }); fs.writeFileSync(args.out, md); console.log(`wrote ${args.out}`); } else process.stdout.write(md);
  if (args.json) { fs.writeFileSync(args.json, JSON.stringify({ ...R, A: undefined }, null, 1)); console.log(`wrote ${args.json}`); }
}
void DEFAULTS;
