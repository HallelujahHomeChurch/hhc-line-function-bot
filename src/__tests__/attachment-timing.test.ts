import { describe, expect, it } from "vitest";

import { ATTACHMENT_SCAN_TIMING } from "../attachments/scan-timing.js";
import { attachmentAssetDeadlines } from "../tools/run-attachment-asset-job.js";
import { attachmentScanPublicationDeadline } from "../tools/run-attachment-scan-job.js";

describe("attachment scan timing", () => {
  it("keeps scan, publication, replica, queue, claim, and retention in safe order", () => {
    const timing = ATTACHMENT_SCAN_TIMING;

    expect(timing.replicaTimeoutMs).toBe(30 * 60 * 1000);
    expect(timing.scanDeadlineMs).toBeLessThan(timing.publicationDeadlineMs);
    expect(timing.publicationDeadlineMs).toBeLessThan(timing.replicaTimeoutMs);
    expect(timing.replicaTimeoutMs + timing.ackMarginMs).toBeLessThan(timing.queueVisibilityMs);
    expect(timing.queueVisibilityMs).toBeLessThan(timing.claimLeaseMs);
    expect(timing.retryCycles * timing.queueVisibilityMs + timing.scanDeadlineMs).toBeLessThan(
      timing.workTtlMs
    );
  });

  it("derives both Asset deadlines from the shared timing policy", () => {
    const startedAt = new Date("2026-08-01T08:00:00.000Z");

    expect(attachmentAssetDeadlines(startedAt)).toEqual({
      scanDeadline: new Date("2026-08-01T08:10:00.000Z"),
      publicationDeadline: new Date("2026-08-01T08:14:00.000Z")
    });
    expect(attachmentScanPublicationDeadline(startedAt)).toEqual(
      new Date("2026-08-01T08:14:00.000Z")
    );
  });
});
