import { readFile, mkdir, open, link, unlink } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { MACRO_DIAGNOSTIC_METHOD_VERSION, diagnoseUsMacro, canonicalJSON, sha256, verifyDiagnosticSnapshot } from '../js/utils/us_macro_diagnostic.js';
import { writeSnapshotIndex } from './_us_macro_snapshot_index.mjs';

const DEFAULT_DATA = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../data');
const SOURCE_FILES = { macro_summary: 'us_macro_diagnostic.json', SPY: 'SPY.json', QQQ: 'QQQ.json', cpi: 'cpi.json', credit_spread: 'credit_spread.json' };
const SAME_KEYS = ['schema_version', 'local_date_Taipei', 'method_version', 'macro_data_method_version', 'as_of', 'generation_id', 'view', 'input_sha256', 'output_sha256', 'diagnostic_input', 'diagnostic_output'];
const CORE_SERIES = new Set(['PCEC96', 'DSPIC96', 'INDPRO', 'PAYEMS', 'UNRATE']);

async function readSource(dataDir, filename, required = false) {
  let bytes;
  try { bytes = await readFile(path.join(dataDir, filename)); }
  catch (error) { if (error.code === 'ENOENT' && !required) return { value: null, hash: null }; throw error; }
  return { value: JSON.parse(bytes.toString('utf8')), hash: `sha256:${createHash('sha256').update(bytes).digest('hex')}` };
}
function compactInput(input) {
  const { asOf } = input, date = asOf.slice(0, 10);
  const latestMonth = new Date(`${asOf.slice(0, 7)}-01T00:00:00Z`);
  latestMonth.setUTCMonth(latestMonth.getUTCMonth() - 1);
  const month = latestMonth.toISOString().slice(0, 7);
  const prices = {};
  for (const symbol of ['SPY', 'QQQ']) prices[symbol] = input.prices[symbol] === null ? null : {
    data: input.prices[symbol].data.filter(row => row.date < date).slice(-150).map(row => ({ date: row.date, close: row.close })),
  };
  const cpi = input.cpi === null ? null : { components: input.cpi.components
    .filter(c => ['headline', 'core'].includes(c.key))
    .map(c => ({ key: c.key, data: c.data.filter(row => row.date.slice(0, 7) <= month).slice(-4).map(row => ({ date: row.date, yoy: row.yoy })) })) };
  const creditSpread = input.creditSpread === null ? null : { data: input.creditSpread.data.filter(row => row.date < date).slice(-21).map(row => ({ date: row.date, hy: row.hy })) };
  const common = input.macroSummary.coverage?.common_month;
  const indicators = Object.fromEntries(Object.entries(input.macroSummary.indicators).map(([id, item]) => {
    const visible = item.observations.filter(row => row.reference_month <= month);
    const last = CORE_SERIES.has(id) && common && common <= month ? common : visible.at(-1)?.reference_month;
    if (!last) return [id, { ...item, observations: [] }];
    const start = new Date(`${last}-01T00:00:00Z`);
    start.setUTCMonth(start.getUTCMonth() - 15);
    const first = start.toISOString().slice(0, 7);
    return [id, { ...item, observations: visible.filter(row => row.reference_month >= first && row.reference_month <= last) }];
  }));
  const macroSummary = { ...input.macroSummary, indicators };
  return { asOf, methodVersion: input.methodVersion, macroSummary, prices, cpi, creditSpread };
}
function utcSecond(ms) { return new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z'); }
export async function captureUsMacroDiagnostic({ dataDir = DEFAULT_DATA, asOf, now = () => Date.now() }) {
  const instant = new Date(asOf);
  if (!/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/.test(asOf) || !Number.isFinite(instant.getTime()) || utcSecond(instant.getTime()) !== asOf) throw new Error('invalid --as-of UTC second');
  const runNow = now();
  if (!Number.isFinite(runNow) || Math.abs(runNow - instant.getTime()) > 2 * 3600000 || runNow < instant.getTime()) throw new Error('as_of outside current two-hour capture window');
  const sources = {};
  for (const [key, name] of Object.entries(SOURCE_FILES)) sources[key] = await readSource(dataDir, name, key === 'macro_summary');
  const input = { asOf, methodVersion: MACRO_DIAGNOSTIC_METHOD_VERSION, macroSummary: sources.macro_summary.value,
    prices: { SPY: sources.SPY.value, QQQ: sources.QQQ.value }, cpi: sources.cpi.value, creditSpread: sources.credit_spread.value };
  const live = diagnoseUsMacro(input), compact = compactInput(input), output = diagnoseUsMacro(compact);
  if (canonicalJSON(live) !== canonicalJSON(output)) throw new Error('live/compact diagnostic mismatch');
  const localDate = new Date(instant.getTime() + 8 * 3600000).toISOString().slice(0, 10);
  const snapshot = { schema_version: 1, as_of: asOf, captured_at: utcSecond(Math.max(now(), instant.getTime())), local_date_Taipei: localDate,
    method_version: MACRO_DIAGNOSTIC_METHOD_VERSION, macro_data_method_version: sources.macro_summary.value.method_version,
    generation_id: sources.macro_summary.value.generation_id, view: output.view,
    source_file_sha256: Object.fromEntries(Object.entries(sources).map(([k, v]) => [k, v.hash])),
    input_sha256: await sha256(compact), output_sha256: await sha256(output), diagnostic_input: compact, diagnostic_output: output };
  const directory = path.join(dataDir, 'us_macro_diagnostic_snapshots', localDate.slice(0, 4));
  const target = path.join(directory, `${localDate}.json`);
  async function existing() {
    let content;
    try { content = await readFile(target, 'utf8'); }
    catch (error) { if (error.code === 'ENOENT') return null; throw error; }
    if (Buffer.byteLength(content) > 2 * 1024 * 1024) throw new Error('existing snapshot exceeds 2 MiB');
    if (content !== `${canonicalJSON(JSON.parse(content))}\n`) throw new Error('existing snapshot is not canonical');
    const old = JSON.parse(content);
    await verifyDiagnosticSnapshot(old);
    if (SAME_KEYS.every(key => canonicalJSON(old[key]) === canonicalJSON(snapshot[key]))) return { status: 'no-op', path: target, snapshot: old };
    throw new Error(`snapshot conflict: ${target}`);
  }
  const prior = await existing(); if (prior) { await writeSnapshotIndex(dataDir); return prior; }
  await mkdir(directory, { recursive: true });
  const temp = path.join(directory, `.${localDate}.${randomUUID()}.tmp`);
  let handle;
  try {
    handle = await open(temp, 'wx', 0o600);
    const bytes = `${canonicalJSON(snapshot)}\n`;
    await handle.writeFile(bytes, 'utf8'); await handle.sync(); await handle.close(); handle = null;
    try { await link(temp, target); }
    catch (error) { if (error.code === 'EEXIST') { const same = await existing(); await writeSnapshotIndex(dataDir); return same; } throw error; }
    const dirHandle = await open(directory, 'r');
    try { await dirHandle.sync(); } finally { await dirHandle.close(); }
    await writeSnapshotIndex(dataDir);
    return { status: 'written', path: target, snapshot };
  } finally { if (handle) await handle.close(); await unlink(temp).catch(error => { if (error.code !== 'ENOENT') throw error; }); }
}

function parseArgs(args) {
  const options = {};
  for (let i = 0; i < args.length; i += 2) {
    if (!['--data-dir', '--as-of'].includes(args[i]) || args[i + 1] === undefined) throw new Error('usage: --data-dir DIR --as-of UTC_SECOND');
    options[args[i] === '--data-dir' ? 'dataDir' : 'asOf'] = args[i + 1];
  }
  if (!options.asOf) throw new Error('--as-of is required');
  return options;
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try { const result = await captureUsMacroDiagnostic(parseArgs(process.argv.slice(2))); console.log(`${result.status}: ${result.path}`); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}
