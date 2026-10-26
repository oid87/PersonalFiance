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
    check('25 quote cards', (await page.locator('#nonnormal-cards .nonnormal-q').count()) === 25);
    check('every card shows an English ticker (SOXX, QQQ, VOO, KOSPI for US/Korea)', await page.evaluate(() => { const t = id => document.querySelector(`.nonnormal-q[data-series="${id}"] .nonnormal-q-tk`)?.textContent; return [...document.querySelectorAll('#nonnormal-cards .nonnormal-q')].every(c => c.querySelector('.nonnormal-q-tk')?.textContent) && [t('SOX'), t('NDX'), t('SPX'), t('KOSPI')].join() === 'SOXX,QQQ,VOO,KOSPI'; }));
    check('cards include the new series', ['費半', '那斯達克', '恆生', '歐股 50', '布蘭特原油', '上櫃融資維持率', 'VXN', '恐懼貪婪', '比特幣', '台股市場廣度', '美股市場廣度', '跌停家數', '無觀察類股'].every(k => cards.includes(k)));
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
    check('stance: five boxes with a lit count and verdict', (await page.locator('#nonnormal-boxes .nonnormal-box').count()) === 5 && /亮 \d\/5 格/.test(await text('boxes')) && /尚未轉冷|提高警覺|強烈訊號/.test(await text('boxes')));
    check('stance: temperature table lists five markets with a zone, day/week/month direction and distance to 2/5/10-year lines', await page.evaluate(() => {
      const rows = [...document.querySelectorAll('#nonnormal-temp tbody tr')];
      return rows.length === 5 && rows.every(r => /過熱|偏熱|盤整|偏冷|極冷/.test(r.cells[1].textContent) && /日.週.月./.test(r.cells[2].textContent.replace(/\s/g, '')) && /[+-]\d+%/.test(r.cells[5].textContent));
    }));
    check('temperature history: price + 10-month line + zone background, gap pane, five-market heat strip; last week matches the table', await page.evaluate(() => {
      const c = echarts.getInstanceByDom(document.getElementById('nonnormal-temp-chart')), o = c?.getOption();
      if (!o) return false;
      const xs = o.xAxis[0].data, heat = o.series.find(s => s.type === 'heatmap'), bg = o.series.find(s => s.type === 'bar');
      const zones = ['過熱', '偏熱', '盤整', '偏冷', '極冷'], tw = [...document.querySelectorAll('#nonnormal-temp tbody tr')][0].cells[1].textContent.trim();
      const lastTw = heat.data.find(([x, y]) => x === xs.length - 1 && y === 0)?.[2];
      return o.yAxis[3].data.length === 5 && bg.data.filter(Boolean).length > 500 && o.series.some(s => s.markArea?.data?.length === 5) && zones[lastTw] === tw
        && document.querySelectorAll('#nonnormal-temp-legend .nonnormal-zone').length === 5;
    }));
    await page.click('[data-nonnormal-temp-market="SOX"]');
    await page.click('[data-nonnormal-temp-range="all"]');
    check('temperature history: market chip switches the top panes, 全部 starts at that market\'s first week', await page.evaluate(() => {
      const c = echarts.getInstanceByDom(document.getElementById('nonnormal-temp-chart')), o = c.getOption(), z = o.dataZoom[0];
      return o.yAxis[0].name === '費半' && o.xAxis[0].data[z.startValue] >= '2002-01-01' && z.endValue === o.xAxis[0].data.length - 1;
    }));
    check('stance: three batch cards 20/30/50 with per-condition marks', await page.evaluate(() => {
      const c = [...document.querySelectorAll('#nonnormal-batches .nonnormal-batch')];
      return c.length === 3 && ['20%', '30%', '50%'].every((w, i) => c[i].querySelector('h4').textContent.includes(w)) && c.every(x => /未到|接近|到位/.test(x.textContent) && x.querySelectorAll('li').length >= 4);
    }));
    check('turnaround: VIX ladder goes up to ≥ 60 with episode counts; margin ladder has the 135% tier', /≥ 60/.test(await text('turn')) && /2000 起盤中 \d+ 次/.test(await text('turn')) && /< 135%/.test(await text('turn')));
    check('cash panel: 4w and 8w states, five ranked assets, chart drawn', (await page.locator('#nonnormal-cash-state .nonnormal-cash-pill').count()) === 2
      && (await page.locator('#nonnormal-cash-rank .nonnormal-rank-row').count()) === 5 && (await page.locator('#nonnormal-cash-chart canvas').count()) > 0);
    check('TLT row notes the 10Y yield change over the same dates', /^同期 10Y 殖利率 [+-]?\d+bp/.test(await page.locator('#nonnormal-cash-rank .nonnormal-rank-note').innerText()));
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
      return ['為什麼看這個', '怎麼算亮燈', '現在'].every(k => t.includes(k)) && /半導體/.test(t) && !/本專案/.test(t)
        && !!document.querySelector('#nonnormal-dialog-sub .nonnormal-why-state');
    }));
    check('desktop dialog: reason left, chart right, chart about twice as wide', await page.evaluate(() => {
      const a = document.getElementById('nonnormal-dialog-why').getBoundingClientRect(), b = document.getElementById('nonnormal-dialog-chart').getBoundingClientRect();
      return a.right <= b.left && b.width / a.width > 1.7 && b.width / a.width < 2.3;
    }));
    check('large chart shows about half a year', await page.evaluate(() => { const o = echarts.getInstanceByDom(document.getElementById('nonnormal-dialog-chart')).getOption(); const d = o.xAxis[0].data; return (Date.parse(d.at(-1)) - Date.parse(d[0])) / 864e5 >= 175 && (Date.parse(d.at(-1)) - Date.parse(d[0])) / 864e5 <= 185; }));
    await page.keyboard.press('Escape');
    check('Escape closes the large chart', !(await page.evaluate(() => document.getElementById('nonnormal-dialog').open)));
    check('zoom floor: history chart cannot zoom below ~9 months (weekly → 38 bars)', await page.evaluate(async () => {
      const ch = echarts.getInstanceByDom(document.getElementById('nonnormal-chart')), d = ch.getOption().xAxis[0].data;
      ch.dispatchAction({ type: 'dataZoom', startValue: d[d.length - 3], endValue: d.at(-1) });
      await new Promise(r => setTimeout(r, 200));
      const z = ch.getOption().dataZoom.find(x => x.type === 'slider');
      const ok = z.endValue - z.startValue >= 38;
      ch.dispatchAction({ type: 'dataZoom', start: 0, end: 100 });
      return ok;
    }));
    check('chart canvas drawn', (await page.locator('#nonnormal-chart canvas').count()) > 0);
    check('TWII axis follows the visible window: low −10% to high +10%, six ticks from low to high', await page.evaluate(() => {
      const ch = echarts.getInstanceByDom(document.getElementById('nonnormal-chart'));
      ch.dispatchAction({ type: 'dataZoom', startValue: '2015-05-29', endValue: '2016-09-30' });
      const o = ch.getOption(), z = o.dataZoom[0], vis = o.series[0].data.slice(z.startValue, z.endValue + 1).filter(Number.isFinite);
      const lo = Math.min(...vis), hi = Math.max(...vis), [a, b] = ch.getModel().getComponent('yAxis', 0).axis.scale.getExtent();
      const t = o.series.find(x => x.id === 'twii-ticks').markLine.data.map(m => m.yAxis), near = (x, y) => Math.abs(x - y) < 1;
      return near(a, lo * 0.9) && near(b, hi * 1.1) && t.length === 6 && near(t[0], lo) && near(t[5], hi) && hi < 11000;
    }));
    check('collapsed sections not rendered before opening', (await page.locator('#nonnormal-cases tbody tr').count()) === 0 && (await page.locator('#nonnormal-sources tbody tr').count()) === 0);
    await page.locator('#nonnormal-cases-details > summary').click();
    await page.waitForFunction(() => document.querySelectorAll('#nonnormal-cases tbody tr').length > 0, null, { timeout: 5000 }).catch(() => {});
    check('three historical cases rendered on open', (await page.locator('#nonnormal-cases tbody tr').count()) === 3);
    check('case table reports a verdict per case', ((await text('cases')).match(/提前|沒有提前|沒有達到/g) || []).length >= 3);
    check('base rate line rendered', /2013 起/.test(await text('base')));
    await page.locator('#nonnormal-sources-details > summary').click();
    await page.waitForFunction(() => document.querySelectorAll('#nonnormal-sources tbody tr').length > 0, null, { timeout: 5000 }).catch(() => {});
    check('sources table has 12 rows', (await page.locator('#nonnormal-sources tbody tr').count()) === 12);
    const sources = await text('sources');
    check('thresholds listed without source labels', sources.includes('20 個交易日') && !sources.includes('本專案'));
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
    // 子頁面「過往觀察」
    await page.setViewportSize({ width: 1280, height: 900 });
    check('dashboard links to the history sub-page', (await page.locator('#tab-nonnormal a[href="#tab=nonnormalhist"]').count()) === 1);
    await page.goto(base + '/#tab=nonnormalhist');
    await page.waitForFunction(() => document.querySelector('#nonnormalhist-chart canvas') || /失敗/.test(document.getElementById('nonnormalhist-status')?.textContent || ''), null, { timeout: 30000 });
    const hist = id => page.locator('#nonnormalhist-' + id).innerText();
    check('history: no load error', !/失敗/.test(await hist('status')), await hist('status'));
    check('history: data starts in 2013', /^資料 2013-/.test(await hist('asof')), await hist('asof'));
    const yearsShown = async () => (await hist('yearly')).split('\n').slice(1).map(r => r.slice(0, 4));
    check('history: default range is 2013–2019', (await yearsShown()).every(y => y >= '2013' && y <= '2019'), await yearsShown());
    check('history: episodes table has rows and summary', (await page.locator('#nonnormalhist-table tbody tr').count()) > 0 && /次/.test(await hist('summary')));
    await page.locator('[data-nonnormalhist-range="new"]').click();
    check('history: 2020 起 shows 2020+ years and the 2025-04 limit-down day', (await yearsShown()).every(y => y >= '2020') && /1702 家/.test(await hist('yearly')), await yearsShown());
    await page.locator('[data-nonnormalhist-trigger="ld300"]').click();
    check('history: limit-down trigger lists 2024-08 and 2025-04', /2024-08-05/.test(await hist('table')) && /2025-04-07/.test(await hist('table')), await hist('table'));
    await page.locator('[data-nonnormalhist-trigger="tw50"]').click();
    check('history: 0050 trigger lists 2020-03 and 2025-04', /2020-03-/.test(await hist('table')) && /2025-04-/.test(await hist('table')), await hist('table'));
    check('history: US chart drawn', (await page.locator('#nonnormalhist-us-chart canvas').count()) > 0);
    for (const [g, etf] of [['qqq', 'QQQ'], ['voo5', 'VOO'], ['soxx', 'SOXX']]) {
      await page.locator(`[data-nonnormalhist-us="${g}"]`).click();
      check(`history: US ${g} has episodes with the ${etf} price column`, (await page.locator('#nonnormalhist-us-table tbody tr').count()) > 0 && (await hist('us-table')).startsWith('訊號日\t' + etf), (await hist('us-table')).slice(0, 80));
    }
    check('history: US yearly has three groups', /QQQ.*VOO.*SOXX/.test((await hist('us-yearly')).split('\n')[0]));
    for (const [w, h] of [[390, 844], [844, 390]]) {
      await page.setViewportSize({ width: w, height: h });
      await page.waitForTimeout(400);
      const m = await page.evaluate(() => ({ sw: document.documentElement.scrollWidth, iw: innerWidth }));
      check(`history: no horizontal page scroll at ${w}x${h}`, m.sw <= m.iw + 1, m);
    }
    check('no console warning/error/pageerror/requestfailed', problems.length === 0, problems);
    console.log(JSON.stringify({ ok: true, cases: cases.length }));
  } finally { await browser.close(); server.close(); }
})().catch(e => { console.error(JSON.stringify({ ok: false, error: e.message, cases, problems })); process.exit(1); });
