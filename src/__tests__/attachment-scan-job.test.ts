import { describe, expect, it, vi } from "vitest";

import {
  attachmentScanPublicationDeadline,
  formatAttachmentScanJobStatus,
  readAttachmentScanJobEnvironment,
  receiveAttachmentScanWork,
  shouldAcknowledgeAttachmentScanResult
} from "../tools/run-attachment-scan-job.js";

describe("attachment scan job environment", () => {
  it("ends publication authority before the 900-second replica deadline", () => {
    expect(
      attachmentScanPublicationDeadline(new Date("2026-07-24T04:00:00.000Z")).toISOString()
    ).toBe("2026-07-24T04:14:00.000Z");
  });

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
      scanTimeoutMs: 15_000,
      signaturePolicy: { warningAgeMs: 168 * 60 * 60 * 1000 }
    });
  });

  it("parses an explicit positive integer signature warning age in hours", () => {
    expect(
      readAttachmentScanJobEnvironment({
        WORK_ID: "4c03465b-8a87-45a2-9d0d-54f904f4e6ab",
        CLAMAV_DATABASE_DIRECTORY: "/var/lib/clamav/current",
        CLAMAV_SIGNATURE_WARNING_AGE_HOURS: "12"
      }).signaturePolicy
    ).toEqual({ warningAgeMs: 12 * 60 * 60 * 1000 });
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
      scanTimeoutMs: 15_000,
      signaturePolicy: { warningAgeMs: 168 * 60 * 60 * 1000 }
    });
  });

  it.each(["0", "1.5", "not-a-number"])(
    "rejects an invalid signature warning age without echoing it",
    (value) => {
      expect(() =>
        readAttachmentScanJobEnvironment({
          WORK_ID: "4c03465b-8a87-45a2-9d0d-54f904f4e6ab",
          CLAMAV_DATABASE_DIRECTORY: "/var/lib/clamav/current",
          CLAMAV_SIGNATURE_WARNING_AGE_HOURS: value
        })
      ).toThrow("CLAMAV_SIGNATURE_WARNING_AGE_HOURS");
    }
  );

  it("formats completed worker status without private scan details", () => {
    expect(
      formatAttachmentScanJobStatus({
        status: "completed",
        signatureHealth: "warning"
      })
    ).toEqual({ status: "completed", signatureHealth: "warning" });
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
    expect(lease?.kind).toBe("attachment");
    expect(client.receiveMessages).toHaveBeenCalledWith({
      numberOfMessages: 1,
      visibilityTimeout: 1920
    });
    await lease?.complete();
    expect(client.deleteMessage).toHaveBeenCalledWith("opaque-message", "opaque-receipt");
  });

  it("accepts explicit attachment and media-sync queue kinds without aliases", async () => {
    for (const kind of ["attachment", "media-sync"] as const) {
      const client = {
        receiveMessages: vi.fn().mockResolvedValue({
          receivedMessageItems: [
            {
              messageText: JSON.stringify({
                kind,
                workId: "4c03465b-8a87-45a2-9d0d-54f904f4e6ab"
              }),
              messageId: `message-${kind}`,
              popReceipt: `receipt-${kind}`
            }
          ]
        }),
        deleteMessage: vi.fn().mockResolvedValue(undefined)
      };

      await expect(receiveAttachmentScanWork(client)).resolves.toMatchObject({
        kind,
        workId: "4c03465b-8a87-45a2-9d0d-54f904f4e6ab"
      });
    }
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

  it("acknowledges terminal or missing work but leaves active work for redelivery", () => {
    expect(shouldAcknowledgeAttachmentScanResult({ status: "ignored", reason: "active" })).toBe(
      false
    );
    expect(shouldAcknowledgeAttachmentScanResult({ status: "ignored", reason: "terminal" })).toBe(
      true
    );
    expect(shouldAcknowledgeAttachmentScanResult({ status: "ignored", reason: "missing" })).toBe(
      true
    );
  });

  it("acknowledges only durable Asset outcomes", () => {
    expect(
      shouldAcknowledgeAttachmentScanResult({
        status: "permanent_failure",
        failureCode: "validation_failed"
      })
    ).toBe(true);
    expect(
      shouldAcknowledgeAttachmentScanResult({
        status: "completed",
        signatureHealth: "current"
      })
    ).toBe(true);
    expect(shouldAcknowledgeAttachmentScanResult({ status: "missing" })).toBe(true);
    expect(
      shouldAcknowledgeAttachmentScanResult({
        status: "transient_retry",
        failureCode: "scan_unavailable"
      })
    ).toBe(false);
    expect(shouldAcknowledgeAttachmentScanResult({ status: "scan_pending" })).toBe(false);
    expect(shouldAcknowledgeAttachmentScanResult({ status: "contention" })).toBe(false);
  });

  it("formats explicit Asset retry and contention outcomes without private details", () => {
    expect(
      formatAttachmentScanJobStatus({
        status: "transient_retry",
        failureCode: "scan_unavailable"
      })
    ).toEqual({ status: "transient_retry", failureCode: "scan_unavailable" });
    expect(formatAttachmentScanJobStatus({ status: "scan_pending" })).toEqual({
      status: "scan_pending"
    });
    expect(formatAttachmentScanJobStatus({ status: "contention" })).toEqual({
      status: "contention"
    });
  });

  it("deletes an opaque queue delivery after an outage outlives work retention", async () => {
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
    const result = { status: "ignored", reason: "missing" } as const;

    if (shouldAcknowledgeAttachmentScanResult(result)) {
      await lease?.complete();
    }

    expect(client.deleteMessage).toHaveBeenCalledWith("opaque-message", "opaque-receipt");
  });
});
