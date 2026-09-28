# P1–P5 複核後修正：序列起始日以前不計缺值

Executor sol/medium；只有明確邊界修正，不再派子代理、不commit/push。
唯一可修改檔案：
- /Users/orangembpm2/work/code/personal_financial/PersonalFiance/js/tabs/breadthAdvanced.mjs
- /Users/orangembpm2/work/code/personal_financial/PersonalFiance/js/tabs/breadthAdvanced.test.mjs

[實測] 主session讀碼：missingSp500與missingNyse目前會計入各自首筆資料日前的benchmark日期；test第66行甚至預期missingNyse=3，應修正為0。
[查證] 使用者轉述Claude複核要求：僅修缺值診斷，不改指標、訊號或其他功能。
[決策] firstSp500Date與firstNyseDate各取對應data第一列日期（即使該列為null）。序列未提供或data空陣列無開始日，missing為0。首筆以前無值不計數；首筆起至benchmark末日，缺列/全null照舊計數；NYSE ratio分母0仍算缺值。MC invalidated邏輯不變。

新增三序列錯開測試：benchmark300天，sp500從第101筆起（index100），nyse最後50天（index250），seed日期合法；無實際缺口時兩missing=0、invalidated=false。再加入首筆null、中途缺列、尾部缺列，確認只計真缺值且MC invalidates。修正舊test預期，保留既有計算結果與warmup斷言。

驗收：node --test js/tabs/breadthAdvanced.test.mjs js/tabs/breadthSignals.test.mjs js/utils/eventStudy.test.mjs。回報分支/commit/merge、項數與任何偏離。主session另改Python oracle、規格及報告，禁止碰這些檔案或FINRA workflow/update_all。
