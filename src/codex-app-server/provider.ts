import {
  CodexAppServerClient,
  extractAssistantTextFromNotification,
  isTerminalTurnNotification,
  type RpcNotification
} from "./client.js";
import { ProviderResponseError } from "../router.js";
import type { ChatProvider, LlmConfig, TextGenerationProvider } from "../types.js";

export interface CodexAppServerProviderOptions {
  config: LlmConfig;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  clientFactory?: () => CodexAppServerClient;
}

export function createCodexAppServerProvider(
  options: CodexAppServerProviderOptions
): ChatProvider & TextGenerationProvider {
  return new CodexAppServerProvider(options);
}

class CodexAppServerProvider implements ChatProvider, TextGenerationProvider {
  readonly providerName = "codex_app_server" as const;

  constructor(private readonly options: CodexAppServerProviderOptions) {}

  completeJson(request: Parameters<ChatProvider["completeJson"]>[0]): Promise<string> {
    return this.runTurn([request.prompt, "", "User message:", request.text].join("\n"));
  }

  completeText(request: Parameters<TextGenerationProvider["completeText"]>[0]): Promise<string> {
    return this.runTurn([request.prompt, "", "User message:", request.text].join("\n"));
  }

  private async runTurn(prompt: string): Promise<string> {
    const client = this.options.clientFactory?.() ?? this.startClient();
    const assistantTexts: string[] = [];
    let terminalWait: { promise: Promise<void>; cancel: () => void } | undefined;

    try {
      await client.initialize(this.timeoutMs());
      terminalWait = this.waitForTerminal(client, assistantTexts);
      await client.request(
        "thread/start",
        {
          input: [{ type: "text", text: prompt, text_elements: [] }],
          cwd: this.options.cwd ?? process.cwd(),
          model: this.options.config.codexModel,
          modelProvider: this.options.config.codexModelProvider ?? "openai",
          approvalPolicy: "never",
          sandbox: "read-only",
          developerInstructions:
            "You are serving a LINE bot. Return only the requested final answer. Do not call native shell or file tools.",
          experimentalRawEvents: true,
          dynamicTools: []
        },
        this.timeoutMs()
      );
      await terminalWait.promise;
      const text = assistantTexts.join("\n\n").trim();
      if (!text) {
        throw new ProviderResponseError("codex_empty_response");
      }
      return text;
    } catch (error) {
      if (error instanceof ProviderResponseError) {
        throw error;
      }
      throw new ProviderResponseError(error instanceof Error ? error.message : "codex_unreachable");
    } finally {
      terminalWait?.cancel();
      client.close();
    }
  }

  private waitForTerminal(client: CodexAppServerClient, assistantTexts: string[]) {
    let settled = false;
    let off: () => void = () => undefined;
    let timeout: NodeJS.Timeout | undefined;
    const finish = (callback: () => void) => {
      if (settled) {
        return;
      }
      settled = true;
      if (timeout) {
        clearTimeout(timeout);
      }
      off();
      callback();
    };
    const promise = new Promise<void>((resolve, reject) => {
      timeout = setTimeout(
        () => finish(() => reject(new ProviderResponseError("timeout"))),
        this.timeoutMs()
      );
      off = client.onNotification((notification) => {
        const text = extractAssistantTextFromNotification(notification);
        if (text) {
          assistantTexts.push(text);
        }
        if (isErrorNotification(notification)) {
          finish(() => reject(new ProviderResponseError("codex_app_server_error")));
        }
        if (isTerminalTurnNotification(notification)) {
          finish(resolve);
        }
      });
    });
    return { promise, cancel: () => finish(() => undefined) };
  }

  private startClient(): CodexAppServerClient {
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      ...this.options.env,
      ...(this.options.config.codexHome ? { CODEX_HOME: this.options.config.codexHome } : {})
    };
    delete env.OPENAI_API_KEY;
    delete env.CODEX_API_KEY;
    return CodexAppServerClient.start({
      command: this.options.config.codexAppServerCommand ?? "codex",
      args: this.options.config.codexAppServerArgs ?? ["app-server", "--listen", "stdio://"],
      cwd: this.options.cwd,
      env
    });
  }

  private timeoutMs(): number {
    return this.options.config.timeoutMs;
  }
}

function isErrorNotification(notification: RpcNotification): boolean {
  return notification.method === "error" || notification.method === "turn/error";
}
