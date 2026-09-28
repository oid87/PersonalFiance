# P3/P4/P5 獨立驗收包

Role sol/high；不再派子代理。工作目錄 `/Users/orangembpm2/work/code/personal_financial/PersonalFiance`，分支main、未commit為預期；不stage、不commit、不push。只可寫本報告 `docs/breadth_p3p4p5_verification.md`，程式唯讀；問題回報主session，不自行修改。

先讀AGENTS.md、docs/breadth_p3p4p5_spec.md、docs/breadth_p3p4p5_import.md。集中盤點已完成，檔案由spec列明，不掃其他工作。核心、UI已有實作；執行最後驗收前確認其測試檔已落地，root會通知。可先做公式與API review。

證據：
- [實測] 主session已跑 `python3 scripts/test_breadth_advanced_oracle.py` ，PASS，輸出 `/tmp/breadth-p345-oracle.json`。該脚本與JS共享合成input但獨立以Python標準庫重算；請自己讀/跑，不能只信PASS。
- [實測] 本輪前快照 `/var/folders/9k/tn8t5r9501j_dcxz7czy03lr0000gn/T/breadth-p345-before-lwkl7fv_` 含index/css/breadth/boot/workflow/update_all及data SHA256。須核對data未變，index既有區域、breadth最小接線，無P1/P2回歸。
- [查證] 既有P1/P2 18個JS/7個Python測試；新core/browser實作需追加跑；真實資料來源仍未取得，不得把合成PASS說成真實回測PASS。

驗收重點：
1. 自訂import schema嚴格驗證、非數值不coerce、日期正確/亂序/重複/超軸/空資料、count null/zero分離、文字安全與容量；不把 metadata source 當外部驗證。
2. AD分段與完整200MA、252前日條件、一年前是252sessions不是日曆天；t條件與相等。MC alpha/ratio分母、seed/未校準門檻禁用、252warmup、missing/ratio0 invalidates以後、首尾補缺規則。
3. P5 raw事件差<=5，較晚確認、不使用未來；同日/5/6、雙順序、保守joint eligible；冷卻先全史後range；baseline與全部7期的統計、n、maxloss/MDD。
4. 圖表/明細帶來源、版本、初始化、小n、描述性/成分偏誤、日期軸不是完整交易所日曆、非Bluekurtic重現。無真實資料時等待而不是偽報零事件。
5. import clear/error/race、HTML metadata、theme/mobile、缺一市場/未校準、上方4universes獨立且P1/P2失敗不擋新panel。
6. 命令：node --test js/tabs/breadthAdvanced.test.mjs js/tabs/breadthSignals.test.mjs js/utils/eventStudy.test.mjs；python3 scripts/test_breadth_advanced_oracle.py；.venv/bin/python -m unittest scripts.tests.test_breadth_schema -v；node scripts/test_breadth_advanced_browser.cjs；node scripts/test_breadth_browser.cjs；python3 ../Financial_work/check_reuse.py js/tabs/breadth.js；git diff --check。Browser uses http://127.0.0.1:8766 and PLAYWRIGHT_MODULE existing local npx cache. Do not rerun data fetches. New helper panel not direct boot registered lint may skip: manual review shared utils required.
7. 若必要可寫/tmp獨立探針但不要重跑全專案或改baseline配合實作。異常最多2次重試。

報告須為可給Claude複核的獨立文件：PASS/FAIL/限制分開、source+formula、實跑命令與數字、檔案:行號證據、偏離、未涵蓋事項、分支/commit/merge。不把live-source未接入隱藏成全部完成；區分軟體可驗收與市場資料待接入。報告連结root可重現oracle與規格，別只寫/tmp不可重現結果。
最後訊息≤15行，優先列blocker與限制，通知root收件。
