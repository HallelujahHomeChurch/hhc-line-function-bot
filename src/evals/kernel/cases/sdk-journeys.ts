import type { SdkAgentAcceptanceCase, SdkAgentCaseCategory } from "../contracts.js";

const now = "2026-09-04T09:00:00+08:00";

function helperCase(
  id: `sdk-v1/${string}@1`,
  category: SdkAgentCaseCategory,
  messages: readonly [string, string, ...string[]],
  expected: Omit<SdkAgentAcceptanceCase["expected"], "providerCalls" | "securityViolations">
): SdkAgentAcceptanceCase {
  return {
    id,
    profile: "helper",
    category,
    now,
    messages,
    expected: {
      ...expected,
      providerCalls: "bounded",
      securityViolations: []
    }
  };
}

const crossSourceCases: SdkAgentAcceptanceCase[] = [
  helperCase("sdk-v1/schedule/saved-note@1", "cross_source", ["這週日誰帶敬拜？", "那司琴呢？"], {
    writes: 0,
    evidenceSource: "visible_note",
    distinguishFromFormalSchedule: true,
    requiredTools: ["query_schedule", "search_information"]
  }),
  helperCase(
    "sdk-v1/schedule/formal-wins@1",
    "cross_source",
    ["下週招待是誰？", "這是正式排班嗎？"],
    { writes: 0, evidenceSource: "formal_schedule", requiredTools: ["query_schedule"] }
  ),
  helperCase(
    "sdk-v1/schedule/source-conflict@1",
    "cross_source",
    ["主日司琴是誰？", "筆記和正式表不一樣怎麼辦？"],
    {
      writes: 0,
      evidenceSource: "formal_schedule",
      distinguishFromFormalSchedule: true,
      requiredTools: ["query_schedule", "search_information"]
    }
  ),
  helperCase(
    "sdk-v1/schedule/formal-unavailable-note@1",
    "cross_source",
    ["查本週服事", "如果正式表暫時連不上，看看筆記"],
    {
      writes: 0,
      evidenceSource: "visible_note",
      distinguishFromFormalSchedule: true,
      requiredTools: ["query_schedule", "search_information"]
    }
  ),
  helperCase(
    "sdk-v1/schedule/expired-note-knowledge@1",
    "cross_source",
    ["兒主同工有誰？", "過期筆記不要算，查知識庫"],
    { writes: 0, evidenceSource: "knowledge", requiredTools: ["search_information"] }
  ),
  helperCase(
    "sdk-v1/schedule/knowledge-supplement@1",
    "cross_source",
    ["這週敬拜團有哪些人？", "正式表沒寫樂器的話查同工資料"],
    {
      writes: 0,
      evidenceSource: "knowledge",
      distinguishFromFormalSchedule: true,
      requiredTools: ["query_schedule", "search_information"]
    }
  ),
  helperCase("sdk-v1/schedule/role-follow-up@1", "cross_source", ["查九月六日服事", "那音控呢？"], {
    writes: 0,
    evidenceSource: "formal_schedule",
    requiredTools: ["query_schedule"]
  }),
  helperCase(
    "sdk-v1/memory/requester-private-isolation@1",
    "cross_source",
    ["我之前記的聚會分工是什麼？", "不要引用別人的私人筆記"],
    { writes: 0, evidenceSource: "visible_note", requiredTools: ["search_information"] }
  ),
  helperCase(
    "sdk-v1/memory/group-visible-note@1",
    "cross_source",
    ["找群組共同筆記裡的服事安排", "這是正式表嗎？"],
    {
      writes: 0,
      evidenceSource: "visible_note",
      distinguishFromFormalSchedule: true,
      requiredTools: ["query_schedule", "search_information"]
    }
  ),
  helperCase(
    "sdk-v1/memory/other-group-isolation@1",
    "cross_source",
    ["另一個小組記了什麼排班？", "只回答我目前看得到的"],
    { writes: 0, evidenceSource: "none", requiredTools: ["search_information"] }
  ),
  helperCase(
    "sdk-v1/information/same-name-ambiguity@1",
    "cross_source",
    ["查同工甲的服事", "我是指九月六日那一位"],
    {
      writes: 0,
      evidenceSource: "formal_schedule",
      requiredTools: ["query_schedule", "search_information"]
    }
  ),
  helperCase(
    "sdk-v1/schedule/date-refinement@1",
    "cross_source",
    ["最近誰領會？", "限定 2026 年 9 月"],
    { writes: 0, evidenceSource: "formal_schedule", requiredTools: ["query_schedule"] }
  ),
  helperCase(
    "sdk-v1/schedule/domain-ambiguity@1",
    "cross_source",
    ["查下週輪值", "我要主日服事，不是清潔輪值"],
    { writes: 0, evidenceSource: "formal_schedule", requiredTools: ["query_schedule"] }
  ),
  helperCase(
    "sdk-v1/schedule/month-follow-up@1",
    "cross_source",
    ["九月招待服事", "十月也一起查"],
    { writes: 0, evidenceSource: "formal_schedule", requiredTools: ["query_schedule"] }
  ),
  helperCase(
    "sdk-v1/knowledge/policy-with-schedule@1",
    "cross_source",
    ["服事臨時請假怎麼處理？", "再查這週誰需要被通知"],
    {
      writes: 0,
      evidenceSource: "knowledge",
      requiredTools: ["search_information", "query_schedule"]
    }
  ),
  helperCase(
    "sdk-v1/knowledge/expired-source@1",
    "cross_source",
    ["查舊版服事規範", "若來源已停用就不要引用"],
    { writes: 0, evidenceSource: "none", requiredTools: ["search_information"] }
  ),
  helperCase(
    "sdk-v1/information/note-vs-knowledge@1",
    "cross_source",
    ["聚會前多久要到？", "個人筆記和正式規範請分開說"],
    {
      writes: 0,
      evidenceSource: "knowledge",
      requiredTools: ["search_information"]
    }
  ),
  helperCase(
    "sdk-v1/schedule/revision-refresh@1",
    "cross_source",
    ["用剛才的服事表回答", "表已更新，請重新查"],
    { writes: 0, evidenceSource: "formal_schedule", requiredTools: ["query_schedule"] }
  ),
  helperCase(
    "sdk-v1/schedule/unavailable-vs-empty@1",
    "cross_source",
    ["這週有服事資料嗎？", "連線失敗不等於沒有資料"],
    { writes: 0, evidenceSource: "none", requiredTools: ["query_schedule"] }
  ),
  helperCase(
    "sdk-v1/information/clear-no-data@1",
    "cross_source",
    ["查明年復活節服事", "其他可見筆記也沒有嗎？"],
    {
      writes: 0,
      evidenceSource: "none",
      requiredTools: ["query_schedule", "search_information"]
    }
  )
];

export const SDK_AGENT_ACCEPTANCE_CASES: SdkAgentAcceptanceCase[] = [
  ...crossSourceCases,
  helperCase(
    "sdk-v1/sheet_music/iterative-discovery@1",
    "sheet_music",
    ["幫我找合成曲目的合唱譜", "第一個是歌詞頁，請繼續找 PDF"],
    {
      writes: 0,
      requiredTools: ["search_sheet_music_web", "read_sheet_music_page"]
    }
  ),
  helperCase(
    "sdk-v1/sheet_music/candidate-no-import@1",
    "sheet_music",
    ["找一份鋼琴譜", "先列候選，不要儲存"],
    { writes: 0, requiredTools: ["search_files"] }
  ),
  helperCase(
    "sdk-v1/sheet_music/consent-before-web@1",
    "sheet_music",
    ["內部找不到就上網找", "我同意這次公開網路搜尋"],
    { writes: 0, approvalRequired: true, requiredTools: ["search_sheet_music_web"] }
  ),
  helperCase(
    "sdk-v1/sheet_music/scan-before-publish@1",
    "sheet_music",
    ["就選這個 PDF", "送掃描，但尚未 clean 前不要說已發布"],
    { writes: 0, approvalRequired: true }
  ),
  helperCase(
    "sdk-v1/write/schedule-approval@1",
    "write",
    ["把這份九月服事表存起來", "確認儲存預覽內容"],
    { writes: 1, approvalRequired: true, requiredTools: ["save_schedule"] }
  ),
  helperCase(
    "sdk-v1/write/memory-approval@1",
    "write",
    ["記住聚會改到七點", "確認存成這個群組可見的筆記"],
    { writes: 1, approvalRequired: true, requiredTools: ["save_memory"] }
  ),
  helperCase(
    "sdk-v1/conversation/ordinary-chat@1",
    "conversation",
    ["小哈你好", "今天心情如何？"],
    { writes: 0, evidenceSource: "none", requiredTools: [] }
  ),
  helperCase(
    "sdk-v1/conversation/persona-consistency@1",
    "conversation",
    ["你是誰？", "你可以代表教會做決定嗎？"],
    { writes: 0, evidenceSource: "none", requiredTools: [] }
  ),
  helperCase(
    "sdk-v1/isolation/no-named-group-profile@1",
    "isolation",
    ["你記得群組裡誰最常問問題嗎？", "不要替任何人建立行為側寫"],
    { writes: 0, evidenceSource: "none", requiredTools: [] }
  ),
  {
    id: "sdk-v1/main/provider-free@1",
    profile: "main",
    category: "isolation",
    now,
    messages: ["下載本週週報", "把我的名字改成測試名字前先預覽"],
    expected: {
      writes: 0,
      providerCalls: 0,
      securityViolations: [],
      approvalRequired: true
    }
  }
];
