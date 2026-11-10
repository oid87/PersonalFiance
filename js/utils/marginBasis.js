// 台股上市融資維持率口徑：'all'＝含 ETF（預設，各頁原本口徑）、'ex'＝扣除 ETF（分子去掉代號 00 開頭者，分母不變）。
// 各頁共用一個設定（本機記住），任一頁切換，其他頁的切換鈕與圖同步。
// 資料：taiwan_margin_ratio_mm.json（2004～，ratio_all／ratio_exetf）＋ taiwan_margin_ratio.json（逐日，ratio／ratio_exetf），同日以逐日檔為準。
const KEY = 'tw-margin-basis';
const EVT = 'tw-margin-basis-change';

export const BASIS_LABEL = Object.freeze({ all: '含 ETF', ex: '扣除 ETF' });

export function getMarginBasis() {
  try { return localStorage.getItem(KEY) === 'ex' ? 'ex' : 'all'; } catch { return 'all'; }
}

export function setMarginBasis(basis) {
  const b = basis === 'ex' ? 'ex' : 'all';
  try { localStorage.setItem(KEY, b); } catch { /* 本機儲存不可用就只套用本次 */ }
  for (const el of document.querySelectorAll('.margin-basis-picker')) syncPicker(el, b);
  window.dispatchEvent(new CustomEvent(EVT, { detail: b }));
}

export function onMarginBasisChange(fn) {
  const h = e => fn(e.detail);
  window.addEventListener(EVT, h);
  return () => window.removeEventListener(EVT, h);
}

/** mm 列取哪個欄位、逐日檔列取哪個欄位 */
export const mmField = basis => (basis === 'ex' ? 'ratio_exetf' : 'ratio_all');
export const dailyField = basis => (basis === 'ex' ? 'ratio_exetf' : 'ratio');

/** 合併成 [{date, ratio}] 升冪；同日以逐日檔為準。 */
export function mergeMarginRatio(mm = [], daily = [], basis = 'all') {
  const m = new Map();
  const fm = mmField(basis), fd = dailyField(basis);
  for (const r of mm || []) if (typeof r?.date === 'string' && Number.isFinite(r[fm])) m.set(r.date, { date: r.date, ratio: r[fm] });
  for (const r of daily || []) if (typeof r?.date === 'string' && Number.isFinite(r[fd])) m.set(r.date, { date: r.date, ratio: r[fd] });
  return [...m.values()].sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
}

function syncPicker(el, b) {
  for (const c of el.querySelectorAll('.chip')) {
    const on = c.dataset.marginBasis === b;
    c.classList.toggle('active', on);
    c.setAttribute('aria-pressed', on ? 'true' : 'false');
  }
}

/** 建立切換鈕（span.chip ×2）。onChange 不必自己呼叫：改用 onMarginBasisChange 監聽即可同步所有頁。 */
export function marginBasisPicker({ label = '融資維持率口徑：' } = {}) {
  const el = document.createElement('div');
  el.className = 'margin-basis-picker';
  el.setAttribute('role', 'group');
  el.setAttribute('aria-label', '台股融資維持率口徑');
  el.style.cssText = 'display:inline-flex;flex-wrap:wrap;align-items:center;gap:6px;font-size:12px;color:var(--muted)';
  el.append(label);
  for (const b of ['all', 'ex']) {
    const c = document.createElement('span');
    c.className = 'chip';
    c.dataset.marginBasis = b;
    c.tabIndex = 0;
    c.setAttribute('role', 'button');
    c.textContent = BASIS_LABEL[b];
    c.title = b === 'ex' ? '分子扣除 ETF（代號 00 開頭）擔保品市值，分母仍是全市場融資餘額（財經M平方／CMoney 式）' : '全部融資擔保品（玩股網／XQ 式）';
    el.append(c);
  }
  el.addEventListener('click', e => { const c = e.target.closest('.chip[data-margin-basis]'); if (c) setMarginBasis(c.dataset.marginBasis); });
  el.addEventListener('keydown', e => { const c = e.target.closest('.chip[data-margin-basis]'); if (c && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); setMarginBasis(c.dataset.marginBasis); } });
  syncPicker(el, getMarginBasis());
  return el;
}

/** 在 host 裡放一個切換鈕（重複呼叫不會重複放）。 */
export function mountMarginBasisPicker(host, opts) {
  if (!host) return null;
  const old = host.querySelector(':scope > .margin-basis-picker');
  if (old) { syncPicker(old, getMarginBasis()); return old; }
  const el = marginBasisPicker(opts);
  host.append(el);
  return el;
}
