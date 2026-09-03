# SDK Agent Harness 可行性與全 Repo Complexity Audit

日期：2026-09-04。基準：`origin/main` `04d085646bb40f4386afa4243401542926b5f39b`。此文件補足「設計合理」與「已用 SDK 實際驗證」之間的證據差距。

## 結論

**可以確認 LangChain/LangGraph 能取代自製 agent orchestration 的大部分機械結構，而且真實 DeepSeek 已在小型 live gate 中完成預期的跨工具選擇、一般聊天與寫入暫停。完整 production 品質仍須在實際 adapters 完成後，用30個案例各跑3次驗收。**

實際使用已發布的 LangChain JS `createAgent`、DeepSeek adapter、LangGraph InMemorySaver／PostgresSaver 與官方 middleware，完成14項 mechanics probe，14項通過。另以真實 `deepseek-chat` 跑4個去識別化情境各3次。這證明 SDK 可以擁有工具循環、多工具結果、history、thread、interrupt/resume、limits 與 checkpoint，無需保留自製候選→planner→validator→active-task 流程。

Live probe 由使用者建立的主 checkout `.env` 注入 `DEEPSEEK_API_KEY`；沒有輸出、複製或提交 key，分析 worktree 也沒有建立 `.env`。小型 gate 足以核准選型方向，不能用來宣稱95%服事情境目標或完整 product acceptance 已通過。

## 調查涵蓋範圍

- 讀取 README、AGENTS、architecture-context、production composition、LINE turn runtime、DeepSeek client、provider policy、候選／planner／validator／task state、全部12個 function 的 definition/module/代表 handler、Account/action policy、Redis/Postgres state、knowledge/catalog/schedule/attachment/media-sync 邊界與主要 tests/evals。
- 跑原版本 `pnpm test`：151 files passed、1,897 tests passed、39 skipped；`pnpm eval:agent`、`pnpm eval:kernel` 另有原版本基準。這些不代表新 SDK 或真實 DeepSeek 品質。
- 全 repo TS 統計：`src` 113,489 行，其中 production-like source 約49,433行、tests/evals/testing/tools約64,056行。找出直接依賴自製 agent 名稱的 tests/evals共24,460行；這只是受影響面，不是可以整批刪除的行數。
- 使用 `tsc --noUnusedLocals --noUnusedParameters` 額外發現3個低價值未用參數／變數；現有正式 tsconfig 沒開此 gate。
- 檢查截至當日正式 npm套件內容與型別，沒有依賴未發布 GitHub main API。

沒有逐行人工閱讀113,489行，也沒有把所有 test 視為 legacy。調查以 production import path、主要資料流、全部 function surface、相關 state/security contracts、靜態引用與 repo-wide complexity scan 為界；不應描述為每行 correctness review。

## 實際 SDK Probe

### 環境

| 項目                                       | 值                                                                           |
| ------------------------------------------ | ---------------------------------------------------------------------------- |
| Node                                       | 24.14.1                                                                      |
| `langchain`                                | 1.5.10                                                                       |
| `@langchain/deepseek`                      | 1.1.11                                                                       |
| `@langchain/langgraph-checkpoint-postgres` | 1.0.5                                                                        |
| `pg`                                       | 8.23.0                                                                       |
| `zod`                                      | 4.5.4                                                                        |
| PostgreSQL                                 | isolated `postgres:16-alpine` container                                      |
| Mechanics 模型 endpoint                    | local scripted OpenAI-compatible endpoint；真實 SDK request/response parsing |
| Live 模型                                  | `deepseek-chat`；由未提交的 local env 注入 key                               |

套件安裝在 `/tmp/hhc-sdk-feasibility.vvQqJQ`，使用 `npm install --ignore-scripts --save-exact`，沒有加入專案 dependencies。所有 tool data 和人名都是 synthetic。PostgreSQL container 只存 probe checkpoint及 synthetic operation ID。

### 14項結果

| Probe                             | 結果                              | 證明內容                                                            |
| --------------------------------- | --------------------------------- | ------------------------------------------------------------------- |
| 跨正式表與筆記兩個工具            | PASS；3 model calls、2 tool calls | SDK迴圈可在not-found後繼續其他工具，並把兩個結果送回模型            |
| 同一 response 平行兩個工具        | PASS                              | tool batch會產生兩個對應 tool results                               |
| 第二個使用者回合                  | PASS                              | history含前回合使用者訊息和tool evidence                            |
| 不同 thread                       | PASS                              | B的request沒有A的marker                                             |
| 模型要求不存在的tool              | PASS                              | 沒有執行handler；SDK回傳tool error讓模型處理                        |
| strict schema夾帶`confirm`        | PASS                              | 沒有執行handler；未知欄位被拒                                       |
| model call limit                  | PASS                              | 第2次模型呼叫後以`ModelCallLimitMiddlewareError`停止                |
| tool call limit與平行batch        | PASS                              | 超額batch執行0個tool並以`ToolCallLimitExceededError`停止            |
| AbortSignal                       | PASS                              | 84ms停止，沒有等完600ms endpoint delay                              |
| 多步找歌譜                        | PASS；5 model calls、4 tool calls | search→read歌詞頁→換query→search→read樂譜頁；0 download             |
| Postgres pause後新process approve | PASS                              | approval前0 write，新process resume後1 write                        |
| Postgres pause後新process reject  | PASS                              | approval前後均0 write                                               |
| Postgres pause後撤權再resume      | PASS                              | server tool guard阻止寫入，0 write                                  |
| `deleteThread`                    | PASS                              | `checkpoints`、`checkpoint_blobs`、`checkpoint_writes`該thread均為0 |

初次 probe 曾失敗，原因是 scripted provider 每個 response 使用同一 message ID，SDK reducer將後續AI message當成前一個的更新。改成每個回應唯一ID後，14項全部通過。這是 probe fixture 問題，也形成一個 production contract：模型/provider response ID 必須保留唯一性，不能由自製 adapter壓成常數；加入回歸測試。

### 真實 DeepSeek 小型 Live Gate

四個案例全部使用 synthetic 名稱與資料，不接 production function、資料庫或寫入 handler。前導輪原始斷言把模型回覆文字也視為檔案生命週期權威，因此是3/4；這個失敗沒有被忽略，而是形成 server projection 的硬性要求。修正量測方式後另跑三輪，同時記錄 raw model wording 和 authoritative projection，三輪均為4/4。

| 情境                                 | 3輪結果         | 觀察                                                  |
| ------------------------------------ | --------------- | ----------------------------------------------------- |
| 正式服事表查無→補查可見筆記          | 3/3             | 每輪皆依序呼叫 `query_schedule`、`search_information` |
| 一般聊天不呼叫工具                   | 3/3             | 每輪0 tool call                                       |
| 歌詞頁→換詞→找到SATB歌譜候選         | 3/3工具序列正確 | 每輪2次search＋2次read；0 download                    |
| `save_schedule` proposal             | 3/3             | 每輪都停在SDK interrupt；approval前0 write            |
| 模型自行正確描述「候選／未送掃」狀態 | 2/3             | 正式3輪中1輪過度承諾；前導輪也發生相同問題            |
| server authoritative projection      | 3/3             | 固定依domain stage表達候選、未下載、未掃描、未保存    |

正式三輪合計 input 14,343 tokens、output 2,665 tokens；另有一輪前導測試用來揭露生命週期文案問題。這批數據顯示 DeepSeek 能做本案需要的多步工具選擇，也顯示 prompt 無法可靠保證副作用或檔案狀態用語。正式回覆必須由 domain result 與 server projection 覆蓋這些欄位；模型只負責說明與整理。

### Probe揭露的必要 guardrails

- SDK會阻止不存在的工具或不合schema的參數執行，但通常把錯誤作為tool result交還模型，並非都向transport throw。因此 transport不能只看agent是否正常返回就宣稱寫入成功。
- HITL成功暫停與恢復不等於業務授權。撤權probe依靠tool執行前的server guard才維持0 write。
- 寫入成功訊息、附件、分享連結仍由domain result／server response projection決定；模型文字不能成為副作用完成的唯一證據。
- 官方PostgresSaver可跨process恢復並提供`deleteThread`，但idle TTL、scope key、並發和來源revision失效仍是本專案要接的policy metadata。這不是重造checkpoint serializer。
- 第一次多步找譜用了5次模型呼叫；設計原先「每回合最多4次」不足。建議讀取回合run limit先設6、write tool上限1，並用live資料決定是否下修；thread-level另設上限及TTL。不能為迎合舊預估砍掉必要的第二次搜尋。

## 是否真的能移除自製 Harness

核心相關14個production files合計6,785行，但不可全部刪除：`functions/definitions.ts`、`function-arguments.ts`、turn runtime、context store仍各有help/schema/transport/wake-window等必要部分。可以有證據地切分如下。

### 可由SDK直接取代

| 自製責任                                                   | 主要檔案／現況                                               | SDK證據                                                              |
| ---------------------------------------------------------- | ------------------------------------------------------------ | -------------------------------------------------------------------- |
| candidate排序與top-N准入                                   | `capability-candidates.ts` 526行                             | 所有有效授權工具可交給模型；未知tool不執行                           |
| 一次性JSON planner                                         | `planner.ts` 562行、`controlled-agent-router.ts` 297行       | 原生tool calls與tool results完成多步迴圈                             |
| semantic/confidence validator                              | `plan-validator.ts` 627行、`plan-evidence.ts` 379行          | schema、available tools、limits有SDK邊界；真正auth另留server guard   |
| 單一`currentCapability` task frame                         | active-task／transition／codec共603行                        | messages/checkpoint延續多工具與跨回合；Postgres可跨process恢复／刪除 |
| 自製model/tool loop與部分stage order                       | `application/turn/runtime.ts` 1,380行中的agent orchestration | `createAgent`驅動到stop、limit或interrupt                            |
| function上的大量agent routing metadata與inline router eval | definitions/modules共1,678行中的agentCapability／eval部分    | 簡短tool description＋Zod schema＋獨立產品eval即可                   |

### 必須保留或搬到薄 adapter

- LINE簽章、event去重、wake window、profile/source/requester與Account effective permissions。
- `query_schedule`正式資料、knowledge/memory visibility、catalog freshness、Graph item live validation與來源revision。
- `save_schedule`/memory/resource的domain validation、preview、confirmation binding、idempotency、transaction與audit。
- attachment/media-sync/outbox/worker/Asset scan/clean-only publication。SDK只協調，不碰binary。
- admin/system action catalog/policy/audit，以及provider-free main。
- `not_found`/`unavailable`/`stale`/`ambiguous` typed results、response-only links與privacy-safe telemetry。

### Persona 與 Memory Audit

- Repo目前沒有`personal.md`、`PERSONA.md`或`MEMORY.md`。Helper身份分散在profile `identityLine`、四段small-talk prompt與template replies；完整persona只送入small-talk generator，SDK切換時需統一成helper system prompt。
- 現有文字memory已具private/group visibility、30天expiry、preview/confirm、owner/admin deletion與requester filtering，適合保留成domain store。
- README與AGENTS明確禁止自動群聊記錄；目前conversation window也只收bot已受理、profile/source/requester-scoped的短期回合。把「某人最常問什麼」加入durable memory會把功能記憶變成個人行為側寫，不應作為預設。
- 建議`PERSONA.md`只描述bot身份、語氣與可信度；`MEMORY.md`只描述記憶選擇及禁區。兩者版本控制且唯讀，runtime內容仍存PostgreSQL。群組可自動做無人物、無原文的能力使用量聚合；個人偏好只能本人direct opt-in。

這個界線表示會保留本專案約束，但不再保留「先用我們的router判斷能不能讓agent看工具」的第二套語意代理人。薄adapter的判斷依profile/source/auth/schema，不依中文phrase/confidence。

## Ponytail Repo-wide Findings

以下只找複雜度；不把security、correctness或效能問題混進刪碼清單。估算等SDK integration及引用掃描後再以實際diff取代。

1. `delete:` candidate→planner→semantic validator整條自製語意鏈，約2,391 production lines。以`createAgent`原生tool calls＋server auth/schema guard取代。[`src/agent/capability-candidates.ts`](../../../src/agent/capability-candidates.ts)
2. `delete:` currentCapability active-task、transition與codec，約603 lines。以官方messages/checkpoint取代；opaque refs的scope validation留下。[`src/agent/active-task.ts`](../../../src/agent/active-task.ts)
3. `shrink:` 1,380-line turn runtime中受SDK取代的plan/collect/execute/result lifecycle，預估減700–1,000 lines。留下LINE coordination、admin/system與authoritative response projection。[`src/application/turn/runtime.ts`](../../../src/application/turn/runtime.ts)
4. `shrink:` 873-line function definitions和805-line modules中的routing hints、confidence、operation matrix、inline phrase eval，預估減700–1,000 lines。留下名稱、help、權限、side effect、Zod schema及module composition。[`src/functions/definitions.ts`](../../../src/functions/definitions.ts)
5. `shrink:` PPT／歌譜／general resource各自的ranking、selection、分享及reply orchestration。共用catalog query/selection/share primitives，保留storage adapter差異，預估減400–700 lines。[`src/functions/find-pop-sheet-music.ts`](../../../src/functions/find-pop-sheet-music.ts)
6. `delete:` `createContextManager()`及`recentTurns()`目前只有tests呼叫；SDK messages接管後移除未接線builder。保留被group wake使用的bounded store，預估減80–150 lines。[`src/agent/context-manager.ts`](../../../src/agent/context-manager.ts)
7. `delete:` runtime保留`fallback`角色與sheet-music fallback summarizer，但configuration明確拒絕fallback provider。agent統一回答後移除，預估減100–200 lines。[`src/llm/provider-runtime.ts`](../../../src/llm/provider-runtime.ts)
8. `delete:` `controlledAgent.maxCandidates/minPlannerConfidence`配置、型別、route-test輸出及專測。SDK tool availability與live eval取代，production減50–100 lines並刪舊機制tests。[`src/config.ts`](../../../src/config.ts)
9. `delete:` 2-line `server.ts`、7-line`agent/turn-runtime.ts` compatibility facade在所有imports遷移後可刪；低價值，放最後。[`src/server.ts`](../../../src/server.ts)
10. `delete:` strict no-unused compile找到3個現有未用參數／變數。直接移除並把noUnused gate納入typecheck，估計減3–10 lines。[`src/config.ts`](../../../src/config.ts)

net: 約-4,000到-5,500 production lines，-0 deps possible；SDK migration預計增加3個direct SDK packages及其transitive dependencies。

## 實作前後仍需完成的 Gate

1. 把 throwaway mechanics 與4-case live probe 做成 repo 內可重跑、預設 offline 的測試；鎖定 exact versions 與 lockfile。
2. 實際 source adapters 與 tool descriptions 整合後，將設計中的30個案例各跑3次；小型 synthetic outputs不證明資料檢索與完整模型品質。
3. 所有檔案、分享與寫入回覆由 server projection 驗證 lifecycle；加入「模型說已完成但domain仍是candidate／pending」反例。
4. 上述 gate 通過後才大幅刪除；若失敗，先歸因DeepSeek、tool contract、SDK或資料，不回頭加phrase router。

因此，選型與架構調查已足以決定採用 LangChain/LangGraph 作為 helper agent harness；它是本專案目前最佳適配，不是所有 agent 專案的普遍最佳答案。完整產品改善仍以實際 adapters、30×3 live suite、LINE smoke及安全驗收為準。
