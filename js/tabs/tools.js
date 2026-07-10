// 工具箱 tab — 台股教育速查 + 7 個純前端互動計算機。
// 無任何外部資料源／無 fetch／無 JSON，全部 client-side 即時計算。
// 內容改編整理自 tw-stock.com 公開台股常識（見沙盒 tw_stock_portable.md）；
// 費率/法規參數（融資成數、追繳線等）以證交所/金管會官方公告為準。

let wired = false;

// ── Calculator state (defaults = spec 驗算例，載入即可肉眼核對) ───────────
const dca    = { monthly: 5000, rate: 6, years: 20 };
const r72    = { rate: 6 };
const cagr   = { start: 100000, end: 150000, years: 3 };
const avg    = { rows: [{ price: 100, shares: 1000 }, { price: 90, shares: 2000 }] };
const rev    = { price: 110, pl: 10 };
const fire   = { expense: 600000, rate: 4 };
const infl   = { amount: 1000000, rate: 3, years: 20 };
const val    = { eps: 5, per: 15, div: 3, yld: 5 };
const margin = { value: 100000, pct: 60, call: 130 };

// ── Formatting ────────────────────────────────────────────────────────────
const $ = id => document.getElementById(id);
const fmtInt = v => isFinite(v) ? Math.round(v).toLocaleString('en-US') : '—';
const fmtMoney = v => isFinite(v) ? fmtInt(v) + ' 元' : '—';
const fmtWan = v => isFinite(v) ? (v / 10000).toLocaleString('en-US', { maximumFractionDigits: 1 }) + ' 萬元' : '—';
const fmtNum = (v, d = 0) => isFinite(v) ? v.toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d }) : '—';
const fmtPct = (v, d = 1) => isFinite(v) ? (v >= 0 ? '+' : '') + v.toFixed(d) + '%' : '—';
const clsPN = v => isFinite(v) ? (v >= 0 ? 'pos' : 'neg') : '';
function resItem(label, val_, cls = '', sub = '') {
  return `<div class="tools-res-item"><div class="tr-label">${label}</div>` +
    `<div class="tr-val ${cls}">${val_}</div>${sub ? `<div class="tr-sub">${sub}</div>` : ''}</div>`;
}
function field(label, key, val_, opts = {}) {
  const { step = 1, min = '', unit = '' } = opts;
  return `<div class="tools-field"><label>${label}${unit ? ` (${unit})` : ''}</label>` +
    `<input type="number" data-set="${key}" value="${val_}" step="${step}" ${min !== '' ? `min="${min}"` : ''}/></div>`;
}

// ── Calc engines ──────────────────────────────────────────────────────────
function calcDca() {
  const { monthly, rate, years } = dca;
  const principal = monthly * 12 * years;
  const n = years * 12, mr = rate / 100 / 12;
  const fv = Math.abs(mr) < 1e-9 ? monthly * n : monthly * (Math.pow(1 + mr, n) - 1) / mr;
  const profit = fv - principal;
  return { principal, fv, profit, roi: principal > 0 ? profit / principal : NaN };
}
function calcR72() { return r72.rate > 0 ? 72 / r72.rate : NaN; }
function calcCagr() {
  const { start, end, years } = cagr;
  const c = (start > 0 && years > 0) ? Math.pow(end / start, 1 / years) - 1 : NaN;
  const total = start > 0 ? end / start - 1 : NaN;
  return { c, total };
}
function calcAvg() {
  let cost = 0, shares = 0;
  for (const r of avg.rows) { cost += (+r.price || 0) * (+r.shares || 0); shares += (+r.shares || 0); }
  return shares > 0 ? cost / shares : NaN;
}
function calcRev() { return rev.price / (1 + rev.pl / 100); }
function calcFire() { return fire.rate > 0 ? fire.expense / (fire.rate / 100) : NaN; }
function calcInfl() { return infl.amount / Math.pow(1 + infl.rate / 100, infl.years); }
function calcVal() {
  return {
    perPrice: val.eps * val.per,
    divPrice: val.yld > 0 ? val.div / (val.yld / 100) : NaN,
  };
}
function calcMargin() {
  const { value, pct, call } = margin;
  const loan = value * pct / 100;
  const selfFund = value - loan;
  const initMaint = loan > 0 ? value / loan * 100 : NaN;
  const triggerValue = loan * call / 100;
  const dropPct = value > 0 ? (value - triggerValue) / value * 100 : NaN;
  return { loan, selfFund, initMaint, triggerValue, dropPct };
}

// ── Result renderers (只重繪結果區，不動 input) ────────────────────────────
function renderDca() {
  const r = calcDca();
  $('tools-res-dca').innerHTML =
    resItem('期末總值', fmtMoney(r.fv), '', fmtWan(r.fv)) +
    resItem('總投入本金', fmtMoney(r.principal), '', fmtWan(r.principal)) +
    resItem('總報酬', fmtMoney(r.profit), clsPN(r.profit)) +
    resItem('總報酬率', fmtPct(r.roi * 100), clsPN(r.profit));
}
function renderR72() {
  const y = calcR72();
  $('tools-res-r72').innerHTML = resItem('翻倍年數', isFinite(y) ? y.toFixed(1) + ' 年' : '—');
}
function renderCagr() {
  const { c, total } = calcCagr();
  $('tools-res-cagr').innerHTML =
    resItem('CAGR（年化報酬率）', isFinite(c) ? fmtPct(c * 100, 2) : '—', clsPN(c)) +
    resItem('總報酬率', isFinite(total) ? fmtPct(total * 100, 1) : '—', clsPN(total));
}
function renderAvgRows() {
  $('tools-avg-rows').innerHTML = avg.rows.map((r, i) => `
    <div class="tools-avg-row">
      <input type="number" data-set="avg.price.${i}" value="${r.price}" step="0.01" min="0" placeholder="價格(元)"/>
      <span class="tools-avg-x">元 ×</span>
      <input type="number" data-set="avg.shares.${i}" value="${r.shares}" step="1" min="0" placeholder="股數"/>
      <span class="tools-avg-x">股</span>
      ${avg.rows.length > 1 ? `<span class="tools-row-del" data-act="avg-del" data-idx="${i}" title="刪除此列">✕</span>` : ''}
    </div>`).join('');
}
function renderAvg() {
  const a = calcAvg();
  $('tools-res-avg').innerHTML = resItem('平均成本', isFinite(a) ? fmtNum(a, 2) + ' 元/股' : '—');
  const rc = calcRev();
  $('tools-res-rev').innerHTML = resItem('反推買進成本價', isFinite(rc) ? fmtNum(rc, 2) + ' 元' : '—');
}
function renderFire() {
  const t = calcFire();
  $('tools-res-fire').innerHTML = resItem('退休金目標', fmtMoney(t), '', fmtWan(t));
}
function renderInfl() {
  const v = calcInfl();
  $('tools-res-infl').innerHTML = resItem('未來購買力（相當於現在）', fmtMoney(v), '', fmtWan(v));
}
function renderVal() {
  const v = calcVal();
  $('tools-res-val').innerHTML =
    resItem('本益比法合理價', fmtNum(v.perPrice, 1) + ' 元') +
    resItem('殖利率法合理價', isFinite(v.divPrice) ? fmtNum(v.divPrice, 1) + ' 元' : '—');
}
function renderMargin() {
  const m = calcMargin();
  $('tools-res-margin').innerHTML =
    resItem('融資金額', fmtMoney(m.loan)) +
    resItem('自備款', fmtMoney(m.selfFund)) +
    resItem('初始維持率', isFinite(m.initMaint) ? m.initMaint.toFixed(0) + '%' : '—') +
    resItem('觸發追繳時市值', fmtMoney(m.triggerValue), '', fmtWan(m.triggerValue)) +
    resItem('股價跌多少會觸發追繳', isFinite(m.dropPct) ? '跌 ' + m.dropPct.toFixed(0) + '%' : '—', 'neg');
}

// ── Static section markup ─────────────────────────────────────────────────
function secIndicators() {
  return `
    <h3>技術指標 KD / MACD / RSI 速查</h3>
    <p class="tools-lead">一句話：都是用過去價格算出的數字，幫你判斷「現在太熱還太冷、轉強還轉弱」。</p>
    <table class="info-table">
      <thead><tr><th>指標</th><th>看什麼</th><th>範圍</th><th>常見訊號</th></tr></thead>
      <tbody>
        <tr><td>KD（隨機指標）</td><td>短線超買超賣，反應快</td><td>0–100</td>
          <td>K&gt;80 超買、K&lt;20 超賣；K 由下穿 D＝黃金交叉（偏多）、由上穿下＝死亡交叉（偏空）</td></tr>
        <tr><td>MACD（指數平滑移動平均）</td><td>中期趨勢多空轉折，穩但慢</td><td>—</td>
          <td>柱狀體翻正/負、DIF 上穿慢線＝偏多；0 軸之上偏多頭、之下偏空頭；屬落後指標，適合確認趨勢不適合抓最低</td></tr>
        <tr><td>RSI（相對強弱）</td><td>一段期間漲跌力道強弱</td><td>0–100</td>
          <td>&gt;70 超買、&lt;30 超賣、50 多空分界</td></tr>
      </tbody>
    </table>
    <div class="tools-callout">
      <p><b>誠實提醒</b>：三指標共同限制＝都用過去價格算 → 會<b>鈍化</b>（強/弱勢時訊號失靈）、會<b>背離</b>（價創新高但指標沒跟上，是警訊不一定反轉）、會<b>騙線</b>，盤整時尤其失準。</p>
      <p>強勢股會<b>高檔鈍化</b>：KD/RSI 長期黏在超買區卻一直漲，「超買就賣」會太早下車。</p>
      <p>三個迷思：①交叉照做就行（盤整易失準）②掛越多越準（互相矛盾反而做不了決定）③找到「神級參數」就穩賺（多半是對過去資料過度最佳化，換時段就失靈）。</p>
      <p>務實用法：搭配 K線/支撐壓力/成交量綜合看，並把停損與成本顧好。</p>
    </div>`;
}
function secMargin() {
  const m = calcMargin();
  return `
    <h3>融資融券 / 維持率斷頭</h3>
    <p class="tools-lead">一句話：融資＝向券商借錢買股（看漲）；融券＝向券商借股票來賣（看跌）。都是信用交易，放大獲利也放大虧損，還多利息與斷頭風險。</p>
    <table class="info-table">
      <thead><tr><th>項目</th><th>成數/保證金</th><th>意思</th></tr></thead>
      <tbody>
        <tr><td>融資（上市）</td><td>6 成</td><td>券商借 6 成、自備 4 成，約 2.5 倍槓桿</td></tr>
        <tr><td>融資（上櫃）</td><td>5 成</td><td>券商借 5 成、自備 5 成，2 倍槓桿</td></tr>
        <tr><td>融券保證金</td><td>9 成</td><td>放空先繳成交金額 9 成當保證金</td></tr>
      </tbody>
    </table>
    <p class="tools-note">＊以券商與證交所公告為準，會因個股或法規調整。</p>
    <div class="tools-callout">
      <p>融資利息 ＝ 融資金額 × 年利率 × 天數 ÷ 365（年利率約 6% 上下，各券商不同）</p>
      <p>整戶擔保維持率 ＝ 股票市值 ÷ 融資金額 × 100%</p>
      <p><b>追繳線 130%</b>：維持率低於 130% → 券商發追繳通知（margin call）；未在期限補款 → 強制賣出（斷頭），不管是不是最低點。</p>
    </div>
    <div class="tools-calc">
      <h4>融資追繳試算器</h4>
      <div class="tools-fields">
        ${field('買進總市值', 'margin.value', margin.value, { step: 1000, min: 0, unit: '元' })}
        ${field('融資成數', 'margin.pct', margin.pct, { step: 1, min: 0, unit: '%' })}
        ${field('追繳維持率門檻', 'margin.call', margin.call, { step: 1, min: 0, unit: '%' })}
      </div>
      <div class="tools-result" id="tools-res-margin"></div>
    </div>
    <p class="tools-note">關鍵推算例：用融資買上市股 10 萬（融資 6 成），剛買進維持率 ≈167%；跌到追繳線 130% 時市值剩 7.8 萬 —— <b>股價只要跌約 22% 就會收到追繳通知</b>。槓桿讓你「離斷頭線」比想像近很多。</p>`;
}
function secCalc() {
  return `
    <h3>互動計算機</h3>
    <div class="tools-calc-grid">
      <div class="tools-calc">
        <h4>① 定期定額試算</h4>
        <div class="tools-fields">
          ${field('每月投入', 'dca.monthly', dca.monthly, { step: 500, min: 0, unit: '元' })}
          ${field('年化報酬率', 'dca.rate', dca.rate, { step: 0.5, unit: '%' })}
          ${field('投資年數', 'dca.years', dca.years, { step: 1, min: 0, unit: '年' })}
        </div>
        <div class="tools-result" id="tools-res-dca"></div>
      </div>

      <div class="tools-calc">
        <h4>② 72 法則（翻倍年數速算）</h4>
        <div class="tools-fields">
          ${field('年化報酬率', 'r72.rate', r72.rate, { step: 0.5, min: 0.01, unit: '%' })}
        </div>
        <div class="tools-result" id="tools-res-r72"></div>
        <p class="tools-note">只是估算非精確。對照：6%→12年、8%→9年。</p>
      </div>

      <div class="tools-calc">
        <h4>③ CAGR 年化報酬率</h4>
        <div class="tools-fields">
          ${field('期初金額', 'cagr.start', cagr.start, { step: 1000, min: 0, unit: '元' })}
          ${field('期末金額', 'cagr.end', cagr.end, { step: 1000, min: 0, unit: '元' })}
          ${field('年數', 'cagr.years', cagr.years, { step: 0.5, min: 0.01, unit: '年' })}
        </div>
        <div class="tools-result" id="tools-res-cagr"></div>
      </div>

      <div class="tools-calc">
        <h4>④ 平均成本 / 攤平</h4>
        <div id="tools-avg-rows" class="tools-avg-rows"></div>
        <span class="chip" data-act="avg-add">＋ 新增一列</span>
        <div class="tools-result" id="tools-res-avg"></div>
        <hr class="tools-hr"/>
        <p class="tools-sub-title">反推買進成本價</p>
        <div class="tools-fields">
          ${field('現價', 'rev.price', rev.price, { step: 0.5, min: 0, unit: '元' })}
          ${field('損益率', 'rev.pl', rev.pl, { step: 1, unit: '%' })}
        </div>
        <div class="tools-result" id="tools-res-rev"></div>
      </div>

      <div class="tools-calc">
        <h4>⑤ FIRE / 4% 法則</h4>
        <div class="tools-fields">
          ${field('年支出', 'fire.expense', fire.expense, { step: 10000, min: 0, unit: '元' })}
          ${field('提領率', 'fire.rate', fire.rate, { step: 0.5, min: 0.01, unit: '%' })}
        </div>
        <div class="tools-result" id="tools-res-fire"></div>
        <p class="tools-note">⚠️ 4% 來自美國 Trinity study 歷史回測，台灣市場不保證適用，保守可抓 3%–3.5%（目標金額更高）。</p>
      </div>

      <div class="tools-calc">
        <h4>⑥ 通膨購買力</h4>
        <div class="tools-fields">
          ${field('金額', 'infl.amount', infl.amount, { step: 10000, min: 0, unit: '元' })}
          ${field('年通膨率', 'infl.rate', infl.rate, { step: 0.5, unit: '%' })}
          ${field('年數', 'infl.years', infl.years, { step: 1, min: 0, unit: '年' })}
        </div>
        <div class="tools-result" id="tools-res-infl"></div>
      </div>

      <div class="tools-calc">
        <h4>⑦ 合理價估值（兩法並列）</h4>
        <div class="tools-fields">
          ${field('預估 EPS', 'val.eps', val.eps, { step: 0.1, min: 0, unit: '元' })}
          ${field('合理本益比', 'val.per', val.per, { step: 0.5, min: 0, unit: '倍' })}
        </div>
        <div class="tools-fields">
          ${field('每股現金股利', 'val.div', val.div, { step: 0.1, min: 0, unit: '元' })}
          ${field('目標殖利率', 'val.yld', val.yld, { step: 0.1, min: 0.01, unit: '%' })}
        </div>
        <div class="tools-result" id="tools-res-val"></div>
        <p class="tools-note">全是主觀輸入（EPS/倍數/目標殖利率），算的是參考區間非精準目標，股價未必收斂到合理價。</p>
      </div>
    </div>`;
}

function renderAll() {
  $('tools-sec-indicators').innerHTML = secIndicators();
  $('tools-sec-margin').innerHTML = secMargin();
  $('tools-sec-calc').innerHTML = secCalc();
  renderMargin();
  renderAvgRows();
  renderDca(); renderR72(); renderCagr(); renderAvg(); renderFire(); renderInfl(); renderVal();
}

// ── Events ────────────────────────────────────────────────────────────────
function switchSec(id) {
  for (const s of ['indicators', 'margin', 'calc']) {
    const el = $(`tools-sec-${s}`);
    if (el) el.style.display = s === id ? '' : 'none';
  }
  document.querySelectorAll('#tools-nav .chip').forEach(c => c.classList.toggle('active', c.dataset.toolsSec === id));
}
function onBodyInput(e) {
  const t = e.target, key = t.dataset.set;
  if (!key) return;
  const v = t.value === '' ? NaN : +t.value;
  const parts = key.split('.');
  if (parts[0] === 'avg') {
    // avg.price.<i> / avg.shares.<i>
    const [, field_, idx] = parts;
    if (avg.rows[idx]) avg.rows[idx][field_] = v;
    renderAvg();
    return;
  }
  const objs = { dca, r72, cagr, rev, fire, infl, val, margin };
  const obj = objs[parts[0]];
  if (!obj) return;
  obj[parts[1]] = v;
  switch (parts[0]) {
    case 'dca': renderDca(); break;
    case 'r72': renderR72(); break;
    case 'cagr': renderCagr(); break;
    case 'rev': renderAvg(); break;
    case 'fire': renderFire(); break;
    case 'infl': renderInfl(); break;
    case 'val': renderVal(); break;
    case 'margin': renderMargin(); break;
  }
}
function onBodyClick(e) {
  if (e.target.closest('[data-act="avg-add"]')) {
    avg.rows.push({ price: 0, shares: 0 });
    renderAvgRows(); renderAvg();
    return;
  }
  const del = e.target.closest('[data-act="avg-del"]');
  if (del) {
    const idx = +del.dataset.idx;
    if (avg.rows.length > 1) avg.rows.splice(idx, 1);
    renderAvgRows(); renderAvg();
    return;
  }
}
function setupEvents() {
  $('tools-nav').addEventListener('click', e => {
    const c = e.target.closest('.chip[data-tools-sec]');
    if (c) switchSec(c.dataset.toolsSec);
  });
  const body = $('tools-body');
  body.addEventListener('input', onBodyInput);
  body.addEventListener('click', onBodyClick);
}

// ── Lifecycle (switcher API) ───────────────────────────────────────────────
export function activate() {
  if (wired) return;
  wired = true;
  renderAll();
  setupEvents();
  switchSec('indicators');
}
