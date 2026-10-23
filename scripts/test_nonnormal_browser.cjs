/* 極端狀態儀表板 page integration probe; uses installed Playwright, reads only repository files (no market-data fetch).
 *   node scripts/test_nonnormal_browser.cjs        (PLAYWRIGHT_MODULE=<path> to use another Playwright install)
 */
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const root = path.resolve(__dirname, '..');
const mime = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.json': 'application/json', '.css': 'text/css', '.svg': 'image/svg+xml' };
const server = http.createServer((req, res) => {
  const relative = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
  const file = path.resolve(root, '.' + (relative === '/' ? '/index.html' : relative));
  if (!file.startsWith(root + path.sep)) { res.writeHead(403); return res.end(); }
  try { res.writeHead(200, { 'content-type': mime[path.extname(file)] || 'application/octet-stream', 'cache-control': 'no-store' }); res.end(fs.readFileSync(file)); }
  catch { res.writeHead(404); res.end('not found'); }
});
const cases = [], problems = [];
const check = (name, ok, detail = null) => { cases.push({ name, ok: !!ok, detail }); if (!ok) throw new Error(name + ': ' + JSON.stringify(detail)); };
(async () => {
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const base = 'http://127.0.0.1:' + server.address().port;
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await (await browser.newContext({ viewport: { width: 1280, height: 900 } })).newPage();
    page.on('console', m => { if (['warning', 'error'].includes(m.type())) problems.push({ type: m.type(), text: m.text() }); });
    page.on('pageerror', e => problems.push({ type: 'pageerror', text: e.message }));
    page.on('requestfailed', r => problems.push({ type: 'requestfailed', url: r.url() }));
    await page.goto(base + '/#tab=nonnormal');
    await page.waitForFunction(() => document.querySelectorAll('#nonnormal-cards .nonnormal-q').length > 0 || /失敗/.test(document.getElementById('nonnormal-status')?.textContent || ''), null, { timeout: 30000 });
    const text = id => page.locator('#nonnormal-' + id).innerText();
    check('status has no error', !/失敗/.test(await text('status')), await text('status'));
    check('as-of shows the evaluation date', /^\d{4}-\d{2}-\d{2}/.test(await text('asof')), await text('asof'));
    check('banner shows a level', /常態|留意|警戒|高度警戒/.test(await text('summary')), await text('summary'));
    const cards = await text('cards');
    check('card groups present', ['國際股市', '金融市場', '台股內部', '參考（不計分）'].every(k => cards.includes(k)), cards.slice(0, 200));
    check('21 quote cards', (await page.locator('#nonnormal-cards .nonnormal-q').count()) === 21);
    check('cards include the new series', ['費半', '那斯達克 100', '恆生', '歐股 50', '布蘭特原油', '上櫃融資維持率', 'VXN', '比特幣'].every(k => cards.includes(k)));
    check('US stock order: 費半 → 那斯達克 → S&P 500', (await page.evaluate(() => [...document.querySelectorAll('#nonnormal-cards .nonnormal-cards')[0].querySelectorAll('.nonnormal-q')].map(e => e.dataset.series).join())) === 'SOX,NDX,SPX,KOSPI');
    check('上櫃 margin card shows a ratio', /^\d+\.\d%$/.test(await page.locator('.nonnormal-q[data-series="MARGIN_OTC"] .nonnormal-q-val').innerText()));
    check('sparkline with 50/100MA drawn', await page.evaluate(() => {
      const svg = document.querySelector('.nonnormal-q[data-series="SOX"] svg.nonnormal-spark');
      return !!svg && ['px', 'ma50', 'ma100', 'area'].every(c => svg.querySelector('path.' + c)?.getAttribute('d')?.length > 20);
    }));
    check('lit cards match the banner count', await page.evaluate(() => {
      const lit = new Set([...document.querySelectorAll('#nonnormal-cards .nonnormal-q--on')].map(e => e.dataset.signal)).size;
      const m = document.querySelector('#nonnormal-summary .nonnormal-banner-sub')?.textContent.match(/^(\d+)\//);
      return m && Number(m[1]) === lit;
    }));
    check('lead-lag table lists the three averages', (await page.locator('#nonnormal-leadlag tbody tr').count()) === 3);
    check('cash panel: 4w and 8w states, five ranked assets, chart drawn', (await page.locator('#nonnormal-cash-state .nonnormal-cash-pill').count()) === 2
      && (await page.locator('#nonnormal-cash-rank .nonnormal-rank-row').count()) === 5 && (await page.locator('#nonnormal-cash-chart canvas').count()) > 0);
    await page.locator('#nonnormal-cash-range .chip[data-nonnormal-cash="8"]').click();
    check('cash window chip switches the ranking', await page.locator('#nonnormal-cash-range .chip[data-nonnormal-cash="8"].active').count() === 1);
    await page.locator('.nonnormal-q[data-series="SOX"]').click();
    await page.waitForTimeout(600);
    check('a single click does not open the dialog', !(await page.evaluate(() => document.getElementById('nonnormal-dialog').open)));
    await page.locator('.nonnormal-q[data-series="SOX"]').dblclick();
    await page.waitForFunction(() => document.getElementById('nonnormal-dialog').open && document.querySelector('#nonnormal-dialog-chart canvas'), null, { timeout: 5000 }).catch(() => {});
    check('card click opens the large chart', await page.evaluate(() => document.getElementById('nonnormal-dialog').open && /費半/.test(document.getElementById('nonnormal-dialog-title').textContent) && !!document.querySelector('#nonnormal-dialog-chart canvas')));
    check('dialog explains why: reason, rule with source tags, current reading; state pill in the title row', await page.evaluate(() => {
      const t = document.getElementById('nonnormal-dialog-why').innerText;
      return ['為什麼看這個', '怎麼算亮燈', '現在'].every(k => t.includes(k)) && /半導體/.test(t) && /課程|本專案/.test(t)
        && !!document.querySelector('#nonnormal-dialog-sub .nonnormal-why-state');
    }));
    check('desktop dialog: reason left, chart right, chart about twice as wide', await page.evaluate(() => {
      const a = document.getElementById('nonnormal-dialog-why').getBoundingClientRect(), b = document.getElementById('nonnormal-dialog-chart').getBoundingClientRect();
      return a.right <= b.left && b.width / a.width > 1.7 && b.width / a.width < 2.3;
    }));
    check('large chart shows about half a year', await page.evaluate(() => { const o = echarts.getInstanceByDom(document.getElementById('nonnormal-dialog-chart')).getOption(); const d = o.xAxis[0].data; return (Date.parse(d.at(-1)) - Date.parse(d[0])) / 864e5 >= 175 && (Date.parse(d.at(-1)) - Date.parse(d[0])) / 864e5 <= 185; }));
    await page.keyboard.press('Escape');
    check('Escape closes the large chart', !(await page.evaluate(() => document.getElementById('nonnormal-dialog').open)));
    check('zoom floor: history chart cannot zoom below ~half a year', await page.evaluate(async () => {
      const ch = echarts.getInstanceByDom(document.getElementById('nonnormal-chart')), d = ch.getOption().xAxis[0].data;
      ch.dispatchAction({ type: 'dataZoom', startValue: d[d.length - 3], endValue: d.at(-1) });
      await new Promise(r => setTimeout(r, 200));
      const z = ch.getOption().dataZoom.find(x => x.type === 'slider');
      const ok = z.endValue - z.startValue >= 25;
      ch.dispatchAction({ type: 'dataZoom', start: 0, end: 100 });
      return ok;
    }));
    check('chart canvas drawn', (await page.locator('#nonnormal-chart canvas').count()) > 0);
    check('collapsed sections not rendered before opening', (await page.locator('#nonnormal-cases tbody tr').count()) === 0 && (await page.locator('#nonnormal-sources tbody tr').count()) === 0);
    await page.locator('#nonnormal-cases-details > summary').click();
    await page.waitForFunction(() => document.querySelectorAll('#nonnormal-cases tbody tr').length > 0, null, { timeout: 5000 }).catch(() => {});
    check('three course cases rendered on open', (await page.locator('#nonnormal-cases tbody tr').count()) === 3);
    check('case table reports a verdict per case', ((await text('cases')).match(/提前|沒有提前|沒有達到/g) || []).length >= 3);
    check('base rate line rendered', /2013 起/.test(await text('base')));
    await page.locator('#nonnormal-sources-details > summary').click();
    await page.waitForFunction(() => document.querySelectorAll('#nonnormal-sources tbody tr').length > 0, null, { timeout: 5000 }).catch(() => {});
    check('sources table has 12 rows', (await page.locator('#nonnormal-sources tbody tr').count()) === 12);
    const sources = await text('sources');
    check('every threshold is labelled course or project', sources.includes('課程') && sources.includes('本專案'));
    check('no course citation line in notes', !/來源：投資癮/.test(await text('notes')));
    // interactions
    await page.locator('#nonnormal-range .chip[data-nonnormal-range="all"]').click();
    check('range chip toggles active', await page.locator('#nonnormal-range .chip[data-nonnormal-range="all"].active').count() === 1);
    const box = page.locator('#nonnormal-turn input[data-check="policy"]');
    await box.check();
    check('manual checklist persists in localStorage', JSON.parse(await page.evaluate(() => localStorage.getItem('nonnormal-checklist-v1'))).policy === true);
    await box.uncheck();
    check('auto checklist item is read-only', await page.locator('#nonnormal-turn input[data-check="margin140"]').isDisabled());
    await page.locator('#tab-nonnormal .info-pop-btn').first().click();
    check('info popover opens', await page.locator('#info-popover').isVisible());
    await page.keyboard.press('Escape');
    check('info popover closes on Escape', !(await page.locator('#info-popover').isVisible()));
    // layouts
    await page.setViewportSize({ width: 390, height: 844 });
    await page.waitForTimeout(400);
    await page.locator('.nonnormal-q[data-series="VIX"]').dblclick();
    await page.waitForTimeout(500);
    check('phone dialog: reason stacked above the chart, nothing off-screen', await page.evaluate(() => {
      const a = document.getElementById('nonnormal-dialog-why').getBoundingClientRect(), b = document.getElementById('nonnormal-dialog-chart').getBoundingClientRect();
      const d = document.getElementById('nonnormal-dialog').getBoundingClientRect();
      return a.bottom <= b.top + 1 && b.width > 300 && d.left >= 0 && d.right <= innerWidth;
    }));
    await page.keyboard.press('Escape');
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.locator('.nonnormal-q[data-series="BTC"]').dblclick();
    await page.waitForTimeout(400);
    check('display-only card (BTC) shows 只顯示，不計分 and no rule section', await page.evaluate(() => document.getElementById('nonnormal-dialog-sub').innerText.includes('只顯示，不計分') && !document.getElementById('nonnormal-dialog-why').innerText.includes('怎麼算亮燈')));
    await page.keyboard.press('Escape');
    {
      const touch = await (await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true })).newPage();
      await touch.goto(base + '/#tab=nonnormal');
      await touch.waitForSelector('#nonnormal-cards .nonnormal-q');
      const box = await touch.locator('.nonnormal-q[data-series="SOX"]').boundingBox(), other = await touch.locator('.nonnormal-q[data-series="NDX"]').boundingBox();
      const cx = box.x + box.width / 2, cy = box.y + box.height / 2;
      const isOpen = () => touch.evaluate(() => document.getElementById('nonnormal-dialog').open);
      await touch.touchscreen.tap(cx, cy); await touch.waitForTimeout(600);
      check('touch: one tap does not open', !(await isOpen()));
      await touch.touchscreen.tap(cx, cy); await touch.waitForTimeout(700); await touch.touchscreen.tap(cx, cy); await touch.waitForTimeout(300);
      check('touch: two taps 0.7 s apart do not open', !(await isOpen()));
      await touch.waitForTimeout(600);
      await touch.touchscreen.tap(cx, cy); await touch.waitForTimeout(80); await touch.touchscreen.tap(other.x + other.width / 2, other.y + other.height / 2); await touch.waitForTimeout(300);
      check('touch: taps on two different cards do not open', !(await isOpen()));
      await touch.waitForTimeout(600);
      await touch.touchscreen.tap(cx, cy); await touch.waitForTimeout(120); await touch.touchscreen.tap(cx, cy); await touch.waitForTimeout(500);
      check('touch: double tap within 0.5 s opens the dialog', await isOpen());
      await touch.context().close();
    }
    await page.focus('.nonnormal-q[data-series="TWOII"]');
    await page.keyboard.press('Enter');
    await page.waitForTimeout(400);
    check('keyboard Enter opens the dialog', await page.evaluate(() => document.getElementById('nonnormal-dialog').open && /櫃買/.test(document.getElementById('nonnormal-dialog-title').textContent)));
    await page.keyboard.press('Escape');
    // 每張卡的大圖都要一次看完、不用捲：iPhone 16e 橫放（約 750×340）與直放（約 390×664）、桌機 1280×720
    for (const [w, h, phone] of [[750, 340, true], [390, 664, true], [1280, 720, false]]) {
      const p = await (await browser.newContext({ viewport: { width: w, height: h }, ...(phone ? { hasTouch: true, isMobile: true, deviceScaleFactor: 2 } : {}) })).newPage();
      await p.goto(base + '/#tab=nonnormal');
      await p.waitForSelector('#nonnormal-cards .nonnormal-q');
      const bad = [];
      for (const id of await p.$$eval('#nonnormal-cards .nonnormal-q', els => els.map(e => e.dataset.series))) {
        await p.focus(`.nonnormal-q[data-series="${id}"]`);
        await p.keyboard.press('Enter');
        await p.waitForFunction(() => document.querySelector('#nonnormal-dialog-chart canvas'), null, { timeout: 5000 }).catch(() => {});
        const m = await p.evaluate(() => {
          const d = document.getElementById('nonnormal-dialog'), r = d.getBoundingClientRect(), why = document.getElementById('nonnormal-dialog-why');
          const a = why.getBoundingClientRect(), c = document.getElementById('nonnormal-dialog-chart').getBoundingClientRect();
          return { open: d.open, inView: r.top >= 0 && r.left >= 0 && r.bottom <= innerHeight + 0.5 && r.right <= innerWidth + 0.5,
            noScroll: d.scrollHeight <= d.clientHeight + 1 && why.scrollHeight <= why.clientHeight + 1, chartInside: c.bottom <= r.bottom && c.height >= 180,
            side: innerWidth > innerHeight ? a.right <= c.left : a.bottom <= c.top + 1 };
        });
        if (!m.open || !m.inView || !m.noScroll || !m.chartInside || !m.side) bad.push({ id, ...m });
        await p.keyboard.press('Escape');
      }
      check(`every card's large chart fits one screen without scrolling at ${w}x${h}`, bad.length === 0, bad);
      await p.context().close();
    }
    for (const [w, h] of [[390, 844], [844, 390], [1024, 450]]) {
      await page.setViewportSize({ width: w, height: h });
      await page.waitForTimeout(600);
      const m = await page.evaluate(() => ({ sw: document.documentElement.scrollWidth, iw: innerWidth }));
      check(`no horizontal page scroll at ${w}x${h}`, m.sw <= m.iw + 1, m);
    }
    check('no console warning/error/pageerror/requestfailed', problems.length === 0, problems);
    console.log(JSON.stringify({ ok: true, cases: cases.length }));
  } finally { await browser.close(); server.close(); }
})().catch(e => { console.error(JSON.stringify({ ok: false, error: e.message, cases, problems })); process.exit(1); });
