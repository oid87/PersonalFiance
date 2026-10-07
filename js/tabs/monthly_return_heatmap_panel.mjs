import { suppliedMonthlyReturns } from '../utils/tools_contracts.mjs';

export function mountMonthlyReturnHeatmap(host, payload) {
  const model = suppliedMonthlyReturns(payload);
  const doc = host.ownerDocument, root = doc.createElement('section');
  root.className = 'monthly-heatmap';
  const add = (parent, tag, text) => { const el = doc.createElement(tag); el.textContent = text; parent.append(el); return el; };
  add(root, 'h3', model.kind === 'synthetic' ? '合成示範 · 非市場資料' : '使用者提供的已計算報酬');
  add(root, 'p', `來源：${model.source} · 口徑：${model.basis}`);
  add(root, 'p', model.calculationLabel);
  add(root, 'p', '百分比原值保留，畫面顯示兩位小數。— 表示缺值；未提供與明確 null 分別標示，0.00% 是有效零值。顏色只區分正負，未設金融門檻。');
  if (!model.model.years.length) add(root, 'p', '輸入中沒有月份。');
  else {
    const scroll = doc.createElement('div'); scroll.className = 'table-scroll'; scroll.tabIndex = 0;
    scroll.setAttribute('role', 'region'); scroll.setAttribute('aria-label', '月報酬熱圖，可水平捲動');
    const table = doc.createElement('table'); add(table, 'caption', '已提供月報酬百分比；選取月份可讀取原始值與起迄點');
    const head = doc.createElement('thead'), hr = doc.createElement('tr');
    for (const name of ['年份', ...Array.from({ length: 12 }, (_, i) => `${i + 1}月`)]) add(hr, 'th', name).scope = 'col';
    head.append(hr); table.append(head);
    const body = doc.createElement('tbody');
    for (const [y, year] of model.model.years.entries()) {
      const row = doc.createElement('tr'); add(row, 'th', year).scope = 'row';
      for (const cell of model.model.cells.slice(y * 12, y * 12 + 12)) {
        const td = doc.createElement('td');
        if (cell.returnPct !== null && cell.returnPct !== 0) td.className = cell.returnPct < 0 ? 'negative' : 'positive';
        const button = add(td, 'button', cell.returnPct === null ? '—' : `${cell.returnPct.toFixed(2)}%`);
        button.type = 'button'; button.dataset.month = cell.month;
        const mark = !cell.provided ? '未提供' : cell.returnPct === null ? '提供 null' : cell.partial ? '未完整' : '已提供';
        add(td, 'small', mark); button.setAttribute('aria-label', `${cell.month} ${button.textContent} ${mark}`);
        row.append(td);
      }
      body.append(row);
    }
    table.append(body); scroll.append(table); root.append(scroll);
  }
  const detail = add(root, 'p', '選取月份查看輸入契約。'); detail.setAttribute('role', 'status'); detail.setAttribute('aria-live', 'polite');
  const click = event => {
    const button = event.target.closest('button[data-month]'); if (!button || !root.contains(button)) return;
    const cell = model.model.cells.find(item => item.month === button.dataset.month);
    detail.textContent = `${cell.month} · 原始百分比 ${cell.returnPct ?? 'null'} · ${cell.provided ? '已提供' : '未提供'} · partial ${cell.partial ?? '未提供'} · ${cell.from ?? '未提供起點'} → ${cell.to ?? '未提供迄點'} · ${model.calculationLabel}`;
  };
  root.addEventListener('click', click); host.replaceChildren(root);
  return { model, destroy() { root.removeEventListener('click', click); root.remove(); } };
}
