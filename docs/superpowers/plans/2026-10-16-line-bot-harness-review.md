# LINE Bot 改善計劃顧問與審查紀錄

日期：2026-10-16。計劃：[LINE Bot 對話與會員整合改善計劃](2026-10-16-line-bot-harness-improvement.md)。只記錄本次只讀顧問分析、文件審查與修訂；不代表程式已實作。

## 三位獨立顧問

三席均為目前平台的 Codex 子代理，使用全新上下文，各自閱讀限定範圍原始程式，不提供主代理的既有結論，不遞迴派人。三席皆在每席五分鐘期限內完成，未改檔或跑寫入型測試。

| 顧問                | 範圍                                       | 主要證據與結論                                                                                            | 計劃處置                                                                                                 |
| ------------------- | ------------------------------------------ | --------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| advisor_harness     | LINE 事件、LangChain/LangGraph、限流、恢復 | 無引用契約與發送 receipt；quote 不喚醒；七日 dedup 無恢復；Redis INCR/EXPIRE 非原子                       | P2 加 atomic TTL 與公平配額；P3 lease 與 uncertain outcome；P4 requester-scoped 引用與失效；保留既有框架 |
| advisor_membership  | Account、會員、週報與網站                  | list envelope 不一致；固定首頁遺失目標；403/428 提示錯誤；LINE 與網站 session 不同                        | P1 契約與錯誤分類；P5 窄 continuation 與錯帳號流程；P6 授權版本與精準目的地                              |
| advisor_media_admin | 發碼、綁定、worker、Admin                  | bearer code 無兌換時 fresh auth；解除耦合 collection delete；群組撤開通不阻既有工作；缺 ingest projection | P7 fresh auth、撤碼、保留資料的 pause/unbind、generation/admission fence；P8 狀態與批次驗收              |

有實質差異的建議與取捨：

- 媒體顧問建議候選群組再由 Admin 二次確認；本計劃先保留既有短效一次性 bearer 流程，補 fresh auth、撤碼與可復原 unbind。二次確認不是既有產品要求，先避免增加所有正常操作的往返；貼錯群組在解除前仍可能同步，不能稱此預設已消除所有誤綁風險。
- 媒體顧問偏向終止舊 generation 未完成工作；本計劃 pause 暫存 auto 分支、resume 只續同 generation 且來源有效的工作；unbind 取消未發布 auto 分支，獨立授權的 manual 分支另判；group admission 撤銷同時阻止該群 manual 新執行。後續開通／rebind 不復活已取消工作，unsend 始終沿歷史 source key 生效。
- 引用跨 requester 的公開回覆預設不跨人讀取上下文；只識別 Bot 發過訊息並要求重述，避免新增 public provenance 授權模型。引用保留期沿既有短期 thread，不永久記錄。
- 會員顧問提出自動恢復或按鈕的選項；採明確「繼續查看」，每次重新授權。舊指令相容；線上閱讀與 PDF 依實際授權和發布狀態呈現，不先假定繁體 PDF 對所有會員可用。

## 兩位獨立 reviewer

| Reviewer          | 範圍                                           | 狀態                                     |
| ----------------- | ---------------------------------------------- | ---------------------------------------- |
| reviewer_security | 隱私、引用、狀態機、原子性、遷移、背景工作競態 | 完成初審及修訂覆核；原 blocking 解除     |
| reviewer_delivery | 產品完整性、跨 API 契約、依賴、驗收與回復      | 完成初審及修訂覆核；原 findings resolved |

Reviewer 使用新上下文讀計劃與限定原始碼，不提供顧問答案；只讀回報，主代理修訂文件，再由原 reviewer 定向覆核。沒有增加額外 reviewer 席次。兩席均確認原審查範圍已無阻塞，可依計劃分階段實作；這是文件結論，不是 runtime 驗證。

| Finding                                      | 等級      | 修訂處置                                                                                                                                                  | 覆核                                                   |
| -------------------------------------------- | --------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------ |
| S1 背景 Promise 不是 durable job             | Blocking  | P3 執行前持久化 event→operation/phase；四秒 handoff 不算完成；started/commit 後 throw 無確定結果進 uncertain，不能以 lease 到期盲重試                     | reviewer_security resolved                             |
| S2 inactive compensation 可能刪成果          | Blocking  | P7 不同 worker outcomes；只取消未發布 auto 分支；manual/current auth/shared Asset 分別處理，禁止共用破壞性 cleanup                                        | reviewer_security resolved                             |
| S3 reset/unsend 延遲寫回復活內容             | Important | P4 generation CAS、source lineage、七天 metadata tombstone、超齡事件不建 context，覆蓋 runtime 外的 reply receipt                                         | reviewer_security resolved                             |
| S4 遠端授權與本地 consume 非原子             | Important | P7 明訂 fresh check 為授權點，承認併發撤權窗口；若要求零窗口需另加 owning API revision/claim，不虛稱已保證                                                | reviewer_security resolved                             |
| S5 限流投遞語意與拼字                        | Minor     | P2 使用 PTTL、實際 key TTL；通知 claim 只保證同 bucket/window 至多一次發送嘗試，正文與驗收文字一致                                                        | reviewer_security resolved；最後文字一致性由主代理修正 |
| D1 intent correlation/cancel 不存在          | Important | P5 proposed Account create/finalize intentId/generation、cancel/status CAS、server current intent；更新所有 DTO/client/routes/tests，保留 view nonce/CSRF | reviewer_delivery resolved                             |
| D2 entitlement、caller、reader flag 來源未定 | Important | P5 Web API 窄 access projection 重用 Operations client；P6 修 OpenAPI/runtime caller 不一致；Bot 只送精準 selector，reader flag 留 Web                    | reviewer_delivery resolved                             |
| D3 網站無從辨識 LINE 帳號 mismatch           | Important | 選定一般 selector；網站顯示目前帳號並重新授權，不宣稱自動身份比對，Web 列必要 owner                                                                       | reviewer_delivery resolved                             |
| D4 inactive 文案、媒體順序與 PTTL            | Minor     | P1 區分停用帳號與資格不足；P8 只讀投影先行，P7 unbind/fence 再 pause/resume；拼字修正                                                                     | reviewer_delivery resolved                             |

原 reviewer_security 初審為兩個 blocking、兩個 important 與一個 minor；reviewer_delivery 初審為三個 important 與三項 minor 建議，最後一列合併列示。所有原 findings 已處置；定向覆核不擴大成整套系統安全認證。

## 文件驗證

完成 Markdown 格式、內部連結、必要章節、需求對照及未追蹤文件的 `git diff --no-index --check`。執行既有 `helper-agent-docs.test.ts`：1 file、3 tests passed。本次文件修改不新增程式測試；基線的既有測試結果列於計劃，不重複當成修正驗收。

## 尚未執行

Runtime 實作、跨 repo PR/CI、merge、release、正式 smoke、LINE 真機、真模型及 Redis/Postgres 新狀態機整合驗收。保留以上交付界線，不能以計劃審查替代。
