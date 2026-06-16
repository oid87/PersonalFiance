import { SERIES, PENTA_TICKERS, loaded, loadedHLC } from '../state.js';
import { isLight, tc, mob } from '../utils/theme.js';
import { tsToLocalDate, toWeekly, toWeeklyHLC } from '../utils/dates.js';
import { computeLinearRegression, computeChannelBands, computeRSI, computeKD, computeTDSetup } from '../utils/math.js';
import { loadSeries } from '../utils/data.js';

let pentaChart        = null;
let pentaActiveTicker = "VOO";
let pentaPeriod       = "3.5Y";
let pentaMode         = "pentagram";
let pentaFgActive     = false;
let pentaVixActive    = false;
let penta125Active    = false;
let pentaMaPeriod     = 125;
let pentaWeekly       = false;
let pentaFpeActive    = false;
const pentaFpeCache   = {};
const FPE_FILES       = { QQQ: "data/QQQ_valuation.json", SPY: "data/SPY_valuation.json", SOXX: "data/SOXX_valuation.json", "0050": "data/TW_valuation.json", TWII: "data/TW_valuation.json" };
const FPE_MARKS       = { "0050": [{y:18,c:'#f0883e',l:'18x'},{y:15,c:'#ef4444',l:'15x'}], TWII: [{y:18,c:'#f0883e',l:'18x'},{y:15,c:'#ef4444',l:'15x'}] };
function _fpeMarkLine(ticker) {
  const defs = FPE_MARKS[ticker] || [{y:21,c:'#f0883e',l:'21x'},{y:20,c:'#ef4444',l:'20x'}];
  return { silent:true, symbol:['none','none'], animation:false, data: defs.map(m=>({ yAxis:m.y, label:{formatter:m.l,color:m.c,position:'insideEndTop',fontSize:9}, lineStyle:{color:m.c,type:'dashed',width:1} })) };
}

let _dragAnchor    = null;
let _docMupHandler = null;

function _getPentaPrice(tsMs) {
  const raw = loaded[pentaActiveTicker];
  if (!raw || !raw.length) return null;
  let best = null, bestDiff = Infinity;
  for (const [dateStr, price] of raw) {
    const diff = Math.abs(new Date(dateStr).getTime() - tsMs);
    if (diff < bestDiff) { bestDiff = diff; best = price; }
  }
  return best;
}

function attachDragMeasure(chartInstance) {
  // Canvas overlay — 完全不呼叫 setOption，避免污染 ECharts series 設定
  const container = chartInstance.getDom();
  container.style.position = 'relative';
  let cv = container.querySelector('canvas.__dm');
  if (!cv) {
    cv = document.createElement('canvas');
    cv.className = '__dm';
    cv.style.cssText = 'position:absolute;top:0;left:0;pointer-events:none;z-index:10;';
    container.appendChild(cv);
  }
  cv.width  = chartInstance.getWidth();
  cv.height = chartInstance.getHeight();
  const ctx = cv.getContext('2d');

  const zr = chartInstance.getZr();
  if (attachDragMeasure._down) zr.off('mousedown', attachDragMeasure._down);
  if (attachDragMeasure._move) zr.off('mousemove', attachDragMeasure._move);
  if (attachDragMeasure._up)   zr.off('mouseup',   attachDragMeasure._up);
  if (_docMupHandler) document.removeEventListener('mouseup', _docMupHandler);

  // 切換標的時清除殘留狀態
  _dragAnchor = null;
  ctx.clearRect(0, 0, cv.width, cv.height);

  let dragging = false;
  let startPixel = null;
  let startTs = null;

  const onDown = e => {
    const pt = chartInstance.convertFromPixel({ gridIndex: 0 }, [e.offsetX, e.offsetY]);
    if (!pt || pt[0] == null) return;
    const price = _getPentaPrice(pt[0]);
    if (price == null) return;
    dragging = true;
    startPixel = [e.offsetX, e.offsetY];
    startTs = pt[0];
    _dragAnchor = { date: tsToLocalDate(pt[0]), price };
  };

  const onMove = e => {
    if (!dragging || startTs == null) return;
    const endPt = chartInstance.convertFromPixel({ gridIndex: 0 }, [e.offsetX, e.offsetY]);
    if (!endPt || endPt[0] == null) return;
    const endPrice = _getPentaPrice(endPt[0]);
    if (endPrice == null) return;

    const endDate = tsToLocalDate(endPt[0]);
    _dragAnchor.endDate  = endDate;
    _dragAnchor.endPrice = endPrice;

    const color = endPrice >= _dragAnchor.price ? '#26a69a' : '#ef5350';
    const x1 = startPixel[0], x2 = e.offsetX;
    const yTop = 20, yBot = chartInstance.getHeight() - 50;
    const yMid = (yTop + yBot) / 2;

    ctx.clearRect(0, 0, cv.width, cv.height);
    ctx.save();
    ctx.setLineDash([4, 3]);
    ctx.lineWidth = 1;
    ctx.strokeStyle = '#888';
    ctx.beginPath(); ctx.moveTo(x1, yTop); ctx.lineTo(x1, yBot); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(x2, yTop); ctx.lineTo(x2, yBot); ctx.stroke();
    ctx.strokeStyle = color;
    ctx.lineWidth = 1.5;
    ctx.beginPath(); ctx.moveTo(x1, yMid); ctx.lineTo(x2, yMid); ctx.stroke();
    ctx.setLineDash([]);
    ctx.fillStyle = '#aaa';
    ctx.font = '11px sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText(_dragAnchor.date, x1, yBot + 14);
    ctx.fillText(endDate, x2, yBot + 14);
    ctx.restore();
  };

  const clearOverlay = () => {
    if (!dragging) return;
    dragging = false;
    startPixel = null;
    startTs = null;
    _dragAnchor = null;
    ctx.clearRect(0, 0, cv.width, cv.height);
  };

  attachDragMeasure._down = onDown;
  attachDragMeasure._move = onMove;
  attachDragMeasure._up   = clearOverlay;

  zr.on('mousedown', onDown);
  zr.on('mousemove', onMove);
  zr.on('mouseup',   clearOverlay);
  _docMupHandler = clearOverlay;
  document.addEventListener('mouseup', clearOverlay);
}

function getPentaData() {
  const raw = loaded[pentaActiveTicker];
  if (!raw) return [];
  const d = new Date();
  if      (pentaPeriod === "0.5Y") d.setMonth(d.getMonth() - 6);
  else if (pentaPeriod === "1.5Y") { d.setFullYear(d.getFullYear() - 1); d.setMonth(d.getMonth() - 6); }
  else if (pentaPeriod === "3.5Y") { d.setFullYear(d.getFullYear() - 3); d.setMonth(d.getMonth() - 6); }
  else if (pentaPeriod === "5Y")   d.setFullYear(d.getFullYear() - 5);
  const fromDate = d.toISOString().slice(0, 10);
  const filtered = raw.filter(r => r[0] >= fromDate);
  return pentaWeekly ? toWeekly(filtered) : filtered;
}

function getPentaFgData() {
  const fg = loaded["F&G"];
  if (!fg) return [];
  const d = new Date();
  if      (pentaPeriod === "0.5Y") d.setMonth(d.getMonth() - 6);
  else if (pentaPeriod === "1.5Y") { d.setFullYear(d.getFullYear() - 1); d.setMonth(d.getMonth() - 6); }
  else if (pentaPeriod === "3.5Y") { d.setFullYear(d.getFullYear() - 3); d.setMonth(d.getMonth() - 6); }
  else if (pentaPeriod === "5Y")   d.setFullYear(d.getFullYear() - 5);
  const fromDate = d.toISOString().slice(0, 10);
  return fg.filter(r => r[0] >= fromDate);
}

function getPentaVixData() {
  const vix = loaded["VIX_H"]; // daily high, not close
  if (!vix) return [];
  const d = new Date();
  if      (pentaPeriod === "0.5Y") d.setMonth(d.getMonth() - 6);
  else if (pentaPeriod === "1.5Y") { d.setFullYear(d.getFullYear() - 1); d.setMonth(d.getMonth() - 6); }
  else if (pentaPeriod === "3.5Y") { d.setFullYear(d.getFullYear() - 3); d.setMonth(d.getMonth() - 6); }
  else if (pentaPeriod === "5Y")   d.setFullYear(d.getFullYear() - 5);
  const fromDate = d.toISOString().slice(0, 10);
  return vix.filter(r => r[0] >= fromDate);
}

function _interpFpe(fpeArr) {
  if (!fpeArr || fpeArr.length < 2) return fpeArr.map(r => [r.date, r.fpe]);
  const out = [];
  for (let i = 0; i < fpeArr.length - 1; i++) {
    const d1 = fpeArr[i].date, v1 = fpeArr[i].fpe;
    const d2 = fpeArr[i + 1].date, v2 = fpeArr[i + 1].fpe;
    const t1 = new Date(d1 + "T00:00:00Z").getTime();
    const t2 = new Date(d2 + "T00:00:00Z").getTime();
    const gap = Math.round((t2 - t1) / 86400000);
    if (gap <= 1) { out.push([d1, v1]); continue; }
    for (let j = 0; j < gap; j++) {
      const date = new Date(t1 + j * 86400000).toISOString().slice(0, 10);
      out.push([date, +(v1 + (v2 - v1) * j / gap).toFixed(3)]);
    }
  }
  const last = fpeArr[fpeArr.length - 1];
  out.push([last.date, last.fpe]);
  return out;
}

function getPentaFpeData() {
  const cached = pentaFpeCache[pentaActiveTicker];
  if (!cached || !FPE_FILES[pentaActiveTicker]) return null;
  const interp = _interpFpe(cached);
  const d = new Date();
  if      (pentaPeriod === "0.5Y") d.setMonth(d.getMonth() - 6);
  else if (pentaPeriod === "1.5Y") { d.setFullYear(d.getFullYear() - 1); d.setMonth(d.getMonth() - 6); }
  else if (pentaPeriod === "3.5Y") { d.setFullYear(d.getFullYear() - 3); d.setMonth(d.getMonth() - 6); }
  else if (pentaPeriod === "5Y")   d.setFullYear(d.getFullYear() - 5);
  const fromDate = d.toISOString().slice(0, 10);
  return interp.filter(r => r[0] >= fromDate);
}

function computeCustomMA(dailyData, N) {
  const out = [];
  for (let i = N - 1; i < dailyData.length; i++) {
    let sum = 0;
    for (let j = i - N + 1; j <= i; j++) sum += dailyData[j][1];
    out.push([dailyData[i][0], +(sum / N).toFixed(4)]);
  }
  return out;
}

function renderChannelMode() {
  if (!pentaChart) return;
  const statusEl = document.getElementById("penta-status");

  if (!pentaActiveTicker || !loaded[pentaActiveTicker]) {
    pentaChart.clear();
    statusEl.textContent = "← 選擇標的以顯示通道";
    return;
  }

  const allDaily = loaded[pentaActiveTicker];
  const weekly   = toWeekly(allDaily);
  const bands    = computeChannelBands(weekly);

  if (!bands.ma20.length) {
    statusEl.textContent = "數據不足";
    pentaChart.clear();
    return;
  }

  const d = new Date();
  if      (pentaPeriod === "0.5Y") d.setMonth(d.getMonth() - 6);
  else if (pentaPeriod === "1.5Y") { d.setFullYear(d.getFullYear() - 1); d.setMonth(d.getMonth() - 6); }
  else if (pentaPeriod === "3.5Y") { d.setFullYear(d.getFullYear() - 3); d.setMonth(d.getMonth() - 6); }
  else if (pentaPeriod === "5Y")   d.setFullYear(d.getFullYear() - 5);
  const fromDate = d.toISOString().slice(0, 10);

  const priceW   = weekly.filter(r => r[0] >= fromDate);
  const ma20w    = bands.ma20.filter(r => r[0] >= fromDate);
  const upperW   = bands.upper.filter(r => r[0] >= fromDate);
  const lowerW   = bands.lower.filter(r => r[0] >= fromDate);
  const maLabel  = `MA${pentaMaPeriod}`;
  const ma125Chw = penta125Active ? computeCustomMA(allDaily, pentaMaPeriod).filter(r => r[0] >= fromDate) : null;

  const s        = SERIES.find(x => x.key === pentaActiveTicker);
  const axisClr  = tc("#8b949e", "#57606a");
  const gridClr  = tc("#21262d", "#e1e4e8");
  const tipBg    = tc("#161b22", "#ffffff");
  const tipBdr   = tc("#30363d", "#d0d7de");
  const tipText  = tc("#e6edf3", "#1f2328");
  const lineBase = { type: "line", showSymbol: false, emphasis: { focus: "series" } };

  const isMobCh   = mob();
  const axisOffCh = isMobCh ? 42 : 55;
  const vixDataCh = pentaVixActive && loaded["VIX_H"] ? getPentaVixData() : null;
  const fgDataCh  = pentaFgActive  && loaded["F&G"] ? getPentaFgData()  : null;

  const rightAxesCh = [];
  let vixIdxCh = -1, fgIdxCh = -1;
  if (vixDataCh) {
    vixIdxCh = 1 + rightAxesCh.length;
    rightAxesCh.push({ scale: true, position: "right", offset: rightAxesCh.length * axisOffCh,
      axisLine: { lineStyle: { color: "#f0883e" } }, axisLabel: { fontSize: 11, color: "#f0883e" }, splitLine: { show: false } });
  }
  if (fgDataCh) {
    fgIdxCh = 1 + rightAxesCh.length;
    rightAxesCh.push({ min: 0, max: 100, position: "right", offset: rightAxesCh.length * axisOffCh,
      axisLine: { lineStyle: { color: "#e3b341" } }, axisLabel: { fontSize: 11, color: "#e3b341" }, splitLine: { show: false } });
  }
  const nRtCh     = rightAxesCh.length;
  const fpeDataCh = pentaFpeActive ? getPentaFpeData() : null;
  const fpeSubCh  = pentaFpeActive && !!fpeDataCh;
  const fpeGapCh  = fpeSubCh ? 1 : 0;
  const fpeSubYCh = fpeSubCh ? 1 + nRtCh : -1;
  const rsiIdxCh  = 1 + nRtCh + fpeGapCh;
  const kdIdxCh   = 2 + nRtCh + fpeGapCh;
  const gridRCh   = nRtCh === 0 ? (isMobCh ? 12 : 24) : nRtCh === 1 ? (isMobCh ? 38 : 58) : (isMobCh ? 65 : 105);

  const wHLCCh    = loadedHLC[pentaActiveTicker] ? toWeeklyHLC(loadedHLC[pentaActiveTicker]) : weekly.map(r => [r[0],r[1],r[1],r[1]]);
  const rsiDataCh = computeRSI(weekly, 14).filter(r => r[0] >= fromDate);
  const kdDataCh  = computeKD(wHLCCh, 9).filter(r => r[0] >= fromDate);
  const tdInRgCh  = computeTDSetup(weekly).filter(p => p.date >= fromDate);
  const pmapCh    = new Map(weekly.map(r => [r[0], r[1]]));

  const priceAxisCh = { gridIndex:0, scale:true, axisLine:{lineStyle:{color:axisClr}}, axisLabel:{fontSize:12}, splitLine:{lineStyle:{color:gridClr}} };
  const rtAxWithGCh = rightAxesCh.map(a => ({ ...a, gridIndex: 0 }));
  const fpeAxisCh   = fpeSubCh ? { gridIndex:1, name:'FPE', nameLocation:'start', nameGap:2, nameTextStyle:{color:'#58a6ff',fontSize:9}, min:v=>Math.floor(v.min-1), max:v=>Math.ceil(v.max+1), axisLabel:{fontSize:9,color:'#58a6ff',formatter:v=>`${v}x`}, axisLine:{lineStyle:{color:'#58a6ff'}}, splitLine:{show:false} } : null;
  const rsiAxisCh   = { gridIndex:1+fpeGapCh, min:0, max:100, name:'RSI', nameLocation:'start', nameGap:2, nameTextStyle:{color:'#a371f7',fontSize:9}, axisLine:{lineStyle:{color:axisClr}}, axisLabel:{fontSize:9,color:'#a371f7'}, splitLine:{show:false} };
  const kdAxisCh    = { gridIndex:2+fpeGapCh, min:0, max:100, name:'KD',  nameLocation:'start', nameGap:2, nameTextStyle:{color:'#f0883e',fontSize:9}, axisLine:{lineStyle:{color:axisClr}}, axisLabel:{fontSize:9,color:'#f0883e'}, splitLine:{show:false} };
  const yAxisCh     = [priceAxisCh, ...rtAxWithGCh, ...(fpeAxisCh ? [fpeAxisCh] : []), rsiAxisCh, kdAxisCh];

  const mkTDCh = (items, pos, clr, c9) => {
    const norm = items.filter(p => p.count < 9);
    const sig9 = items.filter(p => p.count === 9);
    const out  = [];
    if (norm.length) out.push({ type:'scatter', name:`__tdc_${pos}`, xAxisIndex:0, yAxisIndex:0, data:norm.map(p=>[p.date,pmapCh.get(p.date)??0,p.count]), symbolSize:0, silent:true, label:{show:true, formatter:p=>String(p.data[2]), position:pos, fontSize:9, color:clr} });
    if (sig9.length) out.push({ type:'scatter', name:`__tdc9_${pos}`, xAxisIndex:0, yAxisIndex:0, data:sig9.map(p=>[p.date,pmapCh.get(p.date)??0]), symbol:'circle', symbolSize:11, silent:true, itemStyle:{color:c9,borderColor:'#fff',borderWidth:1.5}, label:{show:true, formatter:'9', position:pos, fontSize:10, fontWeight:'bold', color:c9, distance:4} });
    return out;
  };
  const tdSeriesCh = [
    ...mkTDCh(tdInRgCh.filter(p=>p.dir==='down'), 'top',    '#3fb950', '#56d364'),
    ...mkTDCh(tdInRgCh.filter(p=>p.dir==='up'),   'bottom', '#f85149', '#f85149'),
  ];

  pentaChart.setOption({
    backgroundColor: "transparent",
    tooltip: {
      trigger: "axis", axisPointer: { type: "cross" },
      backgroundColor: tipBg, borderColor: tipBdr, textStyle: { color: tipText },
      formatter(params) {
        if (!params?.length) return '';
        const ts = params[0]?.axisValue;
        const dateLabel = ts ? tsToLocalDate(ts) : "";
        let out = `<b>${dateLabel}</b><br/>`;
        const priceV = params.find(p => p.seriesName === "價格")?.value?.[1];
        for (const p of params) {
          if (p.seriesName.startsWith("__")) continue;
          const v = p.value?.[1]; if (v == null) continue;
          const fmt = p.seriesName==="F&G" ? v.toFixed(0) : p.seriesName==="VIX" ? v.toFixed(2) : v.toLocaleString(undefined,{maximumFractionDigits:2});
          out += `<span style="color:${p.color}">●</span> ${p.seriesName}: <b>${fmt}</b><br/>`;
        }
        if (_dragAnchor && priceV != null) {
          const pct = (priceV - _dragAnchor.price) / _dragAnchor.price * 100;
          const clr = pct >= 0 ? '#26a69a' : '#ef5350';
          const fmt = v => v.toLocaleString(undefined, { maximumFractionDigits: 2 });
          out += `<span style="color:#888">↔ ${_dragAnchor.date} <b style="color:#ccc">${fmt(_dragAnchor.price)}</b> → <b style="color:${clr}">${fmt(priceV)}</b>　<b style="color:${clr}">${pct>=0?'+':''}${pct.toFixed(2)}%</b></span><br/>`;
        }
        return out;
      },
    },
    legend: {
      data: ["上軌 +2.5σ","MA20","價格","下軌 -2.5σ",...(ma125Chw?[maLabel]:[]),...(vixIdxCh>=0?["VIX"]:[]),...(fgIdxCh>=0?["F&G"]:[]),...(fpeSubCh?["FPE"]:[])],
      textStyle: { color: tipText, fontSize: 13 }, top: 6,
    },
    axisPointer: { link: [{ xAxisIndex: 'all' }] },
    grid: fpeSubCh ? [
      { left:isMobCh?45:72, right:gridRCh, top:48, bottom:'50%' },
      { left:isMobCh?45:72, right:50, top:'53%', bottom:'38%' },
      { left:isMobCh?45:72, right:50, top:'65%', bottom:'22%' },
      { left:isMobCh?45:72, right:50, top:'81%', bottom:36 },
    ] : [
      { left:isMobCh?45:72, right:gridRCh, top:48, bottom:'38%' },
      { left:isMobCh?45:72, right:50, top:'65%', bottom:'22%' },
      { left:isMobCh?45:72, right:50, top:'81%', bottom:36 },
    ],
    xAxis: fpeSubCh ? [
      { gridIndex:0, type:"time", axisLabel:{show:false}, splitLine:{show:false} },
      { gridIndex:1, type:"time", axisLabel:{show:false}, splitLine:{show:false} },
      { gridIndex:2, type:"time", axisLabel:{show:false}, splitLine:{show:false} },
      { gridIndex:3, type:"time", axisLine:{lineStyle:{color:axisClr}}, axisLabel:{fontSize:isMobCh?10:12}, splitLine:{show:false} },
    ] : [
      { gridIndex:0, type:"time", axisLabel:{show:false}, splitLine:{show:false} },
      { gridIndex:1, type:"time", axisLabel:{show:false}, splitLine:{show:false} },
      { gridIndex:2, type:"time", axisLine:{lineStyle:{color:axisClr}}, axisLabel:{fontSize:isMobCh?10:12}, splitLine:{show:false} },
    ],
    yAxis: yAxisCh,
    dataZoom: [
      { type:"inside", xAxisIndex: fpeSubCh ? [0,1,2,3] : [0,1,2] },
      { type:"slider", height:18, bottom:14, xAxisIndex: fpeSubCh ? [0,1,2,3] : [0,1,2] },
    ],
    series: [
      { ...lineBase, name:"上軌 +2.5σ", data:upperW, xAxisIndex:0, yAxisIndex:0, lineStyle:{width:1.5,color:"#e91e63"}, itemStyle:{color:"#e91e63"} },
      { ...lineBase, name:"MA20",       data:ma20w,  xAxisIndex:0, yAxisIndex:0, lineStyle:{width:1.5,color:"#9e9e9e",type:"dashed"}, itemStyle:{color:"#9e9e9e"} },
      { ...lineBase, name:"價格",       data:priceW, xAxisIndex:0, yAxisIndex:0, lineStyle:{width:1.8,color:s.color}, itemStyle:{color:s.color} },
      { ...lineBase, name:"下軌 -2.5σ", data:lowerW, xAxisIndex:0, yAxisIndex:0, lineStyle:{width:1.5,color:"#1565c0"}, itemStyle:{color:"#1565c0"} },
      ...(ma125Chw ? [{ ...lineBase, name:maLabel, data:ma125Chw, xAxisIndex:0, yAxisIndex:0, lineStyle:{width:2,color:"#ff9800"}, itemStyle:{color:"#ff9800"} }] : []),
      ...(vixIdxCh>=0 ? [{ ...lineBase, name:"VIX", data:vixDataCh, xAxisIndex:0, yAxisIndex:vixIdxCh, lineStyle:{width:1.5,color:"#f0883e",type:"dashed"}, itemStyle:{color:"#f0883e"}, areaStyle:{color:"rgba(240,136,62,0.06)"} }] : []),
      ...(fgIdxCh>=0  ? [{ ...lineBase, name:"F&G", data:fgDataCh,  xAxisIndex:0, yAxisIndex:fgIdxCh,  lineStyle:{width:1.5,color:"#e3b341",type:"dashed"}, itemStyle:{color:"#e3b341"}, areaStyle:{color:"rgba(227,179,65,0.06)"} }] : []),
      ...(fpeSubCh ? [{ type:'line', name:'FPE', xAxisIndex:1, yAxisIndex:fpeSubYCh, data:fpeDataCh, showSymbol:false, lineStyle:{width:1.5,color:'#58a6ff'}, itemStyle:{color:'#58a6ff'}, markLine:_fpeMarkLine(pentaActiveTicker) }] : []),
      ...(rsiDataCh.length ? [{ type:'line', name:'RSI', xAxisIndex:1+fpeGapCh, yAxisIndex:rsiIdxCh, data:rsiDataCh, showSymbol:false, lineStyle:{width:1.5,color:'#a371f7'}, itemStyle:{color:'#a371f7'}, markLine:{silent:true,symbol:['none','none'],animation:false,data:[{yAxis:70,label:{formatter:'70',fontSize:9},lineStyle:{color:'#f85149',type:'dashed',width:1,opacity:0.5}},{yAxis:30,label:{formatter:'30',fontSize:9},lineStyle:{color:'#3fb950',type:'dashed',width:1,opacity:0.5}}]} }] : []),
      ...(kdDataCh.length ? [
        { type:'line', name:'K', xAxisIndex:2+fpeGapCh, yAxisIndex:kdIdxCh, data:kdDataCh.map(r=>[r[0],r[1]]), showSymbol:false, lineStyle:{width:1.5,color:'#f0883e'}, itemStyle:{color:'#f0883e'}, markLine:{silent:true,symbol:['none','none'],animation:false,data:[{yAxis:80,label:{formatter:'80',fontSize:9},lineStyle:{color:'#f85149',type:'dashed',width:1,opacity:0.5}},{yAxis:20,label:{formatter:'20',fontSize:9},lineStyle:{color:'#3fb950',type:'dashed',width:1,opacity:0.5}}]} },
        { type:'line', name:'D', xAxisIndex:2+fpeGapCh, yAxisIndex:kdIdxCh, data:kdDataCh.map(r=>[r[0],r[2]]), showSymbol:false, lineStyle:{width:1.5,color:'#79c0ff',type:'dashed'}, itemStyle:{color:'#79c0ff'} },
      ] : []),
      ...tdSeriesCh,
    ],
  }, { notMerge: true });

  statusEl.textContent =
    `${pentaActiveTicker} 樂活通道 · ${pentaPeriod} · MA20 週線 ±2.5σ · ${weekly.length} 週完整歷史`;
  attachDragMeasure(pentaChart);
}

export function renderPentagram() {
  if (pentaMode === "channel") { renderChannelMode(); return; }
  if (!pentaChart) return;
  const statusEl = document.getElementById("penta-status");

  if (!pentaActiveTicker || !loaded[pentaActiveTicker]) {
    pentaChart.clear();
    statusEl.textContent = "← 選擇標的以顯示五線譜";
    return;
  }

  const data   = getPentaData();
  const result = computeLinearRegression(data);

  if (!result) {
    statusEl.textContent = `數據不足`;
    pentaChart.clear();
    return;
  }

  const rLen      = result.upper2.length;
  const lastDate  = data[data.length - 1][0];
  const lastPrice = data[data.length - 1][1];
  const lastU2    = result.upper2[rLen - 1][1];
  const lastU1    = result.upper1[rLen - 1][1];
  const lastTr    = result.trend [rLen - 1][1];
  const lastL1    = result.lower1[rLen - 1][1];
  const lastL2    = result.lower2[rLen - 1][1];
  let zoneName, zoneClr;
  if      (lastPrice >= lastU2) { zoneName = "超漲"; zoneClr = "#e91e63"; }
  else if (lastPrice >= lastU1) { zoneName = "偏貴"; zoneClr = "#f06292"; }
  else if (lastPrice >= lastTr) { zoneName = "偏強"; zoneClr = "#78909c"; }
  else if (lastPrice >= lastL1) { zoneName = "偏弱"; zoneClr = "#64b5f6"; }
  else if (lastPrice >= lastL2) { zoneName = "便宜"; zoneClr = "#1976d2"; }
  else                          { zoneName = "超跌"; zoneClr = "#1565c0"; }
  const badgePos = lastPrice >= lastTr ? "bottom" : "top";

  const maLabelPt   = `MA${pentaMaPeriod}`;
  const fromDatePt  = data.length > 0 ? data[0][0] : "";
  const ma125DataPt = penta125Active
    ? computeCustomMA(loaded[pentaActiveTicker], pentaMaPeriod).filter(r => r[0] >= fromDatePt)
    : null;

  let deviationStr = "";
  let badgeLabel   = zoneName;
  if (ma125DataPt && ma125DataPt.length > 0) {
    const lastMA = ma125DataPt[ma125DataPt.length - 1][1];
    const dev    = (lastPrice - lastMA) / lastMA * 100;
    deviationStr = `${dev >= 0 ? "+" : ""}${dev.toFixed(2)}%`;
    badgeLabel   = `${zoneName}  ${deviationStr}`;
  }

  const s        = SERIES.find(x => x.key === pentaActiveTicker);
  const axisClr  = tc("#8b949e", "#57606a");
  const gridClr  = tc("#21262d", "#e1e4e8");
  const tipBg    = tc("#161b22", "#ffffff");
  const tipBdr   = tc("#30363d", "#d0d7de");
  const tipText  = tc("#e6edf3", "#1f2328");
  const lineBase = { type: "line", showSymbol: false, emphasis: { focus: "series" } };

  const isMobPt   = mob();
  const axisOffPt = isMobPt ? 42 : 55;
  const vixDataPt = pentaVixActive && loaded["VIX_H"] ? getPentaVixData() : null;
  const fgDataPt  = pentaFgActive  && loaded["F&G"] ? getPentaFgData()  : null;

  const rightAxesPt = [];
  let vixIdxPt = -1, fgIdxPt = -1;
  if (vixDataPt) {
    vixIdxPt = 1 + rightAxesPt.length;
    rightAxesPt.push({ scale: true, position: "right", offset: rightAxesPt.length * axisOffPt,
      axisLine: { lineStyle: { color: "#f0883e" } }, axisLabel: { fontSize: 11, color: "#f0883e" }, splitLine: { show: false } });
  }
  if (fgDataPt) {
    fgIdxPt = 1 + rightAxesPt.length;
    rightAxesPt.push({ min: 0, max: 100, position: "right", offset: rightAxesPt.length * axisOffPt,
      axisLine: { lineStyle: { color: "#e3b341" } }, axisLabel: { fontSize: 11, color: "#e3b341" }, splitLine: { show: false } });
  }
  const nRtPt     = rightAxesPt.length;
  const fpeDataPt = pentaFpeActive ? getPentaFpeData() : null;
  const fpeSubPt  = pentaFpeActive && !!fpeDataPt;
  const fpeGapPt  = fpeSubPt ? 1 : 0;
  const fpeSubYPt = fpeSubPt ? 1 + nRtPt : -1;
  const rsiIdxPt  = 1 + nRtPt + fpeGapPt;
  const kdIdxPt   = 2 + nRtPt + fpeGapPt;
  const gridRPt   = nRtPt === 0 ? (isMobPt ? 12 : 24) : nRtPt === 1 ? (isMobPt ? 38 : 58) : (isMobPt ? 65 : 105);

  const wklyPt   = toWeekly(loaded[pentaActiveTicker] || []);
  const wHLCPt   = loadedHLC[pentaActiveTicker] ? toWeeklyHLC(loadedHLC[pentaActiveTicker]) : wklyPt.map(r => [r[0],r[1],r[1],r[1]]);
  const rsiDataPt = computeRSI(wklyPt, 14).filter(r => r[0] >= fromDatePt);
  const kdDataPt  = computeKD(wHLCPt, 9).filter(r => r[0] >= fromDatePt);
  const tdInRgPt  = computeTDSetup(wklyPt).filter(p => p.date >= fromDatePt);
  const pmapPt    = new Map(wklyPt.map(r => [r[0], r[1]]));

  const priceAxisPt = { gridIndex:0, scale:true, axisLine:{lineStyle:{color:axisClr}}, axisLabel:{fontSize:12}, splitLine:{lineStyle:{color:gridClr}} };
  const rtAxWithGPt = rightAxesPt.map(a => ({ ...a, gridIndex: 0 }));
  const fpeAxisPt   = fpeSubPt ? { gridIndex:1, name:'FPE', nameLocation:'start', nameGap:2, nameTextStyle:{color:'#58a6ff',fontSize:9}, min:v=>Math.floor(v.min-1), max:v=>Math.ceil(v.max+1), axisLabel:{fontSize:9,color:'#58a6ff',formatter:v=>`${v}x`}, axisLine:{lineStyle:{color:'#58a6ff'}}, splitLine:{show:false} } : null;
  const rsiAxisPt   = { gridIndex:1+fpeGapPt, min:0, max:100, name:'RSI', nameLocation:'start', nameGap:2, nameTextStyle:{color:'#a371f7',fontSize:9}, axisLine:{lineStyle:{color:axisClr}}, axisLabel:{fontSize:9,color:'#a371f7'}, splitLine:{show:false} };
  const kdAxisPt    = { gridIndex:2+fpeGapPt, min:0, max:100, name:'KD',  nameLocation:'start', nameGap:2, nameTextStyle:{color:'#f0883e',fontSize:9}, axisLine:{lineStyle:{color:axisClr}}, axisLabel:{fontSize:9,color:'#f0883e'}, splitLine:{show:false} };
  const yAxisPt     = [priceAxisPt, ...rtAxWithGPt, ...(fpeAxisPt ? [fpeAxisPt] : []), rsiAxisPt, kdAxisPt];

  const mkTDPt = (items, pos, clr, c9) => {
    const norm = items.filter(p => p.count < 9);
    const sig9 = items.filter(p => p.count === 9);
    const out  = [];
    if (norm.length) out.push({ type:'scatter', name:`__tdp_${pos}`, xAxisIndex:0, yAxisIndex:0, data:norm.map(p=>[p.date,pmapPt.get(p.date)??0,p.count]), symbolSize:0, silent:true, label:{show:true, formatter:p=>String(p.data[2]), position:pos, fontSize:9, color:clr} });
    if (sig9.length) out.push({ type:'scatter', name:`__tdp9_${pos}`, xAxisIndex:0, yAxisIndex:0, data:sig9.map(p=>[p.date,pmapPt.get(p.date)??0]), symbol:'circle', symbolSize:11, silent:true, itemStyle:{color:c9,borderColor:'#fff',borderWidth:1.5}, label:{show:true, formatter:'9', position:pos, fontSize:10, fontWeight:'bold', color:c9, distance:4} });
    return out;
  };
  const tdSeriesPt = [
    ...mkTDPt(tdInRgPt.filter(p=>p.dir==='down'), 'top',    '#3fb950', '#56d364'),
    ...mkTDPt(tdInRgPt.filter(p=>p.dir==='up'),   'bottom', '#f85149', '#f85149'),
  ];

  const sU2 = { ...lineBase, name:"極度貪婪", data:result.upper2, xAxisIndex:0, yAxisIndex:0, lineStyle:{width:1.5,color:"#e91e63"}, itemStyle:{color:"#e91e63"} };
  const sU1 = { ...lineBase, name:"貪婪",     data:result.upper1, xAxisIndex:0, yAxisIndex:0, lineStyle:{width:1.5,color:"#f48fb1"}, itemStyle:{color:"#f48fb1"} };
  const sTr = { ...lineBase, name:"趨勢線",   data:result.trend,  xAxisIndex:0, yAxisIndex:0, lineStyle:{width:1.5,color:"#9e9e9e"}, itemStyle:{color:"#9e9e9e"} };
  const sL1 = { ...lineBase, name:"恐懼",     data:result.lower1, xAxisIndex:0, yAxisIndex:0, lineStyle:{width:1.5,color:"#64b5f6"}, itemStyle:{color:"#64b5f6"} };
  const sL2 = { ...lineBase, name:"極度恐懼", data:result.lower2, xAxisIndex:0, yAxisIndex:0, lineStyle:{width:1.5,color:"#1565c0"}, itemStyle:{color:"#1565c0"} };
  const sPr = { ...lineBase, name:"價格",     data,               xAxisIndex:0, yAxisIndex:0, lineStyle:{width:1.5,color:s.color},   itemStyle:{color:s.color},
    markPoint: { silent:true, animation:false, data:[{ coord:[lastDate,lastPrice], symbol:"circle", symbolSize:10, itemStyle:{color:zoneClr,borderColor:"#fff",borderWidth:2}, label:{show:true, formatter:badgeLabel, position:badgePos, distance:8, color:"#fff", backgroundColor:zoneClr, borderRadius:4, padding:[3,8], fontSize:12, fontWeight:"bold"} }] }
  };
  let bandsSorted;
  if      (lastPrice >= lastU2) bandsSorted = [sPr, sU2, sU1, sTr, sL1, sL2];
  else if (lastPrice >= lastU1) bandsSorted = [sU2, sPr, sU1, sTr, sL1, sL2];
  else if (lastPrice >= lastTr) bandsSorted = [sU2, sU1, sPr, sTr, sL1, sL2];
  else if (lastPrice >= lastL1) bandsSorted = [sU2, sU1, sTr, sPr, sL1, sL2];
  else if (lastPrice >= lastL2) bandsSorted = [sU2, sU1, sTr, sL1, sPr, sL2];
  else                          bandsSorted = [sU2, sU1, sTr, sL1, sL2, sPr];

  pentaChart.setOption({
    backgroundColor: "transparent",
    tooltip: {
      trigger: "axis", axisPointer: { type: "cross" },
      backgroundColor: tipBg, borderColor: tipBdr, textStyle: { color: tipText },
      formatter(params) {
        if (!params?.length) return '';
        const ts = params[0]?.axisValue;
        const dateLabel = ts ? tsToLocalDate(ts) : "";
        let out = `<b>${dateLabel}</b><br/>`;
        const priceV = params.find(p => p.seriesName === "價格")?.value?.[1];
        for (const p of params) {
          if (p.seriesName.startsWith("__")) continue;
          const v = p.value?.[1]; if (v == null) continue;
          const fmt = p.seriesName==="F&G" ? v.toFixed(0) : p.seriesName==="VIX" ? v.toFixed(2) : v.toLocaleString(undefined,{maximumFractionDigits:2});
          out += `<span style="color:${p.color}">●</span> ${p.seriesName}: <b>${fmt}</b>`;
          if (p.seriesName === maLabelPt && priceV != null) {
            const dev = (priceV - v) / v * 100;
            out += `  <span style="color:${dev>=0?"#f48fb1":"#64b5f6"};font-size:11px">${dev>=0?"+":""}${dev.toFixed(2)}%</span>`;
          }
          out += "<br/>";
        }
        if (_dragAnchor && priceV != null) {
          const pct = (priceV - _dragAnchor.price) / _dragAnchor.price * 100;
          const clr = pct >= 0 ? '#26a69a' : '#ef5350';
          const fmt = v => v.toLocaleString(undefined, { maximumFractionDigits: 2 });
          out += `<span style="color:#888">↔ ${_dragAnchor.date} <b style="color:#ccc">${fmt(_dragAnchor.price)}</b> → <b style="color:${clr}">${fmt(priceV)}</b>　<b style="color:${clr}">${pct>=0?'+':''}${pct.toFixed(2)}%</b></span><br/>`;
        }
        return out;
      },
    },
    legend: {
      data: [...bandsSorted.map(x=>x.name),...(ma125DataPt?[maLabelPt]:[]),...(vixIdxPt>=0?["VIX"]:[]),...(fgIdxPt>=0?["F&G"]:[]),...(fpeSubPt?["FPE"]:[])],
      textStyle: { color: tipText, fontSize: 13 }, top: 6,
    },
    axisPointer: { link: [{ xAxisIndex: 'all' }] },
    grid: fpeSubPt ? [
      { left:isMobPt?45:72, right:gridRPt, top:48, bottom:'50%' },
      { left:isMobPt?45:72, right:50, top:'53%', bottom:'38%' },
      { left:isMobPt?45:72, right:50, top:'65%', bottom:'22%' },
      { left:isMobPt?45:72, right:50, top:'81%', bottom:36 },
    ] : [
      { left:isMobPt?45:72, right:gridRPt, top:48, bottom:'38%' },
      { left:isMobPt?45:72, right:50, top:'65%', bottom:'22%' },
      { left:isMobPt?45:72, right:50, top:'81%', bottom:36 },
    ],
    xAxis: fpeSubPt ? [
      { gridIndex:0, type:"time", axisLabel:{show:false}, splitLine:{show:false} },
      { gridIndex:1, type:"time", axisLabel:{show:false}, splitLine:{show:false} },
      { gridIndex:2, type:"time", axisLabel:{show:false}, splitLine:{show:false} },
      { gridIndex:3, type:"time", axisLine:{lineStyle:{color:axisClr}}, axisLabel:{fontSize:isMobPt?10:12}, splitLine:{show:false} },
    ] : [
      { gridIndex:0, type:"time", axisLabel:{show:false}, splitLine:{show:false} },
      { gridIndex:1, type:"time", axisLabel:{show:false}, splitLine:{show:false} },
      { gridIndex:2, type:"time", axisLine:{lineStyle:{color:axisClr}}, axisLabel:{fontSize:isMobPt?10:12}, splitLine:{show:false} },
    ],
    yAxis: yAxisPt,
    dataZoom: [
      { type:"inside", xAxisIndex: fpeSubPt ? [0,1,2,3] : [0,1,2] },
      { type:"slider", height:18, bottom:14, xAxisIndex: fpeSubPt ? [0,1,2,3] : [0,1,2] },
    ],
    series: [
      ...bandsSorted,
      ...(ma125DataPt ? [{ ...lineBase, name:maLabelPt, data:ma125DataPt, xAxisIndex:0, yAxisIndex:0, lineStyle:{width:2,color:"#ff9800"}, itemStyle:{color:"#ff9800"} }] : []),
      ...(vixIdxPt>=0 ? [{ ...lineBase, name:"VIX", data:vixDataPt, xAxisIndex:0, yAxisIndex:vixIdxPt, lineStyle:{width:1.5,color:"#f0883e",type:"dashed"}, itemStyle:{color:"#f0883e"}, areaStyle:{color:"rgba(240,136,62,0.06)"} }] : []),
      ...(fgIdxPt>=0  ? [{ ...lineBase, name:"F&G", data:fgDataPt,  xAxisIndex:0, yAxisIndex:fgIdxPt,  lineStyle:{width:1.5,color:"#e3b341",type:"dashed"}, itemStyle:{color:"#e3b341"}, areaStyle:{color:"rgba(227,179,65,0.06)"} }] : []),
      ...(fpeSubPt ? [{ type:'line', name:'FPE', xAxisIndex:1, yAxisIndex:fpeSubYPt, data:fpeDataPt, showSymbol:false, lineStyle:{width:1.5,color:'#58a6ff'}, itemStyle:{color:'#58a6ff'}, markLine:_fpeMarkLine(pentaActiveTicker) }] : []),
      ...(rsiDataPt.length ? [{ type:'line', name:'RSI', xAxisIndex:1+fpeGapPt, yAxisIndex:rsiIdxPt, data:rsiDataPt, showSymbol:false, lineStyle:{width:1.5,color:'#a371f7'}, itemStyle:{color:'#a371f7'}, markLine:{silent:true,symbol:['none','none'],animation:false,data:[{yAxis:70,label:{formatter:'70',fontSize:9},lineStyle:{color:'#f85149',type:'dashed',width:1,opacity:0.5}},{yAxis:30,label:{formatter:'30',fontSize:9},lineStyle:{color:'#3fb950',type:'dashed',width:1,opacity:0.5}}]} }] : []),
      ...(kdDataPt.length ? [
        { type:'line', name:'K', xAxisIndex:2+fpeGapPt, yAxisIndex:kdIdxPt, data:kdDataPt.map(r=>[r[0],r[1]]), showSymbol:false, lineStyle:{width:1.5,color:'#f0883e'}, itemStyle:{color:'#f0883e'}, markLine:{silent:true,symbol:['none','none'],animation:false,data:[{yAxis:80,label:{formatter:'80',fontSize:9},lineStyle:{color:'#f85149',type:'dashed',width:1,opacity:0.5}},{yAxis:20,label:{formatter:'20',fontSize:9},lineStyle:{color:'#3fb950',type:'dashed',width:1,opacity:0.5}}]} },
        { type:'line', name:'D', xAxisIndex:2+fpeGapPt, yAxisIndex:kdIdxPt, data:kdDataPt.map(r=>[r[0],r[2]]), showSymbol:false, lineStyle:{width:1.5,color:'#79c0ff',type:'dashed'}, itemStyle:{color:'#79c0ff'} },
      ] : []),
      ...tdSeriesPt,
    ],
  }, { notMerge: true });

  statusEl.textContent =
    `${pentaActiveTicker} 五線譜 · ${pentaPeriod} · 線性迴歸通道 · ${data.length} 筆${pentaWeekly ? "週" : "日"}線 · 目前：${zoneName}${deviationStr ? ` · ${maLabelPt} 乖離：${deviationStr}` : ""}`;
  attachDragMeasure(pentaChart);
}

export function renderPentaTickerPicker() {
  const wrap = document.getElementById("penta-ticker-picker");
  wrap.innerHTML = "";
  for (const key of PENTA_TICKERS) {
    const s  = SERIES.find(x => x.key === key);
    const on = pentaActiveTicker === key;
    const el = document.createElement("span");
    el.className = "chip";
    el.textContent = key;
    el.style.borderColor = on ? s.color : "";
    el.style.color       = on ? s.color : "";
    el.onclick = async () => {
      pentaActiveTicker = key;
      renderPentaTickerPicker();
      if (!loaded[key]) {
        document.getElementById("penta-status").textContent = "載入中…";
        await loadSeries(s);
      }
      if (pentaFpeActive) await _ensureFpeData(key);
      renderPentagram();
    };
    wrap.appendChild(el);
  }
}

export function activate() {
  const el = document.getElementById("penta-chart");
  if (!pentaChart) {
    pentaChart = echarts.init(el, isLight() ? null : "dark");
  }
  setTimeout(() => { pentaChart.resize(); renderPentagram(); }, 50);
}

export function onThemeChange(light) {
  if (!pentaChart) return;
  pentaChart.dispose();
  pentaChart = echarts.init(document.getElementById("penta-chart"), light ? null : "dark");
  renderPentagram();
}

export function resize() {
  pentaChart?.resize();
}

document.getElementById("penta-period-picker")?.addEventListener("click", e => {
  const t = e.target.closest(".chip[data-period]");
  if (!t) return;
  pentaPeriod = t.dataset.period;
  for (const c of e.currentTarget.querySelectorAll(".chip"))
    c.classList.toggle("active", c === t);
  renderPentagram();
});

document.getElementById("penta-mode-picker")?.addEventListener("click", e => {
  const t = e.target.closest(".chip[data-mode]");
  if (!t) return;
  pentaMode = t.dataset.mode;
  for (const c of e.currentTarget.querySelectorAll(".chip"))
    c.classList.toggle("active", c === t);
  renderPentagram();
});

document.getElementById("penta-vix-toggle")?.addEventListener("click", async () => {
  pentaVixActive = !pentaVixActive;
  document.getElementById("penta-vix-toggle").classList.toggle("vix-on", pentaVixActive);
  if (pentaVixActive && !loaded["VIX_H"]) {
    const resp = await fetch("data/VIX.json", { cache: "no-cache" });
    const j = await resp.json();
    loaded["VIX_H"] = (j.data || []).map(r => [r.date, r.high]);
  }
  renderPentagram();
});

document.getElementById("penta-fg-toggle")?.addEventListener("click", async () => {
  pentaFgActive = !pentaFgActive;
  document.getElementById("penta-fg-toggle").classList.toggle("fg-on", pentaFgActive);
  if (pentaFgActive && !loaded["F&G"]) {
    await loadSeries(SERIES.find(x => x.key === "F&G"));
  }
  renderPentagram();
});

document.getElementById("penta-ma125-toggle")?.addEventListener("click", () => {
  penta125Active = !penta125Active;
  document.getElementById("penta-ma125-toggle").classList.toggle("ma125-on", penta125Active);
  renderPentagram();
});

document.getElementById("penta-weekly-toggle")?.addEventListener("click", () => {
  pentaWeekly = !pentaWeekly;
  document.getElementById("penta-weekly-toggle").classList.toggle("active", pentaWeekly);
  renderPentagram();
});

async function _ensureFpeData(ticker) {
  if (!FPE_FILES[ticker] || pentaFpeCache[ticker]) return;
  try {
    const resp = await fetch(FPE_FILES[ticker], { cache: "no-cache" });
    const j = await resp.json();
    pentaFpeCache[ticker] = (j.data || []).sort((a, b) => a.date < b.date ? -1 : 1);
  } catch (e) { /* data unavailable */ }
}

export async function toggleFpe() {
  pentaFpeActive = !pentaFpeActive;
  document.getElementById("penta-fpe-toggle")?.classList.toggle("active", pentaFpeActive);
  if (pentaFpeActive) await _ensureFpeData(pentaActiveTicker);
  renderPentagram();
}
