import { buildAgentJobScope, type AgentJobStore } from "../agent/jobs.js";
import type { PublicSearchAnswer } from "../clients/public-web-search.js";
import type { QuoteToken } from "../quotes/types.js";
import type { FunctionHandler, FunctionHandlerContext } from "../types.js";

export function explicitPublicQuestion(text: string | undefined): string | undefined {
  const question = /^(?:@?小哈[，,\s]*)?公開搜尋[:：]\s*([^\r\n]+)$/u
    .exec(text?.trim() ?? "")?.[1]
    ?.trim();
  return question && Buffer.byteLength(question) <= 2_000 ? question : undefined;
}

export interface PublicSearchDependencies {
  search(question: string): Promise<PublicSearchAnswer>;
  reserve(profile: string, requester: string, eventId: string): Promise<boolean>;
  jobs: AgentJobStore;
  isCurrent(token: QuoteToken): Promise<boolean>;
  now?: () => Date;
}

export function createPublicSearchHandler(options: PublicSearchDependencies): FunctionHandler {
  return async (_args, context) => {
    const question = explicitPublicQuestion(context.event.message?.text);
    const token = context.quoteContext?.token;
    const scope = buildAgentJobScope(context.profile.name, context.event.source);
    const eventId = context.event.webhookEventId ?? context.event.message?.id;
    const unavailable = (replyText: string) => ({
      ok: false,
      replyText,
      authoritativeReply: true,
      contextPolicy: "status_only" as const,
      agentResult: { status: "unavailable" as const, replyText: "公開搜尋未完成。" }
    });
    if (
      context.profile.name !== "helper" ||
      !context.profile.enabledFunctions.includes("query_public_web") ||
      !context.profile.allowedProviders.includes("openai")
    )
      return unavailable("目前未開放公開搜尋。");
    if (!question)
      return unavailable(
        "請另給可公開查詢的問題，例如「小哈，公開搜尋：台南本週展覽」。只會送出冒號後的新問題，不使用對話或筆記內容。"
      );
    if (
      !scope ||
      !token ||
      !eventId ||
      !context.event.source.userId ||
      !(await options.isCurrent(token))
    )
      return unavailable("這次搜尋上下文已失效，請重新明確提出公開問題。");
    if (!(await options.reserve(context.profile.name, context.event.source.userId, eventId)))
      return unavailable(
        "本次公開搜尋未執行：可能已處理、今日額度已用完，或額度服務暫時不可用。請勿重複提交。"
      );
    const now = options.now?.() ?? new Date();
    const job = await options.jobs.createPending({
      scope,
      contextToken: token,
      capability: "query_public_web",
      label: "公開搜尋",
      ttlMs: 10 * 60_000
    });
    try {
      const answer = await options.search(question);
      if (!(await options.isCurrent(token))) throw new Error("public_search_context_expired");
      const result = {
        ok: true,
        authoritativeReply: true,
        contextPolicy: "status_only" as const,
        externalSearch: { kind: "web_search" as const, resultId: job.id },
        resultAuthority: {
          kind: "capabilities" as const,
          capabilities: ["query_public_web" as const],
          expiresAt: new Date(now.getTime() + 10 * 60_000).toISOString()
        },
        replyText: `公開搜尋結果（外部來源）\n${answer.text}`,
        agentResult: {
          status: "success" as const,
          replyText: "公開搜尋結果由伺服器顯示。",
          replyData: { kind: "external_delivery", fields: { deliveredByServer: true } }
        }
      };
      await options.jobs.complete(job.id, result, "query_public_web");
      console.info(
        JSON.stringify({
          event: "helper.public_search",
          status: "completed",
          model: "gpt-6-luna",
          inputTokens: answer.inputTokens,
          outputTokens: answer.outputTokens,
          searchCalls: answer.searchCalls
        })
      );
      return {
        ...result,
        replyText: `${result.replyText}\n\n結果保留 10 分鐘。如需保存，請另傳：\n小哈，保存搜尋結果 ${job.id}\n仍需預覽確認。`
      };
    } catch {
      await options.jobs.fail(job.id, "public_search_unavailable");
      console.info(
        JSON.stringify({ event: "helper.public_search", status: "unavailable", usageUnknown: true })
      );
      return unavailable(
        "公開搜尋暫時不可用，這次沒有可確認的搜尋答案；不會自動重試或改用其他模型冒充搜尋結果。"
      );
    }
  };
}

export function createSearchResultReader(
  options: Pick<PublicSearchDependencies, "jobs" | "isCurrent">
) {
  return async (id: string, context: FunctionHandlerContext): Promise<string | undefined> => {
    const scope = buildAgentJobScope(context.profile.name, context.event.source);
    if (!scope || !context.profile.enabledFunctions.includes("query_public_web")) return undefined;
    const job = await options.jobs.get(id, scope);
    if (
      job?.status !== "completed" ||
      job.capability !== "query_public_web" ||
      job.result?.externalSearch?.kind !== "web_search" ||
      job.result.externalSearch.resultId !== id ||
      !job.contextToken ||
      !(await options.isCurrent(job.contextToken))
    )
      return undefined;
    return job.result.replyText;
  };
}
