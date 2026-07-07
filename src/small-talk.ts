import { SMALL_TALK_CATEGORIES } from "./types.js";
import type {
  BotProfileConfig,
  FunctionExecutionResult,
  JsonRecord,
  SmallTalkCategory,
  TextGenerationProvider
} from "./types.js";

const replies: Record<SmallTalkCategory, string> = {
  greeting: "你好，我在。有需要再叫我就好。",
  wellbeing: "我在，謝謝你關心。有需要查資料再叫我就好。",
  thanks: "不客氣，有需要再叫我。",
  encouragement: "不辛苦，我在旁邊幫忙就好。",
  reassurance: "不會啦，我比較適合安靜地幫忙查資料。有明確歌名或聚會範圍時，我會比較快幫上忙。",
  persona: "有一點像，我比較適合安靜地把資料找好。",
  light_joke: "我可以安靜幫忙，但不要太考驗我。"
};

export function createSmallTalkReply(category: SmallTalkCategory): FunctionExecutionResult {
  return {
    ok: true,
    replyText: replies[category]
  };
}

export interface ControlledSmallTalkInput {
  profile: BotProfileConfig;
  text: string;
  category: SmallTalkCategory;
  generator?: TextGenerationProvider;
}

export async function createControlledSmallTalkReply(
  input: ControlledSmallTalkInput
): Promise<FunctionExecutionResult> {
  const fallback = createSmallTalkReply(input.category);
  const config = input.profile.smallTalk ?? { mode: "template" as const, maxChars: 80 };
  if (config.mode !== "llm" || !input.generator) {
    return fallback;
  }

  try {
    const reply = sanitizeGeneratedReply(
      await input.generator.completeText({
        prompt: buildSmallTalkPrompt(input.category, config.maxChars),
        profileName: input.profile.name,
        text: input.text,
        category: input.category,
        maxChars: config.maxChars
      }),
      config.maxChars
    );
    return reply ? { ok: true, replyText: reply } : fallback;
  } catch {
    return fallback;
  }
}

export function smallTalkCategoryFromArguments(args: JsonRecord): SmallTalkCategory {
  const raw = typeof args.category === "string" ? args.category.trim() : "";
  return isSmallTalkCategory(raw) ? raw : "reassurance";
}

export function isSmallTalkCategory(value: string): value is SmallTalkCategory {
  return (SMALL_TALK_CATEGORIES as readonly string[]).includes(value);
}

function buildSmallTalkPrompt(category: SmallTalkCategory, maxChars: number): string {
  return [
    "你是 LINE bot 小哈，是台灣教會同工的小助理。",
    `請根據使用者訊息回覆一句繁體中文，最多 ${maxChars} 個字。`,
    `small_talk 類別是 ${category}。`,
    "語氣要像熟悉但安靜的教會同工，溫和、簡短、自然。",
    "不要回答知識問題，不要給心理諮商或屬靈權威建議，不要編造資料。",
    "不要提到系統、模型、AI、Ollama、Notion、OneDrive、Graph、Azure、token、prompt。",
    "不要包含網址、Markdown、條列、引號、表情符號。"
  ].join("\n");
}

function sanitizeGeneratedReply(value: string, maxChars: number): string | undefined {
  const reply = value
    .normalize("NFC")
    .trim()
    .replace(/^["'「『]+|["'」』]+$/gu, "")
    .replace(/\s+/gu, " ");
  if (!reply) {
    return undefined;
  }
  if (Array.from(reply).length > maxChars) {
    return undefined;
  }
  if (/https?:\/\/|www\./iu.test(reply)) {
    return undefined;
  }
  if (/[#*_`>-]/u.test(reply)) {
    return undefined;
  }
  if (
    /系統|模型|AI|LLM|Ollama|Notion|OneDrive|Graph|Azure|token|secret|prompt|開發|資料庫/iu.test(
      reply
    )
  ) {
    return undefined;
  }
  return reply;
}
