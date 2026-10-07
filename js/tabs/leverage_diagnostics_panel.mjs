// Mountable, read-only panel. Caller owns the data request and activation guards.
// The standalone tools workspace supplies the controls and local bundle.
import { buildLeverageDiagnostics } from './leverage_diagnostics.mjs';
import { WINDOW_LABEL } from './levvol_calc.mjs';

const pct = value => Number.isFinite(value) ? `${(value * 100).toFixed(1)}%` : '—';
const ratio = value => Number.isFinite(value) ? value.toFixed(3) : '—';
const money = value => Number.isFinite(value) ? `$${Math.round(value).toLocaleString('en-US')}` : '—';

export function mountLeverageDiagnostics(host, { bundle, settings }) {
  const document = host.ownerDocument;
  const model = buildLeverageDiagnostics(bundle, settings);
  const root = document.createElement('section');
  root.className = 'leverage-diagnostics';
  const appendText = (parent, tag, text) => {
    const element = document.createElement(tag);
    element.textContent = text;
    parent.append(element);
    return element;
  };
  appendText(root, 'h3', model ? `${model.id} · 既有槓桿診斷` : '槓桿診斷無可用標的');
  if (model) {
    appendText(root, 'p', `${model.underlyingName ?? model.underlying} · ${model.theoreticalLeverage}x · 資料更新 ${model.updated ?? '—'}`);
    appendText(root, 'p', model.underlyingPriceOnly
      ? '標的為價格指數，不含股息。'
      : '標的沿用既有 bundle 的含息資料口徑。');
    appendText(root, 'h4', '選定區間：歷史回測');
    const backtest = model.backtest;
    if (!backtest) appendText(root, 'p', '此區間無足夠資料，請調整日期。');
    else {
      appendText(root, 'p', `${backtest.startDate} → ${backtest.endDate} · ${backtest.observationCount} 個價格觀測 · ${backtest.syntheticDays} 天合成`);
      const list = document.createElement('dl');
      for (const [label, value] of [
        ['累計投入', money(backtest.contributed)],
        ['槓桿目前價值', money(backtest.leveragedValue)],
        ['無槓桿目前價值', money(backtest.underlyingValue)],
        ['槓桿總報酬率（目前價值 / 累計投入 − 1）', pct(backtest.leveragedReturn)],
        ['無槓桿總報酬率（目前價值 / 累計投入 − 1）', pct(backtest.underlyingReturn)],
        ['槓桿 NAV 最大回撤', pct(backtest.maxDrawdown)],
        ['最長水下天數（曆日）', String(backtest.longestUnderwaterDays)],
        ['是否回本', backtest.recoveredContribution ? '已回本' : '未回本'],
      ]) {
        appendText(list, 'dt', label);
        appendText(list, 'dd', value);
      }
      root.append(list);
      if (backtest.syntheticDays) appendText(root, 'p', `合成日沿用既有每日重置與成本假設；ETF 成立日 ${backtest.inception}，年化合成成本 ${pct(backtest.annualCost)}。實際與合成覆蓋以既有引擎結果為準。`);
      for (const [name, episodes] of [['槓桿 NAV', backtest.leveragedEpisodes], ['無槓桿 NAV', backtest.underlyingEpisodes]]) {
        appendText(root, 'h4', `${name} 最深回撤區間（沿用既有前五筆）`);
        if (!episodes.length) { appendText(root, 'p', '選定區間沒有回撤事件。'); continue; }
        const scroll = document.createElement('div'); scroll.className = 'table-scroll'; scroll.tabIndex = 0;
        scroll.setAttribute('role', 'region'); scroll.setAttribute('aria-label', `${name} 回撤表，可水平捲動`);
        const table = document.createElement('table'), head = document.createElement('thead'), header = document.createElement('tr');
        appendText(table, 'caption', `${name}：選定回測區間，曆日天數`);
        for (const label of ['峰值日', '谷底日', '恢復日', '深度', '曆日']) appendText(header, 'th', label).scope = 'col';
        head.append(header); table.append(head);
        const body = document.createElement('tbody');
        for (const episode of episodes) {
          const row = document.createElement('tr');
          for (const value of [episode.peakDate, episode.troughDate, episode.recDate ?? '尚未恢復', pct(episode.depth), String(episode.days)]) appendText(row, 'td', value);
          body.append(row);
        }
        table.append(body); scroll.append(table); root.append(scroll);
      }
    }
    appendText(root, 'h4', '全期重疊真實資料：波動率倍數');
    const volatility = model.volatility;
    if (!volatility) appendText(root, 'p', '資料不足（重疊價格觀測少於既有 257 筆門檻），無法計算。');
    else {
      appendText(root, 'p', `${volatility.startDate} → ${volatility.endDate} · ${volatility.dates.length} 個報酬觀測；本表使用全期真實資料，不隨上方回測區間裁切。`);
      const scroll = document.createElement('div');
      scroll.className = 'table-scroll';
      scroll.style.overflowX = 'auto';
      scroll.tabIndex = 0;
      scroll.setAttribute('role', 'region');
      scroll.setAttribute('aria-label', '波動率倍數表，可水平捲動');
      const table = document.createElement('table');
      table.className = 'info-table';
      appendText(table, 'caption', 'log return 母體標準差比值；窗口為價格觀測數，沿用既有月／季標籤');
      const head = document.createElement('thead');
      const header = document.createElement('tr');
      for (const label of ['窗口', 'median', 'mean', 'p5', 'p95', '有效樣本 n', '理論值']) {
        const cell = appendText(header, 'th', label);
        cell.scope = 'col';
      }
      head.append(header);
      table.append(head);
      const body = document.createElement('tbody');
      for (const window of volatility.windows) {
        const row = document.createElement('tr');
        for (const value of [WINDOW_LABEL[window.w], ratio(window.median), ratio(window.mean),
          ratio(window.p5), ratio(window.p95), String(window.n), String(model.theoreticalLeverage)]) {
          appendText(row, 'td', value);
        }
        body.append(row);
      }
      table.append(body);
      scroll.append(table);
      root.append(scroll);
      appendText(root, 'p', `單日基準（全期）：${ratio(volatility.dailyBaseline)} · 理論值 ${model.theoreticalLeverage}x`);
    }
  }
  host.replaceChildren(root);
  return { model, destroy() { root.remove(); } };
}
