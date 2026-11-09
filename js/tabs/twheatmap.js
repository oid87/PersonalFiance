// 台股族群熱力圖 — 最新交易日各官方產業別（族群）的等權平均漲跌，依大類分區、可展開個股。
// 資料：data/tw_heatmap.json（scripts/fetch_tw_mainstream.py 產生）＋ data/TWII.json（取前一交易日）。
import { requestJSON } from '../utils/data.js';
import { groupRows } from './twheatmap_calc.mjs';

const $ = id => document.getElementById('twhm-' + id);
let loaded = false;

function el(tag, text, cls) { const e = document.createElement(tag); if (text != null) e.textContent = text; if (cls) e.className = cls; return e; }
const fmt = v => (v > 0 ? '+' : '') + v.toFixed(2) + '%';
// 紅漲綠跌；|漲跌| 5% 以上顏色最深
function tint(v) {
  const a = Math.min(Math.abs(v) / 5, 1) * 0.55 + 0.08;
  return v > 0 ? `rgba(239,68,68,${a})` : v < 0 ? `rgba(34,197,94,${a})` : 'transparent';
}

function render(src, prevDate) {
  const cats = groupRows(src.data);
  $('asof').textContent = `${src.date} 對比 ${prevDate || '前一交易日'}`;
  const nav = $('nav'), body = $('body');
  nav.replaceChildren(); body.replaceChildren();
  for (const c of cats) {
    const a = el('a', c.name); a.href = `#tab=twheatmap`; a.append(el('small', String(c.n)));
    a.addEventListener('click', e => { e.preventDefault(); document.getElementById('twhm-sec-' + c.id)?.scrollIntoView(); });
    nav.append(a);
    const sec = el('section', null, 'twhm-sec'); sec.id = 'twhm-sec-' + c.id;
    sec.append(el('h3', c.name));
    sec.append(el('div', `${c.groups.length} 個族群 · ${c.n} 檔公司 · 大類等權 ${fmt(c.avg)}（${src.date} 對比 ${prevDate || '前一交易日'}）`, 'twhm-sum'));
    for (const g of c.groups) {
      const row = el('div', null, 'twhm-row');
      const btn = el('button'); btn.type = 'button'; btn.setAttribute('aria-expanded', 'false');
      const ret = el('span', fmt(g.avg), 'twhm-ret'); ret.style.background = tint(g.avg);
      btn.append(el('span', g.name), el('span', `${g.stocks.length}/${g.total} 檔有行情`, 'twhm-cnt'), ret, el('span', '⌄', 'twhm-caret'));
      const list = el('div', null, 'twhm-stocks');
      btn.addEventListener('click', () => {
        const open = row.classList.toggle('open');
        btn.setAttribute('aria-expanded', String(open));
        if (open && !list.childElementCount) for (const s of g.stocks) {
          const it = el('div', null, 'twhm-stock'); it.style.background = tint(s.ret);
          it.append(el('span', `${s.code} ${s.name}`), el('span', fmt(s.ret)));
          list.append(it);
        }
      });
      row.append(btn, list); sec.append(row);
    }
    body.append(sec);
  }
}

export async function activate(context = {}) {
  if (loaded) return;
  const [h, t] = await Promise.all([
    requestJSON('data/tw_heatmap.json', { signal: context.signal }),
    requestJSON('data/TWII.json', { signal: context.signal }).catch(() => null),
  ]);
  if (!Array.isArray(h?.data) || !h.data.length) throw new Error('族群熱力圖資料不足');
  if (context.isCurrent && !context.isCurrent()) return;
  const prev = (t?.data || []).map(r => r.date).filter(d => d < h.date).at(-1);
  render(h, prev);
  $('status').textContent = '';
  $('status').hidden = true;
  loaded = true;
}

export function getCharts() { return []; }
