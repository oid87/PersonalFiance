#!/usr/bin/env node
'use strict';
// Two-page browser QA. See TESTING.md; importing this file does not start a browser.
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const http = require('node:http');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const ROOT = path.resolve(__dirname, '..');
const hash = value => crypto.createHash('sha256').update(value).digest('hex');
const assert = (value, message) => { if (!value) throw new Error(message); };
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.png': 'image/png', '.svg': 'image/svg+xml', '.ico': 'image/x-icon' };

// Own the server/port: a stale preview cannot accidentally pass as this checkout.
async function startServer(root) {
  const realRoot = fs.realpathSync(root);
  const server = http.createServer((req, res) => {
    try {
      if (!['GET', 'HEAD'].includes(req.method)) { res.writeHead(405); res.end(); return; }
      const relative = decodeURIComponent(req.url.split('?')[0]).replace(/^\/+/, '') || 'index.html';
      if (relative.split('/').some(p => p.startsWith('.') || p === '..') || relative.includes('\\') || relative.includes('\0')) {
        res.writeHead(403); res.end(); return;
      }
      const file = path.resolve(realRoot, relative);
      if (!file.startsWith(realRoot + path.sep) || !TYPES[path.extname(file)]) { res.writeHead(403); res.end(); return; }
      if (!fs.existsSync(file) || !fs.statSync(file).isFile()) { res.writeHead(404); res.end(); return; }
      if (!fs.realpathSync(file).startsWith(realRoot + path.sep)) { res.writeHead(403); res.end(); return; }
      const body = fs.readFileSync(file);
      res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)], 'Content-Length': body.length, 'Cache-Control': 'no-store' });
      res.end(req.method === 'HEAD' ? undefined : body);
    } catch { res.writeHead(400); res.end(); }
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  return { url: `http://127.0.0.1:${server.address().port}`, root: realRoot,
    close: () => new Promise((resolve, reject) => { server.close(error => error ? reject(error) : resolve()); server.closeAllConnections(); }) };
}
function parseArgs(args) {
  const options = { selfTestFailure: false };
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--help') options.help = true;
    else if (args[i] === '--self-test-failure') options.selfTestFailure = true;
    else if (args[i] === '--output' && args[i + 1]) options.output = path.resolve(args[++i]);
    else throw new Error(`Unknown or incomplete argument: ${args[i]}`);
  }
  return options;
}
function summarize(cases, messages) {
  const failed = cases.filter(c => c.status !== 'PASS').map(c => c.name);
  return { status: failed.length ? 'FAIL' : 'PASS', passed: cases.length - failed.length, total: cases.length,
    consoleErrors: messages.filter(m => m.type === 'error').length,
    consoleWarnings: messages.filter(m => m.type === 'warning').length,
    pageErrors: messages.filter(m => m.type === 'pageerror').length, failedScenarios: failed, exitCode: failed.length ? 1 : 0 };
}

async function run(options = {}) {
  const out = options.output || fs.mkdtempSync(path.join(os.tmpdir(), 'personal-finance-browser-smoke-'));
  if (options.output) fs.mkdirSync(out); // Refuse existing output: never overwrite another QA run.
  const report = { schemaVersion: 1, scope: ['trend', 'stressdash'], started: new Date().toISOString(),
    commands: { argv: process.argv, cwd: process.cwd(), selfTestFailure: !!options.selfTestFailure },
    sourceIdentity: { root: fs.realpathSync(ROOT), servedFiles: [], responses: [] },
    runtime: { node: process.version, os: `${os.platform()} ${os.release()}`, arch: os.arch(), headless: true, chromiumSandbox: true },
    cases: [], console: { expectedErrors: 0, expectedWarnings: 0, messages: [] }, requests: [],
    artifacts: { directory: out, report: path.join(out, 'report.json'), failures: [] },
    limitations: ['Only trend and stressdash; not the 72-page matrix.', 'Chromium emulation, not Safari, screen reader or real touch devices.',
      'CDP composition is browser-level; native macOS input-method candidate UI is not verified. Raw event trust is retained.',
      'ECharts 5.5.0 is loaded from the product CDN; network access is required. No automatic dependency/browser installation.'],
    cleanup: { browserClosed: false, serverClosed: false } };
  let server, browser, context, page, stage = 'setup', pending = [], phaseFailed = false;
  const save = () => fs.writeFileSync(report.artifacts.report, JSON.stringify(report, null, 2) + '\n');
  const frame = () => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  const chartId = tab => tab === 'trend' ? 'chart' : 'stressdash-chart';
  async function chartReady(tab) {
    await page.waitForFunction(({ tab, id }) => {
      const section = document.getElementById('tab-' + tab), c = window.echarts?.getInstanceByDom(document.getElementById(id));
      return section && !section.hidden && section.getAttribute('aria-busy') !== 'true' && c?.getWidth() > 0 && c.getHeight() > 0 && c.getOption()?.series?.length;
    }, { tab, id: chartId(tab) }, { timeout: 20000 });
    await frame();
  }
  async function snap(id) {
    const value = await page.evaluate(id => {
      const host = document.getElementById(id), c = echarts.getInstanceByDom(host), o = c.getOption();
      return { id: c.id, width: c.getWidth(), height: c.getHeight(), hostWidth: host.clientWidth, hostHeight: host.clientHeight,
        zoom: (o.dataZoom || []).map(z => ({ start: z.start, end: z.end, startValue: z.startValue, endValue: z.endValue })),
        legend: (o.legend || []).map(l => l.selected),
        financial: { series: (o.series || []).map(s => ({ name: s.name, type: s.type, data: s.data, xAxisIndex: s.xAxisIndex, yAxisIndex: s.yAxisIndex, markLine: s.markLine?.data, markArea: s.markArea?.data })),
          xAxis: (o.xAxis || []).map(a => ({ type: a.type, data: a.data, name: a.name, min: a.min, max: a.max })),
          yAxis: (o.yAxis || []).map(a => ({ type: a.type, name: a.name, min: a.min, max: a.max })) } };
    }, id);
    value.financialHash = hash(JSON.stringify(value.financial)); delete value.financial; return value;
  }
  const cleanState = () => page.evaluate(() => ({ focusSections: document.querySelectorAll('.chart-focus-section').length,
    inert: [...document.querySelectorAll('[inert]')].map(e => e.id || e.tagName), overflow: document.body.style.overflow,
    roleDialogs: document.querySelectorAll('.tab-section[aria-modal="true"]').length, hash: location.hash,
    scroll: { x: scrollX, y: scrollY }, active: document.activeElement?.getAttribute('aria-label'),
    sectionAttrs: ['trend', 'stressdash'].map(id => { const e = document.getElementById('tab-' + id); return { id, role: e.getAttribute('role'), modal: e.getAttribute('aria-modal'), label: e.getAttribute('aria-label') }; }) }));
  const noResidue = state => assert(state.focusSections === 0 && !state.inert.length && state.overflow === '' && state.roleDialogs === 0, 'Focus/inert/body/dialog state residue');
  async function failEvidence(name) {
    phaseFailed = true;
    const stem = `${String(report.cases.length).padStart(2, '0')}-${name.replace(/[^a-z0-9]+/gi, '-').slice(0, 70)}`;
    const artifact = { name };
    if (page && !page.isClosed()) {
      try { artifact.screenshot = path.join(out, stem + '.png'); await page.screenshot({ path: artifact.screenshot, fullPage: true, timeout: 7000 }); }
      catch (error) { artifact.screenshotError = error.message; }
      try {
        artifact.state = path.join(out, stem + '.json');
        const state = await page.evaluate(() => ({ url: location.href, activeElement: document.activeElement?.outerHTML,
          bodyOverflow: document.body.style.overflow, inert: [...document.querySelectorAll('[inert]')].map(e => e.outerHTML.slice(0, 250)),
          dialogs: [...document.querySelectorAll('dialog[open], [aria-modal="true"]')].map(e => e.outerHTML.slice(0, 500)),
          text: document.body.innerText, keyboard: window.__smokeKeys, composition: window.__imeEvidence,
          charts: [...document.querySelectorAll('[_echarts_instance_]')].map(e => ({ id: e.id, width: e.clientWidth, height: e.clientHeight, option: window.echarts?.getInstanceByDom(e)?.getOption() })) }));
        fs.writeFileSync(artifact.state, JSON.stringify(state, null, 2) + '\n');
      } catch (error) { artifact.stateError = error.message; }
    }
    report.artifacts.failures.push(artifact);
  }
  async function test(name, action) {
    stage = name;
    try { report.cases.push({ name, status: 'PASS', evidence: await action() }); console.log('PASS ' + name); }
    catch (error) { report.cases.push({ name, status: 'FAIL', reason: error.message, stack: error.stack }); console.log('FAIL ' + name + ': ' + error.message); await failEvidence(name); }
    save();
  }
  const searchOpen = () => page.locator('#screen-dialog').evaluate(e => e.open);
  const shortcuts = ['Meta+k', 'Control+k'];
  function guardCases() {
    return [
      ...shortcuts.map(key => [key + ' search and Escape focus restore', async () => {
        await page.locator('#all-screens-btn').focus(); await page.keyboard.press(key);
        assert(await searchOpen(), 'Search did not open');
        assert(await page.evaluate(() => document.activeElement.id) === 'screen-search', 'Search input not focused');
        await page.locator('#screen-search').fill('趨勢'); await page.keyboard.press(key);
        assert(await page.locator('#screen-search').inputValue() === '趨勢', 'Repeated shortcut reset query');
        await page.keyboard.press('Escape'); assert(!await searchOpen(), 'Search did not close');
        assert(await page.evaluate(() => document.activeElement.id) === 'all-screens-btn', 'Origin focus not restored'); return { key };
      }]),
      ...['input', 'textarea'].map(kind => [kind + ' editor shortcut guard', async () => {
        const id = kind === 'input' ? 'custom-ticker-input' : 'smoke-textarea';
        if (kind === 'textarea') await page.evaluate(() => { const t = document.createElement('textarea'); t.id = 'smoke-textarea'; document.getElementById('tab-trend').prepend(t); });
        try { for (const key of shortcuts) { await page.locator('#' + id).focus(); await page.keyboard.press(key); assert(!await searchOpen(), id + ' triggered search'); } }
        finally { if (kind === 'textarea') await page.evaluate(() => document.getElementById('smoke-textarea')?.remove()); }
        return { keys: shortcuts, fixture: kind === 'textarea' ? 'temporary DOM textarea; no product mutation' : 'original ticker input' };
      }]),
      ...[{ isComposing: true, keyCode: 75 }, { isComposing: false, keyCode: 229 }].map(properties => ['independent synthetic ' + (properties.isComposing ? 'isComposing' : 'keyCode 229') + ' guard', async () => {
        await page.locator('#all-screens-btn').focus();
        const events = await page.evaluate(properties => ['metaKey', 'ctrlKey'].map(modifier => {
          const e = new KeyboardEvent('keydown', { key: 'k', bubbles: true, cancelable: true, ...properties, [modifier]: true });
          document.activeElement.dispatchEvent(e);
          return { modifier, isComposing: e.isComposing, keyCode: e.keyCode, isTrusted: e.isTrusted, defaultPrevented: e.defaultPrevented, searchOpen: document.getElementById('screen-dialog').open };
        }), properties);
        assert(events.every(e => !e.isTrusted && !e.defaultPrevented && !e.searchOpen), 'Synthetic guard failed'); return events;
      }]),
      ['other native dialog shortcut guard', async () => {
        await page.evaluate(() => { const d = document.createElement('dialog'); d.id = 'smoke-dialog'; const b = document.createElement('button'); b.textContent = 'Test modal'; d.append(b); document.body.append(d); d.showModal(); b.focus(); });
        try {
          for (const key of shortcuts) { await page.keyboard.press(key); assert(await page.evaluate(() => document.getElementById('smoke-dialog').open && document.getElementById('smoke-dialog').contains(document.activeElement)) && !await searchOpen(), 'Shortcut conflicted with other dialog'); }
          await page.keyboard.press('Escape'); assert(!await page.locator('#smoke-dialog').evaluate(e => e.open), 'Native dialog Escape failed');
        } finally { await page.evaluate(() => document.getElementById('smoke-dialog')?.remove()); }
        return { keys: shortcuts, fixture: 'temporary native dialog' };
      }],
    ];
  }
  function imeCases() {
    let session;
    const observed = () => page.evaluate(() => ({ ...window.__imeEvidence, value: document.getElementById('custom-ticker-input').value, focused: document.activeElement.id, searchOpen: document.getElementById('screen-dialog').open }));
    return shortcuts.flatMap(key => [
      ['CDP composing ' + key + ' guard', async () => {
        if (!session) {
          session = await context.newCDPSession(page);
          await page.evaluate(() => { window.__imeEvidence = { active: false, events: [] };
            for (const type of ['compositionstart', 'compositionupdate', 'compositionend', 'beforeinput', 'input', 'keydown', 'keyup']) document.addEventListener(type, e => {
              const state = window.__imeEvidence; if (type === 'compositionstart') state.active = true; if (type === 'compositionend') state.active = false;
              state.events.push({ type, target: e.target.id, isTrusted: e.isTrusted, isComposing: typeof e.isComposing === 'boolean' ? e.isComposing : null,
                key: e.key ?? null, keyCode: e.keyCode ?? null, metaKey: e.metaKey ?? null, ctrlKey: e.ctrlKey ?? null, data: e.data ?? null, inputType: e.inputType ?? null,
                compositionActive: state.active, searchOpen: document.getElementById('screen-dialog').open });
            }, true);
          });
        }
        await page.locator('#custom-ticker-input').fill(''); await page.locator('#custom-ticker-input').focus(); const prior = await observed();
        await session.send('Input.imeSetComposition', { text: '測試', selectionStart: 0, selectionEnd: 2 }); const begun = await observed(), events = begun.events.slice(prior.events.length);
        assert(begun.active && begun.value === '測試', 'Browser composition did not start');
        assert(events.some(e => e.type === 'compositionstart' && e.isTrusted) && events.some(e => e.type === 'input' && e.isTrusted && e.isComposing), 'No trusted composing lifecycle');
        await page.keyboard.press(key); const after = await observed(), keys = after.events.slice(begun.events.length);
        assert(keys.some(e => e.type === 'keydown' && e.key?.toLowerCase() === 'k' && e.isTrusted && e.isComposing && e.compositionActive), 'No trusted composing shortcut key');
        assert(!after.searchOpen && keys.every(e => !e.searchOpen), 'Search opened during composition'); return { begun, after, keys };
      }],
      ['CDP commit and ' + key + ' recovery outside editor', async () => {
        assert(session, 'Composition setup failed');
        // Ctrl+K may perform the platform editor command. Start composition again
        // before explicit commit; never alter event isTrusted/isComposing values.
        await session.send('Input.imeSetComposition', { text: '測試', selectionStart: 0, selectionEnd: 2 }); const prior = await observed();
        await session.send('Input.insertText', { text: '測試' }); const ended = await observed(), endEvents = ended.events.slice(prior.events.length);
        assert(!ended.active && endEvents.some(e => e.type === 'compositionend'), 'Composition did not end');
        await page.locator('#all-screens-btn').focus(); const before = await observed(); await page.keyboard.press(key); const opened = await observed(), keys = opened.events.slice(before.events.length);
        assert(opened.searchOpen && opened.focused === 'screen-search', 'Shortcut did not recover outside editor');
        assert(keys.some(e => e.type === 'keydown' && e.key?.toLowerCase() === 'k' && e.isTrusted && !e.isComposing && !e.compositionActive), 'Post-composition key not restored');
        await page.keyboard.press('Escape'); assert(!await searchOpen(), 'Search did not close'); return { endEvents, keys, compositionEndTrust: endEvents.filter(e => e.type === 'compositionend').map(e => e.isTrusted) };
      }],
    ]);
  }
  async function geometry(tab, columns) {
    const layout = await page.evaluate(({ tab, id }) => {
      const rect = e => { const r = e.getBoundingClientRect(); return { x: r.x, y: r.y, right: r.right, bottom: r.bottom, width: r.width, height: r.height }; };
      const host = document.getElementById(id);
      return { viewport: { width: innerWidth, height: innerHeight }, documentWidth: document.documentElement.scrollWidth, bodyWidth: document.body.scrollWidth,
        host: { rect: rect(host), clientWidth: host.clientWidth, scrollWidth: host.scrollWidth, clientHeight: host.clientHeight, scrollHeight: host.scrollHeight },
        cards: tab === 'stressdash' ? [...document.querySelectorAll('#stressdash-top > .breadth-card')].map(e => ({ rect: rect(e), clientWidth: e.clientWidth, scrollWidth: e.scrollWidth, clientHeight: e.clientHeight, scrollHeight: e.scrollHeight,
          children: [...e.children].map(c => ({ rect: rect(c), clientWidth: c.clientWidth, scrollWidth: c.scrollWidth, clientHeight: c.clientHeight, scrollHeight: c.scrollHeight })) })) : [] };
    }, { tab, id: chartId(tab) });
    assert(layout.documentWidth <= layout.viewport.width + 1 && layout.bodyWidth <= layout.viewport.width + 1, 'Document horizontal overflow');
    const host = layout.host;
    assert(host.rect.x >= -1 && host.rect.right <= layout.viewport.width + 1 && host.scrollWidth <= host.clientWidth + 1 && host.scrollHeight <= host.clientHeight + 1, 'Chart host overflow/clipping');
    const s = await snap(chartId(tab)); assert(s.width === s.hostWidth && s.height === s.hostHeight, 'Canvas/host dimensions differ');
    if (columns) {
      assert(layout.cards.length === 3, 'Expected three summary cards');
      for (const c of layout.cards) {
        assert(c.rect.x >= -1 && c.rect.right <= layout.viewport.width + 1 && c.scrollWidth <= c.clientWidth + 1 && c.scrollHeight <= c.clientHeight + 1, 'Card overflow/clipping');
        for (const child of c.children) assert(child.rect.x >= c.rect.x - 1 && child.rect.right <= c.rect.right + 1 && child.rect.bottom <= c.rect.bottom + 1 && child.scrollWidth <= child.clientWidth + 1 && child.scrollHeight <= child.clientHeight + 1, 'Card child overflow/clipping');
      }
      if (columns === 3) assert(layout.cards.every(c => Math.abs(c.rect.y - layout.cards[0].rect.y) < 1 && Math.abs(c.rect.width - layout.cards[0].rect.width) < 1), 'Cards are not equal desktop columns');
      else assert(layout.cards.every(c => Math.abs(c.rect.x - layout.cards[0].rect.x) < 1) && layout.cards[1].rect.y >= layout.cards[0].rect.bottom && layout.cards[2].rect.y >= layout.cards[1].rect.bottom, 'Cards are not one mobile column');
    }
    return layout;
  }
  function chartCases(tab) {
    const id = chartId(tab), label = tab === 'trend' ? '趨勢圖表' : '金融壓力圖表', other = tab === 'trend' ? 'stressdash' : 'trend';
    const button = () => page.getByRole('button', { name: label + '：放大或還原' });
    let before, base, changed;
    return [
      [tab + ' focus instance/data/state/dimensions', async () => {
        await button().scrollIntoViewIfNeeded(); before = await snap(id); base = await cleanState(); await button().click(); await frame(); const focused = await snap(id);
        assert(await page.locator('#tab-' + tab).getAttribute('aria-modal') === 'true', 'Focus dialog semantics absent');
        assert(before.id === focused.id && before.financialHash === focused.financialHash && same(before.zoom, focused.zoom) && same(before.legend, focused.legend), 'Focus recreated chart or reset financial/state data');
        assert(focused.height > before.height, 'Focus height did not grow'); await geometry(tab); return { before, focused, base };
      }],
      [tab + ' focus dialog shortcut ownership', async () => {
        assert(await button().getAttribute('aria-expanded') === 'true', 'Focus setup failed');
        for (const key of shortcuts) { await page.keyboard.press(key); assert(!await searchOpen(), 'Search opened over focus dialog'); } return { keys: shortcuts };
      }],
      [tab + ' actual mouse zoom and legend', async () => {
        const prior = await snap(id), rect = await page.locator('#' + id).boundingBox();
        assert(await button().getAttribute('aria-expanded') === 'true', 'Focus setup failed');
        if (tab === 'trend') {
          const handle = await page.evaluate(id => { const c = echarts.getInstanceByDom(document.getElementById(id)), m = c.getModel().getComponent('dataZoom', 1), v = c._componentsViews.find(v => v.__model === m), e = v?._displayables?.handles?.[0]; if (!e) return null; const b = e.getBoundingRect(), p = e.transformCoordToGlobal(b.x + b.width / 2, b.y + b.height / 2); return { x: p[0], y: p[1] }; }, id);
          assert(handle, 'Rendered slider handle absent'); await page.mouse.move(rect.x + handle.x, rect.y + handle.y); await page.mouse.down();
          await page.mouse.move(rect.x + handle.x + rect.width * 0.22, rect.y + handle.y, { steps: 15 }); await page.mouse.up();
        } else { await page.mouse.move(rect.x + rect.width * 0.55, rect.y + rect.height * 0.27); await page.mouse.wheel(0, -300); }
        await page.waitForFunction(({ id, old }) => JSON.stringify(echarts.getInstanceByDom(document.getElementById(id)).getOption().dataZoom.map(z => ({ start: z.start, end: z.end, startValue: z.startValue, endValue: z.endValue }))) !== old,
          { id, old: JSON.stringify(prior.zoom) }, { timeout: 4000 }); await frame();
        const point = await page.evaluate(({ id, text }) => { const host = document.getElementById(id), c = echarts.getInstanceByDom(host), r = host.getBoundingClientRect();
          const points = c.getZr().storage.getDisplayList().filter(e => e.type === 'tspan' && e.style?.text === text).map(e => { const b = e.getBoundingRect(); return e.transformCoordToGlobal(b.x + b.width / 2, b.y + b.height / 2); }).sort((a, b) => a[1] - b[1]);
          const p = points.find(p => p[1] < 40); return p ? { x: r.x + p[0], y: r.y + p[1], text } : null;
        }, { id, text: tab === 'trend' ? 'QQQ' : 'SPY' });
        assert(point, 'Rendered primary legend absent'); await page.mouse.click(point.x, point.y); await frame(); changed = await snap(id);
        assert(!same(prior.legend, changed.legend), 'Legend click did not change state'); assert(prior.financialHash === changed.financialHash, 'Financial data changed during zoom/legend'); return { prior, changed, point };
      }],
      [tab + ' Escape restores focus/scroll/ARIA/state', async () => {
        assert(base, 'Focus baseline absent'); const prior = changed || await snap(id); await page.keyboard.press('Escape'); await frame(); const restored = await snap(id), cleanup = await cleanState(); noResidue(cleanup);
        assert(prior.id === restored.id && prior.financialHash === restored.financialHash && same(prior.zoom, restored.zoom) && same(prior.legend, restored.legend), 'Restore changed chart/data/zoom/legend');
        assert(same(base.sectionAttrs, cleanup.sectionAttrs), 'Section ARIA attributes not restored'); assert(same(base.scroll, cleanup.scroll), 'Scroll position not restored');
        assert(cleanup.active === label + '：放大或還原', 'Return focus not restored'); await geometry(tab); return { restored, cleanup };
      }],
      [tab + ' same-document route change focus cleanup', async () => {
        await button().click(); await frame(); assert(await button().getAttribute('aria-expanded') === 'true', 'Focus setup failed');
        await page.evaluate(tab => { location.hash = '#tab=' + tab; }, other); await chartReady(other); const cleanup = await cleanState(); noResidue(cleanup);
        assert(same(base.sectionAttrs, cleanup.sectionAttrs), 'Route cleanup did not restore ARIA'); return { cleanup, operation: 'same-document hash route' };
      }],
    ];
  }
  function ma150Cases(label) {
    let base, changed;
    const pick = v => page.locator('#ma-select').selectOption(String(v));
    const maState = () => page.evaluate(() => {
      const c = echarts.getInstanceByDom(document.getElementById('chart')), o = c.getOption();
      return { selected: o.series.filter(s => s.name.startsWith('__ma_QQQ_')).map(s => +s.name.split('_').pop()),
        select: document.getElementById('ma-select').value, customHidden: document.getElementById('ma-custom').hidden,
        names: o.series.map(s => s.name), legendData: o.legend[0].data,
        nonMA: o.series.filter(s => !s.name.startsWith('__ma_')).map(s => ({ name: s.name, data: s.data })),
        signal: document.getElementById('signal-panel').innerText };
    });
    const maOracle = n => page.evaluate(async n => {
      const { loaded } = await import('/js/state.js');
      const input = loaded.QQQ, c = echarts.getInstanceByDom(document.getElementById('chart'));
      const ma = c.getOption().series.find(s => s.name === '__ma_QQQ_' + n);
      const expected = new Map(input.slice(n - 1).map((row, i) => [row[0], +(input.slice(i, i + n).reduce((sum, r) => sum + r[1], 0) / n).toFixed(4)]));
      return { count: ma?.data.length, correct: !!ma?.data.length && ma.data.every(([date, value]) => expected.get(date) === value) };
    }, n);
    return [
      [label + ' MA select default OFF and existing defaults', async () => {
        base = await maState();
        assert(same(await page.locator('#ma-select option').evaluateAll(es => es.map(e => e.value)), ['', '20', '50', '100', '125', '150', '200', '300', 'custom']), 'Unexpected MA options');
        assert(!base.selected.length && !base.names.some(n => n.startsWith('__ma_')) && base.customHidden, 'MA default changed');
        return { ...base, nonMA: hash(JSON.stringify(base.nonMA)) };
      }],
      [label + ' MA single-select presets, custom period and no duplicate/state leak', async () => {
        assert(base, 'Default baseline missing');
        await pick(150); await frame();
        const oracle = await maOracle(150);
        assert(oracle.correct, 'Rendered MA150 differs from independent full-history oracle');
        await pick(20); await frame();
        assert(same((await maState()).selected, [20]), 'Select is not single-choice');
        await pick(''); await frame();
        assert(!(await maState()).names.some(n => n.startsWith('__ma_')), 'MA did not disappear');
        await pick('custom'); await frame();
        assert(!(await maState()).customHidden, 'Custom input not shown');
        await page.locator('#ma-custom').fill('37'); await page.locator('#ma-custom').press('Enter'); await frame();
        const custom = await maOracle(37);
        assert(custom.correct && same((await maState()).selected, [37]), 'Custom MA37 wrong');
        for (let i = 0; i < 6; i++) { await pick(i % 2 ? 150 : 200); await frame(); const s = await maState();
          assert(new Set(s.names).size === s.names.length, 'Duplicate series');
          assert(same(s.selected, [i % 2 ? 150 : 200]), 'Selection state leaked');
          assert(same(s.nonMA, base.nonMA) && s.signal === base.signal, 'Non-MA series or fixed signals changed');
          assert(!s.legendData.some(n => n.startsWith('__ma_')), 'Existing hidden MA legend policy changed');
        }
        return { oracle, custom, nonMAUnchanged: true, signalsUnchanged: true };
      }],
      [label + ' MA change preserves zoom and legend', async () => {
        await page.evaluate(() => { const c = echarts.getInstanceByDom(document.getElementById('chart')); c.dispatchAction({ type: 'dataZoom', start: 24, end: 83 }); c.dispatchAction({ type: 'legendUnSelect', name: 'QQQ' }); });
        await frame(); changed = await snap('chart');
        await pick(200); await frame(); const after = await snap('chart');
        assert(same(changed.zoom, after.zoom) && same(changed.legend, after.legend), 'MA change reset zoom/legend');
        assert(same((await maState()).selected, [200]), 'Select did not apply');
        return { before: changed, after };
      }],
      [label + ' MA controls fit on one row and chart remains usable', async () => {
        const result = await geometry('trend');
        const controls = await page.locator('#ma-picker').evaluate(host => {
          const rect = e => { const r = e.getBoundingClientRect(); return { left: r.left, right: r.right, top: r.top, bottom: r.bottom, width: r.width, height: r.height }; };
          return { rect: rect(host), scrollWidth: host.scrollWidth, clientWidth: host.clientWidth,
            items: [...host.children].filter(e => !e.hidden).map(rect), viewport: innerWidth };
        });
        assert(controls.scrollWidth <= controls.clientWidth + 1 && controls.rect.left >= -1, 'MA control overflow/clipping');
        assert(controls.rect.height <= 50, 'MA control wraps onto several rows');
        for (let i = 0; i < controls.items.length; i++) {
          const a = controls.items[i]; assert(a.left >= controls.rect.left - 1 && a.right <= controls.rect.right + 1 && a.top >= controls.rect.top - 1 && a.bottom <= controls.rect.bottom + 1, 'MA control clipped');
          for (const b of controls.items.slice(i + 1)) assert(a.right <= b.left + 1 || b.right <= a.left + 1 || a.bottom <= b.top + 1 || b.bottom <= a.top + 1, 'MA controls overlap');
        }
        assert(result.host.rect.height >= 200, 'Chart viewport unreasonably compressed');
        return { controls, chart: result.host };
      }],
      [label + ' MA route re-entry and theme keep selection', async () => {
        const before = await maState();
        await page.evaluate(() => { location.hash = '#tab=stressdash'; }); await chartReady('stressdash');
        await page.evaluate(() => { location.hash = '#tab=trend'; }); await chartReady('trend');
        assert(same(await maState(), before), 'Same-document return lost selections/data/signals');
        await page.locator('#theme-btn').click(); await frame();
        assert(same(await maState(), before), 'Theme lost selections/data/signals');
        await page.locator('#theme-btn').click(); await frame();
        return { selected: before.selected, nonMAUnchanged: true, signalsUnchanged: true };
      }],
    ];
  }
  const phases = [
    { name: 'guards', tab: 'trend', cases: guardCases() },
    { name: 'ime', tab: 'trend', cases: imeCases() },
    { name: 'desktop-trend', tab: 'trend', cases: [['desktop trend overflow/clipping', () => geometry('trend')], ...ma150Cases('desktop'), ...chartCases('trend')] },
    { name: 'desktop-stress', tab: 'stressdash', cases: [['desktop stress three columns and clipping', () => geometry('stressdash', 3)], ...chartCases('stressdash')] },
    { name: 'mobile', tab: 'stressdash', mobile: true, cases: [
      ['390px stress single column and clipping', () => geometry('stressdash', 1)],
      ['390px stress focus/Escape dimensions', async () => { const b = page.getByRole('button', { name: '金融壓力圖表：放大或還原' }); await b.click(); await frame(); const focused = await geometry('stressdash'); await page.keyboard.press('Escape'); await frame(); noResidue(await cleanState()); return { focused, restored: await geometry('stressdash', 1) }; }],
      ['390px trend overflow/clipping', async () => { await page.evaluate(() => { location.hash = '#tab=trend'; }); await chartReady('trend'); return geometry('trend'); }],
      ...ma150Cases('390px'),
      ['390px trend focus/Escape dimensions', async () => { const b = page.getByRole('button', { name: '趨勢圖表：放大或還原' }); await b.click(); await frame(); const focused = await geometry('trend'); await page.keyboard.press('Escape'); await frame(); noResidue(await cleanState()); return { focused, restored: await geometry('trend') }; }],
    ] },
  ];
  const fpeFixtures = JSON.parse(fs.readFileSync(path.join(ROOT, 'js/__tests__/fixtures/trend-fpe-endpoints.json'), 'utf8'));
  function fpeCases(label, mixed) {
    let before, focused;
    const seriesState = () => page.evaluate(() => {
      const c = echarts.getInstanceByDom(document.getElementById('chart')), o = c.getOption();
      const fpe = o.series.find(s => s.name === 'QQQ FPE');
      return { fpe: fpe && { data: fpe.data, connectNulls: fpe.connectNulls },
        nonFPE: o.series.filter(s => s.name !== 'QQQ FPE').map(s => ({ name: s.name, data: s.data, markArea: s.markArea, markLine: s.markLine })),
        selectedMA: o.series.filter(s => s.name.startsWith('__ma_QQQ_')).map(s => +s.name.split('_').pop()) };
    });
    async function hover(date) {
      await page.evaluate(date => {
        const c = echarts.getInstanceByDom(document.getElementById('chart'));
        const x = c.convertToPixel({ xAxisIndex: 0 }, new Date(date + 'T00:00:00Z').getTime());
        const y = c.getHeight() * 0.4;
        c.dispatchAction({ type: 'showTip', x, y });
      }, date); await frame();
      return page.evaluate(() => {
        const host = document.getElementById('chart');
        const tooltip = [...host.querySelectorAll('div')].find(e => { const style = getComputedStyle(e); return style.position === 'absolute' && style.visibility === 'visible' && e.innerText.includes('QQQ'); });
        return tooltip?.innerText || '';
      });
    }
    return [
      [label + ' FPE actual series/endpoint fixtures and non-FPE regression', async () => {
        await page.locator('#date-from').fill('2024-01-01'); await page.locator('#date-from').dispatchEvent('change');
        await page.locator('#date-to').fill('2024-02-25'); await page.locator('#date-to').dispatchEvent('change');
        await page.locator('#ma-select').selectOption('150');
        before = await seriesState();
        const signals = await page.evaluate(async () => { const t = await import('/js/tabs/trend.js'); t.renderSignalPanel(); return document.getElementById('signal-panel').innerText; });
        await page.locator('#trend-fpe-toggle').click(); await page.waitForFunction(() => echarts.getInstanceByDom(document.getElementById('chart')).getOption().series.some(s => s.name === 'QQQ FPE')); await frame();
        const actual = await seriesState(); assert(actual.fpe?.connectNulls === false, 'FPE connectNulls must be false');
        assert(same(actual.nonFPE, before.nonFPE) && same(actual.selectedMA, [150]), 'FPE changed other series or MA selection');
        const signalAfter = await page.evaluate(async () => { const t = await import('/js/tabs/trend.js'); t.renderSignalPanel(); return document.getElementById('signal-panel').innerText; });
        assert(signalAfter === signals, 'Fixed MA200/signals changed');
        if (!mixed) assert(same(actual.fpe.data, [['2024-01-02', 20.001], ['2024-01-03', 21.042], ['2024-01-04', 22.083], ['2024-01-05', 23.1234]]), 'Complete valid fixture changed original UTC/rounding results');
        else {
          const byDate = new Map(actual.fpe.data);
          for (const d of ['2024-01-05', '2024-01-08', '2024-01-09', '2024-01-15', '2024-01-16', '2024-01-17', '2024-01-23', '2024-01-24', '2024-01-25', '2024-02-08', '2024-02-09', '2024-02-14', '2024-02-15', '2024-02-20', '2024-02-21']) assert(byDate.get(d) === null, 'Invalid endpoint interval is not null: ' + d);
          assert(byDate.get('2024-01-10') === 24 && byDate.get('2024-01-18') === 26 && byDate.get('2024-02-01') === -3 && byDate.get('2024-02-05') === -6, 'Valid/negative observations lost');
          assert(actual.fpe.data.every(([, v]) => v === null || typeof v === 'number' && Number.isFinite(v)), 'Malformed/nonfinite series values');
        }
        return { actualFPE: actual.fpe, otherSeriesHash: hash(JSON.stringify(actual.nonFPE)), fixedSignalsUnchanged: true, selectedMA: actual.selectedMA };
      }],
      [label + ' FPE rendered polyline breaks and actual hover', async () => {
        const pathEvidence = await page.evaluate(() => {
          const c = echarts.getInstanceByDom(document.getElementById('chart')), model = c.getModel().getSeriesByName('QQQ FPE')[0];
          const view = c._chartsViews.find(v => v.__model === model), line = view?._polyline;
          if (!line) return null;
          const commands = [];
          line.buildPath({ moveTo(x, y) { commands.push(['M', x, y]); }, lineTo(x, y) { commands.push(['L', x, y]); }, bezierCurveTo(...args) { commands.push(['C', ...args]); } }, line.shape);
          return { commands, connectNulls: line.shape.connectNulls, renderedPoints: [...line.shape.points] };
        });
        assert(pathEvidence && pathEvidence.commands.some(c => c[0] === 'L'), 'No rendered FPE stroke');
        const moves = pathEvidence.commands.filter(c => c[0] === 'M').length;
        assert(mixed ? moves > 1 : moves === 1, 'Rendered FPE path failed segment policy');
        const validTip = await hover(mixed ? '2024-01-11' : '2024-01-03');
        assert(validTip.includes('QQQ FPE') && validTip.includes(mixed ? '24.5' : '21.042'), 'Valid hover value absent: ' + validTip);
        const missingTips = [];
        if (mixed) for (const date of ['2024-01-05', '2024-01-16', '2024-01-24', '2024-02-09', '2024-02-15', '2024-02-21']) {
          const tip = await hover(date); assert(tip.includes(date), 'Hover did not target gap date: ' + date + ': ' + tip);
          assert(!/QQQ FPE:\s*(?!—)[\d-]/.test(tip), 'Fabricated FPE hover in gap: ' + tip); missingTips.push({ date, text: tip });
        }
        await page.screenshot({ path: path.join(out, label.replace(/[^a-z0-9]/gi, '-') + '-fpe.png'), fullPage: true });
        await page.evaluate(() => echarts.getInstanceByDom(document.getElementById('chart')).dispatchAction({ type: 'hideTip' }));
        return { pathEvidence, moves, validTip, missingTips };
      }],
      [label + ' FPE zoom/legend/focus/Escape and viewport', async () => {
        await page.evaluate(() => { const c = echarts.getInstanceByDom(document.getElementById('chart')); c.dispatchAction({ type: 'dataZoom', start: 5, end: 95 }); c.dispatchAction({ type: 'legendUnSelect', name: 'QQQ FPE' }); });
        await frame(); const prior = await snap('chart');
        const b = page.getByRole('button', { name: '趨勢圖表：放大或還原' }); await b.click(); await frame(); focused = await snap('chart');
        assert(prior.id === focused.id && prior.financialHash === focused.financialHash && same(prior.zoom, focused.zoom) && same(prior.legend, focused.legend), 'FPE focus changed state/data');
        await geometry('trend'); await page.keyboard.press('Escape'); await frame(); const restored = await snap('chart');
        assert(focused.id === restored.id && focused.financialHash === restored.financialHash && same(focused.zoom, restored.zoom) && same(focused.legend, restored.legend), 'FPE Escape changed state/data');
        noResidue(await cleanState()); await geometry('trend');
        return { prior, focused, restored };
      }],
      [label + ' FPE route/theme/toggle preserve series and fixed signals', async () => {
        const original = await seriesState();
        await page.evaluate(() => { location.hash = '#tab=stressdash'; }); await chartReady('stressdash');
        await page.evaluate(() => { location.hash = '#tab=trend'; }); await chartReady('trend');
        assert(same(await seriesState(), original), 'FPE route return changed series');
        await page.locator('#theme-btn').click(); await frame(); assert(same(await seriesState(), original), 'FPE theme changed series');
        await page.locator('#theme-btn').click(); await frame();
        for (let i = 0; i < 4; i++) { await page.locator('#trend-fpe-toggle').click(); await frame(); const now = await seriesState();
          assert((!!now.fpe) === (i % 2 === 1), 'FPE toggle state leaked');
          assert(same(now.nonFPE, before.nonFPE) && same(now.selectedMA, [150]), 'FPE toggle changed other series');
        }
        assert(same(await seriesState(), original), 'Repeated FPE toggle changed series');
        return { preserved: true, selectedMA: original.selectedMA };
      }],
    ];
  }
  phases.push(
    { name: 'fpe-valid', tab: 'trend', fpeFixture: fpeFixtures.valid, cases: fpeCases('desktop-valid', false) },
    { name: 'fpe-gaps', tab: 'trend', fpeFixture: fpeFixtures.mixed, cases: fpeCases('desktop-gaps', true) },
    { name: 'fpe-mobile', tab: 'trend', mobile: true, fpeFixture: fpeFixtures.mixed, cases: fpeCases('390px-gaps', true) },
  );
  if (options.selfTestFailure) phases[0].cases.push(['controlled failure evidence self-test', async () => { assert(false, 'Intentional harness-only assertion; product files unchanged'); }]);
  report.plannedScenarios = phases.flatMap(p => p.cases.map(c => c[0])).concat(['current checkout HTTP identity', 'zero console errors/warnings/pageerrors/request failures']);
  const completed = new Set();
  try {
    const git = args => execFileSync('git', args, { cwd: ROOT, encoding: 'utf8' }).trim();
    Object.assign(report.sourceIdentity, { branch: git(['branch', '--show-current']), head: git(['rev-parse', 'HEAD']), status: git(['status', '--porcelain=v1', '--untracked-files=all']) });
    let playwright;
    try { playwright = require(process.env.PLAYWRIGHT_MODULE || 'playwright'); report.runtime.playwright = require(path.join(path.dirname(require.resolve(process.env.PLAYWRIGHT_MODULE || 'playwright')), 'package.json')).version; }
    catch (error) { throw new Error('Playwright unavailable. Use the existing npm dependency (npm ci --ignore-scripts only when authorized), or set PLAYWRIGHT_MODULE to its installed module. ' + error.message); }
    report.runtime.binary = playwright.chromium.executablePath();
    assert(fs.existsSync(report.runtime.binary), 'Chromium runtime missing. Inspect existing installation; when authorized run npx playwright install chromium. No implicit install was attempted.');
    server = await startServer(ROOT); report.sourceIdentity.url = server.url;
    const critical = ['index.html', 'js/boot.js', 'js/navigation.js', 'js/tabs/trend.js', 'js/tabs/trend_calc.mjs', 'js/tabs/stressdash.js', 'js/utils/chartFocus.js', 'css/main.css', 'css/chart-focus.css', 'css/dashboard-layout.css'];
    for (const relative of critical) { const response = await fetch(server.url + '/' + relative), body = Buffer.from(await response.arrayBuffer()), disk = fs.readFileSync(path.join(ROOT, relative));
      assert(response.ok && hash(body) === hash(disk), 'Initial HTTP identity mismatch: ' + relative); report.sourceIdentity.servedFiles.push({ path: relative, httpSha256: hash(body), diskSha256: hash(disk) }); }
    browser = await playwright.chromium.launch({ headless: true, chromiumSandbox: true,
      ignoreDefaultArgs: ['--unsafely-disable-devtools-self-xss-warnings', '--enable-unsafe-swiftshader'], timeout: 30000 });
    report.runtime.browser = browser.version(); report.runtime.fixedTime = report.started;
    for (const phase of phases) {
      phaseFailed = false; stage = phase.name + ' setup';
      const diagnosticStart = { console: report.console.messages.length, requests: report.requests.length,
        responses: report.sourceIdentity.responses.length };
      try {
        context = await browser.newContext({ viewport: phase.mobile ? { width: 390, height: 844 } : { width: 1280, height: 900 }, deviceScaleFactor: 1, timezoneId: 'UTC' });
        await context.tracing.start({ screenshots: true, snapshots: true, sources: true });
        page = await context.newPage(); page.setDefaultTimeout(7000); page.setDefaultNavigationTimeout(30000); await page.clock.setFixedTime(new Date(report.runtime.fixedTime));
        page.on('console', message => { if (['error', 'warning'].includes(message.type())) report.console.messages.push({ stage, type: message.type(), text: message.text(), location: message.location() }); });
        page.on('pageerror', error => report.console.messages.push({ stage, type: 'pageerror', text: error.message, stack: error.stack }));
        page.on('requestfailed', request => report.requests.push({ stage, type: 'failed', url: request.url(), error: request.failure() }));
        page.on('response', response => {
          const url = new URL(response.url());
          if (url.origin !== server.url) { report.requests.push({ stage, type: 'external', url: response.url(), status: response.status() }); return; }
          const responseStage = stage;
          pending.push((async () => {
            const item = { stage: responseStage, url: response.url(), status: response.status(), path: decodeURIComponent(url.pathname).replace(/^\//, '') || 'index.html' };
            if (phase.fpeFixture && item.path === 'data/QQQ_valuation.json') {
              const body = await response.body(), expected = JSON.stringify({ data: phase.fpeFixture });
              item.httpSha256 = hash(body); item.fixtureSha256 = hash(expected); item.equal = item.httpSha256 === item.fixtureSha256;
              item.identityKind = 'declared in-memory FPE endpoint fixture; no data file mutation';
              report.sourceIdentity.syntheticResponses ||= []; report.sourceIdentity.syntheticResponses.push(item);
              assert(item.status === 200 && item.equal, 'FPE synthetic response identity mismatch'); return;
            }
            try { const bytes = await response.body(); item.httpSha256 = hash(bytes); item.diskSha256 = hash(fs.readFileSync(path.join(ROOT, item.path))); item.equal = item.httpSha256 === item.diskSha256; }
            catch (error) { item.error = error.message; item.equal = false; }
            report.sourceIdentity.responses.push(item);
          })());
        });
        await context.route('**/*', route => { const request = route.request(), url = new URL(request.url());
          if (request.method() !== 'GET' || (url.origin !== server.url && request.url() !== 'https://cdn.jsdelivr.net/npm/echarts@5.5.0/dist/echarts.min.js')) {
            report.requests.push({ stage, type: 'unexpected', method: request.method(), url: request.url() }); return route.abort();
          }
          if (phase.fpeFixture && url.origin === server.url && url.pathname === '/data/QQQ_valuation.json') return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ data: phase.fpeFixture }) });
          return route.continue();
        });
        await page.addInitScript(() => { window.__smokeKeys = []; document.addEventListener('keydown', e => window.__smokeKeys.push({ key: e.key, metaKey: e.metaKey, ctrlKey: e.ctrlKey, isComposing: e.isComposing, keyCode: e.keyCode, isTrusted: e.isTrusted, target: e.target.id }), true); });
        await page.goto(server.url + '/#tab=' + phase.tab, { waitUntil: 'networkidle' }); await chartReady(phase.tab);
        for (const [name, action] of phase.cases) { await test(name, action); completed.add(name); }
      } catch (error) {
        for (const [name] of phase.cases) if (!completed.has(name)) { await test(name, async () => { throw new Error('Phase setup blocked: ' + error.message); }); completed.add(name); }
      } finally {
        await Promise.all(pending); pending = [];
        // Console/HTTP failures can arrive after an interaction assertion passed.
        // Capture the live page before teardown; the final two checks still own
        // the diagnostic PASS/FAIL result and cannot discard these failures.
        const diagnostics = {
          console: report.console.messages.slice(diagnosticStart.console),
          requests: report.requests.slice(diagnosticStart.requests).filter(r => r.type !== 'external' || r.status !== 200),
          responses: report.sourceIdentity.responses.slice(diagnosticStart.responses).filter(r => r.status !== 200 || !r.equal || r.error),
        };
        if (Object.values(diagnostics).some(items => items.length)) {
          await failEvidence(phase.name + ' asynchronous diagnostics');
          const diagnosticPath = path.join(out, phase.name + '-diagnostics.json');
          fs.writeFileSync(diagnosticPath, JSON.stringify(diagnostics, null, 2) + '\n');
          report.artifacts.failures.push({ phase: phase.name, diagnostics: diagnosticPath });
        }
        if (context) {
          const trace = phaseFailed ? path.join(out, phase.name + '-trace.zip') : undefined;
          try { await context.tracing.stop(trace ? { path: trace } : {}); if (trace) report.artifacts.failures.push({ phase: phase.name, trace }); }
          catch (error) { report.artifacts.failures.push({ phase: phase.name, traceError: error.message }); }
          await context.close(); context = null; page = null;
        }
      }
    }
    await test('current checkout HTTP identity', async () => {
      const responses = report.sourceIdentity.responses; assert(responses.length > 0, 'No application HTTP responses');
      const bad = responses.filter(r => r.status !== 200 || !r.equal || r.error); assert(!bad.length, 'Local response identity failures: ' + JSON.stringify(bad));
      assert(report.sourceIdentity.syntheticResponses?.length === 3 && report.sourceIdentity.syntheticResponses.every(r => r.status === 200 && r.equal), 'Declared FPE fixture responses missing or mismatched');
      const loaded = new Set(responses.map(r => r.path));
      for (const file of [...critical, 'data/QQQ.json', 'data/SPY.json']) assert(loaded.has(file), 'Critical source/data was not loaded by browser: ' + file);
      return { checkedLocalResponses: responses.length, criticalFiles: critical, loadedData: [...loaded].filter(f => f.startsWith('data/')) };
    }); completed.add('current checkout HTTP identity');
    await test('zero console errors/warnings/pageerrors/request failures', async () => {
      assert(!report.console.messages.length, 'Unexpected browser console messages: ' + JSON.stringify(report.console.messages));
      const bad = report.requests.filter(r => r.type !== 'external' || r.status !== 200); assert(!bad.length, 'Request failures: ' + JSON.stringify(bad)); return { errors: 0, warnings: 0, pageerrors: 0, failedRequests: 0, expectedAllowlist: [] };
    }); completed.add('zero console errors/warnings/pageerrors/request failures');
  } catch (error) {
    report.fatal = { stage, message: error.message, stack: error.stack };
    for (const name of report.plannedScenarios) if (!completed.has(name)) { report.cases.push({ name, status: 'FAIL', reason: 'Setup blocked: ' + error.message }); completed.add(name); }
    await failEvidence('startup');
  } finally {
    if (context) await context.close().catch(error => { report.cleanup.contextError = error.message; });
    if (browser) await browser.close().then(() => { report.cleanup.browserClosed = true; }, error => { report.cleanup.browserError = error.message; });
    else report.cleanup.browserClosed = true;
    if (server) await server.close().then(() => { report.cleanup.serverClosed = true; }, error => { report.cleanup.serverError = error.message; });
    else report.cleanup.serverClosed = true;
    if (!report.cleanup.browserClosed || !report.cleanup.serverClosed) report.cases.push({ name: 'resource cleanup', status: 'FAIL', reason: JSON.stringify(report.cleanup) });
    report.finished = new Date().toISOString(); report.summary = summarize(report.cases, report.console.messages); save();
  }
  console.log(`${report.summary.status}\ntests passed / total: ${report.summary.passed} / ${report.summary.total}\nconsole errors: ${report.summary.consoleErrors}; warnings: ${report.summary.consoleWarnings}; pageerrors: ${report.summary.pageErrors}\nfailed scenarios: ${report.summary.failedScenarios.join(', ') || 'none'}\nreport: ${report.artifacts.report}\nfailure artifacts: ${report.artifacts.failures.length ? out : 'none'}`);
  return report;
}
module.exports = { startServer, hash, parseArgs, summarize, run };
if (require.main === module) {
  let options;
  try { options = parseArgs(process.argv.slice(2)); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
  if (options?.help) console.log('Usage: node scripts/browser_smoke.cjs [--output NEW_DIRECTORY] [--self-test-failure]\nRuns two-page Chromium smoke with existing Playwright/browser. Default artifacts: unique OS temporary directory. Failure: exit 1 + report/screenshots/state/trace. See TESTING.md.');
  else if (options) run(options).then(report => { process.exitCode = report.summary.exitCode; }).catch(error => { console.error('FAIL harness output/setup: ' + error.stack); process.exitCode = 1; });
}
