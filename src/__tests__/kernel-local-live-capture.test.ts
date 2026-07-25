import { describe, expect, it } from "vitest";

import { createCaptureLineReplyClient } from "../testing/kernel-local-live/capture-line-client.js";
import {
  RedisKernelLocalLiveChannel,
  type KernelLocalLiveRedisClient
} from "../testing/kernel-local-live/redis-channel.js";

describe("Kernel local live Redis capture", () => {
  it("captures a reply once without storing its text", async () => {
    const redis = new FakeRedisClient();
    const channel = new RedisKernelLocalLiveChannel(redis, "run-a");
    const client = createCaptureLineReplyClient(channel);

    await client.replyText("reply-token-1", "private reply body", {
      quickReplies: [{ label: "選擇一", action: { type: "message", text: "1" } }]
    });

    const captured = await channel.readReply("reply-token-1");
    expect(captured).toMatchObject({
      replyToken: "reply-token-1",
      quickReplyLabels: ["選擇一"]
    });
    expect(captured?.replyHash).toMatch(/^[a-f0-9]{64}$/u);
    expect(JSON.stringify(redis.values)).not.toContain("private reply body");
    await expect(channel.readReply("reply-token-1")).resolves.toBeUndefined();
  });

  it("isolates run prefixes and removes only the owned namespace", async () => {
    const redis = new FakeRedisClient();
    const first = new RedisKernelLocalLiveChannel(redis, "run-a");
    const second = new RedisKernelLocalLiveChannel(redis, "run-b");
    await first.writeReply({
      replyToken: "same-token",
      replyHash: "a".repeat(64),
      quickReplyLabels: []
    });
    await second.writeReply({
      replyToken: "same-token",
      replyHash: "b".repeat(64),
      quickReplyLabels: []
    });

    await first.cleanup();

    await expect(first.readReply("same-token")).resolves.toBeUndefined();
    await expect(second.readReply("same-token")).resolves.toMatchObject({
      replyHash: "b".repeat(64)
    });
  });

  it("rejects observation fields outside the allowlist", async () => {
    const channel = new RedisKernelLocalLiveChannel(new FakeRedisClient(), "run-a");
    await expect(
      channel.appendObservation({
        caseId: "schedule-explicit",
        kind: "route",
        rawText: "must not persist"
      })
    ).rejects.toThrow("kernel_local_live_observation_unknown_key");
  });
});

class FakeRedisClient implements KernelLocalLiveRedisClient {
  readonly values = new Map<string, string>();
  readonly lists = new Map<string, string[]>();

  async set(key: string, value: string): Promise<string> {
    this.values.set(key, value);
    return "OK";
  }

  async getDel(key: string): Promise<string | null> {
    const value = this.values.get(key) ?? null;
    this.values.delete(key);
    return value;
  }

  async rPush(key: string, value: string): Promise<number> {
    const list = this.lists.get(key) ?? [];
    list.push(value);
    this.lists.set(key, list);
    return list.length;
  }

  async lRange(key: string, start: number, stop: number): Promise<string[]> {
    const list = this.lists.get(key) ?? [];
    return list.slice(start, stop < 0 ? undefined : stop + 1);
  }

  async *scanIterator(options: { MATCH: string }): AsyncGenerator<string> {
    const prefix = options.MATCH.replace(/\*$/u, "");
    const keys = [...this.values.keys(), ...this.lists.keys()].filter((key) =>
      key.startsWith(prefix)
    );
    for (const key of keys) yield key;
  }

  async del(keys: string[]): Promise<number> {
    let removed = 0;
    for (const key of keys) {
      if (this.values.delete(key)) removed += 1;
      if (this.lists.delete(key)) removed += 1;
    }
    return removed;
  }
}
