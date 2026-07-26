import {
  KERNEL_LOCAL_LIVE_CASE_IDS,
  type KernelLocalLiveCaseId
} from "../../evals/kernel/local-live/contracts.js";

const OBSERVATION_KEYS = new Set([
  "caseId",
  "kind",
  "disposition",
  "capability",
  "validatorReason",
  "resultClass",
  "lifecycleOutcome",
  "provider",
  "ordinal",
  "outcome"
]);

export interface KernelLocalLiveRedisClient {
  set(key: string, value: string): Promise<unknown>;
  getDel(key: string): Promise<string | null>;
  rPush(key: string, value: string): Promise<number>;
  lRange(key: string, start: number, stop: number): Promise<string[]>;
  scanIterator(options: { MATCH: string }): AsyncIterable<string[]>;
  del(keys: string[]): Promise<number>;
}

export interface CapturedLineReply {
  replyToken: string;
  replyHash: string;
  quickReplyLabels: string[];
}

export interface KernelLocalLiveObservation {
  caseId: KernelLocalLiveCaseId;
  kind: string;
  disposition?: string;
  capability?: string;
  validatorReason?: string;
  resultClass?: string;
  lifecycleOutcome?: string;
  provider?: string;
  ordinal?: number;
  outcome?: string;
}

export class RedisKernelLocalLiveChannel {
  private readonly keyPrefix: string;

  constructor(
    private readonly client: KernelLocalLiveRedisClient,
    runId: string
  ) {
    if (!/^[a-z0-9-]{1,64}$/u.test(runId)) throw new Error("kernel_local_live_run_id_invalid");
    this.keyPrefix = `kernel-local-live:${runId}`;
  }

  async writeReply(reply: CapturedLineReply): Promise<void> {
    assertReply(reply);
    await this.client.set(this.replyKey(reply.replyToken), JSON.stringify(reply));
  }

  async readReply(replyToken: string): Promise<CapturedLineReply | undefined> {
    const raw = await this.client.getDel(this.replyKey(replyToken));
    if (!raw) return undefined;
    const value = JSON.parse(raw) as CapturedLineReply;
    assertReply(value);
    return value;
  }

  async appendObservation(input: unknown): Promise<void> {
    const value = assertObservation(input);
    await this.client.rPush(`${this.keyPrefix}:observations`, JSON.stringify(value));
  }

  async readObservations(): Promise<KernelLocalLiveObservation[]> {
    const entries = await this.client.lRange(`${this.keyPrefix}:observations`, 0, -1);
    return entries.map((entry) => assertObservation(JSON.parse(entry)));
  }

  async cleanup(): Promise<void> {
    const keys: string[] = [];
    for await (const batch of this.client.scanIterator({ MATCH: `${this.keyPrefix}:*` })) {
      keys.push(...batch);
    }
    if (keys.length > 0) await this.client.del(keys);
  }

  private replyKey(replyToken: string): string {
    if (!/^[A-Za-z0-9_-]{1,128}$/u.test(replyToken)) {
      throw new Error("kernel_local_live_reply_token_invalid");
    }
    return `${this.keyPrefix}:reply:${replyToken}`;
  }
}

function assertReply(value: CapturedLineReply): void {
  if (
    !value ||
    typeof value.replyToken !== "string" ||
    !/^[a-f0-9]{64}$/u.test(value.replyHash) ||
    !Array.isArray(value.quickReplyLabels) ||
    value.quickReplyLabels.some((label) => typeof label !== "string" || label.length > 40)
  ) {
    throw new Error("kernel_local_live_reply_invalid");
  }
}

function assertObservation(input: unknown): KernelLocalLiveObservation {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new Error("kernel_local_live_observation_invalid");
  }
  const value = input as Record<string, unknown>;
  if (Object.keys(value).some((key) => !OBSERVATION_KEYS.has(key))) {
    throw new Error("kernel_local_live_observation_unknown_key");
  }
  if (
    typeof value.caseId !== "string" ||
    !KERNEL_LOCAL_LIVE_CASE_IDS.includes(value.caseId as KernelLocalLiveCaseId) ||
    typeof value.kind !== "string"
  ) {
    throw new Error("kernel_local_live_observation_invalid");
  }
  const result: KernelLocalLiveObservation = {
    caseId: value.caseId as KernelLocalLiveCaseId,
    kind: value.kind
  };
  for (const key of [
    "disposition",
    "capability",
    "validatorReason",
    "resultClass",
    "lifecycleOutcome",
    "provider",
    "outcome"
  ] as const) {
    if (value[key] === undefined) continue;
    if (typeof value[key] !== "string") {
      throw new Error("kernel_local_live_observation_invalid");
    }
    result[key] = value[key];
  }
  if (value.ordinal !== undefined) {
    if (typeof value.ordinal !== "number" || !Number.isInteger(value.ordinal)) {
      throw new Error("kernel_local_live_observation_invalid");
    }
    result.ordinal = value.ordinal;
  }
  return result;
}
