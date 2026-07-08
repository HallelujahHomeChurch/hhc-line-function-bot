import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface } from "node:readline";
import type { EventEmitter } from "node:events";
import type { Readable, Writable } from "node:stream";

export type JsonValue =
  string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };

export interface RpcRequest {
  jsonrpc: "2.0";
  id: number;
  method: string;
  params?: unknown;
}

export interface RpcNotification {
  jsonrpc?: "2.0";
  method: string;
  params?: unknown;
}

export interface RpcResponse {
  jsonrpc?: "2.0";
  id: number;
  result?: unknown;
  error?: {
    code?: number;
    message?: string;
    data?: unknown;
  };
}

export interface CodexAppServerTransport extends EventEmitter {
  stdin: Writable;
  stdout: Readable;
  stderr: Readable;
  close?: () => void;
}

type PendingRequest = {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timeout: NodeJS.Timeout;
};

export interface CodexAppServerStartOptions {
  command: string;
  args: string[];
  cwd?: string;
  env?: NodeJS.ProcessEnv;
}

export class CodexAppServerRpcError extends Error {
  constructor(
    message: string,
    readonly code?: number,
    readonly data?: unknown
  ) {
    super(message);
    this.name = "CodexAppServerRpcError";
  }
}

export class CodexAppServerClient {
  private readonly pending = new Map<number, PendingRequest>();
  private readonly notificationHandlers = new Set<(notification: RpcNotification) => void>();
  private nextId = 1;
  private closed = false;
  private stderrTail = "";

  private constructor(private readonly transport: CodexAppServerTransport) {
    createInterface({ input: transport.stdout }).on("line", (line) => this.handleLine(line));
    transport.stderr.on("data", (chunk) => {
      this.stderrTail = appendTail(this.stderrTail, String(chunk), 2000);
    });
    transport.once("exit", (code, signal) => {
      this.closeWithError(
        new Error(
          `codex app-server exited: code=${code ?? "null"} signal=${signal ?? "null"} ${
            this.stderrTail ? `stderr=${this.stderrTail}` : ""
          }`.trim()
        )
      );
    });
    transport.once("error", (error) => {
      this.closeWithError(error instanceof Error ? error : new Error(String(error)));
    });
  }

  static start(options: CodexAppServerStartOptions): CodexAppServerClient {
    const child = spawn(options.command, options.args, {
      cwd: options.cwd,
      env: options.env,
      stdio: ["pipe", "pipe", "pipe"]
    });
    const transport = child as ChildProcessWithoutNullStreams & CodexAppServerTransport;
    transport.close = () => {
      if (!child.killed) {
        child.kill();
      }
    };
    return new CodexAppServerClient(transport);
  }

  static fromTransportForTests(transport: CodexAppServerTransport): CodexAppServerClient {
    return new CodexAppServerClient(transport);
  }

  onNotification(handler: (notification: RpcNotification) => void): () => void {
    this.notificationHandlers.add(handler);
    return () => this.notificationHandlers.delete(handler);
  }

  initialize(timeoutMs = 10_000): Promise<unknown> {
    return this.request(
      "initialize",
      {
        clientInfo: {
          name: "hhc-line-function-bot",
          title: "HHC LINE Function Bot",
          version: "0.1.0"
        },
        capabilities: { experimentalApi: true }
      },
      timeoutMs
    );
  }

  request(method: string, params?: unknown, timeoutMs = 30_000): Promise<unknown> {
    if (this.closed) {
      return Promise.reject(new Error("codex app-server client is closed"));
    }
    const id = this.nextId++;
    const message: RpcRequest = { jsonrpc: "2.0", id, method, params };
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`${method} timed out`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timeout });
      this.transport.stdin.write(`${JSON.stringify(message)}\n`, (error) => {
        if (error) {
          clearTimeout(timeout);
          this.pending.delete(id);
          reject(error);
        }
      });
    });
  }

  close(): void {
    this.closed = true;
    this.transport.stdin.end();
    this.transport.close?.();
  }

  private handleLine(line: string): void {
    if (!line.trim()) {
      return;
    }
    let message: unknown;
    try {
      message = JSON.parse(line);
    } catch {
      return;
    }
    if (!isObject(message)) {
      return;
    }
    if (typeof message.id === "number") {
      this.handleResponse(message as unknown as RpcResponse);
      return;
    }
    if (typeof message.method === "string") {
      for (const handler of this.notificationHandlers) {
        handler(message as unknown as RpcNotification);
      }
    }
  }

  private handleResponse(response: RpcResponse): void {
    const pending = this.pending.get(response.id);
    if (!pending) {
      return;
    }
    clearTimeout(pending.timeout);
    this.pending.delete(response.id);
    if (response.error) {
      pending.reject(
        new CodexAppServerRpcError(
          response.error.message ?? "codex app-server RPC failed",
          response.error.code,
          response.error.data
        )
      );
      return;
    }
    pending.resolve(response.result);
  }

  private closeWithError(error: Error): void {
    if (this.closed) {
      return;
    }
    this.closed = true;
    for (const [id, pending] of this.pending) {
      clearTimeout(pending.timeout);
      pending.reject(error);
      this.pending.delete(id);
    }
  }
}

export function extractAssistantTextFromNotification(
  notification: RpcNotification
): string | undefined {
  if (!isObject(notification.params)) {
    return undefined;
  }
  const item = isObject(notification.params.item) ? notification.params.item : undefined;
  if (!item) {
    return undefined;
  }
  if (
    notification.method === "item/completed" &&
    item.type === "agentMessage" &&
    item.phase !== "commentary"
  ) {
    return readTextItem(item);
  }
  if (
    notification.method === "rawResponseItem/completed" &&
    item.type === "message" &&
    item.role === "assistant" &&
    item.phase !== "commentary"
  ) {
    return readContentText(item.content);
  }
  return undefined;
}

export function isTerminalTurnNotification(notification: RpcNotification): boolean {
  if (!isObject(notification.params)) {
    return false;
  }
  if (notification.method === "turn/completed") {
    return true;
  }
  if (notification.method !== "thread/status") {
    return false;
  }
  const status = typeof notification.params.status === "string" ? notification.params.status : "";
  return status === "completed" || status === "failed" || status === "interrupted";
}

function readTextItem(item: Record<string, unknown>): string | undefined {
  if (typeof item.text === "string") {
    return item.text.trim() || undefined;
  }
  return readContentText(item.content);
}

function readContentText(content: unknown): string | undefined {
  if (!Array.isArray(content)) {
    return undefined;
  }
  const text = content
    .flatMap((entry) => {
      if (!isObject(entry)) {
        return [];
      }
      return typeof entry.text === "string" ? [entry.text] : [];
    })
    .join("\n")
    .trim();
  return text || undefined;
}

function appendTail(current: string, next: string, max: number): string {
  return `${current}${next}`.slice(-max);
}

function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}
