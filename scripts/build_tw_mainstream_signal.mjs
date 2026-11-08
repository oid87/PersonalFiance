#!/usr/bin/env node
// 無主流日判定結果 → data/tw_mainstream_signal.json（給其他分頁／日後綜合訊號讀取）。
// 讀 data/tw_mainstream.json（scripts/fetch_tw_mainstream.py 產生的原始事實），用 js/tabs/mainstream_calc.mjs 的預設參數判定。
import { readFileSync, writeFileSync } from 'node:fs';
import { MAINSTREAM, LEVELS, judgeAll, summary } from '../js/tabs/mainstream_calc.mjs';

const D = new URL('../data/', import.meta.url);
const src = JSON.parse(readFileSync(new URL('tw_mainstream.json', D), 'utf8'));
const j = judgeAll(src.data);
writeFileSync(new URL('tw_mainstream_signal.json', D), JSON.stringify({
  source: 'data/tw_mainstream.json 以 js/tabs/mainstream_calc.mjs 判定（本專案定義）',
  note: 'level：0＝有主流族群、1＝稍微有、2＝完全沒有；strong＝開盤即鎖漲停家數多（強勢、無進場點，不算完全沒有）；count22＝近 22 個交易日完全沒有的次數；turn＝前一天完全沒有、今天有。',
  updated: src.updated, params: MAINSTREAM, levels: LEVELS, latest: summary(j),
  data: j.map(d => ({ date: d.date, level: d.level, strong: d.strong, cands: d.cands, groups: d.groups.length, count22: d.count, streak: d.streak, turn: d.turn })),
}) + '\n');
console.log(`wrote ${j.length} rows; latest ${j.at(-1)?.date} ${LEVELS[j.at(-1)?.level]}`);
