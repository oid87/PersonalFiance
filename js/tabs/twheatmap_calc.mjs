// 台股族群熱力圖的分組與等權計算（官方產業別 → 本專案大類）。
export const CATS = [
  { id: 'tech', name: '半導體與電子', inds: ['半導體', '電子零組件', '電腦及週邊設備', '光電', '通信網路', '電子通路', '資訊服務', '其他電子', '數位雲端', '電子商務'] },
  { id: 'trad', name: '傳產製造', inds: ['電機機械', '電器電纜', '化學', '塑膠', '鋼鐵', '汽車', '橡膠', '紡織纖維', '水泥', '玻璃陶瓷', '造紙', '食品', '油電燃氣', '綠能環保'] },
  { id: 'fin', name: '金融', inds: ['金融保險'] },
  { id: 'bio', name: '生技醫療', inds: ['生技醫療'] },
  { id: 'svc', name: '內需與服務', inds: ['建材營造', '航運', '觀光餐旅', '貿易百貨', '文化創意', '運動休閒', '居家生活', '農業科技', '綜合', '其他'] },
];

const avg = xs => xs.reduce((a, b) => a + b, 0) / xs.length;

// rows: [代號, 簡稱, 產業, 漲跌%|null]。漲跌非有限數者不列入平均，但算進總檔數。
export function groupRows(rows) {
  const byInd = new Map();
  for (const [code, name, ind, ret] of rows) {
    if (!byInd.has(ind)) byInd.set(ind, { total: 0, stocks: [] });
    const g = byInd.get(ind); g.total++;
    if (Number.isFinite(ret)) g.stocks.push({ code, name, ret });
  }
  const seen = new Set();
  const out = CATS.map(c => ({ ...c, inds: c.inds.filter(i => byInd.has(i)) }));
  const rest = [...byInd.keys()].filter(i => !CATS.some(c => c.inds.includes(i)));
  if (rest.length) out.push({ id: 'other', name: '未歸類', inds: rest });
  return out.map(c => {
    const groups = c.inds.map(i => { seen.add(i); const g = byInd.get(i); return { name: i, total: g.total, stocks: g.stocks.sort((a, b) => b.ret - a.ret), avg: g.stocks.length ? avg(g.stocks.map(s => s.ret)) : 0 }; })
      .filter(g => g.stocks.length).sort((a, b) => b.avg - a.avg);
    const all = groups.flatMap(g => g.stocks.map(s => s.ret));
    return { id: c.id, name: c.name, groups, n: groups.reduce((a, g) => a + g.total, 0), avg: all.length ? avg(all) : 0 };
  }).filter(c => c.groups.length);
}
