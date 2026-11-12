// 資料更新狀態表（#tab=breadthwarn 最上方）：各來源最新日期、最後成功更新時間、是否落後或缺漏。
// 資料：data/data_status.json（scripts/build_data_status.py 每次排程產生）。計算：breadthwarn_status_calc.mjs。
import { requestJSON } from '../utils/data.js';
import { summarize } from './breadthwarn_status_calc.mjs';

const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const local = iso => { if (!iso) return '—'; const d = new Date(iso); return Number.isNaN(+d) ? '—' : d.toLocaleString('zh-TW', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false }); };
const MARK = ['', '<span class="breadthwarn-tag breadthwarn-tag--proxy">留意</span> ', '<span class="breadthwarn-tag breadthwarn-tag--bad">需要處理</span> '];

export function render(host, doc, nowMs = Date.now()) {
  if (!host) return;
  const s = summarize(doc, nowMs);
  if (!s) { host.innerHTML = '<p class="breadthwarn-note">資料更新狀態檔讀不到，無法確認各來源是不是最新的；請以各區塊標示的日期為準。</p>'; return; }
  const tr = r => `<tr><th scope="row">${esc(r.name)}</th><td>${esc(r.latest || '沒有')}</td><td>${MARK[r.level]}${esc(r.label)}</td><td>${r.current ? '是' : '不是'}</td><td>${esc(local(r.seen))}</td><td>${r.gaps.length ? esc(r.gaps.join('、')) + (r.backfill ? '' : '（無法回補）') : '沒有'}</td><td>${esc(r.cadence)}</td><td>${esc(r.src)}</td><td>${esc(r.why)}</td></tr>`;
  host.innerHTML = `<details class="breadthwarn-details breadthwarn-datastatus"${s.level === 2 ? ' open' : ''}>
    <summary>${MARK[s.level]}資料更新狀態：${esc(s.head)}</summary>
    <div class="table-scroll" tabindex="0" aria-label="各資料來源更新狀態"><table class="breadthwarn-table"><thead><tr><th>資料</th><th>最新交易日</th><th>狀態</th><th>是目前可取得的最新資料嗎</th><th>這一天的資料何時取得</th><th>缺漏的交易日</th><th>更新週期</th><th>來源</th><th>說明</th></tr></thead><tbody>${s.rows.map(tr).join('')}</tbody></table></div>
    <p class="breadthwarn-note">這張表在 ${esc(local(s.generated))}（你的當地時間）由更新排程產生。狀態是比對各來源的資料日期得出的，不是看排程有沒有跑完；交易日以「任何一個來源已經有資料的日子」為準，所以連假期間會顯示「休市，或所有來源都還沒有新資料」。缺漏的日子保留空白，不用前後一天的數字補。</p>
  </details>`;
}

export async function load(host, options = {}) {
  let doc = null;
  try { doc = await requestJSON('data/data_status.json', options); } catch (e) { if (e?.name === 'AbortError') throw e; }
  render(host, doc);
}
