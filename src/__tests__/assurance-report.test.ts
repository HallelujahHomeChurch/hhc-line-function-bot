import { describe, expect, it } from "vitest";

import { buildAssuranceReport } from "../assurance/report.js";

const timestamp = "2026-07-27T00:00:00.000Z";

describe("buildAssuranceReport", () => {
  it("projects a release report into the fixed allowlisted schema", () => {
    expect(
      buildAssuranceReport({
        version: 1,
        kind: "release",
        releaseId: "release-20260727",
        commitSha: "0123456789abcdef0123456789abcdef01234567",
        startedAt: timestamp,
        completedAt: "2026-07-27T00:01:00.000Z",
        status: "passed",
        failureCode: "none",
        target: {
          resource: "bot",
          revision: "bot--r5",
          image:
            "alive.azurecr.io/hhc-line-function-bot@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
          status: "ready"
        },
        knownGood: {
          revision: "bot--r4",
          image:
            "alive.azurecr.io/hhc-line-function-bot@sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
        },
        checks: [
          {
            name: "release_probe",
            status: "passed",
            observedAt: timestamp,
            code: "none"
          }
        ],
        rollback: {
          status: "not_required"
        },
        providerRequests: { deepseek: 0, embedding: 0 }
      })
    ).toEqual({
      version: 1,
      kind: "release",
      releaseId: "release-20260727",
      commitSha: "0123456789abcdef0123456789abcdef01234567",
      startedAt: timestamp,
      completedAt: "2026-07-27T00:01:00.000Z",
      status: "passed",
      failureCode: "none",
      target: {
        resource: "bot",
        revision: "bot--r5",
        image:
          "alive.azurecr.io/hhc-line-function-bot@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        status: "ready"
      },
      knownGood: {
        revision: "bot--r4",
        image:
          "alive.azurecr.io/hhc-line-function-bot@sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
      },
      checks: [
        {
          name: "release_probe",
          status: "passed",
          observedAt: timestamp,
          code: "none"
        }
      ],
      rollback: { status: "not_required" },
      providerRequests: { deepseek: 0, embedding: 0 }
    });
  });

  it("accepts the periodic-only checks and warning status", () => {
    const report = buildAssuranceReport({
      version: 1,
      kind: "periodic",
      releaseId: "periodic-20260727",
      commitSha: "0123456789abcdef0123456789abcdef01234567",
      startedAt: timestamp,
      completedAt: timestamp,
      status: "passed",
      failureCode: "none",
      target: {
        resource: "attachment_scan",
        revision: "scan--r5",
        image:
          "alive.azurecr.io/hhc-line-function-bot@sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc",
        status: "ready"
      },
      knownGood: {
        revision: "scan--r5",
        image:
          "alive.azurecr.io/hhc-line-function-bot@sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc"
      },
      checks: [
        {
          name: "clamav_signature",
          status: "warning",
          observedAt: timestamp,
          code: "signature_warning"
        },
        {
          name: "attachment_queue",
          status: "passed",
          observedAt: timestamp,
          code: "none"
        }
      ],
      rollback: { status: "not_required" },
      providerRequests: { deepseek: 0, embedding: 0 }
    });

    expect(report.kind).toBe("periodic");
    expect(report.checks).toHaveLength(2);
  });

  it.each([
    ["unknown version", { version: 2 }],
    ["unknown kind", { kind: "unexpected" }],
    ["unknown status", { status: "warning" }],
    [
      "unknown check",
      { checks: [{ name: "unexpected", status: "passed", observedAt: timestamp, code: "none" }] }
    ],
    ["unknown rollback status", { rollback: { status: "unexpected" } }],
    ["provider request", { providerRequests: { deepseek: 1, embedding: 0 } }],
    ["credential URL", { target: { image: "https://user:password@invalid/image" } }],
    ["raw body", { body: "raw response body" }],
    ["invalid timestamp", { completedAt: "27-07-2026" }]
  ])("rejects %s", (_reason, override) => {
    const input = {
      version: 1,
      kind: "release",
      releaseId: "release-20260727",
      commitSha: "0123456789abcdef0123456789abcdef01234567",
      startedAt: timestamp,
      completedAt: timestamp,
      status: "passed",
      failureCode: "none",
      target: {
        resource: "bot",
        revision: "bot--r5",
        image:
          "alive.azurecr.io/hhc-line-function-bot@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        status: "ready"
      },
      knownGood: {
        revision: "bot--r4",
        image:
          "alive.azurecr.io/hhc-line-function-bot@sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
      },
      checks: [{ name: "release_probe", status: "passed", observedAt: timestamp, code: "none" }],
      rollback: { status: "not_required" },
      providerRequests: { deepseek: 0, embedding: 0 },
      ...override
    };

    expect(() => buildAssuranceReport(input)).toThrow("assurance_report_invalid");
  });
});
