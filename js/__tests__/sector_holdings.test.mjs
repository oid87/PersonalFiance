import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

// Run the production popup/loading code without exporting its private state.
const source = fs.readFileSync(new URL('../tabs/sector.js', import.meta.url), 'utf8')
  .replace(/^import .*;\n/gm, '').replace(/^export /gm, '');
const prices = Array.from({ length: 300 }, (_, i) => [
  new Date(Date.UTC(2025, 0, 1 + i)).toISOString().slice(0, 10), 100 + i,
]);
const liveXLK = [{ sym: 'LIVE2', zh: '第二', w: 8 }, { sym: 'LIVE1', zh: '第一', w: 3 }];

function setup(holdingsResponse) {
  const elements = new Map();
  const charts = [];
  const calls = [];
  const element = () => ({
    style: {}, innerHTML: '', addEventListener() {},
    remove() { elements.delete(this.id); },
  });
  const body = { appendChild(el) { elements.set(el.id, el); } };
  const fetcher = async url => { calls.push(url); return await holdingsResponse(); };
  const context = vm.createContext({
    SECTOR_ETFS: ['XLK', 'XLF'], SECTOR_LABEL: { XLK: '科技', XLF: '金融' },
    sectorLoaded: { XLK: prices, XLF: prices },
    isLight: () => false, tc: dark => dark, mob: () => false, PALETTE: {}, chipPicker() {},
    document: {
      getElementById(id) {
        if (id === 'sector-line-chart' || id === 'sector-pop-x') {
          if (!elements.has(id)) elements.set(id, element());
          return elements.get(id);
        }
        return elements.get(id) || null;
      },
      createElement: element, body, addEventListener() {}, removeEventListener() {},
    },
    window: { addEventListener() {} },
    echarts: { init() {
      const chart = { setOption(option) { this.option = option; }, dispose() {}, resize() {} };
      charts.push(chart);
      return chart;
    } },
    fetch: fetcher,
    // Existing dirty loaders may use requestJSON; mirror its request/HTTP/parse
    // result rather than accidentally treating an absent mock as load failure.
    requestJSON: async url => {
      const result = await fetcher(url);
      if (!result.ok) throw new Error('HTTP failure');
      return await result.json();
    },
    clearRequestCache() {},
    setTimeout() {},
  });
  vm.runInContext(source, context);
  return {
    context, calls,
    load: () => vm.runInContext('loadUS()', context),
    popup(key) {
      vm.runInContext(`showLineChart(${JSON.stringify(key)})`, context);
      return { html: elements.get('sector-pop').innerHTML, option: JSON.parse(JSON.stringify(charts.at(-1).option)) };
    },
    fallback: key => JSON.parse(vm.runInContext(`JSON.stringify(SECTOR_HOLDINGS[${JSON.stringify(key)}])`, context)),
  };
}

const response = data => ({ ok: true, json: async () => ({ data }) });
function assertSource(html, loaded) {
  assert.match(html, new RegExp(`data-sector-holdings-source="${loaded ? 'loaded' : 'fallback'}"`));
  assert.match(html, new RegExp(loaded ? 'Loaded holdings · 已載入持股清單' : 'Fallback holdings · 專案內建清單'));
  assert.doesNotMatch(html, new RegExp(loaded ? 'Fallback holdings' : 'Loaded holdings'));
}
function holdings(html) {
  return [...html.matchAll(/<b>([^<]+)<\/b> <span[^>]*>([^<]+)<\/span>/g)].map(m => [m[1], m[2]]);
}
const expected = rows => rows.map(h => [h.sym, `${h.zh} ${h.w}%`]);

test('loaded popup discloses the selected holdings and preserves their exact order/weights on reopen', async () => {
  const page = setup(() => response({ XLK: liveXLK }));
  await page.load();
  const first = page.popup('XLK');
  assertSource(first.html, true);
  assert.deepEqual(holdings(first.html), expected(liveXLK));
  assert.deepEqual(page.popup('XLK'), first);
  assert.deepEqual(page.calls, ['data/sector_holdings.json']);
});

test('partial map labels each ETF from its own actual selection', async () => {
  const page = setup(() => response({ XLK: liveXLK }));
  await page.load();
  const loaded = page.popup('XLK');
  const fallback = page.popup('XLF');
  assertSource(loaded.html, true);
  assertSource(fallback.html, false);
  assert.deepEqual(holdings(fallback.html), expected(page.fallback('XLF')));
  assert.deepEqual(page.popup('XLK'), loaded);
});

for (const [name, fetcher] of [
  ['HTTP failure', () => ({ ok: false })],
  ['request failure', () => { throw new Error('offline'); }],
  ['parse failure', () => ({ ok: true, json: async () => { throw new SyntaxError('invalid JSON'); } })],
  ['absent payload data', () => response(null)],
]) {
  test(`${name} preserves built-in holdings and labels fallback for both ETFs`, async () => {
    const page = setup(fetcher);
    await page.load();
    for (const key of ['XLK', 'XLF']) {
      const popup = page.popup(key);
      assertSource(popup.html, false);
      assert.deepEqual(holdings(popup.html), expected(page.fallback(key)));
    }
  });
}

test('truthy empty loaded array stays loaded and empty; falsy entries still choose built-in list', async () => {
  const page = setup(() => response({ XLK: [], XLF: null }));
  await page.load();
  const empty = page.popup('XLK');
  assertSource(empty.html, true);
  assert.deepEqual(holdings(empty.html), []);
  const fallback = page.popup('XLF');
  assertSource(fallback.html, false);
  assert.deepEqual(holdings(fallback.html), expected(page.fallback('XLF')));
});

test('cached route reload preserves per-ETF selection without refetch or numeric/chart change', async () => {
  const page = setup(() => response({ XLK: liveXLK }));
  await page.load();
  const first = page.popup('XLK');
  await page.load();
  assert.deepEqual(page.popup('XLK'), first);
  assert.deepEqual(page.calls, ['data/sector_holdings.json']);
  assert.deepEqual(JSON.parse(JSON.stringify(first.option.series[0].data)), prices);
  assert.deepEqual(first.option.series.map(s => s.name), ['科技', 'MA50', 'MA200']);
  assert.match(first.html, /\$399\.00/);
  assert.match(first.html, /1M \+5\.56%/);
});
