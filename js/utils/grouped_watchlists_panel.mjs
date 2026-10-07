// Caller supplies an existing symbol catalogue, storage, host and selection callback.
// Mounting does not fetch prices or write storage. Editing explicitly persists.
import { readWatchlists, saveWatchlists, updateWatchlists, normalizeWatchlists } from './grouped_watchlists.mjs';

export function mountGroupedWatchlists(host, { instruments, storage, onSelect, initialValue } = {}) {
  if (!Array.isArray(instruments) || !instruments.every(item =>
    typeof item?.key === 'string' && item.key.length > 0 && typeof item.label === 'string')
    || new Set(instruments.map(item => item.key)).size !== instruments.length) {
    throw new Error('需要唯一標的 key 與顯示名稱的既有目錄');
  }
  const allowedKeys = instruments.map(item => item.key);
  const labels = new Map(instruments.map(item => [item.key, item.label]));
  const document = host.ownerDocument;
  const root = document.createElement('section');
  root.className = 'grouped-watchlists';
  const loaded = readWatchlists(storage, allowedKeys);
  let { value, message } = loaded;
  if (initialValue !== undefined) value = normalizeWatchlists(initialValue, allowedKeys).value;
  const create = (tag, text) => {
    const element = document.createElement(tag);
    if (text !== undefined) element.textContent = text;
    return element;
  };
  const button = (text, action, groupId, symbol) => {
    const element = create('button', text);
    element.type = 'button';
    element.style.minHeight = '44px';
    if (action) element.dataset.action = action;
    if (groupId) element.dataset.groupId = groupId;
    if (symbol) element.dataset.symbol = symbol;
    return element;
  };
  const textInput = (label, initial = '') => {
    const wrapper = create('label', label);
    const input = create('input');
    input.name = 'name';
    input.type = 'text';
    input.required = true;
    input.maxLength = 80;
    input.value = initial;
    input.style.minHeight = '44px';
    wrapper.append(input);
    return wrapper;
  };
  function render(focusGroup) {
    root.replaceChildren();
    root.append(create('h3', '分組觀察清單'), create('p', '清單只記錄標的；點選交由目前頁面開啟。'));
    const status = create('p', message);
    status.setAttribute('role', 'status');
    status.setAttribute('aria-live', 'polite');
    root.append(status);
    const addGroup = create('form');
    addGroup.dataset.action = 'create';
    addGroup.append(textInput('新群組名稱 '));
    const submit = button('建立群組');
    submit.type = 'submit';
    addGroup.append(submit);
    root.append(addGroup);
    if (!value.groups.length) root.append(create('p', '尚無觀察清單群組。'));
    for (const group of value.groups) {
      const section = create('section');
      section.dataset.groupId = group.id;
      section.append(create('h4', group.name));
      const rename = create('form');
      rename.dataset.action = 'rename';
      rename.dataset.groupId = group.id;
      rename.append(textInput('群組名稱 ', group.name));
      const renameButton = button('重新命名');
      renameButton.type = 'submit';
      rename.append(renameButton);
      section.append(rename);
      const add = create('form');
      add.dataset.action = 'add';
      add.dataset.groupId = group.id;
      const label = create('label', '加入標的 ');
      const select = create('select');
      select.name = 'symbol';
      select.style.minHeight = '44px';
      for (const item of instruments.filter(item => !group.symbols.includes(item.key))) {
        const option = create('option', `${item.label} (${item.key})`);
        option.value = item.key;
        select.append(option);
      }
      const addButton = button('加入');
      addButton.type = 'submit';
      select.disabled = !select.options.length;
      addButton.disabled = select.disabled;
      label.append(select);
      add.append(label, addButton);
      section.append(add);
      if (!group.symbols.length) section.append(create('p', '此群組尚無標的。'));
      const list = create('ul');
      for (const symbol of group.symbols) {
        const row = create('li');
        const open = button(`${labels.get(symbol)} (${symbol})`, 'select', group.id, symbol);
        open.disabled = typeof onSelect !== 'function';
        const remove = button('移除', 'remove', group.id, symbol);
        remove.setAttribute('aria-label', `從 ${group.name} 移除 ${labels.get(symbol)}`);
        row.append(open, remove);
        list.append(row);
      }
      section.append(list, button(`刪除群組 ${group.name}`, 'delete', group.id));
      root.append(section);
    }
    if (focusGroup !== undefined) {
      const target = [...root.querySelectorAll('section[data-group-id]')]
        .find(section => section.dataset.groupId === focusGroup)?.querySelector('input')
        ?? root.querySelector('form[data-action="create"] input');
      target?.focus();
    }
  }
  function edit(action) {
    try {
      value = updateWatchlists(value, action, allowedKeys);
      message = loaded.canPersist ? saveWatchlists(storage, value, allowedKeys).message
        : '本次編輯僅保留於畫面；原儲存內容不改寫。';
    } catch (error) { message = error.message; }
    render(action.groupId ?? '');
  }
  function submit(event) {
    const form = event.target.closest('form[data-action]');
    if (!form || !root.contains(form)) return;
    event.preventDefault();
    edit({ type: form.dataset.action, groupId: form.dataset.groupId,
      name: form.elements.namedItem('name')?.value,
      symbol: form.elements.namedItem('symbol')?.value });
  }
  function click(event) {
    const target = event.target.closest('button[data-action]');
    if (!target || !root.contains(target)) return;
    const { action, groupId, symbol } = target.dataset;
    if (action === 'select') { onSelect?.(symbol); return; }
    if (action === 'remove' || action === 'delete') edit({ type: action, groupId, symbol });
  }
  root.addEventListener('submit', submit);
  root.addEventListener('click', click);
  render();
  host.replaceChildren(root);
  return {
    getState: () => structuredClone(value),
    destroy() {
      root.removeEventListener('submit', submit);
      root.removeEventListener('click', click);
      root.remove();
    },
  };
}
