const yahooFinance = require('yahoo-finance2').default;

module.exports = async function handler(req, res) {
  const { ticker } = req.query;
  if (!ticker) return res.status(400).json({ error: 'ticker required' });

  const symbol = ticker.toUpperCase();
  const period1 = new Date();
  period1.setFullYear(period1.getFullYear() - 10);

  try {
    const rows = await yahooFinance.historical(symbol, {
      period1: period1.toISOString().slice(0, 10),
      interval: '1d',
    }, { validateResult: false });

    if (!rows?.length) {
      return res.status(404).json({ error: `No data found for ${symbol}` });
    }

    const today = new Date().toISOString().slice(0, 10);
    const data = rows
      .filter(r => r.close != null)
      .map(r => ({
        date: r.date.toISOString().slice(0, 10),
        open:   Math.round(r.open   * 10000) / 10000,
        high:   Math.round(r.high   * 10000) / 10000,
        low:    Math.round(r.low    * 10000) / 10000,
        close:  Math.round(r.close  * 10000) / 10000,
        volume: r.volume ?? 0,
      }));

    res.setHeader('Cache-Control', 'public, s-maxage=3600, max-age=3600');
    return res.json({ symbol, updated: today, data });
  } catch (err) {
    const msg = String(err.message || err);
    const status = msg.includes('404') || msg.includes('No data') ? 404 : 500;
    return res.status(status).json({ error: `${symbol}: ${msg}` });
  }
};
