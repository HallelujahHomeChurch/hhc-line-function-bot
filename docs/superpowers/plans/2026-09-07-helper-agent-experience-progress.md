# Helper Agent 體驗實作紀錄

工作分支：`codex/helper-agent-experience`，基準 `9086ddd`。使用者已要求審核計劃後開始實作。本紀錄不代表release或LINE驗收完成。

## 審核裁定

- 採一個SDK agent的普通proposal工具準備草稿；提案本身不提交。伺服器以opaque review與一次性取用後執行既有executor。解除「任何提案先暫停整個graph」的耦合，使草稿可持續討論。這是原計劃Phase0要驗證的選項，不引進第二個router。
- 草稿exact arguments可以保存於原有requester-scoped短期session，不能進入LINE postback、trace或長期記憶；main舊session相容。
- 背景一般答案採server-owned結果authority。先保守綁定本次有效工具集合（歷史checkpoint由同policy隔離），取回所有相關權限重查。不能把「沒有executedAction」等同公開內容。
- 原4秒等待不覆蓋前置授權與webhook批次等候；先覆蓋Agent文字與review操作，不宣稱整個HTTP入口已有4秒deadline或process Promise可跨restart續跑。
- 附件草稿工具不批准opt-in或發布；用途與名稱由agent協助，批准由版本綁定的server postback與CAS取用。不能用廣泛文字「確認」跨草稿提交。
- 工具新鮮度投影只取既有server diagnostics中的有效時間及fresh/stale列舉，無provider payload或source identifiers。

## 實作進度

- [x] 隔離worktree與當前PR檢查。
- [x] 工具freshness／截斷資訊回歸red→green，12個policy gateway tests通過。
- [x] 背景結果typed authority、取回重授權、expiry、timer清理與review operation wrapper；focused tests通過。
- [x] 草稿、問題／修改／確認、reset及domain驗證整合；完整預覽與舊按鈕失效。
- [x] 附件草稿、CAS版本確認、composition與入口整合。
- [x] 多結果、研究許可、群組續談及安全事件同步（範圍限制見下）。
- [x] 本地repo gates、PG/Redis整合、bounded live關鍵保存流程與獨立review；30-run與裝置驗收仍未完成。
- [ ] PR CI、release與真實LINE驗收（依授權與可用測試入口）。

## 本地執行

worktree目前重用root node_modules唯讀symlink。pnpm11需以 `pnpm --config.verify-deps-before-run=false ...` 執行，避免自動重安裝共享依賴；沒有更改lockfile或package policy。不得commit symlink。

## 已修正的關鍵邊界

- 正常 domain 缺項回傳 typed outcome，普通 provider 失敗保留 requester checkpoint；外搜污染則 fail closed 清除。
- 提案只能準備草稿。移除未再使用的 graph interrupt/resume 相容層；所有提交仍經一次性取用、即時授權、schema/hash/policy/source revision 與 durable receipt。
- 不允許 model 提供 confirm；保存工具中的 query 字串不能觸發提交。服事表 agent schema 移除與 profile 共用契約矛盾的 visibility；可選欄位不能被模型自行當成必填。
- 完整預覽涵蓋全部日期、年度、欄位和保存原文；LINE 無法完整顯示時不能取得批准資格。多月份輸入要求明確分月，不能悄悄只保存第一個月。
- 長草稿提供get／精確片段修改／重新預覽／取消工具，只在有草稿時暴露；每次查即時Account與完整policy key，不從摘要重造原文。結構化entry／changes須走新提案，沒有通用JSON patch。
- reset 在同 thread lock 內清除 review、附件、upload intent 和外搜短期狀態；舊確認按鈕不能復活。同輪最多一項草稿變更。
- helper 啟用4秒 Agent inline 等待、30分鐘結果保存。一般答案及混合成果以完整有效能力集合綁定，取回重新授權；附件／文字預覽另綁到期時間。查看結果不重跑 Agent。
- 外搜只使用原先同意的找譜題目；讀取外部網頁與變更草稿不能發生於同輪。外部回覆不進後續可寫入的 checkpoint。
- 多讀取成果合併且保留各項結果；與預覽共存時先完整呈現預覽。LINE 以最多5則合法長度訊息交付。

## 驗收證據與尚未驗收

- 真實 DeepSeek 完整保存流程修正後連續通過兩次：預覽→提問保留草稿→更正換新批准→確認（0次模型呼叫）→另一群組讀回 exact 日期／更正對象；只提交一次。第一次7 requests、19,312 input+output tokens；最終工具組合再次7 requests、18,232 tokens、8.75秒。
- 先前第一批8/10、後續診斷失敗均保留；發現 live fixture 使用簡化 prompt，以及模型將可選欄位誤當必填，已分別修正。這些探索資料不構成29/30穩定成功率。
- 累計已知59 provider requests、101,945 input+output tokens；另一次診斷中斷未取得usage，依該次上限保守計入最多10 requests，總請求上界69。沒有把未知usage當0。
- 本地 signed HTTP webhook smoke 回200且捕捉1次模擬LINE reply，provider requests=0；這不是實際LINE送達。
- 最終完整本地測試：139個檔案，1,546通過、39依環境略過；format/typecheck/lint/build/architecture gates通過。
- 最終Redis／PostgreSQL：17/17 tests與21/21 integration matrix；retrieval-product 2/2、offline Agent evaluator17/17通過。最終獨立review的混合長預覽截斷P1已red→green修正並複查關閉。

| 案例    | 實作／本地驗證責任                                                       | 尚待驗收                         |
| ------- | ------------------------------------------------------------------------ | -------------------------------- |
| U01–U04 | 現有SDK evaluator、schedule/retrieval tests                              | 完整三輪live穩定率               |
| U05–U16 | draft、review、experience、schedule-memory、state tests；真實保存journey | 真實LINE多月份分月與過期按鈕     |
| U17–U18 | 同輪單草稿回歸、agent-memory可見性tests                                  | 複合保存逐輪live                 |
| U19–U24 | runtime多結果、結果同步、gateway freshness、retrieval-product            | 實際檔案選擇後追問、三點比較live |
| U25–U28 | research lane、consent query、注入拒絕及worker既有tests                  | 真實找譜到掃描送達               |
| U29–U31 | attachment draft、intake、CAS tests                                      | LINE多檔及自然修改完整操作       |
| U32–U34 | signed group clarification、requester/session isolation                  | 真實群組90秒接續                 |
| U35–U36 | server草稿工具、checkpoint失敗保留及durable receipt                      | 大草稿實際token／摘要成本基準    |
| U37–U39 | jobs、reset race、Redis/PG integration                                   | 部署重啟中的真實LINE取回         |
| U40–U41 | policy tests、main provider-free evaluator與main tests                   | 上線後main對照驗收               |

## 明確限制

- 完整 ingress 收件到reply的 deadline（前置授權、同webhook其他events、LINE網路發送）仍未涵蓋；4秒只保證進入Agent wrapper後的inline等待。後續應在入口獨立驗證與改善，不隨意改成無持久化fire-and-forget。
- 群組120秒續談只由工具明確的 ambiguous／needs_input 訊號延長；一般聊天及純模型反問仍60秒，不把15分鐘群組訊息全部送模型。
- 執行中的Promise不能跨程序重啟；Redis結果會到期且不假裝自動續跑。已提交receipt仍可回放。
- 保留既有8K清tool／16K摘要／24K硬門檻、正常4次／研究6次限制與thinking disabled；沒有全域提高token額度。
- 尚未做正式30-run穩定率與成本median/p95比較，也未完成真實LINE裝置驗收；不得把本地測試或empty webhook等同產品驗收。
