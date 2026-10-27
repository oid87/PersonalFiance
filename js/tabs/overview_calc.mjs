// 每日總覽的卡片定義。每個數字都來自明細頁自己的 overviewSummary()（重用該頁的載入與門檻），
// 或該頁同一支純計算函式；這裡只決定「顯示哪幾個數字、點下去到哪一頁」，不另訂門檻。
// 明細頁模組用動態 import，與導覽載入的是同一個模組實例（同一 URL），之後打開該頁不必重抓資料。
import { requestJSON, ensureLoaded } from '../utils/data.js';
import { loaded } from '../state.js';
import { multiPeriodZones } from './pentagram_calc.mjs';
import { buildForeign } from './twforeign_calc.mjs';

const isNum = v => typeof v === 'number' && Number.isFinite(v);
const fmt = (v, d = 2) => (isNum(v) ? v.toFixed(d) : '—');
const need = (value, what) => {
  if (value == null) throw new Error(what + '暫無資料');
  return value;
};
const lastWith = (rows, field) => [...(rows || [])].reverse().find(r => isNum(r?.[field])) || null;

// 同一次 activate 內，多張卡共用同一頁的摘要（例如極端狀態卡與 VIX 列都讀 nonnormal）。
const memo = new WeakMap();
function once(context, key, load) {
  let cache = memo.get(context);
  if (!cache) memo.set(context, cache = new Map());
  if (!cache.has(key)) cache.set(key, Promise.resolve().then(load));
  return cache.get(key);
}
const summary = (context, file) =>
  once(context, file, async () => (await import(`./${file}.js`)).overviewSummary(context));

// ── 警報（美股兩頁合成「美股警報」，所以是三張）───────────────────────────────
// level：ok／watch／alert，各頁原本的分級對應過來，不重算。
export const ALERT_CARDS = [
  {
    title: '極端狀態（台股為主＋國際）', tab: 'nonnormal',
    async load(context) {
      const s = need(await summary(context, 'nonnormal'), '極端狀態');
      const { now, prev } = s;
      return {
        level: now.level === 0 ? 'ok' : now.level === 1 ? 'watch' : 'alert',
        state: s.level.label,
        detail: `${now.count}/${now.available} 個訊號亮・${now.groups} 組` +
          (prev ? `；上週 ${prev.count} 個` : ''),
        date: now.date,
      };
    },
  },
  {
    title: '美股警報（恐慌拋售）', tab: 'uscap',
    async load(context) {
      const { asset, cfg, status: st } = need(await summary(context, 'uscap'), '美股警報');
      need(st, '美股價格');
      const e = st.eff;
      const [level, state] = st.anyA === true ? ['alert', 'Stage A 恐慌性拋售成立']
        : st.anySensitive === true ? ['watch', '敏感層成立（VXN ≥ ' + cfg.vxnSensitive + '）']
        : st.stageC?.confirmed ? ['watch', `止穩確認（Stage C，${st.stageC.confirmed.date}）`]
        : st.anyA === false ? ['ok', '未觸發'] : [null, '資料不足'];
      return {
        level, state, date: st.date,
        detail: `VIX ${fmt(e.vix, 1)}（門檻 ${cfg.vix}）・VXN ${fmt(e.vxn, 1)}（${cfg.vxn}）・${asset} 距 ${cfg.lookback} 日高回撤 ${fmt(st.day?.dd, 1)}%（${cfg.gate}%）`,
      };
    },
  },
  {
    title: '台股融資去槓桿', tab: 'marginalert',
    async load(context) {
      const s = need(await summary(context, 'marginalert'), '融資警報');
      const zone = s.zone?.key;
      const level = s.triggered || zone === 'boom' ? 'alert' : zone === 'warn' ? 'watch' : zone === 'ok' ? 'ok' : null;
      return {
        level,
        state: (s.zone?.label || '維持率資料不足') + (s.triggered ? `・今日融資單日 ≤ −${s.th}%` : ''),
        detail: `融資維持率（重建）${fmt(s.ratio, 1)}%；警戒 ${s.warn}、爆炸 ${s.boom}`,
        date: s.ratioDate || s.date,
      };
    },
  },
];

// ── 六個主題：每列 { label, load(context) → { value, state, color, date } } ───────────
const today = () => new Date().toISOString().slice(0, 10);   // 與 pentagram 多週期同一個 UTC 今日

function pentaRow(ticker) {
  return {
    label: `${ticker} 五線譜位置（3.5 年）`,
    async load(context) {
      await ensureLoaded(ticker, context);
      const rows = need(loaded[ticker]?.length ? loaded[ticker] : null, ticker);
      const zone = need(multiPeriodZones(rows, ['3.5Y'], today())[0]?.zone, ticker + ' 通道');
      return { value: zone.label, color: zone.color, date: rows.at(-1)[0] };
    },
  };
}

function fpeRow(label, file, note) {
  return {
    label,
    async load(context) {
      const row = need(lastWith((await requestJSON(file, { signal: context.signal }))?.data, 'fpe'), label);
      return { value: fmt(row.fpe, 1) + 'x', state: note, date: row.date };   // 估值頁狀態列也是 1 位小數
    },
  };
}

function summaryRow(label, file, pick = s => s) {
  return {
    label,
    async load(context) {
      const s = need(await summary(context, file), label);
      return { value: s.value, state: s.signal, color: s.color, date: s.date, ...pick(s) };
    },
  };
}

function sentimentRow(label, file, module, labelFn, colorFn) {
  return {
    label,
    async load(context) {
      const [payload, mod] = await Promise.all([requestJSON(file, { signal: context.signal }), import(module)]);
      const latest = need(isNum(payload?.latest?.composite) ? payload.latest : null, label);
      return { value: fmt(latest.composite, 1), state: mod[labelFn](latest.composite), color: mod[colorFn](latest.composite), date: latest.date };
    },
  };
}

const FG_RATING = { 'extreme fear': '極度恐懼', fear: '恐懼', neutral: '中性', greed: '貪婪', 'extreme greed': '極度貪婪' };

export const THEME_CARDS = [
  {
    title: '位階與估值',
    tab: { us: 'valuation', tw: 'valuation' }, go: { us: '估值', tw: '估值' },
    rows: {
      us: [pentaRow('VOO'), fpeRow('SPY Forward P/E', 'data/SPY_valuation.json', '前 20 大持股加權')],
      tw: [pentaRow('0050'), fpeRow('台股 Forward P/E', 'data/TW_valuation.json', '大盤代理')],
    },
  },
  {
    title: '情緒與部位',
    tab: { us: 'sentiment', tw: 'twsent' }, go: { us: '情緒總分', tw: '台股情緒' },
    rows: {
      us: [
        sentimentRow('複合情緒（0–100）', 'data/sentiment.json', './sentiment.js', 'sentLabel', 'sentColor'),
        {
          label: 'CNN 恐懼貪婪',
          async load(context) {
            const row = need(lastWith((await requestJSON('data/fear_greed.json', { signal: context.signal }))?.data, 'value'), 'F&G');
            return { value: fmt(row.value, 0), state: FG_RATING[String(row.rating).toLowerCase()] || row.rating, date: row.date };
          },
        },
      ],
      tw: [sentimentRow('台股情緒（0–100）', 'data/taiwan_sentiment.json', './twsentiment.js', 'fgLabel', 'fgColor')],
    },
  },
  {
    title: '籌碼與融資',
    tab: { us: 'marginpeak', tw: 'twforeign' }, go: { us: '美股與全球融資', tw: '台股法人籌碼' },
    rows: {
      us: [{
        label: 'FINRA 融資餘額年增率',
        async load(context) {
          const s = need(await summary(context, 'marginpeak'), '融資峰值');
          return { value: fmt(s.yoy, 1) + '%', state: s.yoy > 50 ? '高於峰值訊號 A 門檻 50%' : '低於峰值訊號 A 門檻 50%', date: s.date?.slice(0, 7) };
        },
      }],
      tw: [{
        label: '外資近 20 日淨買賣超',
        async load(context) {
          const m = await once(context, 'twforeign', async () => {
            const [f, t] = await Promise.all([
              requestJSON('data/tw_foreign_net.json', { signal: context.signal }),
              requestJSON('data/TWII.json', { signal: context.signal })]);
            need(Array.isArray(f?.data) && f.data.length && Array.isArray(t?.data) && t.data.length ? true : null, '外資買賣超');
            return buildForeign(f.data, t.data, { thr: 5, cooldown: 20, horizon: 20 });
          });
          const i = m.dates.length - 1, v = m.sums[20][i], p = m.pct20[i];
          return {
            value: isNum(v) ? `${v >= 0 ? '+' : ''}${v.toLocaleString('en-US', { maximumFractionDigits: 2, minimumFractionDigits: 2 })}億` : '—',
            color: isNum(v) ? (v >= 0 ? '#3fb950' : '#f85149') : null,
            state: isNum(p) ? `近 5 年百分位 ${p.toFixed(1)}%（越低賣超越重）` : '歷史樣本不足',
            date: m.dates[i],
          };
        },
      }],
    },
  },
  {
    title: '壓力與波動',
    tab: { us: 'stressdash', tw: 'twstress' }, go: { us: '金融壓力', tw: '台股壓力' },
    rows: {
      us: [
        {
          label: 'VIX',
          async load(context) {
            const s = need(await summary(context, 'nonnormal'), 'VIX');
            const v = need(s.vix, 'VIX');
            const N = await import('./nonnormal_calc.mjs');
            return { value: fmt(v.value), state: N.VIX_ZONES[v.zone]?.label, date: v.asOf };
          },
        },
        summaryRow('OFR 金融壓力指數', 'fsi'),
      ],
      tw: [summaryRow('台股綜合壓力（0–100）', 'twstress')],
    },
  },
  {
    title: '總經',
    tab: { us: 'usmacro', tw: 'twcycle' }, go: { us: '經濟成長', tw: '景氣' },
    rows: {
      us: [{
        label: '美國總經四組指標',
        async load(context) {
          const s = need(await summary(context, 'usmacro'), '美國總經');
          const c = s.counts;
          return { value: s.text, state: c ? `轉強 ${c.positive}／轉弱 ${c.negative}／持平 ${c.neutral}／分歧 ${c.divergent}` : '方向資料不足', date: String(s.date).slice(0, 10) };
        },
      }],
      tw: [{
        label: '國發會景氣燈號',
        async load(context) {
          const [payload, { bandOf }] = await Promise.all([
            requestJSON('data/taiwan_business_signal.json', { signal: context.signal }), import('./twcycle.js')]);
          const rows = (payload?.data || []).filter(r => typeof r?.date === 'string' && isNum(r.score));
          const last = need(rows.at(-1), '景氣燈號'), prev = rows.at(-4), b = bandOf(last.score);
          const diff = prev ? last.score - prev.score : 0;
          return { value: `${b.name} ${last.score} 分`, color: b.color, date: last.date.slice(0, 7),
            state: `${b.desc}・近 3 月 ${diff > 0 ? '▲ 升溫' : diff < 0 ? '▼ 降溫' : '→ 持平'}${diff ? ` ${diff > 0 ? '+' : ''}${diff} 分` : ''}` };
        },
      }],
    },
  },
  {
    title: '流動性與利率',
    tab: { us: 'net_liquidity', tw: 'liquidity' }, go: { us: '美元流動性', tw: '全球流動性' },
    rows: {
      us: [
        // 水位本身沒有好壞，顏色只屬於「近 3 月變化」，所以這裡不染色。
        summaryRow('聯準會淨流動性', 'net_liquidity', s => ({ state: s.chg3m ? `${s.signal} ${s.chg3m}` : null, color: null })),
        summaryRow('10Y−2Y 利差', 'yield_curve'),
      ],
      tw: ['m1b_yoy', 'm2_yoy'].map(field => ({
        label: field === 'm1b_yoy' ? 'M1B 年增率' : 'M2 年增率',
        async load(context) {
          const rows = await once(context, 'liquidity_leverage', async () =>
            (await requestJSON('data/liquidity_leverage.json', { signal: context.signal }))?.tw?.monthly || []);
          const row = need(lastWith(rows, field), field);
          const other = lastWith(rows, field === 'm1b_yoy' ? 'm2_yoy' : 'm1b_yoy');
          const gap = field === 'm1b_yoy' && other && other.date === row.date ? (row.m1b_yoy >= other.m2_yoy ? 'M1B 高於 M2' : 'M1B 低於 M2') : null;
          return { value: fmt(row[field]) + '%', state: gap, date: row.date.slice(0, 7) };
        },
      })),
    },
  },
];
