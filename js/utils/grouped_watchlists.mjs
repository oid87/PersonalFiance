// Symbol lists only. No holdings, data requests, global state or import-time I/O.
export const WATCHLISTS_KEY = 'pf:watchlists:v1';
export const emptyWatchlists = () => ({ version: 1, groups: [] });

function groupName(name) {
  if (typeof name !== 'string' || !name.trim() || name.trim().length > 80) {
    throw new Error('群組名稱需為 1–80 個字元');
  }
  return name.trim();
}

export function normalizeWatchlists(value, allowedKeys) {
  const allowed = new Set(allowedKeys);
  if (value?.version !== 1 || !Array.isArray(value.groups)) throw new Error('觀察清單格式或版本無效');
  const ids = new Set();
  let ignoredSymbols = 0;
  const groups = value.groups.map(group => {
    if (!group || typeof group.id !== 'string' || !/^group-[1-9]\d*$/.test(group.id)
      || ids.has(group.id) || !Array.isArray(group.symbols)
      || !group.symbols.every(symbol => typeof symbol === 'string')) {
      throw new Error('觀察清單群組格式無效');
    }
    ids.add(group.id);
    const symbols = [];
    for (const symbol of group.symbols) {
      if (!allowed.has(symbol)) { ignoredSymbols++; continue; }
      if (!symbols.includes(symbol)) symbols.push(symbol);
    }
    return { id: group.id, name: groupName(group.name), symbols };
  });
  return { value: { version: 1, groups }, ignoredSymbols };
}

export function readWatchlists(storage, allowedKeys) {
  try {
    if (!storage) return { value: emptyWatchlists(), canPersist: false, message: '儲存不可用；觀察清單僅保留於本次畫面。' };
    const raw = storage.getItem(WATCHLISTS_KEY);
    if (raw === null) return { value: emptyWatchlists(), canPersist: true, message: '' };
    const normalized = normalizeWatchlists(JSON.parse(raw), allowedKeys);
    return { ...normalized, canPersist: normalized.ignoredSymbols === 0, message: normalized.ignoredSymbols
      ? `略過 ${normalized.ignoredSymbols} 個不在目前目錄的標的；本次編輯僅保留於畫面，原儲存內容不改寫。` : '' };
  } catch {
    // Reading must never erase an unreadable or future-version saved value.
    return { value: emptyWatchlists(), canPersist: false, message: '無法讀取既有清單；本次編輯僅保留於畫面，原儲存內容不改寫。' };
  }
}

export function saveWatchlists(storage, value, allowedKeys) {
  const normalized = normalizeWatchlists(value, allowedKeys).value;
  try {
    if (!storage) throw new Error('Storage unavailable');
    storage.setItem(WATCHLISTS_KEY, JSON.stringify(normalized));
    return { saved: true, message: '觀察清單已儲存在此瀏覽器。' };
  } catch {
    return { saved: false, message: '儲存失敗；目前清單仍保留於本次畫面，重新載入後可能遺失。' };
  }
}

export function updateWatchlists(value, action, allowedKeys) {
  const next = normalizeWatchlists(value, allowedKeys).value;
  const allowed = new Set(allowedKeys);
  if (action.type === 'create') {
    const used = new Set(next.groups.map(group => group.id));
    let number = 1;
    while (used.has(`group-${number}`)) number++;
    next.groups.push({ id: `group-${number}`, name: groupName(action.name), symbols: [] });
    return next;
  }
  const group = next.groups.find(item => item.id === action.groupId);
  if (!group) throw new Error('找不到觀察清單群組');
  switch (action.type) {
    case 'rename': group.name = groupName(action.name); break;
    case 'delete': next.groups = next.groups.filter(item => item.id !== group.id); break;
    case 'add':
      if (!allowed.has(action.symbol)) throw new Error('標的不在目前目錄');
      if (!group.symbols.includes(action.symbol)) group.symbols.push(action.symbol);
      break;
    case 'remove': group.symbols = group.symbols.filter(symbol => symbol !== action.symbol); break;
    default: throw new Error('未知觀察清單操作');
  }
  return next;
}
