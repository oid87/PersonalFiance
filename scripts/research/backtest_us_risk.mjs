// Frozen input + config -> byte-reproducible descriptive research output.
import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { runStudy } from '../../js/tabs/usrisk_calc.mjs';
const args = process.argv.slice(2);
function arg(key, fallback) { const i = args.indexOf(key); if (i < 0) return fallback; if (!args[i + 1]) throw new Error('Missing value: ' + key); return args[i + 1]; }
const file = arg('--input', new URL('../../data/us_risk_observations.json', import.meta.url));
const bytes = readFileSync(file);
const config = JSON.parse(arg('--config', '{}'));
const result = runStudy(JSON.parse(bytes), config);
const output = JSON.stringify({ input_sha256: createHash('sha256').update(bytes).digest('hex'), ...result }, null, 2) + '\n';
const out = arg('--out', null);
if (out) writeFileSync(out, output); else process.stdout.write(output);
