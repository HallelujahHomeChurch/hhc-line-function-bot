import { describe, expect, it, vi } from "vitest";

import {
  AzureAttachmentScanQueue,
  InMemoryAttachmentScanQueue
} from "../attachments/scan-queue.js";

describe("attachment scan queue", () => {
  it("keeps only opaque work ids in the in-memory adapter", async () => {
    const queue = new InMemoryAttachmentScanQueue();
    await queue.enqueue("4c03465b-8a87-45a2-9d0d-54f904f4e6ab");
    expect(queue.workIds).toEqual(["4c03465b-8a87-45a2-9d0d-54f904f4e6ab"]);
    expect(queue.workItems).toEqual([
      {
        kind: "attachment",
        workId: "4c03465b-8a87-45a2-9d0d-54f904f4e6ab"
      }
    ]);
  });

  it("records the explicit media-sync kind in the in-memory adapter", async () => {
    const queue = new InMemoryAttachmentScanQueue();
    await queue.enqueue("4c03465b-8a87-45a2-9d0d-54f904f4e6ab", "media-sync");

    expect(queue.workItems).toEqual([
      {
        kind: "media-sync",
        workId: "4c03465b-8a87-45a2-9d0d-54f904f4e6ab"
      }
    ]);
  });

  it("serializes an Azure Queue message with only workId", async () => {
    const sendMessage = vi.fn().mockResolvedValue({});
    const queue = new AzureAttachmentScanQueue({ sendMessage });

    await queue.enqueue("4c03465b-8a87-45a2-9d0d-54f904f4e6ab");

    expect(sendMessage).toHaveBeenCalledTimes(1);
    const serialized = sendMessage.mock.calls[0]?.[0] as string;
    expect(JSON.parse(serialized)).toEqual({
      workId: "4c03465b-8a87-45a2-9d0d-54f904f4e6ab"
    });
    expect(Object.keys(JSON.parse(serialized))).toEqual(["workId"]);
  });

  it("serializes media-sync work with an explicit kind and no source identity", async () => {
    const sendMessage = vi.fn().mockResolvedValue({});
    const queue = new AzureAttachmentScanQueue({ sendMessage });

    await queue.enqueue("4c03465b-8a87-45a2-9d0d-54f904f4e6ab", "media-sync");

    expect(JSON.parse(sendMessage.mock.calls[0]?.[0] as string)).toEqual({
      kind: "media-sync",
      workId: "4c03465b-8a87-45a2-9d0d-54f904f4e6ab"
    });
  });
});
