import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
const { startServer, hash, parseArgs, summarize } = createRequire(import.meta.url)('../../scripts/browser_smoke.cjs');

test('smoke server owns a free loopback port and serves exact bytes; denies secrets/traversal/symlink escape', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'smoke-server-test-'));
  const external = fs.mkdtempSync(path.join(os.tmpdir(), 'smoke-server-outside-'));
  fs.writeFileSync(path.join(root, 'index.html'), '<p>current checkout</p>');
  fs.writeFileSync(path.join(root, '.secret.json'), 'secret');
  fs.writeFileSync(path.join(external, 'outside.json'), '{}');
  fs.symlinkSync(path.join(external, 'outside.json'), path.join(root, 'escape.json'));
  const server = await startServer(root);
  try {
    const response = await fetch(server.url + '/');
    assert.equal(response.status, 200);
    assert.equal(hash(Buffer.from(await response.arrayBuffer())), hash(fs.readFileSync(path.join(root, 'index.html'))));
    for (const url of ['/.secret.json', '/%2e%2e%2foutside.json', '/escape.json', '/index.html%00', '/index.html%5csecret']) {
      assert.notEqual((await fetch(server.url + url)).status, 200, url);
    }
    assert.equal((await fetch(server.url, { method: 'POST' })).status, 405);
    assert.equal((await fetch(server.url + '/missing.json')).status, 404);
  } finally { await server.close(); fs.rmSync(root, { recursive: true }); fs.rmSync(external, { recursive: true }); }
  await assert.rejects(fetch(server.url));
});

test('smoke result cannot report failed or blocked scenarios as PASS', () => {
  const result = summarize([{ name: 'ready', status: 'PASS' }, { name: 'setup blocked', status: 'FAIL' }], [{ type: 'warning' }]);
  assert.deepEqual(result, { status: 'FAIL', passed: 1, total: 2, consoleErrors: 0, consoleWarnings: 1, pageErrors: 0, failedScenarios: ['setup blocked'], exitCode: 1 });
  assert.equal(summarize([{ name: 'passed', status: 'PASS' }], []).exitCode, 0);
});

test('smoke CLI rejects unknown/incomplete options and supports explicit isolated output', () => {
  assert.throws(() => parseArgs(['--output']), /Unknown or incomplete/);
  assert.throws(() => parseArgs(['--unknown']), /Unknown or incomplete/);
  assert.deepEqual(parseArgs(['--self-test-failure', '--help']), { selfTestFailure: true, help: true });
  assert.equal(parseArgs(['--output', './artifacts']).output, path.resolve('artifacts'));
});
