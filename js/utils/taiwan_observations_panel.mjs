import { requestJSON, clearRequestCacheForSignal } from './data.js';
import { latestTask } from './tools_contracts.mjs';
import { loadTaiwanObservations, TAIWAN_OBSERVATION_SOURCES, unavailableTaiwanRows } from './taiwan_observations.mjs';

export function mountTaiwanObservations(host) {
  const doc = host.ownerDocument, root = doc.createElement('section');
  root.className = 'taiwan-observations';
  const add = (parent, tag, text) => { const el = doc.createElement(tag); el.textContent = text; parent.append(el); return el; };
  add(root, 'p', '各列是各自最新觀察，日期可以不同；月資料不填入每日序列。— 表示缺值或來源不可用，詳見狀態。');
  const retry = add(root, 'button', '重新讀取台灣觀察快照'); retry.type = 'button'; retry.dataset.taiwanRetry = '';
  const status = add(root, 'p', '正在讀取既有快照…'); status.setAttribute('role', 'status'); status.setAttribute('aria-live', 'polite');
  const scroll = doc.createElement('div'); scroll.className = 'table-scroll'; scroll.tabIndex = 0;
  scroll.setAttribute('role', 'region'); scroll.setAttribute('aria-label', '台灣觀察表，可水平捲動');
  const table = doc.createElement('table');
  add(table, 'caption', '台灣觀察 · 指數、融資與月頻貨幣年增率（既有快照，非即時報價）');
  const head = doc.createElement('thead'), headers = doc.createElement('tr');
  for (const label of ['指標', '原值', '單位', '觀測日／資料月份', '檔案更新', '來源／口徑', '狀態']) add(headers, 'th', label).scope = 'col';
  head.append(headers); table.append(head);
  const body = doc.createElement('tbody'); table.append(body); scroll.append(table); root.append(scroll);
  add(root, 'p', '融資維持率是上市融資多頭的重建代理；官方整戶維持率與 MacroMicro 新版上市＋上櫃系列尚未接入。');
  const notes = add(root, 'p', ''); const link = add(notes, 'a', '查看台灣觀察來源與方法'); link.href = 'docs/references/taiwan-observations.md';
  function render(rows) {
    body.replaceChildren();
    for (const row of rows) {
      const tr = doc.createElement('tr'); tr.dataset.metric = row.key; tr.dataset.status = row.status;
      add(tr, 'th', row.label).scope = 'row';
      add(tr, 'td', row.value === null ? '—' : String(row.value));
      add(tr, 'td', row.unit);
      add(tr, 'td', row.observation === null ? '未提供' : `${row.observation}（${row.frequency === 'monthly' ? '月頻期底' : '日觀察'}）`);
      add(tr, 'td', row.updated ?? '未提供');
      const source = add(tr, 'td', row.basis); source.append(doc.createElement('br'));
      const file = add(source, 'a', '查看快照'); file.href = row.file;
      add(tr, 'td', row.reason); body.append(tr);
    }
  }
  const task = latestTask();
  function load(force = false) {
    root.setAttribute('aria-busy', 'true'); status.textContent = '正在讀取既有快照…';
    render(TAIWAN_OBSERVATION_SOURCES.flatMap(source => unavailableTaiwanRows(source.key, '讀取中')));
    return task.run(signal => loadTaiwanObservations({ request: requestJSON, signal, force,
      onInvalid: () => clearRequestCacheForSignal(signal) }), rows => {
      render(rows); root.setAttribute('aria-busy', 'false');
      const count = rows.filter(row => row.status === 'available').length;
      status.textContent = count === rows.length ? `已讀取 ${count} 項既有觀察；各列日期分別標示。`
        : `可用 ${count}／${rows.length} 項；其餘缺值或不可用，請查看各列狀態或重試。`;
    }, error => {
      root.setAttribute('aria-busy', 'false'); status.textContent = `快照不可用：${error.message}。可重新讀取。`;
      render(TAIWAN_OBSERVATION_SOURCES.flatMap(source => unavailableTaiwanRows(source.key, '快照讀取失敗')));
    });
  }
  const retryClick = () => load(true); retry.addEventListener('click', retryClick);
  host.replaceChildren(root); load();
  return { destroy() { task.destroy(); retry.removeEventListener('click', retryClick); root.remove(); } };
}
