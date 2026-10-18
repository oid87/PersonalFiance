// 美股去槓桿研究：把 data/*.json 與 data/research/us_delever/*.json 組成引擎輸入。唯讀、離線。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = rel => JSON.parse(fs.readFileSync(path.join(ROOT, rel), 'utf8'));

export function loadRaw() {
  const hist = read('data/research/us_delever/cftc_tff_2019_2021.json');
  const cur = read('data/cftc_positions.json');
  const byId = new Map();
  for (const src of [hist, cur]) for (const ins of src.instruments) {
    if (!byId.has(ins.id)) byId.set(ins.id, { ...ins, rows: new Map() });
    for (const r of ins.rows) byId.get(ins.id).rows.set(r.date, r);          // 後者（現行管線）覆蓋前者
  }
  const cftc = [...byId.values()].map(i => ({ id: i.id, name: i.name, contract_code: i.contract_code, rows: [...i.rows.values()] }));
  const finraRel = read('data/research/us_delever/finra_release_dates.json');
  return {
    raw: {
      spy: read('data/SPY.json').data, qqq: read('data/QQQ.json').data,
      vix: read('data/VIX.json').data, vxn: read('data/VXN.json').data, vixTerm: read('data/vix_term.json').data,
      creditSpread: read('data/credit_spread.json').data, hyg: read('data/HYG.json').data, lqd: read('data/LQD.json').data,
      breadth: read('data/breadth.json').data, fearGreed: read('data/fear_greed.json').data,
      nfci: read('data/nfci.json').data, cftc,
      finra: read('data/margin_global_us.json').data, finraRelease: finraRel.release,
    },
    meta: {
      cftcUpdated: cur.updated, cftcHistYears: hist.years, nfciUpdated: read('data/nfci.json').updated,
      finraUpdated: read('data/margin_global_us.json').updated, finraSource: read('data/margin_global_us.json').source,
      finraCaptures: { total: finraRel.capture_count, parsed: finraRel.parsed_count }, finraRelease: finraRel.release,
    },
  };
}
