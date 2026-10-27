import { CATEGORIES, DEFAULT_TAB, NAV_ITEMS, PAGES, itemTitle, searchNavigation } from './navigation-catalog.mjs';

const VALID_IDS = new Set(NAV_ITEMS.map(item => item.id));
const FAVORITES_KEY = 'pf:favorites:v1';

export function parseTabHash(hash) {
  try {
    const params = new URLSearchParams(String(hash || '').replace(/^#/, ''));
    const requested = params.get('tab') || DEFAULT_TAB;
    const id = VALID_IDS.has(requested) ? requested : DEFAULT_TAB;
    const rangeKey = params.get('rangeKey');
    const range = params.get('range');
    return { id, valid: id === requested, rangeKey, range };
  } catch {
    return { id: DEFAULT_TAB, valid: false, rangeKey: null, range: null };
  }
}

export function tabHash(id, range = null) {
  const params = new URLSearchParams({ tab: VALID_IDS.has(id) ? id : DEFAULT_TAB });
  if (range?.key && range?.value) {
    params.set('rangeKey', range.key);
    params.set('range', range.value);
  }
  return '#' + params.toString();
}

export function readFavorites(storage) {
  try {
    const value = JSON.parse(storage?.getItem(FAVORITES_KEY) || '[]');
    return new Set(Array.isArray(value) ? value.filter(id => VALID_IDS.has(id)) : []);
  } catch {
    return new Set();
  }
}

export function visibleDialogGeometry(viewport) {
  if (!viewport || !Number.isFinite(viewport.height) || !Number.isFinite(viewport.width) ||
      viewport.height <= 0 || viewport.width <= 0) return null;
  const width = Math.min(620, Math.max(0, viewport.width - 24));
  const height = Math.min(780, Math.max(0, viewport.height - 16));
  return {
    left: (viewport.offsetLeft || 0) + viewport.width / 2,
    top: (viewport.offsetTop || 0) + viewport.height / 2,
    width, height,
    compact: viewport.height <= 500,
  };
}

function editingTarget(target) {
  return Boolean(target?.isContentEditable ||
    target?.closest?.('input, textarea, select, [contenteditable]:not([contenteditable="false"]), [role="textbox"]'));
}

// One entry point for the existing dialog; keyboard opening must retain its origin.
export function bindScreenSearchControls({ document, dialog, search, openButton, closeButton,
  prepareDialog, updateDialogViewport }) {
  let returnFocus = openButton;

  function openDialog(origin) {
    if (!dialog.open) {
      returnFocus = origin || openButton;
      prepareDialog();
      dialog.showModal();
      updateDialogViewport();
    }
    search.focus();
  }

  function closeDialog(focusTarget = returnFocus) {
    if (!dialog.open) return;
    dialog.close();
    (focusTarget?.isConnected ? focusTarget : openButton)?.focus();
  }

  openButton.title = '全部畫面（⌘K / Ctrl+K）';
  openButton.setAttribute('aria-keyshortcuts', 'Meta+K Control+K');
  openButton.addEventListener('click', () => openDialog(openButton));
  closeButton.addEventListener('click', () => closeDialog());
  document.addEventListener('keydown', event => {
    if (event.defaultPrevented || event.isComposing || event.keyCode === 229 ||
        event.altKey || event.shiftKey || event.repeat ||
        !(event.metaKey || event.ctrlKey) || event.key?.toLowerCase() !== 'k') return;
    const targets = event.composedPath?.() || [event.target];
    const active = document.activeElement;
    // The search itself may be refocused; other editors retain their shortcuts.
    if ([...targets, active].some(target => target !== search && editingTarget(target))) return;
    const modals = document.querySelectorAll('dialog[open], [role="dialog"][aria-modal="true"]');
    if ([...modals].some(other => other !== dialog && !other.hidden && !other.closest?.('[hidden]'))) return;
    event.preventDefault();
    openDialog(active);
  });
  dialog.addEventListener('keydown', event => {
    if (event.key === 'Escape' && !event.defaultPrevented &&
        !event.isComposing && event.keyCode !== 229) {
      event.preventDefault();
      closeDialog();
    }
  });
  dialog.addEventListener('cancel', event => {
    event.preventDefault();
    closeDialog();
  });
  return closeDialog;
}

function chipRange(chip) {
  if (!chip?.classList.contains('chip')) return null;
  for (const attr of chip.attributes) {
    if (attr.name === 'data-range' || /^data-[a-z0-9-]+-range$/.test(attr.name)) {
      return { key: attr.name.slice(5), value: attr.value };
    }
  }
  return null;
}

function currentRange(section) {
  for (const chip of section?.querySelectorAll('.chip.active') || []) {
    const range = chipRange(chip);
    if (range) return range;
  }
  return null;
}

function matchingRangeChip(section, key, value) {
  if (!section || !value) return null;
  const matches = [...section.querySelectorAll('.chip')].filter(chip => {
    const range = chipRange(chip);
    return range && range.value === value && (!key || range.key === key);
  });
  return matches.length === 1 ? matches[0] : null;
}

export function initNavigation({ switchTo, needsReload = () => false, visualViewport = window.visualViewport }) {
  const categoryNav = document.getElementById('category-nav');
  const categorySelect = document.getElementById('category-select');
  const subNav = document.getElementById('sub-nav');
  const viewNav = document.getElementById('view-nav');
  const openButton = document.getElementById('all-screens-btn');
  const dialog = document.getElementById('screen-dialog');
  const closeButton = document.getElementById('screen-dialog-close');
  const search = document.getElementById('screen-search');
  const clearButton = document.getElementById('screen-search-clear');
  const resultCount = document.getElementById('screen-result-count');
  const results = document.getElementById('screen-results');
  const favoritesButton = document.getElementById('screen-favorites-only');
  const shareButton = document.getElementById('screen-share-btn');
  const shareInput = document.getElementById('screen-share-url');
  const shareStatus = document.getElementById('screen-share-status');
  const categoryByTab = new Map(NAV_ITEMS.map(item => [item.id, item.categoryId]));
  const pageByTab = new Map(NAV_ITEMS.map(item => [item.id, item.pageId]));
  const categoriesById = new Map(CATEGORIES.map(category => [category.id, category]));
  const pagesById = new Map(PAGES.map(page => [page.id, page]));
  // 回到分類時開上次看的頁，回到頁時開上次看的視圖。
  const lastPageByCategory = new Map();
  const lastTabByPage = new Map();
  let storage;
  try { storage = window.localStorage; } catch {}
  const favorites = readFavorites(storage);
  let favoritesOnly = false;
  let currentCategory = categoryByTab.get(DEFAULT_TAB);
  let currentPage = pageByTab.get(DEFAULT_TAB);
  let currentTab = DEFAULT_TAB;
  let selection = 0;
  let lastURLHash = null;

  function saveFavorites() {
    try { localStorage.setItem(FAVORITES_KEY, JSON.stringify([...favorites])); } catch {}
  }

  for (const category of CATEGORIES) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'cat-btn';
    button.dataset.cat = category.id;
    button.textContent = category.label;
    button.addEventListener('click', () => chooseCategory(category.id));
    categoryNav.append(button);

    const option = document.createElement('option');
    option.value = category.id;
    option.textContent = category.label;
    categorySelect.append(option);
  }

  function markCategory() {
    for (const button of categoryNav.querySelectorAll('.cat-btn')) {
      const selected = button.dataset.cat === currentCategory;
      button.classList.toggle('active', selected);
      if (selected) button.setAttribute('aria-current', 'true');
      else button.removeAttribute('aria-current');
    }
    categorySelect.value = currentCategory;
  }

  function renderSubNav() {
    subNav.replaceChildren();
    const pages = categoriesById.get(currentCategory).pages;
    // 只有一頁一個視圖的分類（每日總覽）不需要這一列。
    subNav.hidden = pages.length === 1 && pages[0].views.length === 1;
    for (const page of pages) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'sub-btn';
      button.dataset.page = page.id;
      button.textContent = page.label;
      button.classList.toggle('active', page.id === currentPage);
      if (page.id === currentPage) button.setAttribute('aria-current', 'page');
      button.addEventListener('click', () => {
        void selectTab(lastTabByPage.get(page.id) || page.views[0].id);
        subNav.querySelector('.sub-btn[data-page="' + page.id + '"]')?.focus();
      });
      subNav.append(button);
    }
    subNav.querySelector('.sub-btn.active')?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }

  function renderViewNav() {
    viewNav.replaceChildren();
    const views = pagesById.get(currentPage).views;
    viewNav.hidden = views.length < 2;
    if (views.length < 2) return;
    for (const tab of views) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'view-btn';
      button.dataset.tab = tab.id;
      button.textContent = tab.label;
      button.classList.toggle('active', tab.id === currentTab);
      if (tab.id === currentTab) button.setAttribute('aria-current', 'page');
      button.addEventListener('click', () => {
        void selectTab(tab.id);
        viewNav.querySelector('.view-btn[data-tab="' + tab.id + '"]')?.focus();
      });
      viewNav.append(button);
    }
    viewNav.querySelector('.view-btn.active')?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }

  // 選完畫面後焦點回到導覽：多視圖頁回切換列，單一視圖頁回子選單。
  function navButtonFor(id) {
    return viewNav.querySelector('.view-btn[data-tab="' + id + '"]') ||
      subNav.querySelector('.sub-btn[data-page="' + pageByTab.get(id) + '"]');
  }

  function setURL(id, range, mode) {
    if (mode === 'none') return;
    const hash = tabHash(id, range);
    if (window.location.hash === hash) {
      lastURLHash = hash;
      return;
    }
    const url = window.location.pathname + window.location.search + hash;
    if (mode === 'replace') window.history.replaceState(null, '', url);
    else window.history.pushState(null, '', url);
    lastURLHash = hash;
  }

  function showReloadButton() {
    if (!needsReload(currentTab)) return;
    const section = document.getElementById('tab-' + currentTab);
    const banner = section?.querySelector(':scope > .tab-load-error');
    if (!banner || banner.querySelector('.tab-reload-page')) return;
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'tab-reload-page';
    button.textContent = '重新載入頁面';
    button.addEventListener('click', () => window.location.reload());
    banner.append(' ', button);
  }

  const errorObserver = new MutationObserver(showReloadButton);
  for (const section of document.querySelectorAll('.tab-section')) {
    errorObserver.observe(section, { childList: true });
  }

  async function selectTab(id, { historyMode = 'push', range = null } = {}) {
    const categoryId = categoryByTab.get(id);
    if (!categoryId) return false;
    if (historyMode === 'push' && selection > 0 && id === currentTab) {
      historyMode = 'replace';
      range = currentRange(document.getElementById('tab-' + id));
    }
    const mySelection = ++selection;
    currentCategory = categoryId;
    currentPage = pageByTab.get(id);
    currentTab = id;
    lastPageByCategory.set(categoryId, currentPage);
    lastTabByPage.set(currentPage, id);
    markCategory();
    renderSubNav();
    renderViewNav();
    setURL(id, range, historyMode);
    const okay = await switchTo(id);
    if (mySelection !== selection) return okay;
    if (okay && range?.value) {
      const section = document.getElementById('tab-' + id);
      const chip = matchingRangeChip(section, range.key, range.value);
      if (chip && !chip.classList.contains('active')) chip.click();
    }
    if (!okay) showReloadButton();
    return okay;
  }

  function chooseCategory(id) {
    const category = categoriesById.get(id);
    if (!category) return;
    const page = pagesById.get(lastPageByCategory.get(id)) || category.pages[0];
    void selectTab(lastTabByPage.get(page.id) || page.views[0].id);
  }

  function renderResults() {
    const matches = searchNavigation(search.value).filter(item => !favoritesOnly || favorites.has(item.id));
    if (favoritesOnly && !favorites.size) resultCount.textContent = '尚未收藏畫面';
    else resultCount.textContent = matches.length ? matches.length + ' 個畫面' : '找不到符合的畫面';
    results.replaceChildren();
    for (const category of CATEGORIES) {
      const groupItems = matches.filter(item => item.categoryId === category.id);
      if (!groupItems.length) continue;
      const group = document.createElement('section');
      group.className = 'screen-result-group';
      const title = document.createElement('h3');
      title.textContent = category.label;
      group.append(title);
      for (const item of groupItems) {
        const row = document.createElement('div');
        row.className = 'screen-result-row';
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'screen-result';
        button.dataset.tab = item.id;
        button.textContent = itemTitle(item);
        button.setAttribute('aria-label', itemTitle(item) + '，' + category.label);
        button.addEventListener('click', () => {
          void selectTab(item.id);
          closeDialog(navButtonFor(item.id));
        });
        const favorite = document.createElement('button');
        favorite.type = 'button';
        favorite.className = 'screen-favorite';
        favorite.dataset.favoriteTab = item.id;
        favorite.textContent = favorites.has(item.id) ? '★' : '☆';
        favorite.setAttribute('aria-label', (favorites.has(item.id) ? '取消收藏' : '收藏') + itemTitle(item));
        favorite.setAttribute('aria-pressed', String(favorites.has(item.id)));
        favorite.addEventListener('click', () => {
          if (favorites.has(item.id)) favorites.delete(item.id);
          else favorites.add(item.id);
          saveFavorites();
          renderResults();
          const next = results.querySelector('.screen-favorite[data-favorite-tab="' + item.id + '"]');
          (next || favoritesButton).focus();
        });
        row.append(button, favorite);
        group.append(row);
      }
      results.append(group);
    }
    results.scrollTop = 0;
  }

  function updateDialogViewport() {
    if (!dialog.open) return;
    const geometry = visibleDialogGeometry(visualViewport);
    if (!geometry) return;
    dialog.style.position = 'fixed';
    dialog.style.margin = '0';
    dialog.style.transform = 'translate(-50%, -50%)';
    dialog.style.left = geometry.left + 'px';
    dialog.style.top = geometry.top + 'px';
    dialog.style.width = geometry.width + 'px';
    dialog.style.height = geometry.height + 'px';
    dialog.classList.toggle('viewport-compact', geometry.compact);
  }

  categorySelect.addEventListener('change', () => chooseCategory(categorySelect.value));
  const closeDialog = bindScreenSearchControls({
    document, dialog, search, openButton, closeButton, updateDialogViewport,
    prepareDialog() {
      search.value = '';
      shareInput.hidden = true;
      shareStatus.textContent = '';
      renderResults();
      results.scrollTop = 0;
    },
  });
  search.addEventListener('input', renderResults);
  clearButton.addEventListener('click', () => {
    search.value = '';
    renderResults();
    search.focus();
  });
  favoritesButton.addEventListener('click', () => {
    favoritesOnly = !favoritesOnly;
    favoritesButton.setAttribute('aria-pressed', String(favoritesOnly));
    renderResults();
    favoritesButton.focus();
  });
  shareButton.addEventListener('click', async () => {
    const section = document.getElementById('tab-' + currentTab);
    const url = new URL(window.location.href);
    url.hash = tabHash(currentTab, currentRange(section));
    try {
      if (!navigator.clipboard?.writeText) throw new Error('Clipboard unavailable');
      await navigator.clipboard.writeText(url.href);
      shareStatus.textContent = '已複製連結';
      shareInput.hidden = true;
    } catch {
      shareInput.value = url.href;
      shareInput.hidden = false;
      shareStatus.textContent = '請複製下方連結';
      shareInput.focus();
      shareInput.select();
    }
  });
  document.addEventListener('click', event => {
    const chip = event.target.closest?.('.chip');
    const section = document.getElementById('tab-' + currentTab);
    if (!chip || !section?.contains(chip) || !chipRange(chip)) return;
    queueMicrotask(() => {
      const selectedRange = currentRange(section);
      if (selectedRange) setURL(currentTab, selectedRange, 'replace');
    });
  });
  visualViewport?.addEventListener?.('resize', updateDialogViewport);
  visualViewport?.addEventListener?.('scroll', updateDialogViewport);

  function restoreFromURL() {
    if (window.location.hash === lastURLHash) return;
    const route = parseTabHash(window.location.hash);
    const range = route.range ? { key: route.rangeKey, value: route.range } : null;
    if (!route.valid) setURL(DEFAULT_TAB, null, 'replace');
    else lastURLHash = window.location.hash;
    void selectTab(route.id, { historyMode: 'none', range });
  }
  window.addEventListener('popstate', restoreFromURL);
  window.addEventListener('hashchange', restoreFromURL);

  markCategory();
  renderSubNav();
  renderViewNav();
  restoreFromURL();
}
