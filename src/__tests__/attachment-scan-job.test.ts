import { describe, expect, it, vi } from "vitest";

import {
  readAttachmentScanJobEnvironment,
  receiveAttachmentScanWork,
  shouldAcknowledgeAttachmentScanResult
} from "../tools/run-attachment-scan-job.js";

describe("attachment scan job environment", () => {
  it("accepts one opaque work id and bounded local scanner settings", () => {
    expect(
      readAttachmentScanJobEnvironment({
        WORK_ID: "4c03465b-8a87-45a2-9d0d-54f904f4e6ab",
        CLAMAV_DATABASE_DIRECTORY: "/var/lib/clamav/current",
        CLAMAV_SIGNATURE_MANIFEST_PATH: "/var/lib/clamav/manifest.json",
        CLAMAV_SCAN_TIMEOUT_MS: "15000"
      })
    ).toEqual({
      workId: "4c03465b-8a87-45a2-9d0d-54f904f4e6ab",
      databaseDirectory: "/var/lib/clamav/current",
      signatureManifestPath: "/var/lib/clamav/manifest.json",
      scanTimeoutMs: 15_000
    });
  });

  it.each([
    [{}, "WORK_ID"],
    [{ WORK_ID: "not-opaque" }, "WORK_ID"],
    [
      {
        WORK_ID: "4c03465b-8a87-45a2-9d0d-54f904f4e6ab",
        CLAMAV_DATABASE_DIRECTORY: "relative"
      },
      "CLAMAV_DATABASE_DIRECTORY"
    ],
    [
      {
        WORK_ID: "4c03465b-8a87-45a2-9d0d-54f904f4e6ab",
        CLAMAV_DATABASE_DIRECTORY: "/var/lib/clamav/current",
        CLAMAV_SCAN_TIMEOUT_MS: "0"
      },
      "CLAMAV_SCAN_TIMEOUT_MS"
    ]
  ])("rejects invalid worker environment without echoing values", (env, field) => {
    expect(() => readAttachmentScanJobEnvironment(env)).toThrow(field);
  });

  it("accepts queue-triggered execution without a static work id", () => {
    expect(
      readAttachmentScanJobEnvironment({
        ATTACHMENT_SCAN_QUEUE_CONNECTION_STRING:
          "DefaultEndpointsProtocol=https;AccountName=placeholder;AccountKey=placeholder",
        ATTACHMENT_SCAN_QUEUE_NAME: "attachment-scan",
        CLAMAV_DATABASE_DIRECTORY: "/var/lib/clamav/current"
      })
    ).toEqual({
      queueConnectionString:
        "DefaultEndpointsProtocol=https;AccountName=placeholder;AccountKey=placeholder",
      queueName: "attachment-scan",
      databaseDirectory: "/var/lib/clamav/current",
      signatureManifestPath: "/var/lib/clamav/current/manifest.json",
      scanTimeoutMs: 15_000
    });
  });

  it("leases and acknowledges exactly one opaque queue work item", async () => {
    const client = {
      receiveMessages: vi.fn().mockResolvedValue({
        receivedMessageItems: [
          {
            messageText: JSON.stringify({
              workId: "4c03465b-8a87-45a2-9d0d-54f904f4e6ab"
            }),
            messageId: "opaque-message",
            popReceipt: "opaque-receipt"
          }
        ]
      }),
      deleteMessage: vi.fn().mockResolvedValue(undefined)
    };

    const lease = await receiveAttachmentScanWork(client);

    expect(lease?.workId).toBe("4c03465b-8a87-45a2-9d0d-54f904f4e6ab");
    expect(client.receiveMessages).toHaveBeenCalledWith({
      numberOfMessages: 1,
      visibilityTimeout: 900
    });
    await lease?.complete();
    expect(client.deleteMessage).toHaveBeenCalledWith("opaque-message", "opaque-receipt");
  });

  it("discards malformed queue payloads without exposing their contents", async () => {
    const client = {
      receiveMessages: vi.fn().mockResolvedValue({
        receivedMessageItems: [
          {
            messageText: '{"workId":"not-opaque","unexpected":"private"}',
            messageId: "opaque-message",
            popReceipt: "opaque-receipt"
          }
        ]
      }),
      deleteMessage: vi.fn().mockResolvedValue(undefined)
    };

    await expect(receiveAttachmentScanWork(client)).resolves.toBeUndefined();
    expect(client.deleteMessage).toHaveBeenCalledWith("opaque-message", "opaque-receipt");
  });

  it("acknowledges not-claimed redelivery only after atomic terminal confirmation", () => {
    const result = { status: "ignored", reason: "not_claimed" } as const;

    expect(shouldAcknowledgeAttachmentScanResult(result, undefined)).toBe(false);
    expect(shouldAcknowledgeAttachmentScanResult(result, "completed")).toBe(true);
    expect(shouldAcknowledgeAttachmentScanResult(result, "failed")).toBe(true);
  });
});
