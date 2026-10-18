---
name: add-tab
description: >
  在 PersonalFiance 新增一個儀表板 tab 的完整程序
  （wiring 三處 + ECharts 慣例 + 驗收清單）。
  Use when adding a new tab/chart page to PersonalFiance.
---

# add-tab skill

## 用途

新增一個 tab 需要同步改 `js/boot.js` 兩處與 `index.html` 一處，加上一個新
模組檔。這個 skill 封裝完整程序，確保沒有遺漏 wiring。

## 模組合約：`js/tabs/<id>.js`

```js
export async function init() { ... }          // 或 activate()
export function onThemeChange(light) { ... }  // 選用：主題切換時重建 chart
export function resize() { ... }              // 選用：resize 時 chart.resize()
```

`switcher.js` 切到該 tab 時呼叫 `entry.module.activate || entry.module.init`
——**每次**切入都會呼叫，不只是第一次，所以函式內部要自己做 guard（如
`if (!chart) chart = echarts.init(...)`、`if (rows) return` 略過重複
fetch），達到「首次切入才真的載入資料」的效果。參考 `js/tabs/umich.js`。

## Wiring 三處

1. `js/boot.js` — import：`import * as <id>Tab from './tabs/<id>.js';`
2. `js/boot.js` — `registerAll([...])` 加一行：`{ id: '<id>', module: <id>Tab },`
3. `js/boot.js` — `CATEGORIES` 陣列，選一個既有分類加入
   `{ id: '<id>', label: '<中文標籤>' }`：
   - `sentiment`（情緒類）／`liquidity`（流動性/壓力類）／
     `position`（位階/估值/趨勢類）／`analysis`（產業輪動/分析類）
4. `index.html` — 新增
   `<section id="tab-<id>" class="tab-section" hidden>...</section>`。
   nav 按鈕**不用**手動加，`renderSubNav()` 依 `CATEGORIES` 動態渲染。

## ECharts / 主題慣例

- 主題色用 CSS 變數，不要寫死：`--bg` / `--panel` / `--border` / `--text` /
  `--muted`。
- 初始化：`echarts.init(el, isLight() ? null : 'dark')`（`isLight()` 來自
  `../utils/theme.js`）。
- 資料一律從 `data/*.json` 用 `fetch()` 讀取，不要 inline。

## ECharts 眉角（歷史踩坑）

- `xAxis.type: 'time'` 時，tooltip 的 `axisValue` 是**毫秒 timestamp**，要
  自己 `new Date(axisValue)` 格式化，不是字串日期。
- 雙 grid（上下疊圖）要兩個 `xAxis` 設同一組 `min`/`max`，且 `dataZoom` 要
  `xAxisIndex: [0, 1]`，否則兩張圖縮放不同步。
- series 顏色寫在 `itemStyle.color`，legend 色塊才會跟著同色。

## 需要新資料源時

先呼叫 `fetch-script` skill 建立 `scripts/fetch_xxx.py` 並接上
`update_all.sh` + `.github/workflows/fetch.yml`，資料就緒後再回來寫
`js/tabs/<id>.js`。

## 驗收清單

- [ ] preview 開啟後切到新 tab，console 無 error
- [ ] 亮/暗主題切換正常，chart 重繪無殘影
- [ ] 視窗 resize 後 chart 跟著調整大小
- [ ] 若加了新資料源：`scripts/fetch_xxx.py` / `.github/workflows/fetch.yml`
      / `scripts/update_all.sh` 三處都有改到

## Ship 清單

完成後把實作檔（`js/tabs/<id>.js`、若有新資料源則含 `scripts/fetch_*.py`）
與 wiring（`js/boot.js`、`index.html`）一起 `git add`，放進同一個 commit。
不要用 `git add -A`。
