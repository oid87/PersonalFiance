// 每日總覽（首頁）：四套警報的今日燈號，加上六個主題的關鍵數字（美股／台股切換）。
// 每個數字都由 overview_calc.mjs 呼叫明細頁同一支純計算函式（或讀同一欄位），
// 所以不會和明細頁對不上；某個來源載入失敗只讓那張卡顯示「暫無資料」，不擋整頁。
import { bindOnce, chipPicker } from '../utils/dom.js';
import { ALERT_CARDS, THEME_CARDS } from './overview_calc.mjs';

const TAB_ID = 'overview';
const LEVEL_CLASS = { ok: 'ov-lv-ok', watch: 'ov-lv-watch', alert: 'ov-lv-alert' };
let market = 'us';
let alertResults = null;
let themeResults = null;

const esc = value => String(value ?? '').replace(/[&<>"']/g, c =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// 首頁底部「最近新增」：手動維護的捷徑，指向新加的視圖或區塊
const NEW_LINKS = [
  { tab: 'twlevetf', title: '槓桿／反向 ETF 熱力圖', detail: '00631L、00632R 等 41 檔：方塊大小＝成交值、顏色＝漲跌，加上正向÷反向成交值' },
  { tab: 'nonnormal', focus: 'longwater', title: '長線水溫', detail: '六個指數在 1／2／5／10 年線的位階（冰水～滾水），和日線水溫並列；含三角型點位距離' },
  { tab: 'twforeignshort', title: '外資賣超與空單', detail: '加權指數、外資每日賣出金額、外資台指期淨空單，三格同步對照' },
  { tab: 'nonnormal', title: '融資餘額急減', detail: '極端狀態儀表板「壓力」格：融資 10 日減幅 ≥ 15% 亮燈' },
  { tab: 'nonnormal', title: '現金流三檔位', detail: '極端狀態儀表板：加權相對年線、兩年線判斷目前第幾檔' },
  { tab: 'nonnormal', title: '極端情境三批配置', detail: '極端狀態儀表板：20%／30%／50% 與「下一批要更極端」' },
  { tab: 'nonnormal', title: 'VIX 共振燈與緩跌提示', detail: '共振燈改為收盤 ≥ 30；灰犀牛型且 VIX 未破 40 時以長均為主' },
];

function buildShell(section) {
  section.innerHTML = `
    <div class="ov-head">
      <h2>每日總覽</h2>
      <span class="ov-asof" id="overview-asof"></span>
      <div class="ov-market" id="overview-market" role="group" aria-label="主題卡市場">
        <button type="button" class="chip active" data-ov-market="us" aria-pressed="true">美股</button>
        <button type="button" class="chip" data-ov-market="tw" aria-pressed="false">台股</button>
      </div>
    </div>
    <p class="ov-lead">先看警報有沒有亮，再看六個主題各自的位置；每張卡點下去就是那一頁的明細。數字由各明細頁自己的程式算出，不會和明細頁對不上。美股的「風險觀察」與「恐慌拋售」兩頁已併成「美股警報」；「台股底部區域」看的是相反方向（跌深、市場冷到底），亮代表可能接近底部，不是危險。</p>
    <h3>警報燈號</h3>
    <div class="ov-grid" id="overview-alerts"></div>
    <h3 id="overview-themes-title">六個主題（美股）</h3>
    <div class="ov-grid" id="overview-themes"></div>
    <p class="ov-foot">燈號顏色：綠＝正常、黃＝留意、紅＝警戒，門檻沿用各明細頁。日期是該數字的資料日期，週末與假日不更新；警報卡超過 5 天沒更新會標「資料過舊」。</p>
    <h3>最近新增</h3>
    <div class="ov-grid">${NEW_LINKS.map(link => `<a class="ov-card" href="#tab=${esc(link.tab)}${link.focus ? '&amp;focus=' + esc(link.focus) : ''}">
      <span class="ov-card-top"><span class="ov-card-title">${esc(link.title)}</span><span class="ov-card-go">前往 →</span></span>
      <span class="ov-detail">${esc(link.detail)}</span>
    </a>`).join('')}</div>`;
  chipPicker(section.querySelector('#overview-market'), 'ov-market', value => {
    market = value === 'tw' ? 'tw' : 'us';
    for (const chip of section.querySelectorAll('#overview-market .chip')) {
      chip.setAttribute('aria-pressed', String(chip.dataset.ovMarket === market));
    }
    renderThemes();
  });
}

// 日資料超過 STALE_DAYS 個日曆天沒更新就標「資料過舊」（涵蓋週末＋一天假日）。
const STALE_DAYS = 5;
function staleNote(date) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date || '')) return '';
  const days = Math.floor((Date.now() - new Date(date + 'T00:00:00').getTime()) / 864e5);
  return days > STALE_DAYS ? `<span class="ov-stale">資料過舊（${days} 天前）</span>` : '';
}

// result: { level: ok|watch|alert|null, state, detail, date } or { error }
function alertCard(card, result) {
  const level = result?.error ? null : result?.level;
  const cls = ['ov-card', LEVEL_CLASS[level] || '', result?.error ? 'ov-na' : ''].filter(Boolean).join(' ');
  return `<a class="${cls}" href="#tab=${esc(card.tab)}">
    <span class="ov-card-top"><span class="ov-card-title">${esc(card.title)}</span><span class="ov-card-go">看明細 →</span></span>
    <span class="ov-state">${esc(result?.error ? '暫無資料' : result?.state)}</span>
    ${result?.detail ? `<span class="ov-detail">${esc(result.detail)}</span>` : ''}
    <span class="ov-date">${esc(result?.error ? String(result.error.message || result.error) : result?.date ? '資料日 ' + result.date : '')}</span>
    ${result?.error ? '' : staleNote(result?.date)}
  </a>`;
}

// rows: [{ label, value, state, color, date } | { label, error }]；color 是明細頁自己的分區色。
const HEX = /^#[0-9a-f]{3,8}$/i;
function themeCard(card, rows) {
  const body = rows.map(row => {
    const cls = ['ov-row', row.error ? 'ov-na' : ''].filter(Boolean).join(' ');
    const note = row.error ? '暫無資料' : [row.state, row.date ? '資料日 ' + row.date : ''].filter(Boolean).join(' · ');
    const tint = !row.error && HEX.test(row.color || '') ? ` style="color:${row.color}"` : '';
    return `<span class="${cls}"><span class="ov-row-label">${esc(row.label)}</span>` +
      `<span class="ov-row-value"${tint}>${esc(row.error ? '—' : row.value)}</span>` +
      `<span class="ov-row-state">${esc(note)}</span></span>`;
  }).join('');
  return `<a class="ov-card" href="#tab=${esc(card.tab[market])}">
    <span class="ov-card-top"><span class="ov-card-title">${esc(card.title)}</span><span class="ov-card-go">${esc(card.go[market])} →</span></span>
    <span class="ov-rows">${body}</span>
  </a>`;
}

function renderAlerts() {
  const host = document.getElementById('overview-alerts');
  host.innerHTML = ALERT_CARDS.map((card, i) => alertCard(card, alertResults?.[i])).join('');
}

function renderThemes() {
  const host = document.getElementById('overview-themes');
  document.getElementById('overview-themes-title').textContent = `六個主題（${market === 'tw' ? '台股' : '美股'}）`;
  host.innerHTML = THEME_CARDS.map((card, i) => themeCard(card, themeResults?.[i]?.[market] || [])).join('');
}

function renderAsOf() {
  const dates = [
    ...(alertResults || []).map(r => r?.date),
    ...(themeResults || []).flatMap(t => [...(t?.us || []), ...(t?.tw || [])].map(r => r?.date)),
  ].filter(Boolean).sort();
  document.getElementById('overview-asof').textContent = dates.length ? '最新資料 ' + dates.at(-1) : '';
}

const settle = load => Promise.resolve().then(load).then(value => value, error => ({ error }));

export async function activate(context = {}) {
  const section = document.getElementById('tab-' + TAB_ID);
  if (bindOnce(section)) buildShell(section);
  const live = () => !context.signal?.aborted && context.isCurrent?.() !== false;
  const [alerts, themes] = await Promise.all([
    Promise.all(ALERT_CARDS.map(card => settle(() => card.load(context)))),
    Promise.all(THEME_CARDS.map(async card => {
      const [us, tw] = await Promise.all(['us', 'tw'].map(m => Promise.all(card.rows[m].map(row =>
        settle(() => row.load(context)).then(result => ({ label: row.label, ...result }))))));
      return { us, tw };
    })),
  ]);
  if (!live()) return;
  // 每張卡各自失敗；全部都失敗才算整頁載入失敗，交給 switcher 的重試。
  const all = [...alerts, ...themes.flatMap(t => [...t.us, ...t.tw])];
  if (all.length && all.every(r => r?.error)) throw all[0].error;
  alertResults = alerts;
  themeResults = themes;
  renderAlerts();
  renderThemes();
  renderAsOf();
}

export function getCharts() { return []; }
