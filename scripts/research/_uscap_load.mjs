// Loads the repository's own data files into the shape js/tabs/uscap_calc.mjs expects (shared by the CLI and ad-hoc checks).
import { readFileSync, existsSync } from 'node:fs';
const root = new URL('../../', import.meta.url);
const read = path => JSON.parse(readFileSync(new URL(path, root), 'utf8'));
const optional = path => (existsSync(new URL(path, root)) ? read(path) : null);
export function loadRaw() {
  const rows = p => read(p).data;
  const term = rows('data/vix_term.json');
  return {
    SPY: rows('data/SPY.json'), QQQ: rows('data/QQQ.json'), VIX: rows('data/VIX.json'), VXN: rows('data/VXN.json'),
    vixTerm: term, putcall: read('data/putcall.json'), HYG: rows('data/HYG.json'), credit: rows('data/credit_spread.json'),
    breadth: rows('data/breadth.json'), breadthNdx: rows('data/breadth_ndx.json'),
    cftc: { main: read('data/cftc_positions.json'), history: optional('data/research/us_delever/cftc_tff_2019_2021.json') },
    finra: rows('data/margin_global_us.json'),
  };
}
