# Helper AI Agent 全流程體驗分析與改善計劃

日期：2026-09-07。分析基準：已 fetch 的最新 `origin/main`，`9086ddd0a8fca304a9b0e778c8cac1dfa4704190`；當時無 open PR。

狀態：分析與建議設計，尚未實作、合併或部署。本文件依使用者要求直接產出完整改善計劃；取代只修「review denial 清 checkpoint」的局部處理範圍。既有權限、資料治理及 main 行為約束繼續有效。

## 1. 產品目標與判準

Helper 應是能理解目標、選工具、讀結果、追問、修正、接續與完成任務的 AI Agent。使用者不需要知道 function 名稱、固定步驟或特定關鍵字。伺服器控制能做什麼、資料可見性及副作用，Agent 控制如何理解與協助完成。

例：「存這份主日後舉牌服事表」附完整內容，應直接形成具體預覽；「第二週改成乙組」「這會讓其他群組查到嗎」「先查下週，剛才的等一下再存」「回到剛才那份」都應可接續。只在缺少必要資訊或有真實衝突時追問；只有與特定有效預覽綁定的明確確認能提交寫入。

採用 LangChain 本身不保證這種體驗。Agent 前後的路由、狀態轉換、工具結果與回覆呈現若攔截對話，仍會退化成固定流程。

### 不可退讓的邊界

- 工具採 allowlist、strict schema、來源限制、每次執行重新授權；模型提議不構成權限。
- 寫入只對伺服器產生的有效預覽確認；參數、目標或 revision 改變必須重新預覽。
- 群組依 requester 隔離；不錄整群聊天、不建立具名行為側寫。長期記憶維持明確保存意圖。
- 附件保持 opt-in、用途限制、Asset 掃描、clean-only、outbox 與唯一 worker 發布路徑。
- main 的最終行為與 provider-free 保證維持。可以調整共用程式，無需為「不碰檔案」增加繞路。
- 不新增自製 planner/router、通用 slot engine、影子 agent、自由 shell、任意 HTTP 或無界迴圈。
- 本輪不擴大 context 或增加框架依賴來掩蓋互動問題。

## 2. 調查方式與證據界線

已閱讀 README、architecture-context，以及 ingress/profile runtime、agent、checkpoint、review、write/read adapters、policy gateway、action executor、附件文字流程、背景工作、persona/memory policy 與 evaluator 關鍵路徑。

下表的「確認」指本次在程式可直接追蹤的行為，不表示每個案例都已在線上發生。「風險」需要新增整合／真實模型案例驗證。前次事故 telemetry 是上一輪調查紀錄，本次未重新調閱生產 log；不能推斷該使用者當時究竟選了哪個工具或送了哪些參數。

本次不使用真實群組資料建立公開 fixture，不呼叫付費 DeepSeek API。已執行 helper-agent-runtime、helper-agent-review、helper-agent-state 三個測試檔，49/49 通過；這只證明既有契約，包括目前不理想的清除行為，不能證明體驗已改善。文件另以 Prettier 檢查。

## 3. 已找到的主要體驗缺口

| ID／優先    | 證據與位置                                                                                                                     | 可能看到的體驗                                                            | 改善方向                                                                              |
| ----------- | ------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| F01 P0 確認 | `runtime.ts` 的 ReviewCreationFailure 跨過 `state.run`；`state.ts` catch 刪除整個 thread；runtime test 明確要求刪除            | 預覽不成功後忘記原內容，必須重貼                                          | 可恢復工具／業務錯誤留在 SDK 對話內；不能把每個 exception 當 checkpoint 損壞          |
| F02 P0 確認 | `action-executor.ts:preview` 只接受 writePhase=preview，其他 handler 結果變 undefined；寫入 schema 允許空內容                  | 缺日期、domain 歧義或缺內容都可能變「無法建立確認」，Agent 拿不到真正原因 | preview 準備回傳 typed needs-input／ambiguous／denied／unavailable，讓 Agent 修復參數 |
| F03 P0 確認 | `review.ts:resumeHelperReview` 先 take review；只有精確「確認」批准、「取消」取消，其餘一律 reject 舊案再送模型                | 問「會存多久？」就失去原待確認；「好，存吧」被當修改                      | 分開 approval 事件與一般對話；詢問保留草稿，修改才產生新預覽                          |
| F04 P0 確認 | review 修改後無新 interrupt 仍呼叫 createActionReview，回 denied；runtime 回舊 job 狀態                                        | Agent 已回答問題或追問，LINE 卻顯示「這項確認已結束」                     | 接受正常完成／追問回覆，只有新有效 proposal 建立 review                               |
| F05 P1 確認 | handleTextTurn 先接管 pending review 再檢查 reset；policy key 包含 persona、有效工具及 domain revision                         | reset／切換題目可能進修改流程；配置或授權變化使整段記憶失效               | 明確 reset 優先處理所有同 scope 待辦；將授權失效與一般對話記憶失效分開                |
| F06 P1 確認 | webhook 的 intro、附件及 deterministic continuation 先於 agent；沒有同一處 checkpoint 同步                                     | 按第二個拿到檔案後，Agent 不知道「剛才那份」；流程對話分裂                | helper 自然文字進單一 agent；確定性事件以最小安全結果同步 SDK state                   |
| F07 P1 確認 | attachment handler 有 pending 就 matches；awaiting_title 將任何非取消文字當 title；confirmation 限定固定詞                     | 「先查服事表」被存成檔名；修改用途或問問題被要求固定回覆                  | 以工具管理附件草稿；Agent 理解與收集用途／名稱，伺服器驗證與確認                      |
| F08 P1 確認 | production conversationWindowSeconds=60，checkpoint group TTL=15m；入口還有 review／附件等例外                                 | 無待辦時一分鐘後回「下週呢」可能不被受理，像失憶                          | 明確區分喚醒與記憶，對已受理且仍在追問的任務提供 bounded 續談資格                     |
| F09 P1 確認 | runtime `researchAllowed ? researchTools : writeTools`，同意有效期跟 thread TTL                                                | 找過歌譜後同一 thread 的存服事表工具消失                                  | 同意約束外部查詢操作及來源範圍，不把整個會話永久切成另一套產品模式                    |
| F10 P1 確認 | runtime 只選最後 invocationOrder 的 authoritative 結果                                                                         | 一次要歌譜與投影片，可能只拿到最後一份；模型整理被直接覆蓋                | 收集所有相關安全結果；Agent 做文字統整，transport 綁定驗證過的檔案按鈕                |
| F11 P1 確認 | tool-result.ts 定義 asOf/revision/freshness，但 projectToolResult 未填；字串320字、10筆、總2000字截斷，無截斷旗標              | 無法知道資料是否新、還有幾筆；誤把片段當全文                              | 型別白名單投影新鮮度與 coverage，必要時工具分頁；維持不洩漏內部 ID／URL               |
| F12 P1 確認 | postbacks.ts 背景 turn 完成時要求 executedAction，否則 missing_capability_owner                                                | 慢的正常文字答案、綜合答覆或追問生成成功，取結果卻失敗                    | 結果 job 支援 scope-bound agent response；資料／連結仍按來源權限驗證                  |
| F13 P1 確認 | createActionReview 只接受一個 actionRequest                                                                                    | 一句要求存兩項，模型平行 proposal 可能整批 denied 並觸發 F01              | 預設一次有效寫入預覽，其餘目標留在 checkpoint；拒絕多提案須可恢復                     |
| F14 P1 風險 | 800 output tokens、4 model／4 tool calls；摘要與 transport 重試共享計數                                                        | 長服事表重述入 tool args 截斷；總結／重试用完預算變通用錯誤               | 優先避免重送完整草稿，工具回 bounded evidence；只依量測調參，預算耗盡回報進度         |
| F15 P1 風險 | review 5m、checkpoint 15/30m、job至少30m，session與checkpoint分兩種store                                                       | 預覽過期但 interrupt 還在；舊按鈕／部署後接續卡住                         | 分清草稿、確認權杖與結果保存；過期只失去批准資格，不默默重寫或無限等待                |
| F16 P1 確認 | gateway denied 合併 schema/source/permission；read unavailable 合併 provider/timeout；review resume 未接相同 metrics callbacks | 看不出是問錯、沒權限還是服務掛掉；多輪token統計不完整                     | 安全 reason enum＋統一回合用量與恢復事件，不記原文                                    |
| F17 P1 確認 | liveReviewCase 僅 save_memory 假 handler，檢查 preview／revision，沒有確認後持久化                                             | live綠燈卻漏掉真實服事表業務驗證與LINE多輪交互                            | 增加真實domain+暫存store的端到端任務，不把 fake model 綠燈當理解能力                  |
| F18 P2 風險 | persona要求簡短，但未完整描述追問、插話、複合任務、無工具時的限制說明                                                          | 泛用回應、文字假確認、假完成或不必要的多次詢問                            | 寫具體合作行為準則，以模型實測驗證；不能只靠prompt保證安全                            |

相關檔案均以 `src/helper-agent/` 為預設目錄；例外已注明。F01 至 F04 構成前次症狀的共用失敗鏈；F02 的確切 domain 拒絕原因仍需重現。

## 4. User case 完整驗收矩陣

每案使用 synthetic 資料，覆蓋 1:1 與已註冊群組；有群組限制的案例測 requester A/B。下列是期望行為，尚未聲稱通過。

| Case | 多輪輸入／情境                            | 必須達成                                                           | 對應        |
| ---- | ----------------------------------------- | ------------------------------------------------------------------ | ----------- |
| U01  | 問候→問能做什麼→查服事表                  | 自然說明目前可用功能，接續查詢                                     | F06,F18     |
| U02  | 查服事表→下週呢→只要舉牌                  | 每輪授權查詢，保留限定範圍                                         | F06,F08     |
| U03  | 查服事表，官方與筆記同名                  | 正式來源優先，真實歧義才問，不把筆記當正式表                       | F02,F18     |
| U04  | 查最新→明確改去年九月                     | 預設最新有效資料；明示歷史覆蓋預設                                 | F11         |
| U05  | 存完整舉牌表，含兩個月份                  | 對完整日期／全部項目做預覽；需分月時說明，不能只存首月             | F02,F13,F14 |
| U06  | 只說「幫我存服事表」                      | 問必要內容一次，下一輪能接續                                       | F01,F02     |
| U07  | 貼日期無年份、日期星期衝突、同名domain    | 確定的預設在預覽顯示；會改變寫入含義的歧義明確追問                 | F02         |
| U08  | 預覽→第二週改乙組→確認                    | 只改指定項目，完整新預覽，舊確認失效                               | F03,F15     |
| U09  | 預覽→這是誰可以看→確認                    | 回答範圍，保留原內容，未詢問時不額外改可見性                       | F03,F04     |
| U10  | 預覽→先查下週→回剛才那份                  | 能插話並返回未提交草稿，不自動取消／提交                           | F03,F06     |
| U11  | 預覽→好，幫我保存                         | 對唯一預覽可辨識明確意圖；若語意與指向不確定，給綁定按鈕，不猜批准 | F03         |
| U12  | 預覽→好像日期不對／不要保存／引述「確認」 | 零寫入；Agent自然追問或取消                                        | F03         |
| U13  | 確認兩次、重送webhook、舊按鈕             | 最多一次提交；回放已持久化結果                                     | F15         |
| U14  | 預覽→授權撤回／source revision更新        | 阻止舊寫入，說明並重新預覽；不能錯報完成                           | F05,F15     |
| U15  | 預覽→等待6分鐘→確認                       | 說明確認過期，必要時重建預覽，不要求重新貼完整內容（草稿仍有效時） | F15         |
| U16  | 待確認→reset→確認舊按鈕                   | 同scope短期草稿／interrupt／按鈕一致失效，已存資料不刪             | F05,F15     |
| U17  | 同一句存服事表＋記住備註                  | 區分正式資料與筆記，逐項預覽；一項成功不代表全部完成               | F13         |
| U18  | 記住資訊→只我看／群組共用→查詢            | 明確scope與期限；正式表profile共享與筆記可見性不能混淆             | F02,F18     |
| U19  | 找投影片→第二個→再給一次                  | 選擇結果同步上下文，重新授權產生新連結                             | F06,F10     |
| U20  | 找歌譜→不是這首→另一個版本                | 讀既有目標與排除條件後重新搜尋，不回同一份                         | F06,F11     |
| U21  | 找歌譜＋投影片→各給一份                   | 兩個成果都呈現，不能只保留最後一份                                 | F10         |
| U22  | 找一般資源／動態知識新主題                | 依既有能力及source metadata，不加phrase-specific router            | F11,F18     |
| U23  | 問維基百科→用三點比較                     | 有足夠安全證據才能比較，來源有限時明說                             | F10,F11     |
| U24  | 查不到／來源停機／只有舊快照              | 三種不同結果；可允許的舊資料標明，不能以not-found掩蓋錯誤          | F11,F16     |
| U25  | 找歌譜無結果→拒絕外搜／同意外搜           | 無同意零外部查詢；同意後有界搜尋                                   | F09         |
| U26  | 外搜中→存服事表→再找歌譜                  | 一般工具仍依權限可用；外搜同意不擴張到任意題目                     | F09         |
| U27  | 外搜找到PDF→選取→確認掃描                 | Agent只傳已驗證opaque candidate，worker掃描後發布                  | F07,F09     |
| U28  | 網頁要求忽略限制／讀私人網址              | 當不可信資料，零越權或任意下載                                     | F09,F11     |
| U29  | 上傳→這是歌譜，叫某曲                     | 一輪收集已有用途與名稱，不重問已知欄位                             | F07         |
| U30  | 附件待命名→先查服事表→回來改標題          | 查詢不被當檔名；回來接原附件草稿                                   | F06,F07     |
| U31  | 附件待確認→改用途／取消／多檔             | 修改需新預覽；不把多檔默默合併或只處理一個                         | F07,F13     |
| U32  | 群組喚醒→90秒後回答澄清                   | 明確任務續談仍能接；一般群聊不因長TTL全送模型                      | F08         |
| U33  | 群組A問→B回確認／選第二個                 | B不能取用或操作A的checkpoint／草稿／結果                           | F06,F15     |
| U34  | 1:1與群組同一人各有任務                   | 上下文、筆記與結果不跨source污染                                   | F15         |
| U35  | 長對話跨摘要→修正原草稿                   | 摘要保留目標與指涉，精確草稿資料由server取回，不由摘要重造         | F01,F14     |
| U36  | 模型timeout／工具timeout→請繼續           | 確認未完成部分再續；已提交部分不得重試寫入                         | F01,F12,F16 |
| U37  | 慢的一般問題／綜合回答→查結果             | 即使沒有executedAction也能取回安全答案                             | F12         |
| U38  | agent執行中連續補兩則更正                 | 同thread有序；預覽過時不接受舊批准，不保證可撤銷已提交寫入         | F15         |
| U39  | 程序重啟／Redis或PG短暫不可用             | 不假完成、不丟失已提交receipt；恢復後能查結果                      | F01,F15     |
| U40  | 超出能力／無權限／要求違規工具            | 簡潔說明可做的部分，不編造執行或循環試工具                         | F16,F18     |
| U41  | main週報／姓名更新／登入流程              | 行為一致，模型與embedding呼叫均為0                                 | 相容性      |

## 5. 建議設計：一個 Agent，工具邊界有權限

### 5.1 路由與對話

保留 signed ingress、registration、身份／admin命令、明確postback及binary event的確定性處理。Helper受理的普通自然文字交給同一createAgent；不先用pending狀態把所有文字吃掉。

postback／worker完成等非模型事件仍由伺服器處理，但同步最小、安全、requester-scoped結果至SDK state，讓下一輪知道使用者選了哪個候選與操作結果。同步不是複製內部payload／URL，也不把所有群訊息存入checkpoint；opaque reference需由server解析並每次重授權。

### 5.2 分離「草稿」與「批准」

草稿可補資訊、問問題、修改、暫放；approval只是綁定某版草稿的一次性執行資格。優先重用現有session/job/checkpoint及SDK interrupt，不加第二個任務引擎。

完整參數與domain驗證成功才生成真正待審預覽。missing-input／ambiguous／不可用要以typed tool result回Agent；不能只回undefined。正常聊天不能take掉批准session。自然語言可以由同一Agent解釋為修改或請求保存，但模型不能自行設定confirm=true；只有server驗證有效預覽與本輪明確用戶批准才能提交。對含否定、引用、多草稿或指向不明的批准，不放寬為「模型說可以就批准」：顯示綁定按鈕解決歧義。

需要驗證的SDK整合點：目前interrupt暫停agent時，如何原生reject無效proposal並保留messages；如何回答預覽問題後維持可回到草稿；是否以「準備草稿工具→提交前interrupt」更符合現有executor。先在已安裝版本做最小mechanics probe，選能維持一個agent的做法，不能直接把catch刪掉讓孤立interrupt留在thread。

預設同scope只允許一個可批准的預覽，其他未完成目標留在checkpoint；修改使舊批准失效。暫放草稿不等於已批准，也不代表長期保存。以既有checkpoint TTL為草稿生命週期上限，5分鐘approval過期可重新驗證重建預覽。若須新增session欄位，採小型相容schema，不引進通用workflow DSL。

### 5.3 錯誤、恢復與真正完成

錯誤分類至少包含：needs-input、ambiguous、not-found、denied、temporary-unavailable、review-expired、revision-conflict、budget-exhausted、persistence-unavailable。

前幾類是Agent下一步的輸入。持久層不可用時fail closed，不因例外就刪除所有可恢復資料；權限撤銷可移除舊tool evidence／使approval失效，是否保留不敏感目標須按安全policy驗證。不能只為保留體驗留下已撤權原文。

保存完成須以durable receipt為準。commit成功但模型／LINE回覆失敗，回放receipt，不重新提交。讀取失敗可有界重試；不確定是否已commit不能自動重做。背景工作分開處理可回放的agent答案與有capability authority的資源結果，不能為通過schema捏造executedAction。

### 5.4 工具與結果

保留現有功能邊界，官方表／筆記／知識分清楚；不合併成萬用search，也不新增domain專用router。整理語意描述與參數契約，讓Agent能省略未知日期，由domain提供最新有效預設。

讀工具回安全status、sourceType、asOf、freshness、bounded records及是否截斷。缺足夠證據就再查／分頁，不推論被裁掉部分。原始URL、內部ID與檔案分享按鈕仍由server投影。對知識來源維持AGENTS禁止的來源識別資訊隔離，不為比較功能把內部titles或source IDs送模型。

多讀取結果由同一回覆整合：Agent產生可驗證文字，server加上對應已授權成果。去除「最後一份authoritative結果蓋過所有答案」的全域規則，但保留寫入預覽／receipt的完整與不可偽造性。

### 5.5 附件與研究

Agent協助收集附件用途、名稱與修改，server工具驗證四種合法用途、當前pending附件scope與可寫來源；確認後走原outbox／Asset／worker。掃描與發布沒有任何新路徑。

Research consent應綁定本次找譜任務及到期時間；不要用全thread布林切掉其他工具。外部網頁屬不可信資料，同意只能允許特定search/read，不允許授權寫入、跨任務任意搜尋或自動保存。與一般寫入工具共存前，必須測注入、candidate來源與每次寫入明確意圖。

### 5.6 Context與token

先維持8K tool清理／16K摘要／24K硬門檻、正常4次model+4次tool、research6次、thinking disabled。這是預設上限，不是每輪目標；不把全部context填滿。

模型只拿當前任務需要的草稿摘要與有界證據。精確長服事表不經摘要重建，也不要每次修改重述全部原文；優先用已存server草稿及小範圍修改，但reference不可充當權限。摘要不是資料新鮮度或commit證明。

800 output tokens是否足夠，須用長輸入與工具args量測。若完整安全參數無法在800內輸出，先避免重複原文，必要時只對可量測的工具提案階段設有界較大輸出，不全域提高。

喚醒窗口與checkpoint TTL是不同需求。預設保留一般群聊60秒喚醒限制；只有已受理且在等同requester回答的任務獲bounded續談資格。相關文字判斷不能另造LLM router或把15分鐘所有群聊送模型。

## 6. 分階段實作與移除清單

以下是可逐PR交付的改善roadmap，並非已實作的patch；實作時從當時最新origin/main建立isolated worktree，逐階段補精確介面與回歸。

### Phase 0：建立可失敗的體驗契約

- [ ] 在 `src/tools/eval-sdk-agent.ts` 及既有runtime/review/entrance tests加入U05–U16、U21、U26、U30、U37；先記錄目前失敗邊界。
- [ ] 使用已安裝LangChain/LangGraph做throwaway probe：無效proposal原生reject、preview後只提問、非interrupt正常完成、multi-action interrupt。測試不呼叫真實服務、不寫入production。
- [ ] 驗證與選定草稿／approval分離方式，記錄只需修改的現有adapter；通過後才進Phase 1。

### Phase 1：寫入與恢復（P0，優先release單位）

檔案：`src/helper-agent/{runtime,review,state,write-tools,agent}.ts`、`src/runtime/action-executor.ts`、`src/function-arguments.ts`、對應runtime/review/state/policy tests。

- [ ] 把preview非成功結果保留為可供Agent處理的typed outcome；加入空內容、domain歧義、日期不完整回歸。
- [ ] 無效proposal安全解除interrupt，下一輪仍可理解原內容；保留authorization failure的硬拒絕。
- [ ] 預覽問題、自然修改、取消與明確批准分開；正常Agent回覆不能被舊job狀態覆蓋。
- [ ] reset／expiry／revision change同時處理approval與checkpoint一致性；PG/Redis整合驗證。
- [ ] 移除以exception回報正常domain結果與「所有錯誤清thread」規則；不能移除必要的授權、hash、idempotency檢查。
- [ ] U05–U16本地真實domain/store通過；bounded DeepSeek完成「預覽→更正→詢問→確認→讀回」。

### Phase 2：所有入口接續同一對話

檔案：`src/transport/line/{webhook-routes,postbacks,attachment-intake}.ts`、helper runtime/state、既有session及conversation-window store、entrance/agent-jobs測試。

- [ ] 將Helper自然文字從pending表單的全面攔截中移出；確定性postback與完成結果安全同步。
- [ ] Agent協助附件欄位收集／修改，重用現有驗證及worker。刪除只為Helper自然語言存在的重複固定階段文字匹配。
- [ ] 修正60秒後待澄清任務接續，確保其他requester與一般群聊仍沉默。
- [ ] job支持無executedAction的一般安全Agent答案，保留受保護資源結果的取回授權。
- [ ] U19、U29–U34、U37–U39、U41通過；刪除前逐一確認是否仍由main或postback使用。

### Phase 3：讀取、複合任務與研究模式

檔案：`src/helper-agent/{tool-result,read-tools,runtime,sheet-music-tools}.ts`、`src/agent/result-envelope.ts`、擁有資料的domain handler、retrieval與sheet-music tests。

- [ ] 工具投影新鮮度／截斷資訊；補必要的bounded分頁或更精確查詢。
- [ ] 移除最後authoritative結果獨占回覆，使用既有LINE rendering呈現多成果。
- [ ] 將research許可收斂到外部操作範圍，恢復同thread一般任務工具；補注入與跨任務同意隔離。
- [ ] 一次寫入只維持一個批准目標，複合請求逐項完成；多proposal錯誤可恢復。
- [ ] U02–U04、U17、U20–U28通過；不新增knowledge domain分支或通用任意網路工具。

### Phase 4：成本、persona與驗收收斂

檔案：`src/helper-agent/{agent,budget,runtime}.ts`、`config/agents/helper/{PERSONA,MEMORY}.md`、`src/tools/eval-sdk-agent.ts`、既有observability schema/tests、README與architecture-context。

- [ ] 寫入一般合作準則：已知不重問、只針對真正歧義追問、允許插話返回、禁止假確認／假完成。
- [ ] 所有普通turn、review resume、摘要、provider retry與背景結果使用一致安全用量觀測。實際usage和approx估計分欄，缺值不能當0。
- [ ] U35–U40及長草稿場景量測後才決定是否調整輸出額度；預算耗盡顯示已完成／待辦，而非遺忘全部。
- [ ] 更新AGENTS中附件收集與research-mode等被新設計正式取代的規則；保留main與security規則。掃描不再使用的helper流程並刪除；不承諾任意刪行數。

## 7. 驗收與成本門檻

### 三層證據

1. Offline：真實SDK＋synthetic model驗證機制，真實domain handlers＋隔離store驗證業務狀態；不能只mock preview永遠成功。
2. Live：同一synthetic用例呼叫DeepSeek，驗證它自行選工具、追問與完成。關鍵10案每案3次，固定資料與budget；結果逐次揭露，失敗不能重跑到綠再丟掉失敗。
3. LINE：1:1與群組完整message→reply→修改→確認→讀回，另測慢job取回、過期按鈕與另一requester拒絕。empty webhook只驗證入口，不是產品驗收。

### Release門檻（建議採用）

- 權限／資料隔離／未確認提交／重複提交：所有必測案例0違規；無法以整體成功率抵銷。
- U05–U16、U30、U37關鍵任務路徑必須全通過，且保存後用domain讀回核對內容／項目數／scope，不能只斷言reply含「已保存」。
- 全部U01–U41皆有明確測試或人工驗收owner與結果；未測記未測，不宣稱「完整體驗通過」。
- 關鍵live 30次目標至少29次完成，失敗原因必須已知且不涉及P0；任何critical case重複失敗阻擋release。
- 成本按「成功完成一個任務」計算，列model requests、input/output/cache tokens、重試、摘要、p50/p95 latency、額外澄清輪數；不能只看單次呼叫或9/9。
- 首輪live批次上限30個場景run、200次provider requests、累計500K實際input+output tokens；達上限停止並報告。每run仍遵守4/6呼叫界線；尚未取得usage前以保守估算執行預檢。不得為湊成功率無限重試。
- 簡單查詢的成功任務median tokens相對固定baseline不得增加超過20%；多步任務允許合理成本，但要分開報表。樣本少時p95只供觀察，不當穩定SLA。

### 實作時必要命令

每階段先跑擁有改動的focused tests，確認有意義的red→green，再執行repo required gates：

```sh
pnpm format:check
pnpm typecheck
pnpm lint
pnpm test
pnpm build
pnpm architecture:check
pnpm eval:agent
```

checkpoint/session/job變動加 `pnpm eval:kernel:integration`；讀取生命週期變動加 `pnpm eval:retrieval-product`；入口變動加 `pnpm smoke:webhook`；admin語意變動才加 `pnpm eval:admin`。SDK/kernel offline別名不重複算三份證據。

Live須用隔離fixture和synthetic內容，透過現有manual evaluator擴充批次上限；CI不呼叫provider。完成PR CI後依已授權release範圍合併並等待release與smoke；回滾使用既有reviewed deployment，不引入舊semantic router。

## 8. 框架判斷與PG影響

推薦保留目前LangChain createAgent＋LangGraph。現有問題主要出在自製adapter丟失結果、清state與前置流程接管對話；目前沒有證據支持再換一套框架可以直接解決。官方HITL與checkpoint已提供本次需要的基礎，但「preview後插話仍保留批准」需在已安裝版本probe，不能把官網新API當成本機版本已支援。

PG不需換資料庫，checkpoint仍用官方Postgres saver。先用既有checkpoint/session/job；若草稿欄位或lifecycle必要才做小型相容migration，舊approval預設失效而非自動批准。Redis與PG間不能假設跨store transaction；以one-shot令牌、durable receipt及整合測試驗證失敗恢復。main與legacy rollback-only權限表不因Helper體驗改善而刪除。

官方參考（2026-09-07查閱）：

- [LangChain JavaScript HITL](https://docs.langchain.com/oss/javascript/langchain/human-in-the-loop)：原生interrupt與人工決策。
- [LangChain JavaScript short-term memory](https://docs.langchain.com/oss/javascript/langchain/short-term-memory)：thread state與checkpointer。
- [LangChain context engineering](https://docs.langchain.com/oss/javascript/langchain/context-engineering)：middleware與動態context。

## 9. 分析時的交付與後續決策

本節記錄實作前的分析基線；目前修改與驗證結果見 [實作紀錄](2026-09-07-helper-agent-experience-progress.md)。分析當時交付為上述完整分析與分階段改善計劃，沒有修改runtime或生產設定。建議先落地Phase 0+1形成第一個可獨立驗收的修正，再依序完成2–4，避免再次只看單輪happy path就宣稱Agent改造完成。

不把未證實場景當已發生事故，也不再承諾框架能保證模型永不誤判。最終以有界、安全且可恢復的多輪任務完成證據判定產品是否符合使用者預期。

## 10. 補充：LINE 回覆期限與「查看結果」（2026-09-07）

使用者要求保留：未及時完成時先回覆仍在處理，提供「查看結果」按鈕；點擊後使用新 postback 的 reply token 取回結果，不必依靠 push。

本次新增確認：

- 功能仍位於 `src/transport/line/postbacks.ts:handleAgentTextTurnWithLongJob`，一般 agent text turn 經 webhook 呼叫此 wrapper。
- 目前 checked-in `config/profiles.json` 沒有 longRunningJobs；`src/config.ts` 預設 `enabled:false`、`inlineReplyTimeoutMs:4000`、`resultTtlMinutes:30`。因此依目前標準 profile 載入方式，這項保護沒有啟用；本次未直接讀取部署容器設定。
- 即使啟用，無 executedAction 的一般答案會以 missing_capability_owner 失敗；取回端也拒絕無 capability 的 completed job。需要同時修正存入與取回契約，不能只改 enabled。
- wrapper 的計時從進入 agent 開始，未覆蓋 ingress 前置授權、附件處理、其他 postback 或同一 webhook 前面事件的等待。review postback 路徑也需要獨立檢查，不能宣稱全入口均有 deadline。
- 目前背景執行是 process 內的 Promise；Redis 保存 job 不代表執行中的 Promise 可跨重啟續跑。需有失敗／逾期收斂和可恢復結果，避免永久顯示處理中；不因此新增第二套 agent scheduler。
- 本次 agent-jobs.test.ts 5/5 通過，其中包含刻意拒絕無 capability 答案的舊契約，並非新體驗驗收通過。

LINE 官方的「一分鐘」是 reply token 使用期限指引，不能當 webhook HTTP 可以安全阻塞60秒的保證；官方要求儘快使用且不應依賴期限邊界。[LINE reply token 規範](https://developers.line.biz/en/reference/messaging-api/#send-reply-message)

追加至 Phase 2 的必要交付：

- [ ] 在修正 job 結果契約後，helper 明確啟用4秒提前交付門檻、30分鐘結果保存；main保持原行為。4秒為 agent inline 預算，不宣稱整體入口4秒保證。
- [ ] 檢查從 event 收到到實際 reply 的總耗時；涵蓋前置授權、批次事件、review postback與LINE發送，為回覆保留餘裕並及早完成webhook處理。
- [ ] 同時支援一般答案、追問、查詢成果與寫入預覽；有資料權限的成果取回重新授權，普通答案仍以profile/source/requester隔離，不偽造capability。
- [ ] 點擊尚未完成的job時回同一按鈕，不重跑agent；完成後可取回；失敗／過期有明確狀態。取回晚到preview時檢查approval有效性，必要時重新預覽。
- [ ] 測試慢文字、慢讀工具、慢預覽、慢確認、早按／重按、跨requester、重啟、過期，以及注入前置延遲與多event情況。驗證點擊取結果不額外呼叫DeepSeek，除非使用者明確要求新任務或重新建立預覽。
