// 資料更新狀態表的純計算（#tab=breadthwarn）。狀態本身由 scripts/_data_status.py 在排程執行當下判斷，
// 這裡只做兩件事：換成頁面用語、用瀏覽器現在的時間檢查「狀態檔本身是不是太久沒更新」。不碰 DOM。
export const STATE = {
  ok: { label: '最新', level: 0 },
  waiting: { label: '等待公布或下一次排程', level: 0 },
  closed: { label: '休市，或所有來源都還沒有新資料', level: 1 },
  behind: { label: '落後', level: 2 },
  failed: { label: '抓取失敗', level: 2 },
};
export const CAUSE = {
  request: '向來源請求失敗', format: '來源的資料格式改了', incomplete: '拿到的資料不完整', script: '更新腳本出錯',
  source: '排程有跑，但來源還沒有新資料',
};
const DAY = 86400000, TPE = 8 * 3600000;

// 從 fromMs 到 nowMs 之間，經過了幾個「平日 21:30（臺北）」＝本來應該有幾次晚間更新
export function missedEvenings(fromMs, nowMs) {
  let n = 0;
  for (let d = Math.floor((fromMs + TPE) / DAY) * DAY; d + 21.5 * 3600000 - TPE <= nowMs; d += DAY) {
    const t = d + 21.5 * 3600000 - TPE, wd = new Date(d).getUTCDay();
    if (t > fromMs && wd >= 1 && wd <= 5) n++;
  }
  return n;
}

export function summarize(doc, nowMs) {
  if (!doc || !Array.isArray(doc.rows) || !doc.generated) return null;
  const gen = Date.parse(doc.generated);
  const hours = (nowMs - gen) / 3600000, missed = missedEvenings(gen, nowMs);
  const stalled = hours >= 36 && missed >= 2;      // 少一次可能只是排程延遲；少兩次以上就是停了
  const rows = doc.rows.map(r => {
    const st = STATE[r.state] || { label: r.state, level: 1 };
    const tight = !r.backfill && r.state === 'behind';
    let label = st.label;
    if (r.state === 'behind') label = `落後 ${r.lag} 個交易日`;
    return {
      key: r.key, name: r.name, src: r.src, cadence: r.cadence, latest: r.latest, seen: r.seen, backfill: r.backfill, gaps: r.gaps || [],
      level: r.alert ? 2 : (r.state === 'behind' || (r.gaps || []).length ? 1 : st.level), label,
      current: r.state === 'ok' || r.state === 'waiting' || r.state === 'closed',
      why: [CAUSE[r.cause], r.note, tight ? '今天收盤前沒補到就永久缺漏' : null].filter(Boolean).join('。'),
    };
  });
  const bad = rows.filter(r => r.level === 2), warn = rows.filter(r => r.level === 1);
  let head;
  if (stalled) head = `狀態檔已經 ${Math.round(hours)} 小時沒有更新（少了 ${missed} 次晚間更新），下面每一項都可能不是最新的。`;
  else if (bad.length) head = `${rows.length} 個資料來源裡有 ${bad.length} 個需要處理：${bad.map(r => r.name).join('、')}。`;
  else if (warn.length) head = `${rows.length} 個資料來源都在正常範圍，${warn.length} 個有備註。`;
  else head = `${rows.length} 個資料來源都是目前可取得的最新資料。`;
  return { head, level: stalled || bad.length ? 2 : warn.length ? 1 : 0, stalled, hours, rows, generated: doc.generated };
}
