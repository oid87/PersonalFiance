// 現金為王（izaax 策略）— 純函式：週線累積報酬、同跌數、恐懼貪婪週低點、逃往黃金。
// js/tabs/cashking.js 與 js/tabs/nonnormal.js（極端狀態儀表板的資金流向）共用。
// raw: { GLD|GCF|BTC|TLT|QQQ: [[date, close], ...], 'F&G': [[date, value], ...] }
export function ckWeekStart(dateStr) {
  const d = new Date(dateStr + "T12:00:00Z");
  const day = d.getUTCDay();
  d.setUTCDate(d.getUTCDate() - (day === 0 ? 6 : day - 1));
  // check_reuse: keep — UTC 建構的時間戳轉日期鍵,slice 與建構端同為 UTC 故自洽;tsToLocalDate 是給 ECharts 本地午夜 axisValue 用的,換過去反而會差一天
  return d.toISOString().slice(0, 10);
}

export function ckWeeklyCloses(data) {
  const m = {};
  for (const [d, c] of data) m[ckWeekStart(d)] = c;
  return m;
}

export function computeCKWeekly(raw, assets, startDate) {
  const n = assets.length;
  const closes = {};
  for (const { key } of assets) {
    closes[key] = raw[key] ? ckWeeklyCloses(raw[key]) : {};
  }

  // F&G min per week
  const fgWk = {};
  for (const [d, v] of (raw["F&G"] || [])) {
    const w = ckWeekStart(d);
    if (!(w in fgWk) || v < fgWk[w]) fgWk[w] = v;
  }

  // 逃往黃金: all non-gold assets down, gold asset up
  const goldKey = (assets.find(a => a.isGold) || {}).key;
  const ftgKeys = assets.map(a => a.key).filter(k => k !== goldKey);

  const weeks = Object.keys(closes["QQQ"]).filter(w => w >= startDate).sort();

  const rows = [];
  for (let i = 8; i < weeks.length; i++) {
    const w = weeks[i], wPrev = weeks[i - 1];
    const w4 = weeks[i - 4], w8 = weeks[i - 8];

    const weekRets = {}, cum4Rets = {}, cum8Rets = {};
    let weekDown = 0, cum4Down = 0, cum8Down = 0;

    for (const { key } of assets) {
      const cW = closes[key][w], cP = closes[key][wPrev];
      const c4 = closes[key][w4], c8 = closes[key][w8];
      weekRets[key] = (cP && cW) ? (cW - cP) / cP : null;
      cum4Rets[key] = (c4 && cW) ? (cW - c4) / c4 : null;
      cum8Rets[key] = (c8 && cW) ? (cW - c8) / c8 : null;
      if (weekRets[key] != null && weekRets[key] < 0) weekDown++;
      if (cum4Rets[key] != null && cum4Rets[key] < 0) cum4Down++;
      if (cum8Rets[key] != null && cum8Rets[key] < 0) cum8Down++;
    }

    // F&G min across 4-week and 8-week windows
    let fgMin4w = null, fgMin8w = null;
    for (let j = i - 7; j <= i; j++) {
      const v = fgWk[weeks[j]];
      if (v == null) continue;
      if (fgMin8w == null || v < fgMin8w) fgMin8w = v;
      if (j >= i - 3 && (fgMin4w == null || v < fgMin4w)) fgMin4w = v;
    }

    const cNow = closes["QQQ"][w];
    const cF4  = i + 4 < weeks.length ? closes["QQQ"][weeks[i + 4]] : null;
    const cF8  = i + 8 < weeks.length ? closes["QQQ"][weeks[i + 8]] : null;

    const ftg4w = goldKey && ftgKeys.every(k => cum4Rets[k] != null && cum4Rets[k] < 0)
      && cum4Rets[goldKey] != null && cum4Rets[goldKey] > 0;
    const ftg8w = goldKey && ftgKeys.every(k => cum8Rets[k] != null && cum8Rets[k] < 0)
      && cum8Rets[goldKey] != null && cum8Rets[goldKey] > 0;

    rows.push({
      w, weekRets, cum4Rets, cum8Rets,
      weekDown, cum4Down, cum8Down,
      fgMin4w, fgMin8w, ftg4w, ftg8w,
      fwd4w: (cNow && cF4) ? (cF4 / cNow - 1) : null,
      fwd8w: (cNow && cF8) ? (cF8 / cNow - 1) : null,
    });
  }
  return rows;
}
