import test from 'node:test';
import assert from 'node:assert/strict';
import { bindScreenSearchControls } from '../navigation.js';

// Small event/focus fixture: tests the production controller without browser globals.
function fixture() {
  const document = { activeElement: null, dialogs: [] };
  function events(target) {
    const listeners = new Map();
    target.addEventListener = (type, handler) => {
      if (!listeners.has(type)) listeners.set(type, []);
      listeners.get(type).push(handler);
    };
    target.emit = (type, properties = {}) => {
      const event = { target, defaultPrevented: false,
        preventDefault() { this.defaultPrevented = true; }, ...properties };
      for (const handler of listeners.get(type) || []) handler(event);
      return event;
    };
    return target;
  }
  function element(tagName = 'BUTTON', editable = false) {
    return events({ tagName, isConnected: true, isContentEditable: editable,
      attrs: {}, focus() { document.activeElement = this; },
      setAttribute(name, value) { this.attrs[name] = value; },
      closest(selector) {
        if (selector === '[hidden]') return this.hidden ? this : this.hiddenAncestor || null;
        return editable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(tagName) ? this : null;
      },
    });
  }
  events(document);
  document.querySelectorAll = selector => {
    assert.equal(selector, 'dialog[open], [role="dialog"][aria-modal="true"]');
    return document.dialogs.filter(dialog => dialog.open ||
      (dialog.attrs.role === 'dialog' && dialog.attrs['aria-modal'] === 'true'));
  };
  const dialog = element('DIALOG');
  dialog.open = false;
  dialog.shown = 0;
  dialog.closed = 0;
  dialog.showModal = () => { assert.equal(dialog.open, false); dialog.open = true; dialog.shown++; };
  dialog.close = () => { dialog.open = false; dialog.closed++; };
  document.dialogs.push(dialog);
  const search = element('INPUT');
  const openButton = element();
  openButton.textContent = '全部畫面';
  const closeButton = element();
  const origin = element();
  origin.focus();
  let prepared = 0;
  let viewportUpdates = 0;
  const closeDialog = bindScreenSearchControls({ document, dialog, search, openButton, closeButton,
    prepareDialog() { prepared++; search.value = ''; },
    updateDialogViewport() { viewportUpdates++; },
  });
  const key = properties => document.emit('keydown', {
    key: 'k', ctrlKey: true, target: document.activeElement, ...properties,
  });
  return { document, dialog, search, openButton, closeButton, origin, element, key, closeDialog,
    get prepared() { return prepared; }, get viewportUpdates() { return viewportUpdates; } };
}

test('Cmd/Ctrl+K opens the existing dialog and Escape restores the originating focus', () => {
  for (const modifiers of [{ ctrlKey: true }, { ctrlKey: false, metaKey: true }]) {
    const f = fixture();
    assert.equal(f.key(modifiers).defaultPrevented, true);
    assert.equal(f.dialog.open, true);
    assert.equal(f.document.activeElement, f.search);
    assert.equal(f.prepared, 1);
    assert.equal(f.viewportUpdates, 1);
    assert.equal(f.dialog.emit('keydown', { key: 'Escape' }).defaultPrevented, true);
    assert.equal(f.dialog.open, false);
    assert.equal(f.document.activeElement, f.origin);
  }
});

test('button opening, close button and native cancel preserve button entry and labels', () => {
  const f = fixture();
  assert.equal(f.openButton.textContent, '全部畫面');
  assert.match(f.openButton.title, /⌘K.*Ctrl\+K/);
  assert.equal(f.openButton.attrs['aria-keyshortcuts'], 'Meta+K Control+K');
  f.openButton.emit('click');
  f.closeButton.emit('click');
  assert.equal(f.document.activeElement, f.openButton);
  f.openButton.emit('click');
  assert.equal(f.dialog.emit('cancel').defaultPrevented, true);
  assert.equal(f.document.activeElement, f.openButton);
});

test('an open screen dialog is refocused without resetting query, reopening or losing its origin', () => {
  const f = fixture();
  f.key();
  f.search.value = 'GDP';
  f.closeButton.focus();
  assert.equal(f.key().defaultPrevented, true);
  assert.equal(f.document.activeElement, f.search);
  assert.equal(f.search.value, 'GDP');
  assert.equal(f.key().defaultPrevented, true); // Search input itself is allowed.
  assert.equal(f.dialog.shown, 1);
  assert.equal(f.prepared, 1);
  f.dialog.emit('keydown', { key: 'Escape' });
  assert.equal(f.document.activeElement, f.origin);
});

test('selection restores the new sub-nav and a removed origin falls back to the entry button', () => {
  const f = fixture();
  f.key();
  const newSubNav = f.element();
  f.closeDialog(newSubNav);
  assert.equal(f.document.activeElement, newSubNav);
  f.origin.focus();
  f.key();
  f.origin.isConnected = false;
  f.dialog.emit('cancel');
  assert.equal(f.document.activeElement, f.openButton);
});

test('shortcut does not consume composition, handled events, repeats or unrelated combinations', () => {
  for (const properties of [
    { isComposing: true }, { keyCode: 229 }, { defaultPrevented: true }, { repeat: true },
    { altKey: true }, { shiftKey: true }, { ctrlKey: false }, { key: '1' }, { key: 'g' },
  ]) {
    const f = fixture();
    const event = f.key(properties);
    assert.equal(f.dialog.open, false, JSON.stringify(properties));
    assert.equal(event.defaultPrevented, Boolean(properties.defaultPrevented));
  }
  const f = fixture();
  f.key();
  for (const properties of [{ isComposing: true }, { keyCode: 229 }, { defaultPrevented: true }]) {
    f.dialog.emit('keydown', { key: 'Escape', ...properties });
    assert.equal(f.dialog.open, true);
  }
});

test('editors retain their shortcuts, including retargeted events and editors in the screen dialog', () => {
  for (const [tag, editable] of [['INPUT', false], ['TEXTAREA', false], ['SELECT', false], ['SPAN', true]]) {
    const f = fixture();
    const editor = f.element(tag, editable);
    editor.focus();
    assert.equal(f.key().defaultPrevented, false);
    assert.equal(f.dialog.open, false);
    f.origin.focus();
    assert.equal(f.key({ target: editor }).defaultPrevented, false);
    assert.equal(f.key({ composedPath: () => [editor, f.origin] }).defaultPrevented, false);
    f.key();
    editor.focus();
    assert.equal(f.key().defaultPrevented, false);
    assert.equal(f.document.activeElement, editor);
    assert.equal(f.dialog.shown, 1);
  }
});

test('another open dialog retains modal ownership', () => {
  const f = fixture();
  const other = f.element('DIALOG');
  other.open = true;
  f.document.dialogs.push(other);
  assert.equal(f.key().defaultPrevented, false);
  assert.equal(f.dialog.open, false);
  other.open = false;
  assert.equal(f.key().defaultPrevented, true);
});

test('visible ARIA chart modal retains ownership; hidden modal and hidden ancestors do not block search', () => {
  const f = fixture();
  const chart = f.element('SECTION');
  chart.attrs.role = 'dialog';
  chart.attrs['aria-modal'] = 'true';
  f.document.dialogs.push(chart);
  chart.focus();
  assert.equal(f.key().defaultPrevented, false);
  assert.equal(f.dialog.open, false);
  assert.equal(f.document.activeElement, chart);
  chart.hidden = true;
  f.origin.focus();
  assert.equal(f.key().defaultPrevented, true);
  f.closeDialog();
  chart.hidden = false;
  chart.hiddenAncestor = f.element('SECTION');
  chart.hiddenAncestor.hidden = true;
  assert.equal(f.key().defaultPrevented, true);
  f.closeDialog();
  chart.hiddenAncestor = null;
  chart.attrs['aria-modal'] = 'false';
  assert.equal(f.key().defaultPrevented, true);
});
