# Trendonify PE Ratio 參考來源

- 網址：<https://trendonify.com/pe-ratio>
- 用途：參考用的各市場／指數 PE ratio 對照頁；目前**未接入**任何 producer 或 `data/` 快照。
- 取得狀態（2026-10-14）：頁面有 Cloudflare 機器人驗證，WebFetch 回 HTTP 403，內建瀏覽器停在「正在執行安全驗證」。
  尚未取得頁面上的 PE 數值，也不繞過驗證；需由 owner 在瀏覽器手動開啟，或另找可程式化的授權來源。
- 既有本地 PE 資料：`data/SP500_PE.json`、`data/WSJ_PE.json`、`data/CAPE.json`、`data/forward_pe_voo.jsonl`、`data/forward_pe_qqq.jsonl`。
- 接入前須先核對：頁面使用條款是否允許抓取、PE 口徑（trailing／forward）、資料日期與更新頻率。
