# LINE Bot 對話與會員整合改善計劃

日期：2026-10-16。狀態：三位顧問分析、兩位獨立 reviewer 審查與修訂覆核完成，可依階段實作；本文件不代表功能已實作或正式環境已驗收。

改善 LINE 引用回覆、群組對話可靠性、Account 登入接續、會員週報與 Admin 媒體同步。保留既有 LangChain `createAgent`、LangGraph checkpoint、server-owned tools、寫入確認及背景工作，不重寫 Agent，也不增加模型供應商。本輪只交付計劃與審查修訂，不修改 runtime、不發 PR、不合併或部署。

## 目標與驗收結果

- 使用者引用 Bot 自己先前對他的回覆時，Bot 能辨識對應內容；未知引用明確要求補充，不能猜測原文。
- 未叫 Bot 的一般群組聊天不消耗對話配額、不引發限流洗版；30–60 張已綁定群組媒體的自動同步維持既有獨立入口。
- 暫時失敗後可安全恢復未完成事件；已完成或結果不確定的寫入不被盲目重做。
- 登入與條款完成後保留原本查詢目標；身份、會員資格、內容權限、Bot 開通與資料夾 ACL 不互相替代。
- 週報依實際授權與發布版本提供明確期數的閱讀／下載入口。
- 管理員可以保留媒體而暫停／解除群組綁定，並看出同步收到、處理中、成功與失敗的數量。

## 基線與證據

程式基線是本次讀取的 `origin/main` 快照；後續實作須重新 fetch 並核對 drift。測試通過不等於最新 main 已部署。

| Repository            | 基線 commit                              |
| --------------------- | ---------------------------------------- |
| hhc-line-function-bot | df809fae4770a4cdaeab998c0082e0cec648b3ba |
| account-api           | c3dbb0c5ee7a1ae1b0ec2d2ee59e5e08fd7ff537 |
| account-fe            | ef1b14a2074fb6c3d71c8a0acd9127b4b949847c |
| admin-fe              | a0ffbe4ebd78f70d53c56444c459546ee54cb21d |
| hhc-web-api           | 3d9b958f447dc204c105a11d13252decf8f4e001 |
| hhc-web               | d94c89d69eb8fea1b0d8a2f72566fed62462874f |
| operations-api        | c72bbba3a112e69a2cd285ad7906a361e087a359 |
| asset-api             | 7875b25f7d0ca9a135092a86278752020421033a |
| frontend-platform     | 5cc405f3483e50aeb0f8078984950cf92ae544a9 |
| api-gateway           | a7393398c45b5c74bd217c1673c1998718cce67e |

初始分析執行了 20 個 Bot 測試檔，546 tests passed、40 external-dependency tests skipped；17 個離線 Agent eval 通過。另以合成資料重現：指定期數合法 `data: []` 回應被判 unavailable；21 則未喚醒群聊觸發限流；receipt 標記後暫時失敗返回 500，重送卻被當 duplicate；428 被顯示為稍後重試。這些是現狀證據，不是本計劃修正後的驗收。

| 證據                | 位置與觀察                                                                                                                                                            |
| ------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| E1 引用未接入       | Bot `src/types.ts` 的 LineMessage、`src/clients/line.ts` 的 replyText、`src/engagement.ts`、`src/helper-agent/runtime.ts`；缺引用解析，發送 receipt 被丟棄            |
| E2 admission 與限流 | Bot `src/transport/line/webhook-routes.ts:612` 先扣額度再 allowEvent；`src/rate-limit.ts` group key 共用，INCR 與 EXPIRE 分開                                         |
| E3 週報契約         | Bot `src/capabilities/download-weekly-paper.ts` 期待 data.items；Web API `internal/httpapi/protected_bulletin_handlers.go:96` 回 data array；Bot 測試沿用錯誤 fixture |
| E4 receipt 恢復     | Bot `src/idempotency/webhook-event-store.ts` 僅 tryStart；七天 dedup 在真正執行之前寫入                                                                               |
| E5 帳號接續         | Account FE `src/pages/LineBindingPage.tsx`、Account API `internal/services/line_binding_service.go`、Bot webhook account-link completion；無原業務目標接續            |
| E6 會員週報         | Web `src/features/weekly/api.ts` 與 `resolve-edition.ts`、Web API `internal/httpapi/member_legal.go`；網站已有授權版本與線上 discovery，Bot 固定 general/zh-Hant PDF  |
| E7 綁定與同步       | Bot `src/media-sync/store.ts`、`service.ts`、`http-routes.ts`、`worker.ts`；Admin `src/pages/MediaSyncPage.tsx`；缺保留媒體的獨立解除與 ingest 管理投影               |
| E8 聚會載入         | Admin `src/pages/media-sync/MeetingBindings.tsx:34` list 後逐筆 getMeeting，單筆失敗令整批失敗                                                                        |

來源路徑相對上表 repository，行號只是定位輔助，以固定 commit 的函式為準。LINE 官方規格：[接收與重送](https://developers.line.biz/en/docs/messaging-api/receiving-messages/)、[發送引用資訊](https://developers.line.biz/en/docs/messaging-api/get-quote-tokens/)。引用 ID 無法事後還原文字，quoteToken 不具讀取原文功能；重送可能亂序，且不是可靠佇列保證。

## 功能與權限分工

| 入口       | 現有功能                                                | 本計劃處置                                                                       |
| ---------- | ------------------------------------------------------- | -------------------------------------------------------------------------------- |
| main       | download_weekly_paper                                   | 保留 command 相容性，修契約並演進為會員週報入口                                  |
| main       | update_own_profile                                      | 保留 linked active caller、欄位開關、預覽與確認；不新增一般資料編輯能力          |
| helper     | find_ppt_slides、query_schedule、query_knowledge        | 維持現有來源授權與工具契約，補引用指涉與回歸                                     |
| helper     | find_sheet_music、find_resource、query_wikipedia        | 維持現有工具與明確同意的研究邊界                                                 |
| helper     | save_schedule、save_resource、save_memory               | 保留 live authorization、預覽、opaque approval、一次執行；不因引用或登入自動執行 |
| helper     | retrieve_memory                                         | 保留 explicit memory 與 source scope，不擴大群聊記錄                             |
| system     | help、whoami、login、registry、reset、memory management | 依真實狀態顯示下一步；不把管理命令變成一般工具                                   |
| media sync | 已開通且已綁定群組自動同步                              | 與人工 save_resource 分開，保留 clean-before-publish 與 source tombstone         |

Account 負責身份、LINE 連結與帳號有效性；Operations 負責會員資格、組織責任與 entitlement；Web API 負責內容發布與存取；Asset 負責媒體與 collection ACL；Bot 負責自身 admission 與對話。Admin 是操作介面，不能成為額外授權權威。所有前端顯示皆只是 projection，實際操作仍由 owning API 驗權。

預設不把所有 helper 讀取改成會員限定，也不把已登入者提升為管理者。任何 entitlement 變更必須逐功能明確列出；本計劃只改善既有資格的呈現與流程。

## 設計決策

1. 保留 `main` provider-free；helper 只有一個既有 LangChain/LangGraph 路徑。不得新增通用 workflow engine、shadow router、generic HTTP tool 或另一個模型。
2. 引用內容只作 untrusted context，不作權限、工具證據或寫入確認。維持 profile/chat/requester 隔離，不保存整個群組聊天。
3. 身份綁定不是瀏覽器登入。續接連結不得攜帶 access token；不得靜默切換網站帳號。第一版只傳一般內容 selector，網站明示「以目前網站帳號查詢」並提供現有切換入口；不宣稱能偵測 LINE 與網站帳號是否相同，不新增跨站身份 handoff。
4. 綁定碼仍為短效一次性 bearer code，不要求每位群組成員登入。新增 pause/unbind 不刪既有媒體；既有 delete collection 行為不被偷換。
5. 引用保留期不超過現有 thread idle TTL：group 15 分鐘、direct 30 分鐘。訊息索引與 checkpoint 採同一生命週期，不另建永久記憶。
6. 額度先保留目前每分鐘 20 次作 requester 對話基線；group 上限另作不發逐則警告的資源保護，實際數值由預備環境 60 則媒體加正常對話混合壓測決定，不任意提高全部配額。
7. 先交付可獨立驗收的小修正。所有新增 store schema 與 API 先 additive，再部署 consumer；不可用 destructive migration 作回復。

## P0 實作前契約核對

Owner：各變更 repository 的實作者。建立最新 main 的 isolated worktree，讀各 repo AGENTS，確認對應 PR 是否仍開啟；不得延用已合併的 media-burst 分支。

- 核對本表 commit drift、目前 OpenAPI／generated clients 與實際 capability config。
- 確認現有 Redis／Postgres test environment、LINE 測試群與兩個測試 requester；只用合成資料，不讀真實群聊。
- 讀取正式環境 redelivery 設定的可用證據；未確認時不得宣稱重送恢復有正式保障，不自動修改 LINE Console。
- 整理四種結果：純查詢、已有 durable job 的寫入、不可判定的外部副作用、訊息投遞。禁止用同一 retry 分支處理四者。
- 協定新增欄位／路由在 owning repo 設計與測試，重用既有 auth client；新 API 必須明確標成待新增，不假設目前存在。

## P1 修正週報契約與可行的錯誤提示

Owner：Bot；驗證 producer 為 Web API。依賴：P0。可先獨立發 PR。

改動範圍：`download-weekly-paper.ts`、對應 tests、main runtime 的必要回歸、README/AGENTS 的過時 public weekly 描述。指定期數解析 `data` array 與 `meta`；latest 保持單筆。保留 issueNumber、locale、series 及欄位邊界驗證，不接受未授權原始 URL。錯誤依 owning API code 處理：428 導向網站既有條款流程，403 顯示資格下一步，503 表示暫時不可用；404 保留不存在或不可存取的非揭露回應，不把它當成「會員資格失效」證明。Account inactive 明確顯示帳號目前不可用，不能沿用目前 deniedResult 的會員資格不足文案。

驗收：合法單筆／清單、空陣列、多筆／期數不符、語言不符、malformed response、timeout、unbound、inactive、403、404、428、503。fixture 取自固定 producer contract；producer shape 變動必須讓 consumer contract test 失敗。修正前合成案例失敗，修正後通過。

回復：只回退 consumer 程式，無資料 migration；不得以回到公開下載繞過權限。

## P2 群組 admission 與原子限流

Owner：Bot。依賴：P0；P4 quote admission 復用此流程。

改動範圍：webhook gate、`engagement.ts`、`rate-limit.ts`、Redis client interface／factory／test fakes、entrance tests。

- Signature／body bound／最低限度的流量防護保持在入口；正常聊天先做 source access、command／wake／現有 continuation 判斷，只有真正接納的 Bot turn 扣對話額度。
- 管理／登入／postback／人工附件仍走原有授權；auto media-sync 保持不扣對話配額。不得為提前判斷而執行工具或 LLM。
- requester bucket 使用 profile/chat/requester；另保留群組資源上限。不提供 requester 的事件不得開對話 state。
- Redis counter 與 expiry 以一個 Lua script 原子執行；修復既有無 TTL key，使用原子 PTTL/expiry 檢查。in-memory 只供測試／單程序，不能聲稱多副本保證。
- 限流提示同一 requester/bucket/window 至多一次發送嘗試：Lua 原子取得 notification claim 才呼叫 LINE，claim 後 crash 可少通知，不承諾 exactly-once delivery。resetAt 由 key 實際 PTTL 計算。群組防護不得逐則洗版；限流不延長對話 window。

驗收：3 人 21 則普通聊天 0 Agent calls／0 限流提示；一人耗盡額度不耗盡他人 requester 額度；30/60 image/file 與文字混合維持媒體完整；手動儲存仍授權；Redis INCR 後故障不產生永久 bucket；多副本同 bucket/window 至多一次發送嘗試。

回復：保留舊 key 相容讀取／自然到期策略，禁止雙寫造成重複扣額；切換期間需專門回歸。不得刪全庫 Redis keys。

## P3 事件處理恢復

Owner：Bot。依賴：P0、P2 的入口順序。改動既有 receipt store，不新建通用任務引擎。

將 `tryStart` 擴成有 owner token、bounded lease、完成狀態的 store；每個 webhookEventId 獨立管理，多事件 envelope 可以跳過已完成、恢復安全失敗事件。Redis transitions 必須 CAS。完成去重保留七天；lease 與續租依現有 turn timeout 設定，過期不能使舊 owner 覆蓋新結果。

| 狀態／工作                                        | 可恢復行為                                                                               |
| ------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| 尚未執行副作用的查詢／admission 暫時失敗          | lease 到期後允許重新 claim，重新驗權                                                     |
| 真正 durable queue/outbox job（不含 turnPromise） | 以 stable operation ID 取既有結果或恢復 owning worker；不得重新呼叫寫入 handler          |
| commit 或外部 publication 結果不確定              | 標記 uncertain，使用既有 reconciliation／人工處置；不可盲重試                            |
| completed／ignored／rate-limited                  | terminal；重送不再執行或發重複警告                                                       |
| 業務完成、LINE reply 失敗或結果不明               | 與業務結果分開記錄；保留結果查詢，不承諾 exactly-once delivery，不重用已耗用 reply token |

入口 lease 不是副作用冪等的替代。`action-executor.ts` 的 fresh authorization、approval CAS、argument hash、durable result 仍為寫入邊界。既有 media-sync intake-before-dedup／unsend、native accountLink 與 challenge completion 各自保持原有安全語義，逐路徑測試後才能遷移。

既有四秒 handoff 是第五種執行形態：`postbacks.ts` 先啟動記憶體 turnPromise，逾時才建 pending result job；它不是 durable worker。P3 必須在啟動業務 Promise 前持久化 event→operation/job 關聯與 execution phase，四秒提示只更新 delivery，不將業務 receipt 標 completed。已開始但程序死亡／缺最終結果，一律先 uncertain；只有宣告並驗證可重放的純讀 operation 才可重新執行，其餘沿原 action executor／worker 結果核對，不因 lease 到期重跑 handler。mixed tool turn 不可被分類為純讀。

handler throw 或 execution_unavailable 不是「未 commit」證明；需區分 not_started、started、committed/result_recorded、uncertain。對外副作用若無可查證 operation ID，只能提供 support/reconciliation，不假稱自動恢復。這些 execution markers 屬既有 receipt/job 的最小擴充，不另建通用 workflow engine。

驗收：claim 後 crash、相同事件並行、舊 owner 續租／完成、租約到期、Redis 暫時故障、混合 envelope、亂序／redelivery、approval consumed、四秒 handoff 後 crash、handler commit 後 throw、result store 失敗、commit 後 crash、reply 失敗。Redis/Postgres 真依賴整合測試不可 skip 才可合併本階段。

遷移／回復：新程式必須尊重舊七天 receipt；新舊混合版本需單一相容 claim gate，否則採受控 drain/cutover。不能換 prefix 後讓舊事件全部重跑。保留 schema 與 terminal records，回退前 drain，確認舊版不會重跑已執行事件。

## P4 引用回覆與上下文

Owner：Bot。依賴：P2；delivery receipt 與 P3 共用投遞結果契約，P3 完成後整合驗收。

改動範圍：LineEvent/LineMessage/LineReplyClient、LINE SDK adapter、所有 reply callers/test fakes、reply builder、group engagement、helper runtime/state/reset/unsend、offline eval。先盤點所有 caller，避免只改 SDK adapter。

- Inbound 保存 `quotedMessageId`；outbound receipt 接回每則 `sentMessages[].id`，與多段 reply 順序對應。quoteToken 僅 transport 使用，不進 LLM、trace 或一般 log。
- metadata lookup key 為 profile/chat/messageId；payload retrieval 另綁 requester。僅索引已接納的本人訊息與 Bot 對應回覆；不得為理解他人引用而擴大群聊收集。
- 索引只保留受限安全文字／server-owned reference，不保存 sharing URL、token、完整 tool payload。資源內容與存取仍需當前授權工具重新取得。
- 同 requester 引用已知 Bot 訊息可喚醒及接續；跨 requester 引用只允許辨識是 Bot 訊息並啟動新問題，不讀原 requester 的 checkpoint、draft、結果、帳號或 approval。預設要求補述需求，不跨人重播舊內容。
- 未知、過期、跨群／跨 profile、缺 requester、收回的引用不得猜原文；已被明確喚醒才回覆補充提示，其他群聊維持安靜。
- 引用以明確 data envelope 呈現來源與 unavailable reason，禁止把引用文字變成 system instruction。引用「確認」不能批准任何寫入。
- `/reset`、TTL、unsend 同步失效索引與受影響狀態；若摘要已混入收回內容無法精確移除，清除該 requester 受影響 checkpoint。明確保存的長期 memory 沿既有刪除流程，不混作臨時引用 cache。
- 每筆索引及 in-flight turn 帶 thread/reset generation 與 source-message lineage；讀取、checkpoint commit 及 runtime 外的 delayed reply receipt 寫入均做 generation CAS。reset 先提升 generation，再清內容；舊 owner 不得重新建立索引。若回覆已送出才失效，不嘗試刪使用者 LINE 畫面，但不能讓它重新變成可用 context。
- unsend 先寫 metadata-only tombstone，即使原訊息尚未到達；沿 lineage 失效衍生 Bot 回覆與摘要。tombstone 至少保留七天以覆蓋 receipt dedup；超出七天的原始事件依 timestamp 拒絕建立新引用 state，不能在墓碑到期後復活原文。metadata 只含必要 opaque/HMAC keys 與時間，不保存收回文字；缺少可信時間或 lineage 時 fail closed。

驗收：引用自己／Bot／另一人、超過 wake window 但索引仍有效、TTL 後、同群兩人、跨群與 profile、未知 ID、無 requester、unsend-before-original、unsend-during-turn、reset-before-reply-receipt、七天後舊事件、多段訊息 receipt、reply 結果未知、prompt injection、權限撤銷及 write review。離線 eval 驗 envelope 與安全；有授權才跑 bounded live eval；LINE 真機驗原生引用。

回復：關閉新 quote admission 並停止讀取索引；資料自然到期。保留原本 wake/mention 行為，不以全群 checkpoint fallback。

## P5 登入接續與會員狀態呈現

Owner：Bot、Account API/FE、Web；會員狀態來源依下表固定。依賴：P1；重試語義採 P3。新增 contract 先於 consumer 部署，以下 proposed 部分不是目前存在的 API。

| 契約                           | Owner 與 caller                                                                    | 第一版處置                                                                                                                                                                                                                                                           |
| ------------------------------ | ---------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| LINE identity / active         | Account 既有 Bot private subject contract                                          | 維持 trusted caller 與 LINE subject 解析，不接受前端自填 subject                                                                                                                                                                                                     |
| Binding correlation            | Account API → Bot private create/finalize                                          | proposed additive opaque intentId、generation 與 expiresAt；finalize 成功／重送返回相同 correlation，Bot continuation 綁精確 intent，不從 URL 擷取 secret                                                                                                            |
| Binding cancel/status          | Account API；FE 依既有 intent cookie/view nonce/CSRF，Bot 依 private caller        | proposed cancel/inspect-by-correlation；cancel 只取消 pending intent，與 finalize 用 CAS 決勝，terminal completed 回 already_completed 不解除既有連結；Bot 點繼續前確認 exact intent completed 且仍 current，拒 cancelled/superseded/expired，不依 callback 到達順序 |
| 會員 qualification/entitlement | Operations private qualification / entitlement-checks，由 Web API 既有 client 代查 | Web API proposed narrow Bot access projection，只接受可信 LINE→Account subject；回 qualified、authorized editions 與 legal-required/allowed/unavailable，不回組織或會員名單；重用既有 Operations client，不讓 Bot 呼叫 browser /me                                   |
| 內容及條款                     | Web API protected endpoints                                                        | 保留各次授權、403/404/428/503 與 no-store；狀態 projection 不取代內容讀取的 live check                                                                                                                                                                               |

取消契約需更新 Account service/store/handler/routes、FE client/cancel、Bot client strict DTO/parser/fakes、OpenAPI/generated clients 與 tests。使用者切換帳號時先 supersede 舊 intent 並重新建立，不只清 FE state；create generation 由 server 排序。同 requester 並行 A/B intent 的舊 callback 不得消耗 B continuation。關聯值不是身份證明或授權 grant；未持有原 requester scope 不得查到 binding 詳情。

預期流程：原始查詢 → 私聊登入／綁定 → 確認目前 HHC 帳號 → 回 LINE → fresh authorization → 繼續查詢按鈕 → 網站既有登入與條款 → 原目標。群組不顯示 email、會員詳情或資格拒絕原因，導向私聊。

- 以窄的 bulletin continuation 保存 allowlisted action、issue/series/locale、profile/chat/requester、綁定 intent 關聯、到期與使用狀態；不恢復退休的通用 pending workflow，也不把完整原文永久保存。
- continuation 以不可猜測、短效、一次性 ID 參照 server state，預設有效期不超過 Account binding intent 的 10 分鐘。過期需重新要求；不得自動延長舊權限。
- 綁定完成只提供「繼續查看」；點擊重新解析目前 LINE→Account subject 與 entitlement，不沿用原授權。讀取 continuation 被使用時原子 claim；寫入需求只能重新預覽，不自動保存。
- 綁定取消、帳號切換或 relink 要使舊 continuation 不可使用。網站只接一般 selector、無 LINE 身份，因此第一版不做 mismatch 自動偵測；清楚顯示目前網站帳號並由該 session 重新授權，提供現有帳號切換入口。LINE 綁定 A、網站為 B 時，只能看到 B 的授權內容，不能顯示 A 的身份／授權或靜默切換。跨站身份比對 handoff 明確不在第一版範圍。
- 一般期數／系列／語言 navigation selector 可跨頁保存，不攜帶私有內容或 bearer grant。身份敏感 continuation 必須 server-bound；OAuth return 只能 allowlist 同站路徑，防 open redirect。
- help/whoami 區分已連結、帳號有效、資格可用／缺少、條款待完成、授權服務暫不可用；不以 user/admin role 推論會員資格。避免首次歡迎列出不能使用的全部功能。

驗收：既有 session／未登入／新註冊／MFA 超時／取消與 finalize 競爭／並行 A/B intent／延遲 callback／重放與過期 continuation／StrictMode reload／LINE 內建瀏覽器與外部瀏覽器／同瀏覽器兩帳號多分頁與切換後舊頁／途中撤權／403/404/428/503；所有 token 不出現在 log、URL query、referrer、模型或 analytics。

回復：移除 continuation 入口仍可手動重新查詢；既有帳號綁定不回滾，不撤銷其他 session。

## P6 週報版本與精準入口

Owner：Bot、Web API、Web、frontend-platform。依賴：P1、P5 的明確 access projection。禁止假設 Bot 可直接呼叫 browser `/me` endpoint 代替使用者授權。Web API online discovery 的 runtime 目前允許 Bot，但 OpenAPI x-hhc-callers 只有 api-gateway；P6 必須先使 caller allowlist、OpenAPI、generated clients 與 runtime tests 一致，明確允許已驗證 Bot workload 加 trusted subject，拒絕 public spoofed identity。discovery 每個要求的 edition 都檢查授權，因此先從 projection 取得允許版本，不可把所有語言一次丟入而被其中一個未授權版本阻斷。

採用既有 authorized editions、online discovery 與網站 resolve-edition 規則，分開 UI locale 與 content locale，支援 general/children。先列使用者有權且已發布的版本，再決定 online/PDF；沒有繁體授權但有其他版本不能一律拒絕。

舊「下載最新週報／下載第 N 期週報」指令保持相容。Bot 第一版統一提供「查看該期週報」的精準 selector 入口，Web 新增並測試該入口後再啟用 Bot 連結，不捏造目前不支援的 query。網站依自己的 build-time reader flag、session 與當前發布狀態提供線上閱讀／下載選項；不要把 onlinePublished 當作 reader enabled，也不把 Web flag 複製到 Bot。online-only 且 reader disabled 時，網站顯示目前無可用閱讀方式／返回目錄，Bot 不宣稱可讀或直接連 reader。正常可讀時由網站導現有 reader route；PDF 沿既有水印 download job。Bot 不傳受保護 PDF bytes，不把短效下載網址貼群組。

驗收：latest/exact number、general/children、UI 與內容不同語言、只有其他語言授權、online-only/PDF-only/both/neither、reader feature disabled、版本撤回、條款更新；以現有網站 fixtures 證明結果一致。精準目標需跨網站登入回跳後仍保持。

部署順序：producer contract → generated client → Web route → Bot link；未具備目標路由前不開啟精準按鈕。回復 Bot presentation，保留舊 route 相容性，不公開資產。

## P7 媒體綁定與保留資料的復原

Owner：Bot、Admin；Asset／Account／Gateway 僅依實際契約需求修改。依賴：P0；worker concurrency 驗收必須使用 Postgres。

維持 registry 與 media binding 的授權分界；Admin 引導顯示「小哈已開通／待綁定／已綁定／已暫停」，不把一個 code 靜默提升成開通群組的權限。重新發碼立即使舊碼失效，沿用既有行為。

兌換前重新驗證發碼者帳號有效與目前 collection 管理權；遠端檢查觀察到撤權就拒絕兌換。授權點明確定義為 consume 前的 fresh check，而非跨服務線性化：fresh check 與本地 consume 之間的併發撤權仍可能成功，第一版不聲稱「撤權完成後零窗口」。要求消除此窗口需 owning authorization API 提供 revision/claim fence，是另案，不把本地 DB transaction 假充跨服務保證。遠端驗權完成後，transaction 內重查碼、有效期、collection/binding generation、刪除狀態及唯一性；不在 DB lock 內做長時間網路 I/O。最終群組名稱與 collection 名稱作安全範圍內的確認回覆。保留 bearer 模式，不新增強制 Admin 二次審批；貼錯可由獨立 unbind 復原。新增獨立撤銷尚未使用綁定碼的操作，撤碼不等同解除既有 binding。

群組 `/group-remove` 亦須撤銷該群組當前媒體執行資格，阻擋已排隊工作的 claim 與 publication；worker 每次 claim 及外部 I/O 後使用當前 admission 與 binding fence。群組重新開通不自動復活已取消的工作；保留已發布媒體與 ACL。發碼者撤權只使未使用的碼不能再兌換，既有 binding 的停用由群組／collection 當前授權規則與明確操作處理，不以發碼者帳號生命週期自動刪媒體。

新增操作是 proposed API，路由名與權限須依現有 OpenAPI 定義後實作：pause/resume binding、unbind preserving assets。操作需現有 collection 管理權、expected binding version、idempotency key、audit。不可將 collection delete 當 unbind。

| 操作   | 新 intake                                  | 已排隊／執行中                                                                 | 已發布內容           |
| ------ | ------------------------------------------ | ------------------------------------------------------------------------------ | -------------------- |
| pause  | 不接收新同步工作，UI 說明不補抓期間媒體    | 暫停新 claim 與 publication；已開始外部 I/O 需記錄結果並重新驗 binding fence   | 保留，不改 ACL       |
| resume | fresh auth 後恢復                          | 只恢復相同 binding generation、來源仍可取得的工作；過期明確 failed             | 保留                 |
| unbind | 立即阻擋舊群組 intake，rotation generation | 取消未發布工作；舊 owner 不得發布到新綁定；外部 commit 不確定須 reconciliation | 保留，不刪除、不擴權 |

pause/unbind completion 必須等待或明確呈現 settling 的 in-flight 狀態，不能宣稱已停而仍有未受控 publication。外部已成功但本地未知的結果先 reconciliation，不直接刪掉或重發。既有 unsend 依歷史 source key 繼續 tombstone／撤回，不因 unbind 失效。Bot leave/rejoin 不默默轉移 binding 或清除資料。

worker 必須用不同 outcome 區分 paused、unbound_generation、admission_revoked，不能把新停用情境映射成既有 binding_inactive。實作採既有刪除流程區分 source tombstone 與 collection deletion：前者使用 source tombstone 與 delete outbox，後者使用 collection deletion ledger 與明確的 Asset collection delete；不新增重複的 worker outcome。現有 terminalFailure/compensatePersistedOwners 可能刪除 Asset、已發布 collection occurrence 與 manual publication，P7 必須拆分判斷與 publication-specific compensation：pause 只釋放／暫停 claim；unbind/admission_revoked 只取消未發布的 auto collection 分支；已發布成果與被其他 publication 引用的 Asset 不被清除。只有明確 unsend/delete 沿原刪除語義。

同一 work 的 manual save_resource 分支維持原批准 scope 與 current authorization，與 auto binding 分開判斷：僅 unbind/pause 不取消已明確授權的 manual 分支；group admission 撤銷則阻止該群組 manual 新執行，但仍保留已發布成果。worker 若要繼續 manual 必須能隔離 auto publication，不能沿共用 activeBinding shortcut。無法證明獨立時保持 blocked/uncertain，不自動重發或刪共用 Asset。

驗收：碼過期／已用／重新發碼／並行兌換／fresh check 前撤權及 check 成功後 consume 前撤權窗口／跨 collection／貼錯群／pause-resume／unbind-rebind／worker claim 與 finalize 競態／collection 已發布而 manual pending 時 pause/unbind／shared Asset retention／scan pending／unsend 同時發生／遠端成功但本地失敗／既有媒體 ACL 不變。30/60 張 batch 回歸不得減少完成率或破壞 clean-before-publish。

部署順序：additive state/schema → 所有 workers 認識 fence → API → Admin；在舊 worker 仍會忽略 pause/generation 時不得開放操作。回復前 drain 所有新狀態；不能部署會忽略 pause 的舊 worker，保持停用直到修復。

## P8 同步狀態與 Admin 效能

Owner：Bot、Admin；Operations list projection 有必要才修改。依賴：P7 新狀態，現有 ingest projection 可獨立先交付。

以既有 ingest/outbox/publication 提供 collection-scoped 狀態 API，套用相同管理 ACL。呈現 received、processing、awaiting_scan、published、failed、cancelled/tombstoned、最後成功時間及安全失敗分類。計數以唯一 source/work 去重，區分「已收到」與「已發布」，不能把人工多目的 publication 重複算成多張照片。只用選定時間窗／session 的界定，不保證 LINE 未提供的整批總數。

提供有界 cursor、poll backoff/abort、時間窗與手動 refresh，禁止逐張群組通知。安全 retry 僅處理可恢復狀態並重新驗權／binding generation；source unavailable 請重新分享；uncertain publication 走 reconciliation，不能讓「全部重試」重複發布。

聚會選擇先列必要資料與按需載入，避免所有 archived meetings 的 N+1；保留 org-unit ancestry 授權、保存前重新讀 version/CAS 與其他 collectionIds。單筆 unavailable 可獨立顯示，不使全部已授權聚會消失。

驗收：60 筆中成功／處理中／失敗可對帳；重送不增計；無權者不見 collection metadata；刪除／unsend／rebind 後計數一致；大量聚會 request 數有界且單筆錯誤不阻斷全頁。範圍外的全平台監控 dashboard 不在本計劃。

## 測試與交付順序

建議 PR 邊界：P1 → P2 → P3 → P4；P5 → P6 另成會員整合鏈。媒體線先交 P8 現有 ingest 的只讀 projection，再交 P7 retained-assets unbind/撤碼/fence，最後交 P7 pause/resume 與 P8 新狀態/retry。P5/P7 可在 P0 後設計，但不可跳過各自 producer/worker 先行順序。每個 PR 含功能、caller、fixture、config、OpenAPI/client、文件及其必要測試，不留「後續補授權／回歸」。

- Bot 行為變更：`pnpm format:check`、`pnpm typecheck`、`pnpm lint`、`pnpm test`、`pnpm build`、`pnpm architecture:check`。
- Agent/context 變更：`pnpm eval:agent`；新增 corpus case 同步 validator 與既有 runner，避免 case ID 只列名未實作。
- Redis/Postgres／publication 變更：`pnpm eval:kernel:integration` 與 owning integration suites，必須真依賴通過；不可用記憶體 mock 宣稱 atomicity。
- Admin 自然語言改動才跑 `pnpm eval:admin`；入口變更跑簽章 webhook smoke；其他 repo 使用各自 AGENTS 與 CI。
- Cross-repo contracts：producer fixtures/OpenAPI → consumer assertions → integrated flow。未驗正式帳號不得標記 login E2E 通過。
- Offline eval 不呼叫真模型。獲授權才跑 bounded live model evaluation；分別記錄 correctness、calls、cost、latency。
- Release 另需使用者授權，各 repo PR CI 通過後由既有 CD 部署；provider-free release smoke 只證明路由／依賴，不能代替 LINE 真機。
- 真機矩陣至少包含兩個 requester、同群／跨群、LINE iOS/Android 的引用與登入、外部瀏覽器、30/60 media、撤權、條款變更、暫停／解除。無裝置或帳號的項目保持 pending。

## 完成條件與範圍

本計劃的完成條件為三位顧問交付、兩位獨立 reviewer 審查、所有 blocking findings 已修正或明列不能執行的外部前置條件。實作、PR CI、merge、release、smoke 與真機驗收為不同狀態。

本輪不改會員授權模型、不全群錄音或記錄聊天、不搬移／刪除正式媒體、不導入新 Agent 框架、不追查先前已停止的 CD 工作。正式 runtime flags、帳號／裝置與實際 LINE redelivery 設定留待各階段的指定驗收。

顧問與 reviewer 的查證結果、處置和剩餘條件記錄於同目錄 `2026-10-16-line-bot-harness-review.md`。
