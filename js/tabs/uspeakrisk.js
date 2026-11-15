// 美股高檔風險研究：SOX、Nasdaq-100、S&P 500 的領先關係（公開研究展示，研究已結案，不產生交易訊號）。
// 研究數字：data/uspeakrisk.json（scripts/build_uspeakrisk_data.py 由研究資料夾彙總；白名單見 docs/research/uspeakrisk_public_data.md）。
// 價格探索器：只讀網站既有的公開資料檔 data/SOX.json、SP500.json、QQQ.json、SPY.json，做描述性計算；本頁不新增任何行情檔。
import { echartsBase, PALETTE, isLight, mob } from '../utils/theme.js';
import { requestJSON } from '../utils/data.js';
import { bindOnce, chipPicker } from '../utils/dom.js';
import { preserveChartState } from '../utils/chartLifecycle.js';
import * as U from './uspeakrisk_calc.mjs';

const byId = id => document.getElementById('uspeakrisk-' + id);
const esc = s => String(s).replace(/[&<>"]/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[ch]));
const fin = v => typeof v === 'number' && Number.isFinite(v);
const f3 = v => (fin(v) ? v.toFixed(3) : '—');
const sf3 = v => (fin(v) ? `${v > 0 ? '+' : ''}${v.toFixed(3)}`.replace('-', '−') : '—');
const pct = (v, d = 0) => (fin(v) ? `${(v * 100).toFixed(d)}%`.replace('-', '−') : '—');
const ciTxt = ci => (Array.isArray(ci) ? `${sf3(ci[0])}～${sf3(ci[1])}` : '不估計');
const COL = { sox_first: '#d29922', sync: '#8b949e', target_first: '#58a6ff', no_follow: '#a371f7' };
const LINE = { SOX: '#d29922', NDX: '#58a6ff', SPX: '#3fb950', SPY: '#3fb950' };
const PRESETS = [
  { id: '2000', label: '2000–2002 科技泡沫', from: '2000-01-03', to: '2002-12-31' },
  { id: '2008', label: '2007–2009 金融危機', from: '2007-06-01', to: '2009-06-30' },
  { id: '2011', label: '2011 修正', from: '2011-03-01', to: '2011-12-30' },
  { id: '2015', label: '2015–2016 修正', from: '2015-05-01', to: '2016-06-30' },
  { id: '2018', label: '2018 Q4', from: '2018-08-01', to: '2019-03-29' },
  { id: '2020', label: '2020 疫情崩跌', from: '2019-12-02', to: '2020-07-31' },
  { id: '2022', label: '2022 熊市', from: '2021-10-01', to: '2022-12-30' },
  { id: '2025', label: '2025 年初修正', from: '2024-12-02', to: '2025-07-31' },
  { id: '2026', label: '2026 年（至資料截止日）', from: '2026-01-02', to: '2026-11-13' },
];
const PAIRS = {
  'sox-ndx': { a: 'SOX', b: 'NDX', label: 'SOX vs Nasdaq-100' },
  'sox-spx': { a: 'SOX', b: 'SPX', label: 'SOX vs S&P 500' },
  'ndx-spx': { a: 'NDX', b: 'SPX', label: 'Nasdaq-100 vs S&P 500' },
  'rsp-spy': { a: 'RSP', b: 'SPY', label: 'RSP vs SPY' },
};
// 網站既有公開檔；RSP 沒有 → 探索器顯示「資料不可用」
const PRICE_FILES = { SOX: 'data/SOX.json', SPX: 'data/SP500.json', NDX: 'data/QQQ.json', SPY: 'data/SPY.json' };
const PNAME = { SOX: '費城半導體指數 SOX', NDX: 'QQQ（代表 Nasdaq-100）', SPX: 'S&P 500 指數', SPY: 'SPY', RSP: 'RSP' };

let D = null, PX = {}, charts = {}, loadedAt = 0;
const ui = { t: 'ndx', hz: 'h252k20', ev: '2022', pair: 'sox-ndx', mode: 'norm', ma: true, from: null, to: null,
  ft: 'ndx', fy0: '', fy1: '', fc: 'all', fd: 'all', sel: null, lagT: 'ndx' };

const stamp = () => `研究版本 ${D.version}｜資料截止 ${D.data_end}`;
function chart(key) {
  const host = byId(key + '-chart');
  if (!charts[key]) charts[key] = echarts.init(host, isLight() ? null : 'dark');
  return charts[key];
}
const foot = () => ({ type: 'text', right: 8, bottom: 2, style: { text: stamp(), fill: PALETTE.muted, fontSize: 10 } });

// ── 版面骨架（一次性）─────────────────────────────────────────────────
function skeleton() {
  const root = byId('root');
  if (!bindOnce(root)) return;
  root.innerHTML = `
<p class="uspr-verdict">一句話結論：歷史上 SOX <b>不是可靠的美股下跌領先訊號</b>，加入它也沒有穩定改善預測，<b>不建議拿來當買賣依據</b>。</p>
<p class="uspr-lede">${esc('1995～2026 年市場事件研究：SOX、Nasdaq-100 與 S&P 500 的歷史領先關係')}</p>
<div class="uspr-meta" id="uspeakrisk-meta"></div>
<div class="uspr-summary">
  <h3>研究摘要</h3>
  <ul id="uspeakrisk-summary"></ul>
  <p class="uspr-note">「領先比例」的意思：以 SOX 收盤<b>重新跌破 50 日均線</b>（之前連續 20 日站在線上）當作一次訊號，看 Nasdaq-100／S&P 500 在前後 40 個交易日內誰先跌破自己的 50 日均線。這是研究自訂的事件分類，<b>不是「所有下跌中 SOX 領先的比例」</b>。</p>
  <div class="uspr-actions"><button type="button" class="chip" id="uspeakrisk-share">複製目前畫面連結</button><span id="uspeakrisk-share-msg" class="uspr-dim" role="status" aria-live="polite"></span></div>
</div>

<h3 class="uspr-h" id="uspeakrisk-sec-lead" data-nav-focus="lead">B. SOX → QQQ → SPY：誰先轉弱？</h3>
<p class="uspr-note">為什麼有人認為半導體會領先？半導體是景氣循環最敏感的產業，也是 Nasdaq-100 的大權重，所以常被當作「礦坑裡的金絲雀」。下面用 83 次 SOX 訊號檢查這個說法。<b>SOX 先跌 ≠ QQQ 必然跟跌。</b></p>
<div class="uspr-card"><div class="uspr-cardhead"><b>四類事件占比</b><button type="button" class="chip" data-png="lead">下載 PNG</button></div>
  <div id="uspeakrisk-lead-chart" class="uspr-chart uspr-chart--short" role="img" aria-label="SOX 訊號四類事件占比"></div>
  <p class="uspr-cap">期間：SOX 訊號 1994-09～2026-11（全部 83 次已成熟訊號）｜來源：研究 P1 修正版 sox_lead_events_v2｜方法：互斥分類，目標指數在 SOX 前 3 日已在 50 日線下或前 40 日內曾跌破，一律算「目標先」。點長條可篩選下方事件清單。</p></div>
<div class="uspr-card"><div class="uspr-cardhead"><b>領先天數分布</b><span class="uspr-chips" id="uspeakrisk-lagt"><span class="chip active" data-lagt="ndx">Nasdaq-100</span><span class="chip" data-lagt="spx">S&amp;P 500</span></span></div>
  <div id="uspeakrisk-lagstats" class="uspr-tiles"></div>
  <div id="uspeakrisk-lag-chart" class="uspr-chart" role="img" aria-label="領先天數直方圖"></div>
  <p class="uspr-cap">橫軸：目標指數在 SOX 訊號前後 40 個交易日內<b>最早一次</b>跌破 50 日線的時間（負數＝目標指數先跌，正數＝SOX 先跌）。窗口內目標沒有跌破的事件不在圖中。</p></div>
<div class="uspr-card"><div class="uspr-cardhead"><b>事件清單</b><span id="uspeakrisk-evcount" class="uspr-dim"></span></div>
  <div class="uspr-filters">
    <label>目標指數 <select id="uspeakrisk-ft"><option value="ndx">Nasdaq-100</option><option value="spx">S&amp;P 500</option></select></label>
    <label>年份 <select id="uspeakrisk-fy0"></select>～<select id="uspeakrisk-fy1"></select></label>
    <label>誰先轉弱 <select id="uspeakrisk-fc"><option value="all">全部</option>${U.CATS.map(c => `<option value="${c}">${U.CAT_LABEL[c]}</option>`).join('')}</select></label>
    <label>60 日內跌 10% <select id="uspeakrisk-fd"><option value="all">全部</option><option value="yes">有</option><option value="no">沒有</option><option value="na">無法判定</option></select></label>
  </div>
  <div class="table-scroll" tabindex="0" aria-label="SOX 訊號事件清單"><table class="uspr-table" id="uspeakrisk-evtable"></table></div>
  <div id="uspeakrisk-evdetail" class="uspr-detail" aria-live="polite"></div></div>

<h3 class="uspr-h" id="uspeakrisk-sec-explore" data-nav-focus="explore">C. 歷史市場事件探索器</h3>
<p class="uspr-note">選一段歷史期間，看三個指數的走勢、回撤和相對強弱。這裡只描述<b>當時發生了什麼</b>；被列進清單不代表模型當年有成功預測。</p>
<div class="uspr-card">
  <div class="uspr-filters">
    <label>期間 <select id="uspeakrisk-ev">${PRESETS.map(p => `<option value="${p.id}">${esc(p.label)}</option>`).join('')}<option value="custom">自訂</option></select></label>
    <label>起 <input type="date" id="uspeakrisk-from" min="2000-01-03" max="2026-11-13"></label>
    <label>迄 <input type="date" id="uspeakrisk-to" min="2000-01-03" max="2026-11-13"></label>
  </div>
  <div class="uspr-filters">
    <span class="uspr-chips" id="uspeakrisk-pair">${Object.entries(PAIRS).map(([k, p]) => `<span class="chip" data-pair="${k}">${esc(p.label)}</span>`).join('')}</span>
    <span class="uspr-chips" id="uspeakrisk-mode"><span class="chip" data-mode="norm">標準化走勢</span><span class="chip" data-mode="dd">距 252 日高點回撤</span></span>
    <label><input type="checkbox" id="uspeakrisk-ma" checked> 50／150／200 日均線</label>
    <button type="button" class="chip" data-png="px">下載 PNG</button>
  </div>
  <div id="uspeakrisk-px-msg" class="uspr-msg" role="status"></div>
  <div id="uspeakrisk-px-chart" class="uspr-chart uspr-chart--tall" role="img" aria-label="指數走勢比較"></div>
  <div id="uspeakrisk-rs-chart" class="uspr-chart uspr-chart--short" role="img" aria-label="相對強弱"></div>
  <p class="uspr-cap">資料：本站既有的每日收盤檔（Yahoo Finance 原始收盤價，網站全站共用）。Nasdaq-100 以 QQQ 收盤代表（研究本身用 ^NDX 指數，兩者走勢相近但不完全相同）；這些檔案從 2000 年起，200 日線要到 2000 年 10 月才有值。RSP 不在本站資料內，選 RSP vs SPY 時顯示「資料不可用」。垂直虛線＝研究定義的 SOX 訊號日（SOX 重新跌破 50 日線）。回撤＝收盤距<b>當時已知</b> 252 日最高收盤，和研究的高檔定義同一口徑。</p>
</div>

<h3 class="uspr-h" id="uspeakrisk-sec-model" data-nav-focus="model">D. 加入 SOX 或 RSP/SPY，預測有沒有變好？</h3>
<div class="uspr-grid2">
  <div class="uspr-card"><b>基準模型 M0（只看價格）</b><ul class="uspr-list"><li>指數距 252 日最高收盤的距離</li><li>收盤相對 50 日均線</li><li>收盤相對 200 日均線</li><li>20 日實現波動率</li></ul></div>
  <div class="uspr-card"><b>M1 ＝ M0 ＋ 新指標</b><ul class="uspr-list"><li><b>＋SOX</b>：SOX 距 252 日高點、SOX 相對 50 日線、SOX 相對目標指數 63 日強弱</li><li><b>＋RSP/SPY</b>：等權／市值加權 63 日變化、RSP/SPY 距 252 日高點（2004 起）</li></ul></div>
</div>
<p class="uspr-note">只在指數「高檔」（收盤距當時已知 252 日最高收盤 ≤5%）的日子預測。逐年往前測（walk-forward）：每年只用之前的資料訓練，再預測當年。SOX 版從 2003 年起是樣本外，RSP 版從 2009 年起。</p>
<div class="uspr-card"><div class="uspr-cardhead"><b>預測目標</b><span class="uspr-chips" id="uspeakrisk-hz">${U.HORIZONS.map(h => `<span class="chip" data-hz="${h.id}">${h.label}</span>`).join('')}</span><button type="button" class="chip" data-png="forest">下載 PNG</button></div>
  <p class="uspr-plain" id="uspeakrisk-plain"></p>
  <div id="uspeakrisk-forest-chart" class="uspr-chart uspr-chart--short" role="img" aria-label="ΔAUC 與 90% 信賴區間"></div>
  <p class="uspr-cap">點＝加入新指標後分辨力（AUC）的變化 ΔAUC；橫線＝90% 信賴區間（以整次危機為單位重抽）。<b>橫線跨過 0 ＝ 無法確定有改善。</b>獨立危機群少於 5 次時不估計區間，只畫點（空心）。</p>
  <p class="uspr-dim uspr-swipe">表格可左右滑動 →</p><div class="table-scroll" tabindex="0" aria-label="模型比較表"><table class="uspr-table" id="uspeakrisk-mtable"></table></div>
  <p class="uspr-cap">AUC：0.5 ＝ 丟銅板，1 ＝ 完全分得出。Brier：機率預測的平均誤差，越小越好；Brier 技巧＝M1 比 M0 少了幾 % 的誤差（負數＝更差）。事件命中：一次下跌事件中，模型在之前任一高檔日發出警報（機率 ≥ 訓練期第 90 百分位）就算抓到；漏報率＝1−命中率。事件口徑：P1 最終審計的 EA 標籤錨定事件。來源：研究 P1 修正版 short/long.csv（AUC、Brier）、P1 最終審計 event_level_EA.csv（事件層級、危機區塊區間）。</p>
</div>

<h3 class="uspr-h" id="uspeakrisk-sec-peak" data-nav-focus="peak">E. 高檔預警真的有效嗎？</h3>
<div class="uspr-card" id="uspeakrisk-peak"></div>
<div class="uspr-card"><b>公平比較：SOX 訊號 vs 指數自己跌破 50 日線</b>
  <div class="table-scroll" tabindex="0" aria-label="公平比較表"><table class="uspr-table" id="uspeakrisk-fair"></table></div>
  <p class="uspr-cap">兩種訊號使用相同期間（1995-05 起）、相同去群聚（之前連續 20 日在線上）、相同結果定義（60 個交易日內收盤距當時已知 252 日高點 ≥10%）。區間＝90% Wilson 信賴區間。兩者發生在不同日子，所以只能說「沒有更好」，不能說「顯著較差」。</p></div>

<h3 class="uspr-h" id="uspeakrisk-sec-data" data-nav-focus="data">F. 為什麼沒有做市場廣度與 Minervini？</h3>
<div class="uspr-card"><div class="uspr-cardhead"><b>S&amp;P 500 歷史成分股：免費資料能取得價格的比例</b></div>
  <div id="uspeakrisk-cov-chart" class="uspr-chart" role="img" aria-label="歷史成分股價格覆蓋率"></div>
  <p class="uspr-cap">分母＝<b>當時</b>真正的 S&amp;P 500 成分股（GitHub fja05680/sp500 歷史名單）；分子＝Yahoo 免費資料能取得、而且代號對得上的日線。橘線＝之後被剔除、下市、併購的成分股的覆蓋率。來源：研究 P0 coverage_yearly.csv。</p>
  <div id="uspeakrisk-covtable"></div>
  <ul class="uspr-list">
    <li><b>缺的正好是跌最慘的公司。</b>免費資料大多沒有已下市股票，而 2000、2008 年廣度惡化的主力就是後來破產、被併購、被剔除的公司。用現在的成分股往回算，會把危機時期算得比實際健康（倖存者偏誤）。</li>
    <li><b>覆蓋率超過 90% 也不等於沒問題。</b>2023 年後整體超過 90%，但已退出成分股只有約一半有價格，而且這幾年沒有大型危機可以驗證。</li>
    <li>Nasdaq-100、SOX 找不到可靠的完整歷史成分名單。</li>
    <li>Minervini 趨勢模板需要每檔成分股的歷史價格，RS Rating 又是專有排名，因此沒有做可信的回測。NYSE／Nasdaq 官方漲跌家數與新高新低，也找不到可驗證、免費且持續更新的長歷史。</li>
    <li><b>無法驗證 ≠ 指標無效</b>，只是現有公開資料不足以回答。</li>
  </ul></div>

<h3 class="uspr-h" data-nav-focus="method">G. 研究方法與限制</h3>
<details class="uspr-details"><summary>名詞與方法（展開）</summary><dl class="uspr-dl">
<dt>Point-in-time 成分股</dt><dd>回測某一天時，只能用「當天」真正在指數裡的股票，不能用今天的名單。</dd>
<dt>倖存者偏誤</dt><dd>只看活下來的公司，會把過去看得比實際好。</dd>
<dt>Walk-forward（逐年往前測）</dt><dd>每年 1 月用之前的資料重新訓練，預測當年；訓練樣本的結果窗口必須在當年開始前結束，避免偷看答案。</dd>
<dt>Leave-one-crisis-out</dt><dd>拿掉一次危機（例如 2008），整個訓練與評分都不用它，看結論會不會翻轉。2000 年只在最初的訓練期，另外標示。</dd>
<dt>AUC</dt><dd>隨機挑一個「之後真的大跌」的日子和一個「沒有大跌」的日子，模型給前者較高機率的比例。0.5＝丟銅板。</dd>
<dt>Brier Score</dt><dd>機率預測和實際結果（0 或 1）差距平方的平均，越小越好。</dd>
<dt>Bootstrap 信賴區間</dt><dd>以「整次危機」為單位重複抽樣 2000 次，看 ΔAUC 的可能範圍。危機少於 5 次就不估計。</dd>
<dt>事件去群聚</dt><dd>同一波下跌只算一次訊號；SOX 要先連續 20 日站回 50 日線，才算下一次訊號。</dd>
<dt>EA 標籤錨定事件</dt><dd>事件層級統計的正式口徑：從模型標籤的每個正例日，找到它第一次跌到門檻的日子，中間沒有回到高檔的合併成一個事件。保證每個模型判定成功的案例都對應到事件。E252（用每天當時的滾動高點計算回撤）只用來描述市場，不和 EA 統計混用；原研究報告中的舊 E252 事件數字以最終審計為準。</dd>
<dt>交易日數 ≠ 獨立危機數</dt><dd>一次熊市會讓幾百個交易日都標成「之後會大跌」，但只算一次危機。統計可信度看的是危機數（這裡常常只有 2～5 次），不是幾千個交易日。</dd>
</dl>
<p class="uspr-note">其他限制：價格指數不含息；研究的 Nasdaq-100 用 ^NDX 指數；只用一種模型（羅吉斯迴歸），參數全部事前固定、沒有為了結果調整；約 30 組比較中出現一兩組「顯著」本來就可能是運氣。</p></details>

<h3 class="uspr-h" data-nav-focus="conclusion">H. 最終研究結論</h3>
<ol class="uspr-concl">
<li>SOX <b>不具備穩健的普遍領先關係</b>：只有 17%（Nasdaq-100）、19%（S&amp;P 500）的 SOX 訊號是 SOX 先跌，更常見的是目標指數自己先跌。</li>
<li>短期（10／20／40 日）加入 SOX 或 RSP/SPY，<b>沒有穩定勝過只看價格的 M0</b>。</li>
<li>長週期（Nasdaq-100 252 日內 −20%）少數結果為正，但只有 5 次獨立危機，屬於值得觀察的統計現象，<b>不是可靠的交易優勢</b>。</li>
<li>市場廣度與 Minervini 因免費歷史資料不足，<b>沒有正式驗證</b>。</li>
<li>本研究<b>不新增任何交易訊號</b>，原有策略規則維持不變。</li>
</ol>
<p class="uspr-disclaimer">本頁為歷史市場研究，不構成個別投資建議。</p>`;
}

// ── A 摘要 ─────────────────────────────────────────────────────────────
function renderSummary() {
  const n = U.catCounts(D.lead_events, 'ndx'), s = U.catCounts(D.lead_events, 'spx');
  const m = U.findModel(D.models, { t: 'ndx', x: 'sox', h: 252, k: 0.2 });
  const first = D.lead_events.map(e => e.d).sort()[0];
  byId('meta').innerHTML = `<span><b>SOX 訊號期間</b> ${first.slice(0, 7)}～2026-11</span><span><b>模型樣本外</b> SOX 版 2003 起、RSP 版 2009 起</span><span><b>資料截止</b> ${D.data_end}</span><span><b>版本</b> ${esc(D.version)}</span>`;
  byId('summary').innerHTML = `
<li>SOX 領先 Nasdaq-100 的事件比例約 <b>${pct(n.sox_first / n.total)}</b>（${n.sox_first}/${n.total}），領先 S&amp;P 500 約 <b>${pct(s.sox_first / s.total)}</b>（${s.sox_first}/${s.total}）。</li>
<li>短期 10／20／40 日的預測，加入 SOX 或 RSP/SPY 都<b>沒有穩健超越</b>只看價格的基準。</li>
<li>長週期可能有少量預測資訊（Nasdaq-100 252 日 −20%：ΔAUC ${sf3(m?.dauc)}），但獨立危機只有 ${m?.n_crisis ?? '—'} 次，事件不足。</li>
<li>最終<b>不新增買賣交易訊號</b>。</li>`;
}

// ── B 領先關係 ─────────────────────────────────────────────────────────
function drawLead() {
  const cnt = { ndx: U.catCounts(D.lead_events, 'ndx'), spx: U.catCounts(D.lead_events, 'spx') };
  const ts = ['spx', 'ndx'];
  chart('lead').setOption(echartsBase({
    tooltip: { trigger: 'item', formatter: p => `${U.TARGET_LABEL[ts[p.dataIndex]]}｜${p.seriesName}<br>${cnt[ts[p.dataIndex]][U.CATS[p.seriesIndex]]} 次（${p.value.toFixed(0)}%）` },
    legend: { top: 0, textStyle: { color: PALETTE.text, fontSize: 11 } },
    grid: { left: mob() ? 78 : 96, right: 16, top: mob() ? 52 : 34, bottom: 40 },
    xAxis: { type: 'value', max: 100, axisLabel: { color: PALETTE.muted, formatter: '{value}%' } },
    yAxis: { type: 'category', data: ts.map(t => U.TARGET_LABEL[t]), axisLabel: { color: PALETTE.text } },
    dataZoom: [],
    graphic: [foot()],
    series: U.CATS.map(c => ({ name: U.CAT_LABEL[c], type: 'bar', stack: 'a', itemStyle: { color: COL[c] },
      label: { show: true, color: '#fff', fontSize: 11, formatter: p => (p.value >= 8 ? cnt[ts[p.dataIndex]][c] : '') },
      data: ts.map(t => (cnt[t][c] / cnt[t].total) * 100) })),
  }), { notMerge: true });
  const ch = charts.lead;
  ch.off('click');
  ch.on('click', p => { ui.ft = ts[p.dataIndex]; ui.fc = U.CATS[p.seriesIndex]; syncFilters(); renderEvents(); byId('evtable').scrollIntoView({ behavior: 'smooth', block: 'nearest' }); });
}

function drawLag() {
  const L = U.lagStats(D.lead_events, ui.lagT), q = D.lag_dist[ui.lagT];
  byId('lagstats').innerHTML = [
    ['「SOX 先轉弱」事件的領先天數中位數', `${fin(L.medianSoxFirst) ? String(L.medianSoxFirst).replace('-', '−') : '—'} 個交易日`, `只看 SOX 先跌的 ${L.soxFirst.length} 次`],
    ['全部事件的領先天數中位數', `${fin(L.medianAll) ? String(L.medianAll).replace('-', '−') : '—'} 個交易日`, `負數＝目標指數通常先跌（${L.all.length} 次窗口內有跌破）`],
    ['SOX 領先超過 2 日的比例', pct(q.gt2), `目標先跌 ${pct(q.lt_m2)}｜±2 日內 ${pct(q.abs_le2)}`],
  ].map(([k, v, s]) => `<div class="uspr-tile"><div class="uspr-k">${k}</div><div class="uspr-v">${v}</div><div class="uspr-s">${s}</div></div>`).join('');
  const bins = U.histogram(L.all);
  const color = b => (b.to < -2 ? COL.target_first : b.from > 2 ? COL.sox_first : COL.sync);
  chart('lag').setOption(echartsBase({
    tooltip: { trigger: 'axis', formatter: ps => `${ps[0].name} 日：${ps[0].value} 次` },
    grid: { left: 40, right: 16, top: 24, bottom: 58 },
    xAxis: { type: 'category', data: bins.map(b => `${b.from}～${b.to}`), name: '目標跌破相對 SOX 的交易日', nameLocation: 'middle', nameGap: 28, nameTextStyle: { color: PALETTE.muted }, axisLabel: { color: PALETTE.muted, fontSize: 10, rotate: mob() ? 45 : 0 } },
    yAxis: { type: 'value', name: '次數', nameTextStyle: { color: PALETTE.muted } },
    dataZoom: [],
    graphic: [foot(), { type: 'text', left: 48, top: 4, style: { text: '← 目標指數先跌　　SOX 先跌 →', fill: PALETTE.muted, fontSize: 11 } }],
    series: [{ type: 'bar', data: bins.map(b => ({ value: b.n, itemStyle: { color: color(b) } })) }],
  }), { notMerge: true });
}

function syncFilters() {
  for (const k of ['ft', 'fy0', 'fy1', 'fc', 'fd']) byId(k).value = ui[k];
}
const YES = { true: '有', false: '沒有', null: '無法判定' };
function renderEvents() {
  const rows = U.filterEvents(D.lead_events, { t: ui.ft, from: ui.fy0 || null, to: ui.fy1 || null, cat: ui.fc, dd10: ui.fd }).slice().sort((a, b) => b.d.localeCompare(a.d));
  byId('evcount').textContent = `${rows.length} 筆（${U.TARGET_LABEL[ui.ft]}）`;
  byId('evtable').innerHTML = `<thead><tr><th>SOX 訊號日</th><th>誰先轉弱</th><th>目標跌破時間</th><th>當時目標在高檔</th><th>60 日內跌 10%</th></tr></thead><tbody>` +
    (rows.length ? rows.map(e => `<tr tabindex="0" data-d="${e.d}" class="${ui.sel === e.d ? 'uspr-sel' : ''}"><td>${e.d}</td><td><span class="uspr-dot" style="background:${COL[e.c]}"></span>${U.CAT_LABEL[e.c]}</td><td>${e.lag == null ? '窗口內沒有' : `${e.lag > 0 ? '+' : ''}${e.lag} 日`.replace('-', '−')}</td><td>${e.hz == null ? '—' : e.hz ? '是' : '否'}</td><td>${YES[e.dd10]}</td></tr>`).join('')
      : '<tr><td colspan="5">沒有符合條件的事件</td></tr>') + '</tbody>';
}
function renderDetail(d) {
  const e = D.lead_events.find(x => x.t === ui.ft && x.d === d);
  if (!e) { byId('evdetail').innerHTML = ''; return; }
  ui.sel = d;
  byId('evdetail').innerHTML = `<b>${e.d}｜${U.TARGET_LABEL[e.t]}</b>：${U.CAT_LABEL[e.c]}。` +
    (e.lag == null ? '前後 40 個交易日內目標指數沒有跌破 50 日線。' : `目標指數最早一次跌破 50 日線在 SOX 訊號${e.lag < 0 ? `前 ${-e.lag}` : e.lag > 0 ? `後 ${e.lag}` : '同一'}個交易日。`) +
    (e.pw ? '訊號前目標指數已經在 50 日線下。' : '') +
    `SOX 10 日內${e.rec == null ? '（無法判定）' : e.rec ? '已站回' : '沒有站回'} 50 日線；目標指數之後 60 個交易日內${e.dd10 == null ? '無法判定是否' : e.dd10 ? '' : '沒有'}跌到距前高 −10%。` +
    (e.d >= '2000-03-01' ? ` <button type="button" class="chip" id="uspeakrisk-goexp">在探索器中查看前後 6 個月</button>` : ' <span class="uspr-dim">（探索器資料從 2000 年起）</span>');
  const btn = byId('goexp');
  if (btn) btn.onclick = () => {
    const dt = new Date(e.d + 'T00:00:00');
    const iso = x => x.toISOString().slice(0, 10);
    const a = new Date(dt); a.setMonth(a.getMonth() - 6); const b = new Date(dt); b.setMonth(b.getMonth() + 6);
    ui.ev = 'custom'; ui.from = iso(a) < '2000-01-03' ? '2000-01-03' : iso(a); ui.to = iso(b) > D.data_end ? D.data_end : iso(b);
    ui.pair = e.t === 'ndx' ? 'sox-ndx' : 'sox-spx';
    syncExplorer(); drawExplorer(); byId('sec-explore').scrollIntoView({ behavior: 'smooth' });
  };
  renderEvents();
}

// ── C 探索器 ───────────────────────────────────────────────────────────
function syncExplorer() {
  byId('ev').value = ui.ev;
  const p = PRESETS.find(x => x.id === ui.ev);
  if (p) { ui.from = p.from; ui.to = p.to; }
  byId('from').value = ui.from; byId('to').value = ui.to;
  for (const c of byId('pair').querySelectorAll('.chip')) c.classList.toggle('active', c.dataset.pair === ui.pair);
  for (const c of byId('mode').querySelectorAll('.chip')) c.classList.toggle('active', c.dataset.mode === ui.mode);
  byId('ma').checked = ui.ma; byId('ma').disabled = ui.mode !== 'norm';
}
function drawExplorer() {
  const pair = PAIRS[ui.pair], msg = byId('px-msg');
  const A = PX[pair.a], B = PX[pair.b];
  if (!A || !B) {
    msg.textContent = `資料不可用：${!A ? PNAME[pair.a] : PNAME[pair.b]} 不在本站可公開的資料內（或載入失敗），因此不顯示這組比較，也不以模擬走勢代替。`;
    for (const k of ['px', 'rs']) if (charts[k]) charts[k].clear();
    return;
  }
  const from = ui.from, to = ui.to;
  if (!from || !to || from >= to) { msg.textContent = '起訖日期不正確。'; return; }
  const series = [], lines = [[pair.a, A], [pair.b, B]];
  let anyData = false;
  for (const [name, s] of lines) {
    const idx = U.sliceRange(s, from, to);
    if (!idx.length) continue;
    anyData = true;
    const col = LINE[name];
    if (ui.mode === 'dd') {
      const dd = U.drawdown252(s);
      series.push({ name: PNAME[name], type: 'line', showSymbol: false, lineStyle: { color: col, width: 1.6 }, itemStyle: { color: col },
        data: idx.map(i => [s[i][0], dd[i] == null ? null : +(dd[i] * 100).toFixed(2)]) });
    } else {
      const base = s[idx[0]][1];
      series.push({ name: PNAME[name], type: 'line', showSymbol: false, lineStyle: { color: col, width: 1.8 }, itemStyle: { color: col },
        data: idx.map(i => [s[i][0], +(s[i][1] / base * 100).toFixed(2)]) });
      if (ui.ma) for (const [n, type] of [[50, 'dotted'], [150, 'dashed'], [200, 'solid']]) {
        const m = U.sma(s, n);
        series.push({ name: `${name} ${n}MA`, type: 'line', showSymbol: false, lineStyle: { color: col, width: 0.9, type, opacity: 0.75 }, itemStyle: { color: col },
          data: idx.map(i => [s[i][0], m[i] == null ? null : +(m[i] / base * 100).toFixed(2)]) });
      }
    }
  }
  if (!anyData) { msg.textContent = '這段期間沒有資料。'; return; }
  const sig = [...new Set(D.lead_events.filter(e => e.d >= from && e.d <= to).map(e => e.d))];
  if (series.length) series[0].markLine = { symbol: 'none', silent: true, label: { show: false }, lineStyle: { color: COL.sox_first, type: 'dashed', width: 1 }, data: sig.map(d => ({ xAxis: d })) };
  msg.textContent = sig.length ? `本期間有 ${sig.length} 次 SOX 訊號（垂直虛線）。` : '本期間沒有研究定義的 SOX 訊號。';
  chart('px').setOption(echartsBase({
    tooltip: { trigger: 'axis', valueFormatter: v => (v == null ? '—' : ui.mode === 'dd' ? `${v}%` : v) },
    legend: { top: 0, type: 'scroll', textStyle: { color: PALETTE.text, fontSize: 11 } },
    grid: { left: 52, right: 16, top: 40, bottom: 44 },
    xAxis: { type: 'time', axisLabel: { color: PALETTE.muted, hideOverlap: true } },
    yAxis: { type: 'value', scale: true, name: ui.mode === 'dd' ? '距 252 日高點 %' : '期初 = 100', nameTextStyle: { color: PALETTE.muted } },
    dataZoom: [],
    graphic: [foot()],
    series,
  }), { notMerge: true });
  const rs = U.relStrength(A, B, from, to);
  chart('rs').setOption(echartsBase({
    tooltip: { trigger: 'axis', valueFormatter: v => (v == null ? '—' : v.toFixed(3)) },
    grid: { left: 52, right: 16, top: 30, bottom: 26 },
    title: { text: `相對強弱 ${pair.a}/${pair.b}（期初 = 1，往上＝${pair.a} 較強）`, left: 8, top: 0, textStyle: { color: PALETTE.text, fontSize: 12, fontWeight: 'normal' } },
    xAxis: { type: 'time', axisLabel: { color: PALETTE.muted, hideOverlap: true } },
    yAxis: { type: 'value', scale: true },
    dataZoom: [],
    series: [{ type: 'line', showSymbol: false, data: rs.map(([d, v]) => [d, +v.toFixed(4)]), lineStyle: { color: PALETTE.text, width: 1.4 }, itemStyle: { color: PALETTE.text },
      markLine: { symbol: 'none', silent: true, label: { show: false }, lineStyle: { color: PALETTE.muted, type: 'dashed' }, data: [{ yAxis: 1 }] } }],
  }), { notMerge: true });
}

// ── D 模型比較 ─────────────────────────────────────────────────────────
function drawModels() {
  const hz = U.HORIZONS.find(h => h.id === ui.hz);
  for (const c of byId('hz').querySelectorAll('.chip')) c.classList.toggle('active', c.dataset.hz === ui.hz);
  const rows = U.forestRows(D.models, hz).reverse();
  chart('forest').setOption(echartsBase({
    tooltip: { trigger: 'item', formatter: p => { const r = rows[p.value[1]]; return r.m?.dauc == null ? `${r.label}：未計算（正例不足）` : `${r.label}<br>ΔAUC ${sf3(r.d)}<br>90% 區間 ${ciTxt(r.ci)}<br>獨立危機群 ${r.m.n_crisis}`; } },
    grid: { left: mob() ? 118 : 150, right: 24, top: 16, bottom: 50 },
    xAxis: { type: 'value', min: -0.3, max: 0.4, name: 'ΔAUC（M1 − M0）', nameLocation: 'middle', nameGap: 24, nameTextStyle: { color: PALETTE.muted } },
    yAxis: { type: 'category', data: rows.map(r => r.label), axisLabel: { color: PALETTE.text, fontSize: 11 } },
    dataZoom: [],
    graphic: [foot()],
    series: [
      { type: 'custom', renderItem: (params, api) => {
        const r = rows[api.value(1)]; if (!r.ci) return null;
        const a = api.coord([r.ci[0], api.value(1)]), b = api.coord([r.ci[1], api.value(1)]);
        const col = U.ciCrossesZero(r.ci) ? PALETTE.muted : '#d29922';
        return { type: 'group', children: [
          { type: 'line', shape: { x1: a[0], y1: a[1], x2: b[0], y2: b[1] }, style: { stroke: col, lineWidth: 2 } },
          { type: 'line', shape: { x1: a[0], y1: a[1] - 5, x2: a[0], y2: a[1] + 5 }, style: { stroke: col, lineWidth: 2 } },
          { type: 'line', shape: { x1: b[0], y1: b[1] - 5, x2: b[0], y2: b[1] + 5 }, style: { stroke: col, lineWidth: 2 } }] };
      }, data: rows.map((r, i) => [r.d ?? 0, i]), z: 1, tooltip: { show: false } },
      { type: 'scatter', symbolSize: 10, z: 2, data: rows.map((r, i) => (r.d == null ? null : { value: [r.d, i], itemStyle: r.ci ? { color: PALETTE.text } : { color: 'transparent', borderColor: PALETTE.text, borderWidth: 2 } })),
        markLine: { symbol: 'none', silent: true, label: { show: false }, lineStyle: { color: PALETTE.muted, type: 'dashed' }, data: [{ xAxis: 0 }] } },
    ],
  }), { notMerge: true });
  const R = U.forestRows(D.models, hz);
  const ok = R.filter(r => r.m && r.m.dauc != null);
  const robust = ok.filter(r => r.ci && !U.ciCrossesZero(r.ci));
  byId('plain').innerHTML = `<b>白話判讀（${hz.label}）：</b>` + (!ok.length ? '這個目標的大跌次數太少，無法比較。'
    : robust.length ? `只有 ${robust.map(r => r.label).join('、')} 的改善在統計上看得到，但獨立危機只有 ${robust.map(r => r.m.n_crisis).join('、')} 次，而且機率準確度（Brier）幾乎沒變，<b>不足以當作交易依據</b>。其餘組合無法確定有改善。`
    : '加入新指標後，<b>無法確定預測有變好</b>（信賴區間跨過 0，或危機次數太少不估計）。');
  const miss = r => (Array.isArray(r) && r[1] ? pct(1 - r[0] / r[1]) : '—');
  byId('mtable').innerHTML = `<thead><tr><th>組合</th><th>AUC M0</th><th>AUC M1</th><th>ΔAUC</th><th>90% 區間（危機區塊）</th><th>Brier M0／M1</th><th>Brier 技巧</th><th>事件命中 M0／M1</th><th>漏報率 M0／M1</th><th>獨立危機群</th></tr></thead><tbody>` +
    R.map(r => { const m = r.m; if (!m || m.dauc == null) return `<tr><td>${r.label}</td><td colspan="9">${esc(m?.note || '未計算')}（正例少於 5 天，無法訓練）</td></tr>`;
      return `<tr><td>${r.label}<div class="uspr-dim">樣本外 ${m.oos_from} 起</div></td><td>${f3(m.auc0)}</td><td>${f3(m.auc1)}</td><td>${sf3(m.dauc)}</td><td>${ciTxt(m.ci_crisis)}${m.ci_crisis ? (U.ciCrossesZero(m.ci_crisis) ? '<div class="uspr-dim">跨過 0</div>' : '<div class="uspr-dim">未跨 0，但見下方說明</div>') : `<div class="uspr-dim">危機 ${m.n_crisis} 次 &lt; 5</div>`}</td><td>${m.brier0?.toFixed(4)}／${m.brier1?.toFixed(4)}</td><td>${pct(m.bss, 1)}</td><td>${m.rec0.join('/')}／${m.rec1.join('/')}</td><td>${miss(m.rec0)}／${miss(m.rec1)}</td><td>${m.n_crisis}</td></tr>`; }).join('') + '</tbody>';
}

// ── E 高檔預警案例 ─────────────────────────────────────────────────────
function renderPeak() {
  const m = U.findModel(D.models, { t: 'ndx', x: 'sox', h: 252, k: 0.2 });
  const s = U.findModel(D.models, { t: 'spx', x: 'sox', h: 252, k: 0.2 });
  byId('peak').innerHTML = `
<b>研究的「高檔」是什麼？</b>
<p>收盤距<b>當天已經知道</b>的過去 252 個交易日最高收盤不到 5%。模型只在這些日子收盤後給出「之後 h 日內跌到距該高點 −10%／−20%」的機率。</p>
<ol class="uspr-timeline">
  <li><b>t 日收盤後</b>：指數在高檔，模型算出機率；超過訓練期第 90 百分位就算「發出警報」。</li>
  <li><b>t+1 起</b>：開始觀察；這段期間內任何一天收盤跌破門檻就算「事件發生」。</li>
  <li><b>t+h 日</b>：窗口結束才知道最終答案。252 日的目標要等<b>一年</b>才能確認。資料尾端還沒走完的日子不算成功也不算失敗。</li>
</ol>
<p class="uspr-note"><b>事前預警</b>＝在 t 日只用當時資料就能算出的警報；<b>事後解釋</b>＝知道最後跌了，回頭找「當時其實有跡象」。本頁的命中率全部是前者（逐年往前測），但事件太少時，前者也可能只是運氣。</p>
<div class="uspr-case"><div class="uspr-cardhead"><b>重點案例：Nasdaq-100 未來 252 日內 −20%，加入 SOX</b></div>
<div class="uspr-tiles">
  <div class="uspr-tile"><div class="uspr-k">排序能力變化 ΔAUC</div><div class="uspr-v">${sf3(m.dauc)}</div><div class="uspr-s">AUC ${f3(m.auc0)} → ${f3(m.auc1)}：數字變好，但樣本太少，見下方結論</div></div>
  <div class="uspr-tile"><div class="uspr-k">90% 危機區塊區間</div><div class="uspr-v">${ciTxt(m.ci_crisis)}</div><div class="uspr-s">只有 ${m.n_crisis} 個獨立危機群，剛好是可估計的下限</div></div>
  <div class="uspr-tile"><div class="uspr-k">事件命中 M0／M0+SOX</div><div class="uspr-v">${m.rec0.join('/')}／${m.rec1.join('/')}</div><div class="uspr-s">命中時提前約 ${m.lead1 ? `${Math.round(m.lead1[0])}～${Math.round(m.lead1[2])}` : '—'} 個交易日</div></div>
  <div class="uspr-tile"><div class="uspr-k">Brier 技巧</div><div class="uspr-v">${pct(m.bss, 1)}</div><div class="uspr-s">機率估計幾乎沒有變準</div></div>
</div>
<p>同一組合換成 S&amp;P 500：ΔAUC ${sf3(s.dauc)}（方向相反），只有 ${s.n_crisis} 次危機，不估計區間。逐一拿掉 2008、2020、2022 重新訓練，Nasdaq-100 的 ΔAUC 仍為正（約 +0.07～+0.11）。</p>
<p class="uspr-callout"><b>這是值得觀察的統計現象，並不是可靠的交易優勢。</b>5 次危機太少；機率沒有變準；S&amp;P 500 不成立；而且這是約 30 組比較中的一組。</p></div>`;
  const F = D.fair;
  const row = (t, pop) => ['sox', 'self'].map(sg => F.find(x => x.t === t && x.pop === pop && x.signal === sg));
  byId('fair').innerHTML = `<thead><tr><th>目標</th><th>母體</th><th>SOX 跌破 50 日線</th><th>目標自己跌破 50 日線</th></tr></thead><tbody>` +
    [['ndx', 'all'], ['ndx', 'highzone'], ['spx', 'all'], ['spx', 'highzone']].map(([t, pop]) => {
      const [a, b] = row(t, pop); const c = x => `${pct(x.rate)}（${x.hits}/${x.n}）<div class="uspr-dim">區間 ${pct(x.ci90[0])}～${pct(x.ci90[1])}${x.pending ? `｜未成熟 ${x.pending}` : ''}｜沒出事 ${x.non_crisis}</div>`;
      return `<tr><td>${U.TARGET_LABEL[t]}</td><td>${pop === 'all' ? '全部' : '目標在高檔'}</td><td>${c(a)}</td><td>${c(b)}</td></tr>`;
    }).join('') + '</tbody>';
}

// ── F 資料完整性 ───────────────────────────────────────────────────────
function drawCoverage() {
  const C = D.coverage;
  chart('cov').setOption(echartsBase({
    tooltip: { trigger: 'axis', valueFormatter: v => `${v}%` },
    legend: { top: 0, textStyle: { color: PALETTE.text, fontSize: 11 } },
    grid: { left: 44, right: 16, top: 36, bottom: 44 },
    xAxis: { type: 'category', data: C.map(r => r.y), axisLabel: { color: PALETTE.muted } },
    yAxis: { type: 'value', max: 100, axisLabel: { formatter: '{value}%' } },
    dataZoom: [],
    graphic: [foot()],
    series: [
      { name: '當時全部成分股', type: 'bar', itemStyle: { color: '#58a6ff' }, data: C.map(r => +(r.B * 100).toFixed(1)),
        markLine: { symbol: 'none', silent: true, label: { formatter: '90%', color: PALETTE.muted }, lineStyle: { color: PALETTE.muted, type: 'dashed' }, data: [{ yAxis: 90 }] } },
      { name: '之後被剔除／下市的成分股', type: 'line', itemStyle: { color: '#f0883e' }, lineStyle: { color: '#f0883e' }, data: C.map(r => (r.Bx == null ? null : +(r.Bx * 100).toFixed(1))) },
    ],
  }), { notMerge: true });
  const pick = [2000, 2008, 2015, 2020, 2022, 2025].map(y => C.find(r => r.y === y)).filter(Boolean);
  byId('covtable').innerHTML = `<div class="table-scroll" tabindex="0" aria-label="覆蓋率表"><table class="uspr-table"><thead><tr><th>年份</th>${pick.map(r => `<th>${r.y}</th>`).join('')}</tr></thead><tbody><tr><td>有效價格覆蓋率</td>${pick.map(r => `<td>${pct(r.B, 1)}</td>`).join('')}</tr><tr><td>其中已退出成分股</td>${pick.map(r => `<td>${pct(r.Bx, 1)}</td>`).join('')}</tr></tbody></table></div>`;
}

// ── 互動、分享、匯出 ─────────────────────────────────────────────────
function shareState() { return { t: ui.ft, hz: ui.hz, ev: ui.ev === 'custom' ? null : ui.ev, pair: ui.pair, mode: ui.mode }; }
function updateURL() {
  const h = U.stateHash(shareState());
  if (location.hash !== h && /tab=uspeakrisk/.test(location.hash || '')) history.replaceState(history.state, '', h);
}
function wire() {
  const root = byId('root');
  if (!bindOnce(root.querySelector('.uspr-summary'))) return;
  const years = [...new Set(D.lead_events.map(e => e.d.slice(0, 4)))].sort();
  const opts = years.map(y => `<option value="${y}">${y}</option>`).join('');
  byId('fy0').innerHTML = opts; byId('fy1').innerHTML = opts;
  ui.fy0 = years[0]; ui.fy1 = years.at(-1);
  for (const k of ['ft', 'fy0', 'fy1', 'fc', 'fd']) byId(k).addEventListener('change', () => { ui[k] = byId(k).value; ui.sel = null; byId('evdetail').innerHTML = ''; renderEvents(); updateURL(); });
  const pickRow = ev => { const tr = ev.target.closest('tr[data-d]'); if (tr) renderDetail(tr.dataset.d); };
  byId('evtable').addEventListener('click', pickRow);
  byId('evtable').addEventListener('keydown', ev => { if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); pickRow(ev); } });
  chipPicker(byId('lagt'), 'lagt', v => { ui.lagT = v; drawLag(); });
  chipPicker(byId('hz'), 'hz', v => { ui.hz = v; drawModels(); updateURL(); });
  chipPicker(byId('pair'), 'pair', v => { ui.pair = v; drawExplorer(); updateURL(); });
  chipPicker(byId('mode'), 'mode', v => { ui.mode = v; byId('ma').disabled = v !== 'norm'; drawExplorer(); updateURL(); });
  byId('ma').addEventListener('change', () => { ui.ma = byId('ma').checked; drawExplorer(); });
  byId('ev').addEventListener('change', () => { ui.ev = byId('ev').value; syncExplorer(); drawExplorer(); updateURL(); });
  for (const k of ['from', 'to']) byId(k).addEventListener('change', () => { ui[k] = byId(k).value; ui.ev = 'custom'; byId('ev').value = 'custom'; drawExplorer(); updateURL(); });
  byId('share').addEventListener('click', async () => {
    updateURL();
    const url = location.href.split('#')[0] + U.stateHash(shareState());
    try { await navigator.clipboard.writeText(url); byId('share-msg').textContent = '已複製連結（含目前選擇的指數、預測目標、期間與比較組合）'; }
    catch { byId('share-msg').textContent = url; }
  });
  root.addEventListener('click', ev => {
    const b = ev.target.closest('[data-png]'); if (!b) return;
    const ch = charts[b.dataset.png]; if (!ch) return;
    const a = document.createElement('a');
    a.href = ch.getDataURL({ type: 'png', pixelRatio: 2, backgroundColor: getComputedStyle(document.body).backgroundColor || '#fff' });
    a.download = `uspeakrisk_${b.dataset.png}_${D.version}.png`; a.click();
  });
}

function drawAll() {
  renderSummary(); drawLead(); drawLag(); syncFilters(); renderEvents(); syncExplorer(); drawExplorer(); drawModels(); renderPeak(); drawCoverage();
  for (const c of byId('lagt').querySelectorAll('.chip')) c.classList.toggle('active', c.dataset.lagt === ui.lagT);
}

// ── lifecycle ──────────────────────────────────────────────────────────
export async function activate(context = {}) {
  if (D && Date.now() - loadedAt < 300_000) { resize(); return; }
  skeleton();
  try {
    D = await requestJSON('data/uspeakrisk.json', { signal: context.signal });
    if (context.signal?.aborted || context.isCurrent?.() === false) return;
    if (!Array.isArray(D?.lead_events) || !Array.isArray(D?.models)) throw new Error('data/uspeakrisk.json 格式不完整');
    // 價格探索器資料是 optional：任一檔失敗只讓探索器顯示「資料不可用」
    const got = await Promise.all(Object.entries(PRICE_FILES).map(([k, url]) => requestJSON(url, { signal: context.signal }).then(j => [k, U.closes(j)]).catch(e => { if (context.signal?.aborted) throw e; return [k, null]; })));
    if (context.signal?.aborted || context.isCurrent?.() === false) return;
    PX = Object.fromEntries(got.filter(([, v]) => v && v.length).map(([k, v]) => [k, v.filter(r => r[0] <= D.data_end)]));
    byId('status').textContent = Object.keys(PX).length < 4 ? '部分價格資料載入失敗：探索器相關比較會顯示「資料不可用」。' : '';
  } catch (e) {
    if (!context.signal?.aborted) byId('status').textContent = '載入失敗：' + (e.message || e);
    throw e;
  }
  loadedAt = Date.now();
  const st = U.parseState(location.hash);
  if (st.t) ui.ft = st.t, ui.lagT = st.t;
  if (st.hz) ui.hz = st.hz;
  if (st.ev && PRESETS.some(p => p.id === st.ev)) ui.ev = st.ev;
  if (st.pair) ui.pair = st.pair;
  if (st.mode) ui.mode = st.mode;
  wire();
  drawAll();
}
export function getCharts() { return Object.values(charts); }
export function resize() { for (const c of Object.values(charts)) c.resize(); }
export function onThemeChange() {
  if (!D) return;
  return preserveChartState(getCharts, () => {
    for (const c of Object.values(charts)) c.dispose();
    charts = {};
    drawAll();
  });
}
