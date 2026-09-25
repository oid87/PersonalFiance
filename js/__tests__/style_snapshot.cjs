// Computed-style snapshot — proves inline-style → CSS-class migrations in index.html are
// visually inert. For 4 viewport×theme combos, loads index.html (no tab switching), takes
// getComputedStyle() of every element in DOM order (ALL properties), hashes each element's
// full computed style with sha1, and writes { "<vp>-<theme>": { "<key>": "<sha1>" } }.
//
// Usage:
//   export PLAYWRIGHT_MODULE=<path to playwright>
//   git archive HEAD | tar -x -C <scratchpad>/S/base
//   node js/__tests__/style_snapshot.cjs <scratchpad>/S/base 8911 <scratchpad>/S/s_base1.json
//   node js/__tests__/style_snapshot.cjs <scratchpad>/S/base 8912 <scratchpad>/S/s_base2.json
//   node js/__tests__/style_snapshot.cjs .                   8913 <scratchpad>/S/s_after.json
//   node js/__tests__/style_snapshot.cjs --diff a.json b.json   # which keys differ (hashes only)
//   node js/__tests__/style_snapshot.cjs --diff a.json b.json <rootA> <rootB> [port]
//     # also reopens both roots and prints the differing property names + before/after
//     # values for every mismatched key (needs PLAYWRIGHT_MODULE + rootA/rootB present).
//
// Run the baseline twice first: any key that differs between base1/base2 means the tool
// itself is nondeterministic and must be fixed before trusting any comparison.
'use strict';
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

function sha1(str) {
  return crypto.createHash('sha1').update(str).digest('hex');
}

const VIEWPORTS = {
  desktop: { width: 1440, height: 1000 },
  mobile: { width: 375, height: 812 },
};

function waitForServer(url, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    const tryOnce = () => {
      const http = require('node:http');
      const req = http.get(url, res => { res.resume(); resolve(); });
      req.on('error', () => {
        if (Date.now() > deadline) reject(new Error('server did not start in time'));
        else setTimeout(tryOnce, 150);
      });
    };
    tryOnce();
  });
}

async function rawStylesForCombo(chromium, port, vpName, theme) {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage({ viewport: VIEWPORTS[vpName] });
    await page.goto(`http://127.0.0.1:${port}/index.html`, { waitUntil: 'networkidle' });
    if (theme === 'light') {
      await page.evaluate(() => document.body.classList.add('light'));
    }
    await page.waitForTimeout(500);

    return await page.evaluate(() => {
      const out = {};
      const els = document.querySelectorAll('*');
      els.forEach((el, index) => {
        const tag = el.tagName;
        const id = el.id || '';
        const key = `${index}:${tag}#${id}`;
        const cs = window.getComputedStyle(el);
        const props = {};
        for (const p of cs) {
          props[p] = cs.getPropertyValue(p);
        }
        out[key] = props;
      });
      return out;
    });
  } finally {
    await browser.close();
  }
}

async function snapshotCombo(chromium, port, vpName, theme) {
  const styles = await rawStylesForCombo(chromium, port, vpName, theme);
  const hashed = {};
  for (const key of Object.keys(styles)) {
    hashed[key] = sha1(JSON.stringify(styles[key]));
  }
  return hashed;
}

async function runDiff(aPath, bPath, rootA, rootB, portArg) {
  const a = JSON.parse(fs.readFileSync(aPath, 'utf8'));
  const b = JSON.parse(fs.readFileSync(bPath, 'utf8'));
  const combos = new Set([...Object.keys(a), ...Object.keys(b)]);
  const diffKeysByCombo = {};
  let anyDiff = false;
  for (const combo of combos) {
    const ah = a[combo] || {};
    const bh = b[combo] || {};
    const keys = new Set([...Object.keys(ah), ...Object.keys(bh)]);
    const diffKeys = [];
    for (const k of keys) {
      if (ah[k] !== bh[k]) diffKeys.push(k);
    }
    if (diffKeys.length) {
      anyDiff = true;
      diffKeysByCombo[combo] = diffKeys;
      console.log(`\n=== combo ${combo}: ${diffKeys.length} differing key(s) ===`);
      for (const k of diffKeys) console.log(`  ${k}: ${ah[k] || '(missing)'} -> ${bh[k] || '(missing)'}`);
    }
  }
  if (!anyDiff) {
    console.log('No differences.');
    return;
  }
  if (!rootA || !rootB) {
    console.log('\n(Pass <rootA> <rootB> [port] to also print the differing property names + values.)');
    return;
  }
  const port = Number(portArg || 8999);
  const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
  const serverA = spawn('python3', ['-m', 'http.server', String(port), '--directory', rootA], { stdio: 'ignore' });
  const serverB = spawn('python3', ['-m', 'http.server', String(port + 1), '--directory', rootB], { stdio: 'ignore' });
  try {
    await waitForServer(`http://127.0.0.1:${port}/index.html`, 15000);
    await waitForServer(`http://127.0.0.1:${port + 1}/index.html`, 15000);
    for (const combo of Object.keys(diffKeysByCombo)) {
      const [vpName, theme] = combo.split('-');
      console.log(`\n### property-level detail for ${combo} ###`);
      const rawA = await rawStylesForCombo(chromium, port, vpName, theme);
      const rawB = await rawStylesForCombo(chromium, port + 1, vpName, theme);
      for (const key of diffKeysByCombo[combo]) {
        const pa = rawA[key] || {};
        const pb = rawB[key] || {};
        const propNames = new Set([...Object.keys(pa), ...Object.keys(pb)]);
        const propDiffs = [];
        for (const p of propNames) {
          if (pa[p] !== pb[p]) propDiffs.push(p);
        }
        console.log(`  ${key}:`);
        for (const p of propDiffs) {
          console.log(`    ${p}: ${pa[p] === undefined ? '(missing)' : pa[p]} -> ${pb[p] === undefined ? '(missing)' : pb[p]}`);
        }
      }
    }
  } finally {
    serverA.kill();
    serverB.kill();
  }
}

async function main() {
  const args = process.argv.slice(2);
  if (args[0] === '--diff') {
    await runDiff(args[1], args[2], args[3], args[4], args[5]);
    return;
  }
  const [rootDir, portArg, outJson] = args;
  if (!rootDir || !portArg || !outJson) {
    console.error('usage: node style_snapshot.cjs <rootDir> <port> <outJson>');
    console.error('       node style_snapshot.cjs --diff <a.json> <b.json>');
    process.exit(1);
  }
  const port = Number(portArg);
  const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');

  const server = spawn('python3', ['-m', 'http.server', String(port), '--directory', rootDir], {
    stdio: 'ignore',
  });
  try {
    await waitForServer(`http://127.0.0.1:${port}/index.html`, 15000);
    const result = {};
    for (const vpName of Object.keys(VIEWPORTS)) {
      for (const theme of ['dark', 'light']) {
        const comboKey = `${vpName}-${theme}`;
        result[comboKey] = await snapshotCombo(chromium, port, vpName, theme);
      }
    }
    fs.mkdirSync(path.dirname(outJson), { recursive: true });
    fs.writeFileSync(outJson, JSON.stringify(result, null, 2));
    console.log(`wrote ${outJson}: ${Object.keys(result).length} combos`);
  } finally {
    server.kill();
  }
}

main().catch(err => { console.error(err); process.exit(1); });
