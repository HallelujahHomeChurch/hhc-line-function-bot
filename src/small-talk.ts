import { SMALL_TALK_CATEGORIES } from "./types.js";
import { providerCapabilities } from "./llm/provider-metadata.js";
import type {
  BotProfileConfig,
  FunctionExecutionResult,
  JsonRecord,
  ModelProviderName,
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
  fallbackGenerator?: TextGenerationProvider;
}

export async function createControlledSmallTalkReply(
  input: ControlledSmallTalkInput
): Promise<FunctionExecutionResult> {
  const fallback = createSmallTalkReply(input.category);
  const config = input.profile.smallTalk ?? { mode: "template" as const, maxChars: 80 };
  if (config.mode !== "llm" || !input.generator) {
    return {
      ...fallback,
      smallTalkTrace: {
        lane: "smart_talk",
        outcome: "template",
        reason: config.mode !== "llm" ? "template_mode" : "generator_missing"
      }
    };
  }

  const primaryReply = await tryGeneratedReply(input, input.generator, config.maxChars);
  if (primaryReply.replyText) {
    return {
      ok: true,
      replyText: primaryReply.replyText,
      smallTalkTrace: {
        lane: "smart_talk",
        outcome: "generated",
        provider: primaryReply.provider
      }
    };
  }

  if (input.fallbackGenerator && input.fallbackGenerator !== input.generator) {
    const fallbackReply = await tryGeneratedReply(input, input.fallbackGenerator, config.maxChars);
    if (fallbackReply.replyText) {
      return {
        ok: true,
        replyText: fallbackReply.replyText,
        smallTalkTrace: {
          lane: "smart_talk",
          outcome: "fallback",
          provider: fallbackReply.provider,
          reason: "primary_failed"
        }
      };
    }
  }

  return {
    ...fallback,
    smallTalkTrace: {
      lane: "smart_talk",
      outcome: "template",
      reason: "generation_failed"
    }
  };
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
    "你是 LINE bot 小哈，是一個受控的小助理。",
    "你像一位成熟、溫和、懂生活的基督徒朋友，能自然理解教會生活，也懂一般日常生活。",
    `請根據使用者訊息回覆一句繁體中文，最多 ${maxChars} 個字。`,
    `small_talk 類別是 ${category}。`,
    "你的回覆要自然、簡短、有分寸。",
    "除非使用者主動提到信仰、教會、服事、聚會、詩歌或相關情境，不要刻意使用宗教用語或教會梗。",
    "不要回答需要查證的知識問題，不要假裝查過資料，不要給心理諮商、醫療、法律、財務或屬靈權威建議。",
    "不要提到系統、模型、AI、Ollama、DeepSeek、Notion、OneDrive、Graph、Azure、token、prompt。",
    "不要包含網址、Markdown、條列、引號、表情符號。"
  ].join("\n");
}

interface GeneratedReplyAttempt {
  replyText?: string;
  provider?: ModelProviderName;
}

async function tryGeneratedReply(
  input: ControlledSmallTalkInput,
  generator: TextGenerationProvider,
  baseMaxChars: number
): Promise<GeneratedReplyAttempt> {
  const maxChars = effectiveSmartTalkMaxChars(generator, input.profile.name, baseMaxChars);
  const provider = providerNameForGenerator(generator, input.profile.name);
  try {
    const replyText = sanitizeGeneratedReply(
      await generator.completeText({
        prompt: buildSmallTalkPrompt(input.category, maxChars),
        profileName: input.profile.name,
        text: input.text,
        category: input.category,
        maxChars
      }),
      maxChars
    );
    return { replyText, provider };
  } catch {
    return { provider };
  }
}

function providerNameForGenerator(
  generator: TextGenerationProvider,
  profileName: string
): ModelProviderName | undefined {
  return generator.providerNameForProfile?.(profileName) ?? generator.providerName;
}

function effectiveSmartTalkMaxChars(
  generator: TextGenerationProvider,
  profileName: string,
  baseMaxChars: number
): number {
  const providerName = providerNameForGenerator(generator, profileName);
  const capabilities = providerName ? providerCapabilities[providerName] : generator.capabilities;
  return capabilities?.remoteApi ? Math.max(baseMaxChars, 320) : baseMaxChars;
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
