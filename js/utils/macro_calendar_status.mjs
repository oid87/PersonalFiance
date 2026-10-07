// Assessment/contract only: no future-event rows and no collector.
export const MACRO_CALENDAR_STATUS = Object.freeze({ schemaVersion: 1, status: 'unavailable',
  reason: '尚未核准並接入可重現的未來總經發布行事曆；更新時間不代表未來事件覆蓋。',
  events: Object.freeze([]), references: Object.freeze([
    Object.freeze({ name: 'BLS 官方發布行事曆（人工查閱）', href: 'https://www.bls.gov/schedule/' }),
    Object.freeze({ name: 'Federal Reserve FOMC 官方行事曆（人工查閱）', href: 'https://www.federalreserve.gov/monetarypolicy/fomccalendars.htm' }),
    Object.freeze({ name: 'BEA 官方發布行事曆（人工查閱）', href: 'https://www.bea.gov/news/schedule' }),
  ]) });

export function mountMacroCalendarStatus(host) {
  const doc = host.ownerDocument, root = doc.createElement('section');
  const add = (tag, text) => { const el = doc.createElement(tag); el.textContent = text; root.append(el); return el; };
  add('p', '未接入未來總經事件來源（unavailable）').className = 'notice';
  add('p', MACRO_CALENDAR_STATUS.reason);
  add('p', '既有 CPI 是歷史發布日期；財報檔是企業事件；總經 archive 是歷史快照。它們不能冒充完整的未來總經事件 feed。');
  const list = doc.createElement('ul');
  for (const item of MACRO_CALENDAR_STATUS.references) {
    const li = doc.createElement('li'), anchor = doc.createElement('a'); anchor.href = item.href; anchor.textContent = item.name; li.append(anchor); list.append(li);
  }
  root.append(list); add('p', '連結僅供使用者查閱，本頁不抓取／排程／發布事件。待確認來源、授權、時區、修訂與覆蓋契約後再接線。');
  host.replaceChildren(root); return { destroy() { root.remove(); } };
}
