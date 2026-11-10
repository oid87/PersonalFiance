// 台股槓桿／反向 ETF 熱力圖：方塊大小＝成交值、顏色＝漲跌；正2 與反1 對照看追多／避險資金。
// 資料：data/tw_lev_etf.json（scripts/fetch_tw_lev_etf.py，TWSE STOCK_DAY_ALL）。
import { isLight, PALETTE } from '../utils/theme.js';
import { requestJSON } from '../utils/data.js';
import { bindOnce, chipPicker } from '../utils/dom.js';

const TAB_ID = 'twlevetf';
const $ = id => document.getElementById('twlev-' + id);
let chart = null;
let src = null;
let group = 'all';

const fmtPct = v => (v == null ? '—' : (v > 0 ? '+' : '') + v.toFixed(2) + '%');
const fmtYi = v => (v == null ? '—' : (v / 1e8).toFixed(v >= 1e10 ? 0 : 1) + ' 億');
// 紅漲綠跌，|漲跌| 5% 以上最深
function tint(v) {
  if (v == null) return isLight() ? '#cbd5e1' : '#475569';
  const a = Math.min(Math.abs(v) / 5, 1) * 0.75 + 0.2;
  return v > 0 ? `rgba(220,38,38,${a})` : v < 0 ? `rgba(22,163,74,${a})` : (isLight() ? '#cbd5e1' : '#475569');
}
const levLabel = n => (n > 0 ? `+${n}x` : `${n}x`);

function rowsFor() {
  return (src?.data || []).filter(r => (group === 'all' || r.group === group) && r.value > 0);
}

function renderSummary() {
  const rows = rowsFor();
  const sum = f => rows.filter(f).reduce((s, r) => s + r.value, 0);
  const longV = sum(r => r.lev > 0), shortV = sum(r => r.lev < 0);
  const ratio = shortV > 0 ? (longV / shortV).toFixed(1) : '—';
  const top = [...rows].sort((a, b) => b.value - a.value)[0];
  $('summary').innerHTML = [
    ['槓桿（正向）成交值', fmtYi(longV)],
    ['反向成交值', fmtYi(shortV)],
    ['正向 ÷ 反向', ratio + ' 倍'],
    ['成交最大', top ? `${top.code} ${top.name} ${fmtPct(top.ret)}` : '—'],
  ].map(([k, v]) => `<div class="twlev-kpi"><span>${k}</span><b>${v}</b></div>`).join('');
}

function renderChart() {
  const rows = rowsFor();
  const text = PALETTE.text;
  chart.setOption({
    backgroundColor: 'transparent',
    tooltip: {
      formatter: p => {
        const r = p.data?._r;
        return r ? `${r.code} ${r.name}<br>倍數 ${levLabel(r.lev)}　收盤 ${r.close ?? '—'}<br>漲跌 ${fmtPct(r.ret)}　成交值 ${fmtYi(r.value)}` : p.name;
      },
    },
    series: [{
      type: 'treemap', roam: false, nodeClick: false, breadcrumb: { show: false },
      left: 0, right: 0, top: 0, bottom: 0,
      label: {
        show: true, color: '#fff', fontSize: 12, lineHeight: 16,
        formatter: p => { const r = p.data._r; return `${r.name}\n${r.code} | ${levLabel(r.lev)}\n${fmtPct(r.ret)}`; },
      },
      upperLabel: { show: false },
      itemStyle: { borderColor: isLight() ? '#fff' : '#0f172a', borderWidth: 2, gapWidth: 2 },
      data: rows.map(r => ({ name: r.code, value: r.value, _r: r, itemStyle: { color: tint(r.ret) } })),
    }],
    textStyle: { color: text },
  }, true);
}

function render() {
  $('asof').textContent = `行情日 ${src.date}・抓取 ${src.updated}・證交所收盤（非即時）`;
  renderSummary();
  renderChart();
}

export async function activate(context = {}) {
  const section = document.getElementById('tab-' + TAB_ID);
  if (bindOnce(section)) {
    chipPicker($('group'), 'twlev-group', value => { group = value; if (src) render(); });
  }
  const data = await requestJSON('data/tw_lev_etf.json', { signal: context.signal });
  if (!Array.isArray(data?.data) || !data.data.length) throw new Error('槓桿／反向 ETF 資料不足');
  if (context.isCurrent && !context.isCurrent()) return;
  src = data;
  if (!chart) chart = echarts.init($('chart'), isLight() ? null : 'dark');
  $('status').hidden = true;
  render();
}

export function onThemeChange() {
  if (!chart) return;
  chart.dispose();
  chart = echarts.init($('chart'), isLight() ? null : 'dark');
  if (src) renderChart();
}
export function resize() { chart?.resize(); }
export function getCharts() { return chart ? [chart] : []; }
