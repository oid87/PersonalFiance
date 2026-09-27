import { readdir, readFile, mkdir, open, rename, unlink } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import path from 'node:path';
import { canonicalJSON, verifyDiagnosticSnapshot, assertSupportedMacroDiagnosticMethodVersion } from '../js/utils/us_macro_diagnostic.js';

const MAX_BYTES = 2 * 1024 * 1024;
const HASH = /^sha256:[0-9a-f]{64}$/;
const DATE = /^\d{4}-\d\d-\d\d$/;
const UTC = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/;
const YEAR_TEMP = /^\.\d{4}-\d\d-\d\d\.[0-9a-f-]{36}\.tmp$/;
const INDEX_TEMP = /^\.index\.[0-9a-f-]{36}\.tmp$/;

export function snapshotRoot(dataDir) { return path.join(dataDir, 'us_macro_diagnostic_snapshots'); }
function hash(bytes) { return `sha256:${createHash('sha256').update(bytes).digest('hex')}`; }
function validUtc(value) {
  if (typeof value !== 'string' || !UTC.test(value)) return false;
  const millis = Date.parse(value);
  return Number.isFinite(millis) && new Date(millis).toISOString().replace('.000Z', 'Z') === value;
}

export async function scanSnapshots(dataDir) {
  const root = snapshotRoot(dataDir);
  let years;
  try { years = await readdir(root, { withFileTypes: true }); }
  catch (error) { if (error.code === 'ENOENT') return []; throw error; }
  const entries = [], localDates = new Set();
  for (const year of years) {
    if (year.isFile() && (year.name === 'index.json' || INDEX_TEMP.test(year.name))) continue;
    if (!year.isDirectory() || !/^\d{4}$/.test(year.name)) throw new Error(`unexpected snapshot entry: ${year.name}`);
    for (const item of await readdir(path.join(root, year.name), { withFileTypes: true })) {
      if (item.isFile() && YEAR_TEMP.test(item.name)) continue;
      if (!item.isFile() || !/^\d{4}-\d\d-\d\d\.json$/.test(item.name)) throw new Error(`unexpected snapshot file: ${item.name}`);
      const filename = path.join(root, year.name, item.name), bytes = await readFile(filename);
      if (bytes.length > MAX_BYTES) throw new Error(`snapshot exceeds 2 MiB: ${filename}`);
      let snapshot;
      try { snapshot = JSON.parse(bytes.toString('utf8')); }
      catch { throw new Error(`invalid snapshot JSON: ${filename}`); }
      if (bytes.toString('utf8') !== `${canonicalJSON(snapshot)}\n`) throw new Error(`noncanonical snapshot: ${filename}`);
      const localDate = item.name.slice(0, 10);
      if (!DATE.test(localDate) || localDate.slice(0, 4) !== year.name || snapshot.local_date_Taipei !== localDate) throw new Error(`snapshot path/date mismatch: ${filename}`);
      if (Object.hasOwn(snapshot, 'data')) throw new Error(`snapshot has forbidden data key: ${filename}`);
      await verifyDiagnosticSnapshot(snapshot);
      if (localDates.has(localDate)) throw new Error(`duplicate Taipei snapshot date: ${localDate}`);
      localDates.add(localDate);
      entries.push({ path: `${year.name}/${item.name}`, sha256: hash(bytes), as_of: snapshot.as_of,
        captured_at: snapshot.captured_at, method_version: snapshot.method_version });
    }
  }
  entries.sort((a, b) => a.as_of.localeCompare(b.as_of));
  for (let i = 1; i < entries.length; i++) if (entries[i].as_of <= entries[i - 1].as_of) throw new Error('snapshot as_of is not strictly increasing');
  return entries;
}

export async function readSnapshotIndex(dataDir) {
  let bytes;
  try { bytes = await readFile(path.join(snapshotRoot(dataDir), 'index.json')); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  let index;
  try { index = JSON.parse(bytes.toString('utf8')); }
  catch { throw new Error('invalid snapshot index JSON'); }
  if (bytes.toString('utf8') !== `${canonicalJSON(index)}\n`) throw new Error('noncanonical snapshot index');
  if (!index || Object.keys(index).sort().join(',') !== 'entries,schema_version' || index.schema_version !== 1 || !Array.isArray(index.entries)) throw new Error('invalid snapshot index schema');
  const dates = new Set();
  for (let i = 0; i < index.entries.length; i++) {
    const entry = index.entries[i];
    if (!entry || Object.keys(entry).sort().join(',') !== 'as_of,captured_at,method_version,path,sha256' ||
        !/^(\d{4})\/\1-\d\d-\d\d\.json$/.test(entry.path) || !HASH.test(entry.sha256) ||
        !validUtc(entry.as_of) || !validUtc(entry.captured_at) || typeof entry.method_version !== 'string') throw new Error('invalid snapshot index entry');
    assertSupportedMacroDiagnosticMethodVersion(entry.method_version);
    const localDate = new Date(Date.parse(entry.as_of) + 8 * 3600000).toISOString().slice(0, 10);
    if (entry.path !== `${localDate.slice(0, 4)}/${localDate}.json` || dates.has(localDate)) throw new Error('snapshot index path/date mismatch or duplicate');
    dates.add(localDate);
    if (i && entry.as_of <= index.entries[i - 1].as_of) throw new Error('snapshot index order invalid');
  }
  return index;
}

export async function validateSnapshotIndex(dataDir, entries) {
  const index = await readSnapshotIndex(dataDir);
  if (index === null) {
    if (entries.length) throw new Error('snapshot index missing');
    return;
  }
  if (canonicalJSON(index.entries) !== canonicalJSON(entries)) throw new Error('snapshot index does not match saved snapshots');
}

export async function writeSnapshotIndex(dataDir) {
  const entries = await scanSnapshots(dataDir);
  const root = snapshotRoot(dataDir);
  await mkdir(root, { recursive: true });
  const temp = path.join(root, `.index.${randomUUID()}.tmp`), target = path.join(root, 'index.json');
  let handle;
  try {
    handle = await open(temp, 'wx', 0o600);
    await handle.writeFile(`${canonicalJSON({ schema_version: 1, entries })}\n`, 'utf8');
    await handle.sync(); await handle.close(); handle = null;
    await rename(temp, target);
    const directory = await open(root, 'r');
    try { await directory.sync(); } finally { await directory.close(); }
  } finally {
    if (handle) await handle.close();
    await unlink(temp).catch(error => { if (error.code !== 'ENOENT') throw error; });
  }
  return entries;
}
