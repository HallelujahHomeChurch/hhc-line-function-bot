# SearXNG 退役實作計劃

日期：2026-11-01，Asia/Taipei。狀態：Gemini 計劃審查完成；PR1 已實作且本機完整驗證通過；PR CI／發布待完成。
程式基準：`aed4c6128942f3d3c486f8d99eed1480b89f7a10`（最新已檢查的 `origin/main`）。

移除公開網路找譜、公開頁面閱讀及搜尋結果檔案匯入，最後刪除 `hhc-searxng`。
預設採兩個 PR：先停止產生新外部工作，保留既有工作的相容處理；排空後才刪除相容程式。
兩次發布都驗證完成後才刪 Azure App，以保留切換期間的回退能力。

使用者已指示依序實作。本輪先完成 PR1 程式、測試與未合併 PR；merge／發布依 Deployment Rule 另行取得授權。PR2 上線與 Azure App 刪除仍受排空、發布驗證及授權 gate 限制；涉及 azure-infra 時先走該專案規範流程。

## 1. 完成條件與範圍

- [ ] Helper 的內部流行／詩歌譜庫搜尋、格式篩選、多結果選擇及臨時分享連結正常。
- [ ] 查無結果不再詢問「上網找」，只提供內部查詢修正方向；依賴不可用仍不能偽裝成查無結果。
- [ ] Agent 不再取得 `search_sheet_music_web` 或 `read_sheet_music_page`，也不能透過舊同意、quote、數字或保存按鈕恢復搜尋／匯入。
- [ ] 舊的已確認外部匯入有可核對的終態／結果；不遺失、不盲目重播、不產生重複發布。
- [ ] 一般 LINE 圖片／檔案保存、群組 upload intent、媒體同步、Asset 掃描與 durable outbox 行為保留。
- [ ] `main` 維持 provider-free；Wikipedia、知識查詢、記憶、排班與權限模型保留。
- [ ] 部署、release probe、acceptance、report、receipt 與 rollback 不再要求或重建 SearXNG。
- [ ] 刪除 App 後 provider-free release smoke 仍通過；共用 ACA environment、儲存、佇列、registry 與 logs 保留。
- [ ] 執行中的正式程式、現行 manifest/env 與部署腳本不再有 SearXNG 依賴；歷史設計文件和明確的負向測試可以保留名稱。

不擴充新搜尋 provider、通用網頁工具、管理 API、功能開關或任務引擎。不因名稱含 `external` 就刪除：`external_link`、外部文件識別欄位、`recordExternalResult` 和其他共同邊界各依實際呼叫者判斷。
已匯入檔案、catalog、使用者明確保存的連結及歷史 audit／release artifacts 都保留。不做全庫／全佇列清除，也不為這次退役建立破壞性 PG migration。

## 2. 來源與責任邊界

以下路徑皆相對 repository 根目錄；實作前需重新確認最新 main 有無漂移。

| 邊界                   | 擁有檔案                                                                                                                                                                                               | 退役處理                                                                |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------- |
| 查無結果與外部匯入入口 | `src/functions/find-pop-sheet-music.ts`、`src/bootstrap/compose-capabilities.ts`                                                                                                                       | 移除同意提示、候選匯入與新 work 建立；保留內部選擇                      |
| Agent 組合與回合       | `src/helper-agent/sheet-music-tools.ts`、`runtime.ts`、`agent.ts`、`budget.ts`                                                                                                                         | 刪除研究工具、專用模式、研究額度與研究專用互斥／清理分支                |
| Scoped 狀態與入口      | `src/helper-agent/state.ts`、`src/state/session-store.ts`、`redis-session-store.ts`、`src/runtime/profile-runtime.ts`、`src/transport/line/webhook-routes.ts`                                          | 刪除新同意／匯入能力，過渡期只安全終止已存在的舊 session                |
| Client、設定與型別     | `src/clients/searxng.ts`、`public-page.ts`、`src/bootstrap/create-production-runtime.ts`、`src/config.ts`、`src/types.ts`                                                                              | 移除專用 client／reader／WebSearch 型別／設定與注入                     |
| 外部 binary 相容       | `src/clients/external-binary.ts`、`src/attachments/asset-worker.ts`、`scan-work-store.ts`、`scan-worker-config.ts`、`src/tools/run-attachment-worker.ts`、`src/functions/resource-binary-publisher.ts` | PR1 保留既有外部工作；PR2 刪除專用路徑，保留共同 lease／Asset／發布保護 |
| 部署宣告               | `aca.searxng.containerapp.yaml`、`infra/searxng/settings.yml`、`aca.containerapp.yaml`、`aca.release-probe-job.yaml`、`.env.example`、`.github/workflows/release.yml`                                  | PR1 移除搜尋服務宣告與引用；worker 的外部下載設定在 PR2 移除            |
| Release 合約           | `scripts/deploy-aca.sh`、`release-assurance.sh`、`release-receipt.py`、`accept-release.sh`、`src/assurance/release-probe.ts`、`report.ts`、`src/tools/run-release-probe.ts`                            | 同一次 PR1 完整移除 SearXNG gate，明確處理格式版本與回滾                |
| 文件與可執行證據       | `README.md`、`AGENTS.md`、`docs/architecture-context.md`、`docs/runbooks/production-operations.md`、相關 tests／evals                                                                                  | 更新現行說明；歷史 specs 不重寫，必要時加退役指引                       |

共享狀態的兩項保留原則：

- `markContextDirty` 同時服務 group-history 不可信內容隔離，不能隨研究模式一起移除；保留其斷線／例外後清理保護。
- `recordExternalResult` 也記錄 deterministic selection、review 與非模型處理結果，不能按名稱整個刪除。保留 webhook admission、group reply adapter、quote lifecycle 與 fresh authorization。

## 3. Task 0：重新定界與唯讀基線

執行者：實作代理；生產操作核准人：Ray。從最新 `origin/main` 建立 `codex/*` 隔離 worktree；同任務未結 PR 存在時延續，否則不重用舊功能分支。

- [ ] 檢查 branch、dirty status、worktrees 與 GitHub 同任務 PR；保留其他任務及這份未合併計劃。
- [ ] 重讀適用 AGENTS、README 和本表 owning sources；使用 `rg` 追完所有 client、session、worker 與 receipt 呼叫者，包含 fixtures、exports、tests、YAML、shell/Python。
- [ ] 唯讀確認 Bot、attachment app／finite job、release probe 的 image、revision、traffic、執行狀態；確認沒有部署或 deferred acceptance 正在交錯執行。
- [ ] 在私密操作環境辨認實際 Redis key prefix、Azure queue 與權限，僅透過正常授權載入 secret，禁止印出值或提交到 public repo。
- [ ] 切換前盤點外部工作／結果，建立有界的核對清單；公用證據只記錄計數、狀態、時間、commit 和去識別摘要，不記檔名、URL、LINE IDs、work/job IDs 或 payload。
- [ ] 確認可使用的唯讀巡檢方法。若現有介面不足，以最小一次性操作程式重用 `scanKeyBatches`，限制掃描 prefix、批次、時間、輸出欄位；用 synthetic fixture 驗證。不要新增 Bot admin action 或通用掃描框架。

目前 store 介面只有 pending-enqueue index，沒有完整外部工作巡檢 API。`listPendingEnqueue()` 會移除過時 index 並可能 reconcile job，不可當作純讀取；直接使用 bounded SCAN／GET／PTTL、read-only set 查詢及 job 記錄讀取。
`AgentJobStore` 在 production 使用 Redis，未設定 Redis 才用記憶體；不是 PostgreSQL `agent_jobs` 表。

退出條件：基線來源、檢查範圍和不確定事項可定位；權限或資料覆蓋不足時可以完成程式 PR，但不能宣稱排空或進行最後刪除。

## 4. Task 1：PR1 停止新搜尋與新匯入

- [x] 刪除 `createSheetMusicResearchTools`、`storeSheetMusicImportCandidates` 與專用 client／reader；移除 production 與 synthetic fixture 的注入、相關 WebSearch 型別。
- [x] 將 `createSheetMusicNotFoundResult` 收斂為內部查詢的 not-found 回覆，保留 unavailable／ambiguity 語意；刪除 `externalResearchEnabled`、同意建立與專用常數。
- [x] 移除新外部匯入的選檔、target、確認及 enqueue 路徑；不修改內部 `select_sheet_music` 或數字選擇。
- [x] 移除 agent 的 `sheet_music_research` 模式，回到現有 normal 4 次 model／4 次 tool 額度；共同 token、output、重試及工具安全限制保留。
- [x] 移除研究工具 observability allowlist、研究專用 lane、清理分支與錯誤文案；保留 group-history 的 dirty-context 隔離和寫入互斥。
- [x] `helperPolicyKey` 的 contract 從當前 v8 升至下一版（依實作時最新值），使舊 checkpoint／draft approvals 依既有 policy 驗證失效。一般保存草稿可能須重新預覽，這是明確的切換影響。
- [x] 移除 PG／記憶體新 research consent 寫入、讀取及方法；既有 PG `external_search_*` 欄位保留未使用，不 drop。保留同一 requester 鎖、TTL、cleanup、quote generation 與 policy reset。
- [x] 過渡期保留舊 session 的最小可讀型別與辨識，只在原入口處，經現有 admission 後，匹配 profile/source/requester、未到期且無較新互動衝突的舊 session，才回覆「公開網路找譜已停用，請改查內部譜庫或上傳檔案」並終止該 session。
- [x] 舊 session 終止分支不得呼叫模型、研究工具、work create、queue enqueue 或 publish；不新增無 session 的關鍵字捷徑。只允許原 session 的有限舊選項；不能把一般「保存」、數字、其他使用者或新草稿誤當退役操作。
- [x] 群組未明確喚醒的舊 message action 維持沉默；有效 requester-scoped postback 仍走原驗證／有效期；舊 quote 不恢復同意或執行權限。
- [x] `external_binary` worker／work 解碼及 EXTERNAL_RESOURCE 設定先保留，僅為已確認的舊工作完成掃描／發布／結果更新；不得再有外部 producer。
- [x] 在保留點加一行 `shortcut:`，寫明僅相容 PR1 前 durable work、owner Ray、PR2 排空 gate 通過後移除；同步記入本計劃。

舊 session 最長十分鐘不是排空外部 work 的證明。不要全面清 Redis、改全域 state prefix 或重設全部使用者狀態。

退出條件：新外部工作不可從任何 runtime／按鈕／quote／舊 session 建立；舊工作仍能用相同 idempotency key 和 Asset descriptor 恢復，不重抓或重複發布。

## 5. Task 2：PR1 同步移除部署與 release 依賴

- [x] 刪除 SearXNG manifest/settings；移除 release workflow 對已刪路徑的 trigger。
- [x] 刪除 deploy 的 manifest/temp files／secret-key rendering、create/update、FQDN lookup、URL 注入與相關 required variables。
- [x] 移除 Bot 及 release-probe Job 的 `SEARXNG_BASE_URL`／timeout；依 ACA update 的實際語意驗證環境變數已刪除，不只在模板中消失。
- [x] 不在 deployment script 中自動刪 Azure App；PR1 留下現存 SearXNG 原狀，不再管理或更新它。
- [x] 移除 known-good SearXNG snapshot、mutation tracking、rollback 分支；保留 bot、attachment app／finite job、catalog、probe 與 periodic assurance 的回復保護。
- [x] 從 release-probe input/runner/checks 移除 `searxng_root`；從 report types/allowlists/failure maps/private-pending 必要集合移除 SearXNG。TS 與 Bash 內嵌 Python 同步修改。
- [x] Deployment receipt 使用嚴格 `version: 2` 並移除 `searxngImage`，同步 producer、reader、acceptance env mapping、workflow artifact contract 及 fixtures。版本差異不能只靠忽略多餘欄位。
- [x] 明確區分 receipt 和 assurance report 的 schema：receipt 必須升版；report 外層若未改形狀可保留 v1，但當前合法 check 集合已更動，測試／文件必須一致，不能把舊 report 當新 release 證據。
- [x] 新 reader 拒絕舊 receipt、錯 commit/run/revision/image/deployment-attempt／Redis fence；舊 deferred acceptance 必須以產生它的 workflow/commit 處理，不能轉成新格式補蓋驗收。
- [x] 測試 PR1 發布中途失敗回復 pre-PR1 bot、worker 和 probe Job 的 image／manifest；舊 probe 所需 SearXNG 在此時仍存在。移除專用 rollback 不能刪共同 revision copy＋OCI digest pinning。
- [x] 保留內部 Bot ingress、Dapr app id/port/protocol、Account preflight、Postgres/Redis readiness、gateway signed-empty probes、故障 report 與可證明時才加入的零 provider attestation。

退出條件：沒有 SearXNG 資源的 synthetic deployment 能成功；成功、private-pending、失敗回滾、failed-job-only acceptance 重試都有對應證據。無任何新 deploy 路徑會重建 SearXNG。

## 6. Task 3：PR1 驗證與發布

先跑最相關的測試，再跑 repository gates；修復真實失敗，不為已通過的別名重跑同一 evaluator。

| 驗證面向      | 必須覆蓋的案例                                                                                                                    | 主要位置                                                                                     |
| ------------- | --------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| 內部查譜      | 命中、格式篩選、ambiguous、多結果、not-found 不給上網按鈕、unavailable 不降為 not-found                                           | `sheet-music.test.ts`、`registry.test.ts`、read-tools tests                                  |
| 舊狀態／入口  | 舊同意、數字、保存、取消、重播、不同 profile/requester/source、沒有 requester、session 到期；新互動不被舊 session 攔截            | helper runtime/experience/state、`profile-runtime.test.ts`、session tests                    |
| 群組與 quote  | 未喚醒沉默、scoped postback、舊 quote generation、contract 變動、dirty-context exception、正常譜庫／知識 quote 可 fresh-read      | `quoted-continuation.test.ts`、quote tests                                                   |
| 模型／權限    | 無研究工具、無 6-call 模式、一般寫入 policy/review 不變、`main` 零 provider                                                       | helper tools/budget/runtime、main tests                                                      |
| 既有外部 work | PR1 前 queued/claimed、有 Asset ID、已建立 descriptor 未存 ID、暫時失敗、expired publishing、pendingJobUpdate；不重抓、不重複發布 | attachment worker/store/job/lifecycle tests                                                  |
| 共用附件      | LINE 圖片／檔案及群組 intent、lease fencing、outbox retry、clean-only 發布、ack、結果隔離、media-sync                             | attachment/media-sync tests                                                                  |
| Release       | 無 SearXNG 的成功發布、probe/private-pending、嚴格 v2 receipt、v1 拒絕、跨版 rollback、失敗 report 不虛報 attestation             | deployment-contract、release probe/report/metadata/assurance、`scripts/release-flow.test.py` |

- [x] `pnpm format:check`
- [x] `pnpm typecheck`
- [x] `pnpm lint`
- [x] `pnpm test`（含 release shell/Python wrapper tests；確認實際有執行相關流程）
- [x] `pnpm build`
- [x] `pnpm architecture:check`
- [x] `pnpm eval:agent`（同一離線 evaluator，不再重跑 sdk-agent/kernel 別名）
- [x] `pnpm eval:retrieval-product`
- [x] `pnpm eval:kernel:integration`（本次改 Redis/PG lifecycle；只用隔離測試服務，不連 production）
- [x] `pnpm smoke:webhook`（確認腳本使用 synthetic／本機 fixture，且不載入真 provider）
- [ ] 更新 `src/tools/eval-sdk-agent.ts`、`src/evals/synthetic-runtime-fixture.ts`、PG integration matrix 與 case/report 清單；原研究 cases 改成退役負向案例，保留共享權限、隔離、quote、preview 的等價覆蓋。
- [ ] 更新現行文件；操作手冊目前對公開頁面閱讀的描述已落後於實作，一併改成退役後行為，不延續舊說明。
- [ ] 開 PR，required `PR CI` 通過；若沒有部署授權，到此停在 verified/unmerged PR。
- [ ] 另行獲准後 merge，由既有 GitHub Actions Production Release 發布；不手動另建部署路徑。
- [ ] 記錄新 revision、resolved digest、traffic、Job/app image、release report 和 acceptance 狀態；provider-free smoke 通過才算發布驗證完成。

Signed-empty webhook 僅證明 reachability，不證明 LINE delivery 或 reply-token。真實 LINE 單聊／群組、上傳檔案及有 provider 的對話驗收要另外列出授權和結果；無授權時標為 pending，不能以離線測試取代。

## 7. Task 4：PR1 後排空外部工作

執行者：獲授權的實作／操作代理；owner Ray。PR1 上線完成後，先保留相容 worker 和現存 SearXNG。

- [ ] 驗證所有承接流量的 bot revisions 已是 PR1 之後，舊 in-flight turns／background producers 已終止；檢查舊 finite job executions 及 attachment app replicas，不只看 latestRevision。
- [ ] 記錄最後可能產生外部 work 的時間和當時的核對清單；跨切換在途工作納入後續掃描，不只使用切換前 snapshot。
- [ ] 用 bounded SCAN 完整巡檢 attachment-scan-work prefix，依 `externalUrl` 分類；同時核對 outbox set、外部工作的 Redis AgentJob 記錄、active worker／finite job 執行和可取得的 queue delivery 證據。
- [ ] 分開記錄 pending_enqueue、queued、claimed、publishing、terminal-but-pendingJobUpdate、pending/uncertain job，以及 parse 失敗或查無原紀錄的未確定項。
- [ ] Redis `get` 的 projected job、總 queue depth、只看 outbox index、單次 peek、只等 90 分鐘或只看 SearXNG request count 都不能單獨證明排空。
- [ ] Queue 只裝 opaque work ID／kind，沒有可直接依 external 來源篩選的欄位；peek 不能看 invisible 訊息或保證覆蓋整佇列。LINE/media-sync 工作可持續存在，不要求共用 queue 歸零，也不為檢查而 receive/dequeue/ack 訊息。
- [ ] 定義觀察間隔時依實際生產 max visibility、lease、retry、outbox interval 和最後 producer 終止時間計算；目前程式基準 visibility 32 分鐘、claim lease 35 分鐘、work TTL 90 分鐘只作核對，不能當成功捷徑。
- [ ] 初次完整檢查後，再於涵蓋在途 lease／delivery 的間隔後重查；搭配無新 producer 證據和個別已知工作的 durable terminal/result 核對。SCAN 非 snapshot；若有 race、無法分類的訊息或資料已到期而無結果，維持 unknown，不推定完成。
- [ ] `publication_abandoned`／uncertain 必須先核對 Graph/catalog/Asset 是否已發布，不能 blindly replay；暫時錯誤留給相容 worker 正常重試，不在巡檢程式中改資料。
- [ ] 不呼叫 queue purge、清全部 Redis、取消共用 LINE 工作或手動改 claimed/publishing 狀態。需人工處理的工作另列精確處置及授權，未完成前阻擋 PR2 上線。

**排空 gate**：無新 external producer；完整檢查範圍可證明；所有已知外部 work 均有 durable terminal 和結果同步證據；沒有未結案外部 job、pendingJobUpdate、active lease／publish 或未知項。若 TTL 已吃掉必要證據，不以零計數補證，先處理證據缺口。

不以固定日期強制移除相容程式。Ray 持有暫留 owner；每次交接帶上未結案數與上述退出條件，避免無期限技術債。

## 8. Task 5：PR2 清理 worker 與過渡相容程式

只有排空 gate 通過後才部署此 PR。由最新 main 另開隔離 `codex/*` 分支，不從未合併 PR1 形成新任務。

- [ ] 移除外部下載 client、external-only errors、worker options/config 和 `EXTERNAL_RESOURCE_*` env，覆蓋 Bot、attachment app、finite job、`.env.example`。
- [ ] 收斂 `AttachmentScanWorkInput`／worker 到 LINE 來源；TS parser、Redis Lua hasOnlyKeys/XOR 驗證與 producer/consumer 同步修改，不只刪 TypeScript 欄位。
- [ ] 保持仍可能存在的 terminal 舊 work 安全重複投遞：若需要讀取最小 terminal tombstone，僅保留到原 TTL／queue retry 範圍；不容許藉舊 external payload 新建工作或下載。必要時將此小段延後清除並明列 owner／條件，不讓 parser 拒絕舊格式冒充「missing 即成功」。
- [ ] 不無故升級全部 work schema／全域 Redis contract；若實際需要 schema 變更，先補新舊 LINE work 的相容測試與 rollback，再決定最小版本策略。
- [ ] 移除 PR1 過渡舊 session 終止分支、session 型別及 store methods；測試其原 TTL 過後的 session 不影響一般查詢／新互動。保留原 JSON/session 邊界的錯誤處理。
- [ ] `PreparedResourceBinary.sourceKind` 等只有 LINE caller 的欄位可以隨呼叫者一起收斂，但不改 Asset ownership/idempotency、publication lease、queue ack 與 durable 結果語意。
- [ ] 保留 `external_link` 的保存／查詢及既有資料；刪除專用 positive tests，保留拒絕任意外部下載與共享附件安全的負向覆蓋。
- [ ] 跑 Task 3 的完整 gates；特別驗證尚未完成的 LINE work、舊 LINE format、重複 queue delivery、result retrieval 和 PR2→PR1 回滾。
- [ ] PR CI 通過；獲授權後 merge／Production Release／provider-free smoke。沒有部署授權則留 PR unmerged，SearXNG 仍保留。

退出條件：目前 binary worker 只接受合法 LINE work；不依賴 external downloader；一般附件與 media-sync 無回歸；rollback 到 PR1 無格式不相容。

## 9. Task 6：最後刪除 Azure App

前提：兩個 PR 已發布且 smoke/acceptance 狀態明確、排空 gate 仍成立、已決定回退基準為 PR1 或 PR2，並取得刪除此資源的明確授權。

- [ ] 再確認 subscription、resource group、resource type 和名稱，精確目標只有 `alive / Microsoft.App/containerApps / hhc-searxng`；不刪 resource group 或 environment。
- [ ] 以正常 secret 管理流程保留必要的重建來源，僅在私密位置保存；public 文件只指向 Git 中最後 manifest/settings、pinned OCI digest 和重新產生設定 secret 的程序，不保存 secret 值。
- [ ] 確認沒有 current ACA app/job env、release gate、rollout 或排程仍依賴 SearXNG；只檢查 env 不足以證明沒有其他程式硬編碼 caller，保留此次盤點的覆蓋範圍。
- [ ] 單獨的受控操作刪除這個 App，不把每次 application deployment 變成自動刪資源流程。
- [ ] 唯讀確認此精確資源不存在，Bot/attachment app/jobs、Dapr、gateway 與既有 provider-free release probe 仍通過；執行前先確認重跑方式不會順帶做 catalog/Graph/Asset 寫入。
- [ ] 確認不再有 deploy create/update/FQDN lookup 的有效路徑；下次正式發布自然驗證不重建，不為此額外跑整次昂貴 image build。
- [ ] 記錄刪除時間、執行範圍、post-delete smoke 與回滾基準；保留共享 logs、registry、queue、storage、Asset、DB、Redis 及先前匯入檔案。
- [ ] 只有 merge、release、smoke 和後續工作全部完成才移除本任務乾淨暫存 worktrees；local branch commits 已進 origin/main 才刪分支。primary main 若乾淨才 `git pull --ff-only`。

## 10. 失敗與回滾決策

| 時點／失敗                  | 處置                                                                                                                                                               |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Local／PR CI 失敗           | 留分支修復，不能 merge；此時不是 production release failure                                                                                                        |
| PR1 release 失敗            | 現有 transaction 恢復已記錄的 bot／worker／probe 等 revision/image；SearXNG 尚存在，不需移除它；核對 shared state fence                                            |
| PR1 成功但外部工作未排空    | 保持 PR1 相容 worker、原 Asset/outbox 流程與 SearXNG；不部署 PR2、不清工作                                                                                         |
| PR2 失敗或一般附件回歸      | 回到已驗證的 PR1；不重開 research producer；核對 LINE work schema／結果與重複發布                                                                                  |
| 刪 App 失敗                 | Bot 功能退役仍可成立；記錄資源尚存與成本未終止，重試需沿用原精確範圍和授權                                                                                         |
| 刪 App 後需回退 application | 優先回 PR1／PR2 已退役版本；pre-PR1 不是直接可用的回退目標                                                                                                         |
| 必須回 pre-PR1              | 先透過受審重建流程恢復 internal-only SearXNG、設定 secret／URL 與健康，再依 reviewed release 回退 Bot/worker/probe；不可把舊 receipt 改版或開 public endpoint 代替 |

任何回退都不能承諾復活已到期 session／draft，也不能重放已發布外部工作。若回 pre-PR1 重新啟用 producer，先前排空證據失效，後續 cleanup 必須重做 gate。

## 11. Gemini 審查與處置

席次：依 consultant-analysis 未指定數量預設一席，Gemini 一席，不含主代理；未另增顧問。
官方 `agy` CLI，requested model `gemini-4-argon-medium`、plan mode、sandbox、JSON output。
CLI exit code 0、structured status `SUCCESS`、一個 turn，執行約 37 秒；CLI 未回傳 resolved model 欄位，不能額外宣稱服務端實際模型。
顧問只收到公開程式摘錄及本次草綱，沒有 live Azure 匯出、憑證、真實對話或其他專案資料；任務禁止工具、改檔與委派。CLI 回傳一輪文字審查，未觀察到工具操作。

結論為「有條件通過」。這是對草綱的獨立審查，不是最終實作／production 驗收；以下修訂由主代理整合，沒有宣稱顧問再次覆核最終全文。

| 顧問發現                                                  | 處置與最終計劃位置                                                                                                                                                                             |
| --------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 舊 session／按鈕在入口移除後可能落入一般對話              | 採納。Task 1 保留 requester-scoped、原 TTL 的最小終止分支，不給舊操作新權限；Task 3 測完整群組／新互動旅程；Task 5 再清理                                                                      |
| Policy contract 升版需處理 quote generation、dirty marker | 採納。Task 1/3 明訂舊 token、policy reset、history dirty-context 和正常內部 quote 測試                                                                                                         |
| v2 receipt 與 pre-PR1 rollback 可能交錯                   | 採納。Task 2 覆蓋 producer/reader/acceptance/舊 Job manifest 回復；歷史 receipt 不改寫，保留 SearXNG 到所有切換驗證完成                                                                        |
| Drain 必須含完整 work、job、outbox、queue 與結果同步      | 採納原則並修正來源。顧問提出的 PG `agent_jobs` 不存在於目前 owning path，改為 Redis AgentJob。queue 是 opaque/invisible，不能用 peek 或全佇列零計數證明外部工作歸零；Task 4 明列證據缺口即阻擋 |
| 兩 PR 比一次刪 worker 更安全；刪 App 應在 drain 後        | 採納兩 PR；刪除時機更保守地延至 PR2 發布驗證之後。顧問建議 drain 後先刪 App 再 PR2，沒有縮短必要工作且較早失去 pre-PR1 回退能力，故不採此排序                                                  |

一次針對性補查已確認：Redis session reader 是 JSON parse 後依 type 投影，不是遇到已退休 type 就自動安全剔除；需保留兼容測試。`markContextDirty` 由 group history 共用，job store 是 Redis，rollback 會回復舊 probe Job manifest；上述事實均納入 Task 1–4。

## 12. 尚待執行的證據

- 目前 production 的外部 work/job/outbox/queue 完整排空狀態與可觀測性；不能由程式閱讀推定。
- 真實 LINE 裝置上的舊按鈕、quote、單聊／群組、保存結果體驗；需明確授權及測試帳號。
- 兩個 PR 的 local checks、required PR CI、release、public acceptance 與刪除後 smoke。
- 實際帳單節省；退役能移除常駐副本，但沒有本次 billing 計算，不承諾特定金額。

規劃完成不等於上述 gates 已通過。沒有範圍外變更、真 provider 呼叫、merge、發布或 Azure 資源刪除。

## 13. PR1 實作進度

已移除 public research tools/client/page reader、新同意及外部匯入 producer、研究模式與額度，policy contract 升為 v9。保留 requester/source/profile-scoped 舊 session 的一次性終止與現有 worker 外部工作相容；不攔截目前內部選擇或附件／review 狀態。沒有修改 worker 的下載、Asset、lease、outbox 或發布邏輯，只有標記暫留理由。

部署不再建立／更新 SearXNG，release probe/report/rollback 解除專用依賴，deployment receipt 嚴格升為 v2。已補上舊 receipt 拒絕和 pre-retirement probe manifest 回復案例；保留舊資源於 production，以供後續受控發布回退。

目前 local typecheck、lint、build、architecture、config validation、offline agent evaluator、retrieval evaluator、隔離 Redis/PG integration 與本機 signed webhook smoke 已通過。完整 test suite 為 164 files passed、1 skipped；1,858 tests passed、66 skipped。另有 19 個 offline agent cases、35 個整合單元測試與 24 個 real-dependency matrix／cleanup checks 通過。66 個 full-suite skip 不算通過證據，涉及本次 helper state 的 PG/Redis 路徑已有獨立整合 gate；PR CI 尚待執行，不能將本段作為 production 證據。沒有 merge、發布、真 provider/LINE 呼叫、Azure mutation 或 azure-infra 修改。

尚未完成：production 唯讀 work/job/outbox/queue 基線、切換後排空、PR2、cloud App 刪除與真實 LINE 驗收。依賴上線的項目不能在未合併 PR1 上假裝完成。
