# 市場廣度第一輪 A：資料可行性調查

## 目標與難度
建立 P0／P3／P4 的可核對資料來源決策表；本包只研究，不實作抓取管線、不購買或訂閱。難度 medium：來源、定義、歷史範圍與可重現性需要判斷。executor 使用 gpt-6-sol / medium，不再派子代理。

## 唯一可新增檔案
- `/Users/orangembpm2/work/code/personal_financial/PersonalFiance/docs/breadth_phase1_sources.md`
其餘檔案唯讀；不修改 data、程式、設定、memory；不 commit、不 push。若需臨時資料用系統暫存目錄，不留憑證。

## 已知證據
- [實測] 主 session 讀取 `scripts/_breadth.py:78`：現有廣度為股價高於自身20/50/200MA的比例，不是 A-D line。
- [實測] 主 session 讀取 `scripts/fetch_breadth.py:27`：S&P500名單取當前Wikipedia。`index.html:739`明示今日成分股回算的倖存者／前視偏誤。
- [查證] McClellan官方說明 ratio-adjusted daily breadth = 1000*(A-D)/(A+D)，版本與中性點不同，不可盲搬-500門檻：https://www.mcoscillator.com/learning_center/kb/market_data/ratio_adjusted_summation_index/ 及 https://www.mcoscillator.com/learning_center/kb/market_data/summation_index_and_zero/ 。需由你重開頁核對。
- [未知／調查標的] NYSE長期每日A/D、S&P500歷史成分股及成分股A/D序列的可下載性、範圍與授權尚未確定。本包交付就是辨識這些未知，不把它們當作已成立的實作前提。

## 怎麼做（定案流程）
1. 只讀本spec、repo AGENTS.md；本包不掃描程式庫。沿用上列已盤點背景。
2. 研究兩條路線：(a)可靠提供者直接給歷史S&P500 A-D／NYSE A/D或McClellan序列；(b)以point-in-time成分股＋個股歷史收盤重建S&P500 A/D。說明兩者適用場景。
3. 優先查第一方官方資料與文件，候選最多5個提供者，web search最多8次工具呼叫，URL打開／端點取樣合計最多15次。兩次同類失敗就停止該來源。不要展開到其他技術指標或策略研究。
4. 每個來源記錄：精確URL、股票母體（NYSE全部證券／普通股等）、原始／比例調整版本、可證實起訖、粒度、下載／API方式、登入／費用／授權限制、CI是否可用，以及證據等級。沒有公開證據的欄位寫「未確認」，不可推測。
5. 能合法公開取樣的來源最多3個，每個只取足以確認schema與值的少量資料。報告留請求方法、實測日期、HTTP狀態、header/欄位及2-3列原始樣本；來源只提供圖表或文字時明確標為文件查證，不能稱為API可用。不得繞過登入／付費／反爬。
6. 若遇PDF/PPT/Excel/Word，依使用者要求先以 `~/.local/bin/markitdown <file> -o <file>.md` 轉換再讀；不要直接解析原檔。為控制成本，優先HTML／JSON／CSV。
7. 定義最低可行方案及升級方案，分別回答：目前能觀察什麼、能回測什麼、不能宣稱什麼。付費且未取得的資料只列選項，不要求使用者現在購買。
8. 列出重建A-D與McClellan必須先固定的口徑：成分股生效日、IPO/退市/缺值、平盤、拆股與配息調整、EMA與加總初始化、warmup、中性點、門檻版本；本輪只列決策項與有證據的建議，不發明Bluekurtic原始算法。

## 交付與驗收
- 交付繁中Markdown，至多180行，含「候選來源表」「原始取樣證據」「建議與阻礙」「尚未確認」「deviations」五段。
- 每個影響決策的事實使用[實測]/[查證]/[推論]/[未確認]標記並附URL或憑據；來源schema/額度/歷史/授權不得用推論填空。
- 明確區分官方指數母體與proxy、當日觀察與可用於無前視回測的歷史。
- 不聲稱重現附件訊號；没有原始資料或完整條件時寫不可驗證。
- 完成回覆≤12行：檔案路徑、首選路線、阻礙、deviations、分支名、是否commit/合回（本包應為未commit、不適用）。不貼整份報告。

## 不做
不修改產品、不跑全量回填、不產生投資訊號、不開新chat、不建立automation、不再發包、不承諾免費長期資料必然可得。
