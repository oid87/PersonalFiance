import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { scanSnapshots, validateSnapshotIndex } from './_us_macro_snapshot_index.mjs';

const DEFAULT_DATA = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../data');
export async function validateUsMacroDiagnosticSnapshots({ dataDir = DEFAULT_DATA } = {}) {
  const entries = await scanSnapshots(dataDir);
  await validateSnapshotIndex(dataDir, entries);
  return { count: entries.length, status: entries.length ? 'observed' : 'unsupported' };
}

function parseArgs(args) {
  if (!args.length) return {};
  if (args.length !== 2 || args[0] !== '--data-dir') throw new Error('usage: --data-dir DIR');
  return { dataDir: args[1] };
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try { const result = await validateUsMacroDiagnosticSnapshots(parseArgs(process.argv.slice(2))); console.log(`snapshots: ${result.count}; history: ${result.status}`); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}
