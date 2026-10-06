---
name: add-tab
description: >
  在 PersonalFiance 新增一個儀表板 tab 的完整程序
  （catalogue 接線 + ECharts 慣例 + 驗收清單）。
  Use when adding a new tab/chart page to PersonalFiance.
---

# add-tab skill

## 用途

新增 tab 從 `js/scaffold/_template.js` 起手，同步加入單一導覽清單與 HTML section。

## 模組合約：`js/tabs/<id>.js`

```js
export async function activate({ signal, isCurrent } = {}) { ... }
export function getCharts() { return [chart].filter(Boolean); }
export function onThemeChange(light) { ... }
export function resize() { ... }
```

`switcher.js` 每次切入都 await `activate(context)`（兼容 `init`）。用共用 `requestJSON`／`ensureLoaded` 並傳 signal，驗證必要 payload；必要資料失敗 throw，optional 失敗明示 partial。資料準備完成且 `isCurrent()` 仍為 true 才提交 state／render，不能吞錯讓 dispatcher 誤判成功。首次 render 必須在 activate resolve 前完成。詳細契約見 `docs/runtime-contracts.md`。

## 接線

1. `js/navigation-catalog.mjs` 的 `CATEGORIES` 加入 `{ id, label }`，選擇既有八分類之一；需要時新增搜尋 aliases。
2. 檔案預設 `js/tabs/<id>.js`；只有檔名不同才加入同檔 `MODULE_FILE` 例外。`boot.js` 自動由 catalogue 產生 lazy registry，不新增靜態 import。
3. `index.html` 新增 `<section id="tab-<id>" class="tab-section" hidden>...</section>`。選單按鈕由 `navigation.js` 產生。
4. 更新 `navigation.test.mjs` 中預期畫面清單，驗證搜尋／modulePath／重複 id；先接線再跑 reuse lint。

## ECharts / 主題慣例

- 主題色用 CSS 變數，不要寫死：`--bg` / `--panel` / `--border` / `--text` /
  `--muted`。
- 初始化：`echarts.init(el, isLight() ? null : 'dark')`（`isLight()` 來自
  `../utils/theme.js`）。
- 資料從 `data/*.json` 經 `utils/data.js` 的共用 request API 讀取，不要 inline。

## ECharts 眉角（歷史踩坑）

- `xAxis.type: 'time'` 時，tooltip 的 `axisValue` 是**毫秒 timestamp**，要
  用 `utils/dates.js` 的 `tsToLocalDate(axisValue)`，不是字串日期。
- 雙 grid（上下疊圖）要兩個 `xAxis` 設同一組 `min`/`max`，且 `dataZoom` 要
  `xAxisIndex: [0, 1]`，否則兩張圖縮放不同步。
- series 顏色寫在 `itemStyle.color`，legend 色塊才會跟著同色。

## 需要新資料源時

先呼叫 `fetch-script` skill 建立 `scripts/fetch_xxx.py` 並接上
`source_manifest.json` + `update_all.sh` + `.github/workflows/fetch.yml`，資料就緒後再回來寫
`js/tabs/<id>.js`。

## 驗收清單

- [ ] preview 開啟後切到新 tab，console 無 error；未切入前不得抓該頁資料
- [ ] 必要來源 HTTP／壞 JSON／空或畸形 payload 失敗後可重試；optional 缺失明示 partial
- [ ] iPhone 16e 直向／橫向與短高度操作可及，主要觸控目標至少 44×44 CSS px
- [ ] 亮/暗主題與 resize／隱藏後重返保留 chart zoom、legend，無殘影
- [ ] 視窗 resize 後 chart 跟著調整大小
- [ ] 若加了新資料源：`scripts/fetch_xxx.py` / `.github/workflows/fetch.yml`
      / `scripts/update_all.sh` / `scripts/source_manifest.json` 都有改到

## Ship 清單

完成後把實作檔（`js/tabs/<id>.js`、若有新資料源則含 `scripts/fetch_*.py`）
與 wiring（`js/navigation-catalog.mjs`、`index.html`）一起 `git add`，放進同一個 commit。
不要用 `git add -A`。
