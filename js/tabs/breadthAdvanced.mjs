const MAX_BYTES = 10 * 1024 * 1024;
const MAX_ROWS = 20000;
const LOOKBACK = 252;
const JOINT_WINDOW = 5;
const finite = value => typeof value === 'number' && Number.isFinite(value);
const fail = message => { throw new TypeError(message); };
function object(value, name) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(`${name} must be an object`);
}
function date(value, name) {
  const time = typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) ? Date.parse(`${value}T00:00:00Z`) : NaN;
  if (!Number.isFinite(time) || new Date(time).toISOString().slice(0, 10) !== value) fail(`${name}: invalid YYYY-MM-DD date`);
  return value;
}
function metadata(value, name) {
  if (typeof value !== 'string' || !value.trim() || value.length > 500) fail(`${name} must be nonempty text, at most 500 characters`);
  return value.trim();
}
function rows(value, name, check, axis = null) {
  if (!Array.isArray(value) || value.length > MAX_ROWS) fail(`${name} must be an array of at most ${MAX_ROWS} rows`);
  let previous = null;
  return value.map((row, index) => {
    object(row, `${name}[${index}]`);
    const d = date(row.date, `${name}[${index}]`);
    if (previous !== null && d <= previous) fail(`${name} dates must be strictly increasing and unique`);
    if (axis && !axis.has(d)) fail(`${name} date ${d} is absent from benchmark sessions`);
    previous = d;
    return { date: d, ...check(row, `${name}[${index}]`) };
  });
}
function counts(row, name) {
  const values = [row.advances, row.declines, row.unchanged];
  if (!values.every(value => value === null)) {
    if (!values.every(value => Number.isSafeInteger(value) && value >= 0)) fail(`${name} counts must all be nonnegative safe integers, or all null`);
    const total = values.reduce((a, b) => a + b, 0);
    if (!Number.isSafeInteger(total) || total <= 0) fail(`${name} count total must be positive and safe`);
  }
  return { advances: values[0], declines: values[1], unchanged: values[2] };
}

/** Validate and copy the custom local-import format; never retain input references. */
export function parseBreadthImport(input) {
  let value = input;
  if (typeof input === 'string') {
    if (new TextEncoder().encode(input).byteLength > MAX_BYTES) fail('JSON import exceeds 10 MiB');
    try { value = JSON.parse(input); } catch { fail('Invalid JSON import'); }
  }
  object(value, 'Import');
  if (value.schemaVersion !== 1) fail('schemaVersion must be 1');
  object(value.benchmark, 'benchmark');
  if (value.benchmark.symbol !== 'SP500') fail('benchmark.symbol must be SP500');
  const benchmark = { symbol: 'SP500', source: metadata(value.benchmark.source, 'benchmark.source'),
    priceBasis: metadata(value.benchmark.priceBasis, 'benchmark.priceBasis'),
    data: rows(value.benchmark.data, 'benchmark.data', (row, name) => {
      if (row.close !== null && (!finite(row.close) || row.close <= 0)) fail(`${name}.close must be positive and finite, or null`);
      return { close: row.close };
    }) };
  if (!benchmark.data.length) fail('benchmark requires at least one session');
  const axis = new Set(benchmark.data.map(row => row.date));
  const bundle = { schemaVersion: 1, benchmark };
  for (const [name, universe] of [['sp500', 'SP500'], ['nyse', 'NYSE']]) {
    if (value[name] === undefined) continue;
    const series = value[name]; object(series, name);
    if (series.universe !== universe) fail(`${name}.universe must be ${universe}`);
    const copy = { universe, source: metadata(series.source, `${name}.source`),
      constituentsBasis: metadata(series.constituentsBasis, `${name}.constituentsBasis`),
      priceBasis: metadata(series.priceBasis, `${name}.priceBasis`), data: rows(series.data, `${name}.data`, counts, axis) };
    if (name === 'nyse') {
      if (!['raw', 'ratio'].includes(series.variant)) fail('nyse.variant must be raw or ratio');
      copy.variant = series.variant;
      if (series.seed === null) copy.seed = null;
      else {
        const seed = series.seed; object(seed, 'nyse.seed');
        const d = date(seed.date, 'nyse.seed');
        if (copy.data.length && d >= copy.data[0].date) fail('nyse.seed.date must precede the first NYSE row');
        if (![seed.ema19, seed.ema39, seed.summation].every(finite)) fail('nyse.seed states must be finite numbers');
        if (seed.calibration !== 'provider') fail('nyse.seed.calibration must be provider');
        copy.seed = { date: d, ema19: seed.ema19, ema39: seed.ema39, summation: seed.summation,
          source: metadata(seed.source, 'nyse.seed.source'), calibration: 'provider' };
      }
    }
    bundle[name] = copy;
  }
  if (!bundle.sp500 && !bundle.nyse) fail('At least one of sp500 or nyse is required');
  return bundle;
}

/** Project the stored self-calculation onto the benchmark's existing session axis. */
export function projectSp500Bundle(adFile, sp500File) {
  object(adFile, 'adFile'); object(adFile.meta, 'adFile.meta'); object(sp500File, 'sp500File');
  const ad = rows(adFile.data, 'adFile.data', counts);
  if (!ad.length) fail('adFile requires at least one observation');
  const benchmarkRows = rows(sp500File.data, 'sp500File.data', row => ({ close: row.close }));
  const benchmark = { symbol: 'SP500', source: 'yfinance ^GSPC（data/SP500.json）',
    priceBasis: '原始收盤（auto_adjust=False）', data: benchmarkRows.filter(row => row.date >= ad[0].date) };
  const axis = new Set(benchmark.data.map(row => row.date));
  const droppedDates = ad.filter(row => !axis.has(row.date)).map(row => row.date);
  const bundle = parseBreadthImport({ schemaVersion: 1, benchmark,
    sp500: { universe: 'SP500', source: adFile.meta.source, constituentsBasis: adFile.meta.constituentsBasis,
      priceBasis: adFile.meta.priceBasis, data: ad.filter(row => axis.has(row.date)) } });
  return { bundle, droppedDates };
}

/** Full-history calculations on the supplied benchmark session axis. */
export function buildAdvancedContext(input) {
  const bundle = parseBreadthImport(input);
  const adRows = new Map(bundle.sp500?.data.map(row => [row.date, row]) ?? []);
  const mcRows = new Map(bundle.nyse?.data.map(row => [row.date, row]) ?? []);
  const seed = bundle.nyse?.seed;
  const firstSp500Date = bundle.sp500?.data[0]?.date ?? null;
  const firstNyseDate = bundle.nyse?.data[0]?.date ?? null;
  let ad = 0, adWindow = [], adWindowSum = 0;
  let ema19 = seed?.ema19 ?? null, ema39 = seed?.ema39 ?? null, summation = seed?.summation ?? 0;
  let mcCount = 0, invalidated = false, missingSp500 = 0, missingNyse = 0;
  const sessions = bundle.benchmark.data.map(price => {
    const s = { date: price.date, close: price.close, ad: null, adMA200: null,
      oscillator: null, summation: null, mcReady: false, mcCalibrated: false };
    const a = adRows.get(price.date);
    if (!a || a.advances === null) {
      if (firstSp500Date && price.date >= firstSp500Date) missingSp500++;
      ad = 0; adWindow = []; adWindowSum = 0;
    } else {
      ad += a.advances - a.declines;
      if (!Number.isSafeInteger(ad)) fail('A-D cumulative value exceeds safe integer range');
      s.ad = ad;
      if (adWindow.length === 200) {
        adWindowSum -= adWindow.shift();
        if (!Number.isSafeInteger(adWindowSum)) fail('A-D rolling sum exceeds safe integer range');
      }
      adWindow.push(ad); adWindowSum += ad;
      if (!Number.isSafeInteger(adWindowSum)) fail('A-D rolling sum exceeds safe integer range');
      if (adWindow.length === 200) s.adMA200 = adWindowSum / 200;
    }
    const m = mcRows.get(price.date);
    const denominator = m && m.advances !== null ? m.advances + m.declines : null;
    const valid = m && m.advances !== null && (bundle.nyse.variant === 'raw' || denominator > 0);
    if (firstNyseDate && price.date >= firstNyseDate && !valid) missingNyse++;
    if (firstNyseDate && price.date >= firstNyseDate) {
      if (!valid) invalidated = true;
      if (!invalidated) {
        const net = bundle.nyse.variant === 'raw' ? m.advances - m.declines : 1000 * (m.advances - m.declines) / denominator;
        if (ema19 === null) { ema19 = net; ema39 = net; }
        else { ema19 = 0.1 * net + 0.9 * ema19; ema39 = 0.05 * net + 0.95 * ema39; }
        const oscillator = ema19 - ema39;
        summation += oscillator;
        if (![ema19, ema39, summation, oscillator].every(finite)) fail('McClellan calculation exceeds finite numeric range');
        mcCount++;
        Object.assign(s, { oscillator, summation, mcReady: mcCount >= LOOKBACK,
          mcCalibrated: Boolean(seed) && mcCount >= LOOKBACK });
      }
    }
    return s;
  });
  const signals = { ad: [], mc: [], joint: [] }, eligibleDates = { ad: [], mc: [], joint: [] };
  let adValidRun = 0, adAboveRun = 0, mcValidRun = 0, mcAboveRun = 0, jointRun = 0;
  let latestAd = null, latestMc = null;
  const evidence = (s, adDate, mcDate, lagSessions = null) => ({ date: s.date, adDate, mcDate, lagSessions,
    ad: s.ad, adMA200: s.adMA200, summation: s.summation });
  sessions.forEach((s, i) => {
    const adValid = s.ad !== null && s.adMA200 !== null;
    const mcValid = s.mcCalibrated;
    const adEligible = s.close !== null && adValid && adValidRun >= LOOKBACK;
    const mcEligible = s.close !== null && mcValid && mcValidRun >= LOOKBACK;
    const jointEligible = adEligible && mcEligible && jointRun >= JOINT_WINDOW;
    if (adEligible) eligibleDates.ad.push(s.date);
    if (mcEligible) eligibleDates.mc.push(s.date);
    if (jointEligible) eligibleDates.joint.push(s.date);
    const adEvent = adEligible && s.ad < s.adMA200 && adAboveRun >= LOOKBACK;
    const mcEvent = mcEligible && s.summation < -500 && mcAboveRun >= LOOKBACK;
    if (adEvent) { signals.ad.push(evidence(s, s.date, null)); latestAd = { date: s.date, index: i }; }
    if (mcEvent) { signals.mc.push(evidence(s, null, s.date)); latestMc = { date: s.date, index: i }; }
    if (jointEligible && (adEvent || mcEvent) && latestAd && latestMc) {
      const lag = Math.abs(latestAd.index - latestMc.index);
      if (lag <= JOINT_WINDOW) signals.joint.push(evidence(s, latestAd.date, latestMc.date, lag));
    }
    adValidRun = adValid ? adValidRun + 1 : 0;
    adAboveRun = adValid && s.ad > s.adMA200 ? adAboveRun + 1 : 0;
    mcValidRun = mcValid ? mcValidRun + 1 : 0;
    mcAboveRun = mcValid && s.summation >= -500 ? mcAboveRun + 1 : 0;
    jointRun = adEligible && mcEligible ? jointRun + 1 : 0;
  });
  return { prices: bundle.benchmark.data, sessions, signals, eligibleDates,
    meta: { variant: bundle.nyse?.variant ?? null, calibrated: Boolean(seed), jointWindow: JOINT_WINDOW, warmup: LOOKBACK, yearSessions: LOOKBACK },
    diagnostics: { missingSp500, missingNyse, mcInvalidated: invalidated },
    latest: { benchmark: bundle.benchmark.data.at(-1)?.date ?? null,
      sp500: bundle.sp500?.data.at(-1)?.date ?? null, nyse: bundle.nyse?.data.at(-1)?.date ?? null } };
}
