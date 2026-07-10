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

function buildSmallTalkPrompt(
  category: SmallTalkCategory,
  maxChars: number | undefined,
  profile: BotProfileConfig
): string {
  const prompting = profile.smallTalk?.prompting;
  return [
    prompting?.personaPrompt?.trim(),
    maxChars === undefined ? undefined : `請根據使用者訊息回覆一句繁體中文，最多 ${maxChars} 個字。`,
    `small_talk 類別是 ${category}。`,
    prompting?.conversationRulesPrompt?.trim(),
    prompting?.safetyRulesPrompt?.trim(),
    prompting?.formatRulesPrompt?.trim()
  ]
    .filter((part): part is string => Boolean(part))
    .join("\n");
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
        prompt: buildSmallTalkPrompt(input.category, maxChars, input.profile),
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
): number | undefined {
  const providerName = providerNameForGenerator(generator, profileName);
  const capabilities = providerName ? providerCapabilities[providerName] : generator.capabilities;
  return capabilities?.remoteApi ? undefined : baseMaxChars;
}

function sanitizeGeneratedReply(value: string, maxChars: number | undefined): string | undefined {
  const reply = value
    .normalize("NFC")
    .trim()
    .replace(/^["'「『]+|["'」』]+$/gu, "")
    .replace(/^(小哈\s*[，,、:：]?\s*)+/u, "")
    .replace(/\s+/gu, " ");
  if (!reply) {
    return undefined;
  }
  if (maxChars !== undefined && Array.from(reply).length > maxChars) {
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
