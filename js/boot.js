import { SERIES, loaded, active } from './state.js';
import { isLight } from './utils/theme.js';
import { isDataFresh, loadSeries, ensureLoaded } from './utils/data.js';
import { registerAll, switchTo, applyThemeAll, setupResizeHandler } from './switcher.js';

import * as trendTab     from './tabs/trend.js';
import * as pentagramTab from './tabs/pentagram.js';
import * as macroTab     from './tabs/macro.js';
import * as corrTab      from './tabs/corr.js';
import * as sectorTab    from './tabs/sector.js';
import * as cashkingTab  from './tabs/cashking.js';
import * as sentimentTab from './tabs/sentiment.js';
import * as breadthTab   from './tabs/breadth.js';
import * as earningsTab  from './tabs/earnings.js';
import * as valuationTab from './tabs/valuation.js';
import * as leverageTab  from './tabs/leverage.js';
import * as aaiiTab      from './tabs/aaii.js';
import * as twSentTab    from './tabs/twsentiment.js';
import * as positionTab  from './tabs/position.js';
import * as liquidityTab from './tabs/liquidity.js';
import * as bullbearTab  from './tabs/bullbear.js';
import * as waveTab      from './tabs/wave.js';
import * as twCycleTab   from './tabs/twcycle.js';
import * as vixSkewTab   from './tabs/vixskew.js';
import * as fsiTab        from './tabs/fsi.js';
import * as nfciTab       from './tabs/nfci.js';
import * as twStressTab   from './tabs/twstress.js';
import * as umichTab      from './tabs/umich.js';
import * as flowsTab      from './tabs/flows.js';
import * as inflationTab  from './tabs/inflation.js';
import * as creditTab        from './tabs/credit.js';
import * as twSectorFlowTab  from './tabs/twsectorflow.js';
import * as wkrevTab         from './tabs/wkrev.js';
import * as marginheatTab    from './tabs/marginheat.js';
import * as marginpeakTab    from './tabs/marginpeak.js';
import * as baniniTab        from './tabs/banini.js';
import * as qqqmacdTab       from './tabs/qqqmacd.js';
import * as structTab        from './tabs/struct.js';
import * as toolsTab         from './tabs/tools.js';
import * as netLiqTab        from './tabs/net_liquidity.js';
import * as yieldCurveTab    from './tabs/yield_curve.js';
import * as vixTermTab       from './tabs/vix_term.js';
import * as realRatesTab     from './tabs/real_rates.js';
import * as moneyMktTab      from './tabs/money_market.js';
import * as putcallTab       from './tabs/putcall.js';
import * as centralBanksTab  from './tabs/central_banks.js';
import * as inflNowcastTab   from './tabs/infl_nowcast.js';

registerAll([
  { id: 'trend',     module: trendTab     },
  { id: 'pentagram', module: pentagramTab },
  { id: 'macro',     module: macroTab     },
  { id: 'corr',      module: corrTab      },
  { id: 'sector',    module: sectorTab    },
  { id: 'cashking',  module: cashkingTab  },
  { id: 'sentiment', module: sentimentTab },
  { id: 'breadth',   module: breadthTab   },
  { id: 'earnings',  module: earningsTab  },
  { id: 'valuation', module: valuationTab },
  { id: 'leverage',  module: leverageTab  },
  { id: 'aaii',      module: aaiiTab      },
  { id: 'twsent',    module: twSentTab    },
  { id: 'position',  module: positionTab  },
  { id: 'liquidity', module: liquidityTab },
  { id: 'bullbear',  module: bullbearTab  },
  { id: 'wave',      module: waveTab      },
  { id: 'twcycle',   module: twCycleTab   },
  { id: 'vixskew',   module: vixSkewTab   },
  { id: 'fsi',       module: fsiTab       },
  { id: 'nfci',      module: nfciTab      },
  { id: 'twstress',  module: twStressTab  },
  { id: 'umich',     module: umichTab     },
  { id: 'flows',    module: flowsTab     },
  { id: 'inflation', module: inflationTab },
  { id: 'credit',        module: creditTab        },
  { id: 'twsectorflow',  module: twSectorFlowTab  },
  { id: 'wkrev',         module: wkrevTab         },
  { id: 'marginheat',    module: marginheatTab    },
  { id: 'marginpeak',    module: marginpeakTab    },
  { id: 'banini',        module: baniniTab        },
  { id: 'qqqmacd',       module: qqqmacdTab       },
  { id: 'struct',        module: structTab        },
  { id: 'tools',         module: toolsTab         },
  { id: 'net_liquidity', module: netLiqTab        },
  { id: 'yield_curve',   module: yieldCurveTab    },
  { id: 'vix_term',      module: vixTermTab       },
  { id: 'real_rates',    module: realRatesTab     },
  { id: 'money_market',  module: moneyMktTab      },
  { id: 'putcall',       module: putcallTab       },
  { id: 'central_banks', module: centralBanksTab  },
  { id: 'infl_nowcast',  module: inflNowcastTab   },
]);

setupResizeHandler();

const CATEGORIES = [
  {
    id: 'sentiment', tabs: [
      { id: 'sentiment', label: '複合情緒' },
      { id: 'aaii',      label: '散戶情緒' },
      { id: 'twsent',    label: '台股情緒' },
      { id: 'bullbear',  label: '牛熊' },
      { id: 'umich',     label: '消費者信心' },
      { id: 'flows',    label: '資金脈衝' },
      { id: 'banini',   label: '反指標(8zz)' },
      { id: 'putcall',  label: 'Put/Call' },
    ]
  },
  {
    id: 'liquidity', tabs: [
      { id: 'liquidity', label: '流動性×槓桿' },
      { id: 'marginheat', label: '融資熱度' },
      { id: 'breadth',   label: '市場廣度' },
      { id: 'fsi',       label: '金融壓力' },
      { id: 'nfci',      label: '金融狀況' },
      { id: 'twstress',  label: '台股壓力' },
      { id: 'vixskew',   label: 'VIX-SKEW' },
      { id: 'inflation', label: '通膨預期' },
      { id: 'credit',    label: '信用' },
      { id: 'net_liquidity', label: '淨流動性' },
      { id: 'yield_curve',   label: '殖利率曲線' },
      { id: 'vix_term',      label: 'VIX期限結構' },
      { id: 'real_rates',    label: '實質利率' },
      { id: 'money_market',  label: '貨幣市場' },
      { id: 'central_banks', label: '全球央行資產' },
      { id: 'infl_nowcast',  label: '通膨Nowcast' },
    ]
  },
  {
    id: 'position', tabs: [
      { id: 'trend',     label: '趨勢' },
      { id: 'pentagram', label: '五線譜' },
      { id: 'macro',     label: '宏觀' },
      { id: 'valuation', label: '估值' },
      { id: 'position',  label: '位階' },
      { id: 'struct',    label: '結構判讀' },
      { id: 'twcycle',   label: '景氣燈號' },
      { id: 'tools',     label: '工具箱' },
    ]
  },
  {
    id: 'analysis', tabs: [
      { id: 'corr',     label: '相關係數' },
      { id: 'sector',        label: '產業輪動' },
      { id: 'twsectorflow',  label: '外資板塊流向' },
      { id: 'cashking',      label: '現金為王' },
      { id: 'earnings', label: '財報日' },
      { id: 'wave',     label: '波浪理論' },
      { id: 'leverage', label: '槓桿模擬' },
      { id: 'wkrev',    label: '週K反轉' },
      { id: 'qqqmacd',  label: 'MACD死叉' },
      { id: 'marginpeak', label: '融資峰值' },
    ]
  },
];

function renderSubNav(cat, activeTabId) {
  const subNav = document.getElementById('sub-nav');
  subNav.innerHTML = cat.tabs.map(t =>
    `<button class="sub-btn${t.id === activeTabId ? ' active' : ''}" data-tab="${t.id}">${t.label}</button>`
  ).join('');
  subNav.querySelectorAll('.sub-btn').forEach(btn =>
    btn.addEventListener('click', () => {
      subNav.querySelectorAll('.sub-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      switchTo(btn.dataset.tab);
    })
  );
}

function applyTheme(light) {
  document.body.classList.toggle("light", light);
  document.getElementById("theme-btn").textContent = light ? "☾" : "☀";
  localStorage.setItem("theme", light ? "light" : "dark");
  applyThemeAll(light);
}

document.getElementById("theme-btn").addEventListener("click", () => applyTheme(!isLight()));

// Default: 位置 category, 趨勢 tab
let _activeCat = CATEGORIES.find(c => c.id === 'position');
renderSubNav(_activeCat, 'trend');

document.querySelectorAll(".cat-btn").forEach(btn =>
  btn.addEventListener("click", () => {
    document.querySelectorAll(".cat-btn").forEach(b => b.classList.remove("active"));
    btn.classList.add("active");
    _activeCat = CATEGORIES.find(c => c.id === btn.dataset.cat);
    const firstTab = _activeCat.tabs[0].id;
    renderSubNav(_activeCat, firstTab);
    switchTo(firstTab);
  })
);

(async () => {
  const status = document.getElementById("status");
  if (localStorage.getItem("theme") === "dark") applyTheme(false);
  try {
    await Promise.all(SERIES.filter(s => active.has(s.key)).map(loadSeries));
    trendTab.renderSeriesPicker();
    trendTab.render();
    pentagramTab.renderPentaTickerPicker();
    const lastDates = Object.values(loaded).map(d => d[d.length - 1]?.[0]).filter(Boolean);
    const latestDate = lastDates.sort().at(-1);
    const allFresh = Object.values(loaded).every(isDataFresh);
    status.textContent = `已載入 ${Object.keys(loaded).length} 個指標 · 最新資料 ${latestDate}${allFresh ? "" : " ⚠ 部分資料可能過期"} · 點選 chip 切換顯示`;

    // Pre-load VIX for signal panel, macro data in background
    ensureLoaded("VIX").then(() => trendTab.renderSignalPanel()).catch(() => {});
    macroTab.loadMacroData().catch(() => {});
    trendTab.renderSignalPanel();
  } catch (err) {
    status.textContent = `載入失敗：${err.message}`;
  }
})();

document.getElementById("penta-fpe-toggle")?.addEventListener("click", () => pentagramTab.toggleFpe());
document.getElementById("trend-fpe-toggle")?.addEventListener("click", () => trendTab.toggleTrendFpe());

document.querySelectorAll("#val-range-picker .chip").forEach(chip =>
  chip.addEventListener("click", () => {
    document.querySelectorAll("#val-range-picker .chip").forEach(c => c.classList.remove("active"));
    chip.classList.add("active");
    valuationTab.setRange(chip.dataset.valRange);
  })
);

document.querySelectorAll(".info-panel-header").forEach(h => {
  h.addEventListener("click", () => {
    h.classList.toggle("open");
    h.nextElementSibling.classList.toggle("open");
  });
});
