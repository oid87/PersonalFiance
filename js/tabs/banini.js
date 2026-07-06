// 反指標(8zz) tab — banini-tracker (https://github.com/cablate/banini-tracker) 公開資料集視覺化。
// 追蹤 FB 網紅「股海冥燈 巴逆逆(8zz)」貼文做反指標分析（去識別化快照，2024-04~2026-04）。
// self_result 是本頁自算的方向判定，非原作者公式（原作者未公開其成功率計算方法）。
// 資料 data/banini_reverse_indicator.json，靜態快照，非逐日累積時序。
import { isLight, tc } from '../utils/theme.js';

let chartTimeline = null;
let chartBreakdown = null;
let raw = null; // banini_reverse_indicator.json

const RESULT_COLOR = {
  success: "#3fb950",
  fail: "#e24b4a",
  insufficient: "var(--muted)",
  no_data: "var(--muted)",
};
const RESULT_LABEL = {
  success: "成功",
  fail: "失敗",
  insufficient: "資料不足",
  no_data: "無資料",
};

export async function init() {
  const status = document.getElementById("banini-status");
  if (raw) { renderAll(); return; }
  status.textContent = "載入中…";
  try {
    raw = await fetch("data/banini_reverse_indicator.json").then(r => r.json());
    renderAll();
    status.textContent =
      `共 ${raw.data.length} 筆預測 · ${raw.upstream_range.from.slice(0,10)} ~ ${raw.upstream_range.to.slice(0,10)} · 更新至 ${raw.updated} · ` +
      `來源：banini-tracker by cablate (https://github.com/cablate/banini-tracker)`;
  } catch (err) {
    status.textContent = `載入失敗：${err.message}`;
  }
}

function renderAll() {
  renderHeader();
  renderTimelineChart();
  renderBreakdownChart();
  renderTable();
}

function renderHeader() {
  const s = raw.stats;
  const overall = s.self_success_rate.overall;
  const bull = s.self_success_rate["多"];
  const bear = s.self_success_rate["空"];
  document.getElementById("banini-header").innerHTML = `
    <div style="display:flex;flex-wrap:wrap;gap:24px;align-items:baseline;margin-bottom:12px">
      <div>
        <div style="font-size:24px;font-weight:600">${raw.data.length} 筆預測</div>
        <div style="font-size:12px;color:var(--muted)">
          ${raw.upstream_range.from.slice(0,10)} ~ ${raw.upstream_range.to.slice(0,10)}
        </div>
      </div>
      <div>
        <div style="font-size:20px;font-weight:600">${overall.rate_pct}%</div>
        <div style="font-size:11px;color:var(--muted)">
          自算成功率（本頁自算，非原作者公式）· 成功${overall.success} / 失敗${overall.fail} / 資料不足${overall.insufficient} / 無資料${overall.no_data}
        </div>
      </div>
      <div>
        <div style="font-size:16px;font-weight:600">多 ${bull.rate_pct}%</div>
        <div style="font-size:11px;color:var(--muted)">成功${bull.success} / 失敗${bull.fail}</div>
      </div>
      <div>
        <div style="font-size:16px;font-weight:600">空 ${bear.rate_pct}%</div>
        <div style="font-size:11px;color:var(--muted)">成功${bear.success} / 失敗${bear.fail}</div>
      </div>
    </div>`;
}

function renderTimelineChart() {
  if (!chartTimeline) {
    chartTimeline = echarts.init(document.getElementById("banini-chart-timeline"), isLight() ? null : "dark");
  }
  const rows = raw.stats.monthly_counts;
  chartTimeline.setOption({
    animation: false,
    grid: { left: 44, right: 16, top: 30, bottom: 28 },
    title: { text: "貼文/預測活躍度（每月筆數）", left: 0, top: 0, textStyle: { fontSize: 13, color: tc("#8b949e", "#57606a") } },
    tooltip: { trigger: "axis" },
    xAxis: {
      type: "category",
      data: rows.map(r => r.month),
      axisLabel: { color: tc("#8b949e", "#57606a") },
      axisLine: { lineStyle: { color: tc("#30363d", "#d0d7de") } },
    },
    yAxis: {
      axisLabel: { color: tc("#8b949e", "#57606a") },
      splitLine: { lineStyle: { color: tc("#21262d", "#eaeef2") } },
    },
    series: [{
      type: "bar",
      data: rows.map(r => r.count),
      itemStyle: { color: "#58a6ff" },
    }],
  });
}

function renderBreakdownChart() {
  if (!chartBreakdown) {
    chartBreakdown = echarts.init(document.getElementById("banini-chart-breakdown"), isLight() ? null : "dark");
  }
  const byType = raw.stats.by_symbol_type;
  const byView = raw.stats.by_reverse_view;
  const typeColors = ["#58a6ff", "#f0883e", "#3fb950", "#e24b4a", "#a371f7", "#17a2b8"];
  chartBreakdown.setOption({
    animation: false,
    tooltip: { trigger: "item" },
    legend: [
      { top: 0, left: "0%", data: Object.keys(byType), textStyle: { color: tc("#8b949e", "#57606a"), fontSize: 11 } },
    ],
    title: [
      { text: "標的類型分布", left: "8%", top: "6%", textStyle: { fontSize: 12, color: tc("#8b949e", "#57606a") } },
      { text: "多／空分布", left: "62%", top: "6%", textStyle: { fontSize: 12, color: tc("#8b949e", "#57606a") } },
    ],
    series: [
      {
        type: "pie",
        radius: ["30%", "55%"],
        center: ["25%", "58%"],
        data: Object.entries(byType).map(([name, value], i) => ({
          name, value, itemStyle: { color: typeColors[i % typeColors.length] },
        })),
        label: { color: tc("#8b949e", "#57606a"), fontSize: 11 },
      },
      {
        type: "pie",
        radius: ["30%", "55%"],
        center: ["75%", "58%"],
        data: Object.entries(byView).map(([name, value]) => ({
          name, value,
          itemStyle: { color: name === "多" ? "#e24b4a" : "#3fb950" },
        })),
        label: { color: tc("#8b949e", "#57606a"), fontSize: 11 },
      },
    ],
  });
}

function renderTable() {
  const rows = [...raw.data].sort((a, b) => (a.created_at < b.created_at ? 1 : -1));
  const body = rows.map(r => {
    const color = RESULT_COLOR[r.self_result] || "var(--muted)";
    const label = RESULT_LABEL[r.self_result] || r.self_result;
    return `<tr>
      <td>${r.created_at.slice(0, 10)}</td>
      <td>${r.symbol_name}（${r.symbol_code}）</td>
      <td>${r.her_action}</td>
      <td>${r.reverse_view}</td>
      <td style="color:${color};font-weight:600">${label}</td>
    </tr>`;
  }).join("");
  document.getElementById("banini-table").innerHTML = `
    <thead>
      <tr>
        <th>日期</th><th>標的</th><th>她的動作</th><th>反指標方向</th><th>本頁自算結果</th>
      </tr>
    </thead>
    <tbody>${body}</tbody>`;
}

export function onThemeChange(light) {
  if (chartTimeline) {
    chartTimeline.dispose();
    chartTimeline = echarts.init(document.getElementById("banini-chart-timeline"), light ? null : "dark");
    renderTimelineChart();
  }
  if (chartBreakdown) {
    chartBreakdown.dispose();
    chartBreakdown = echarts.init(document.getElementById("banini-chart-breakdown"), light ? null : "dark");
    renderBreakdownChart();
  }
}

export function resize() {
  chartTimeline?.resize();
  chartBreakdown?.resize();
}
