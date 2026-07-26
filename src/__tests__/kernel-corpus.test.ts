import { describe, expect, it } from "vitest";

import { RECURRENCE_FAMILIES } from "../evals/kernel/contracts.js";
import { KERNEL_ACCEPTANCE_CASES, validateKernelCorpus } from "../evals/kernel/corpus.js";
import { PRODUCT_EXPERIENCE_KERNEL_CASES } from "../evals/kernel/cases/product-experience.js";
import { REMOTE_RUNTIME_KERNEL_CASES } from "../evals/kernel/cases/remote-runtime.js";
import { SCHEDULE_KERNEL_CASES } from "../evals/kernel/cases/schedule.js";

const R41_PRODUCT_EXPERIENCE_CASE_IDS = [
  "kernel-v1/product_experience/effective-discovery-direct@1",
  "kernel-v1/product_experience/effective-discovery-group@1",
  "kernel-v1/product_experience/effective-discovery-granted-user@1",
  "kernel-v1/product_experience/effective-discovery-admin@1",
  "kernel-v1/product_experience/registration-first-read@1",
  "kernel-v1/product_experience/result-guidance-classes@1",
  "kernel-v1/product_experience/branch-group-isolation@1"
] as const;

describe("Kernel v1 versioned acceptance corpus", () => {
  it("uses unique stable versioned case IDs", () => {
    const ids = KERNEL_ACCEPTANCE_CASES.map(({ id }) => id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids.every((id) => /^kernel-v1\/[a-z_]+\/[a-z0-9-]+@1$/u.test(id))).toBe(true);
    expect(KERNEL_ACCEPTANCE_CASES.every(({ version }) => version === 1)).toBe(true);
    expect(validateKernelCorpus(KERNEL_ACCEPTANCE_CASES)).toEqual([]);
  });

  it("contains fifty canonical schedule assertions and five ambiguity/lifecycle cases", async () => {
    const observations = await Promise.all(
      SCHEDULE_KERNEL_CASES.map((entry) =>
        entry.run({ now: () => new Date("2026-07-16T08:00:00Z") })
      )
    );
    expect(observations.flatMap(({ scheduleAssertions }) => scheduleAssertions)).toHaveLength(50);
    const ambiguity = observations.filter(({ ambiguityEligible }) => ambiguityEligible);
    expect(ambiguity).toHaveLength(5);
    expect(
      ambiguity.filter(({ ambiguityResolvedWithinTwoTurns }) => ambiguityResolvedWithinTwoTurns)
    ).toHaveLength(4);
    expect(
      observations.filter(
        ({ boundary, recurrenceFamily }) =>
          boundary === "active_task_lifecycle" && recurrenceFamily === "role_follow_up_lost"
      )
    ).toHaveLength(2);
  });

  it("covers the schedule-owned recurrence families", () => {
    expect(SCHEDULE_KERNEL_CASES.map(({ recurrenceFamily }) => recurrenceFamily)).toEqual(
      expect.arrayContaining([
        "wrapper_words_hide_subject",
        "generic_schedule_domain_ambiguity",
        "explicit_domain_lost",
        "role_follow_up_lost",
        "required_slot_misrouted"
      ])
    );
  });

  it("covers retrieval, knowledge, memory, write, and state journeys", () => {
    const ids = KERNEL_ACCEPTANCE_CASES.map(({ id }) => id);
    expect(ids).toEqual(
      expect.arrayContaining([
        "kernel-v1/ppt/sequential-distinct-query@1",
        "kernel-v1/ppt/wrapper-words-subject@1",
        "kernel-v1/sheet_music/catalog-hit@1",
        "kernel-v1/sheet_music/unavailable-not-not-found@1",
        "kernel-v1/resource/fresh-second-query@1",
        "kernel-v1/resource/tombstone-cannot-resurrect@1",
        "kernel-v1/resource/reference-validation@1",
        "kernel-v1/knowledge/body-only-routing@1",
        "kernel-v1/knowledge/section-document-source-follow-up@1",
        "kernel-v1/memory/explicit-save-retrieve@1",
        "kernel-v1/write/bare-confirmation-precedence@1",
        "kernel-v1/write/unauthorized-save-denied@1",
        "kernel-v1/write/scan-unavailable-fails-closed@1",
        "kernel-v1/write/group-attachment-without-intent-silent@1",
        "kernel-v1/write/group-requester-cannot-complete-other-upload@1",
        "kernel-v1/resource/unavailable-not-not-found@1",
        "kernel-v1/state/group-requester-isolation@1",
        "kernel-v1/state/expired-active-task-not-used@1",
        "kernel-v1/resource/deepseek-unavailable-explicit@1",
        "kernel-v1/resource/deepseek-unavailable-ambiguous@1",
        "kernel-v1/write/signature-missing-no-publish@1",
        "kernel-v1/write/signature-aged-publishes@1",
        "kernel-v1/write/infected-no-publish@1",
        "kernel-v1/state/clean-job-requester-scope@1"
      ])
    );
    expect(
      new Set(KERNEL_ACCEPTANCE_CASES.map(({ recurrenceFamily }) => recurrenceFamily))
    ).toEqual(new Set(RECURRENCE_FAMILIES));
  });

  it("keeps unavailable and security denominators meaningful", async () => {
    const observations = await Promise.all(
      KERNEL_ACCEPTANCE_CASES.map((entry) =>
        entry.run({ now: () => new Date("2026-07-16T08:00:00Z") })
      )
    );
    expect(
      observations.filter(({ unavailableEligible }) => unavailableEligible).length
    ).toBeGreaterThanOrEqual(10);
    expect(
      KERNEL_ACCEPTANCE_CASES.filter(({ journey }) => journey !== "schedule").length
    ).toBeGreaterThanOrEqual(20);
    expect(
      observations.filter(
        ({ recurrenceFamily }) =>
          recurrenceFamily === "write_safety_bypass" ||
          recurrenceFamily === "group_requester_scope_leak" ||
          recurrenceFamily === "pending_write_confirmation_escape" ||
          recurrenceFamily === "replica_state_divergence"
      ).length
    ).toBeGreaterThanOrEqual(10);
  });

  it("passes the remote-provider and attachment-job boundaries at the gate clock", async () => {
    const observations = await Promise.all(
      REMOTE_RUNTIME_KERNEL_CASES.map((entry) =>
        entry.run({ now: () => new Date("2026-07-21T00:00:00.000Z") })
      )
    );

    expect(observations.map(({ caseId, passed }) => ({ caseId, passed }))).toEqual(
      REMOTE_RUNTIME_KERNEL_CASES.map(({ id }) => ({ caseId: id, passed: true }))
    );
  });

  it("contains every versioned R4.1 product-experience boundary exactly once", () => {
    const corpusIds = KERNEL_ACCEPTANCE_CASES.map(({ id }) => id);
    const productExperienceIds = PRODUCT_EXPERIENCE_KERNEL_CASES.map(({ id }) => id);

    expect(productExperienceIds).toEqual(R41_PRODUCT_EXPERIENCE_CASE_IDS);
    expect(corpusIds.filter((id) => R41_PRODUCT_EXPERIENCE_CASE_IDS.includes(id as never))).toEqual(
      R41_PRODUCT_EXPERIENCE_CASE_IDS
    );
  });

  it("accepts exact discovery, registration-first-read, result guidance, and branch isolation", async () => {
    const observations = await Promise.all(
      PRODUCT_EXPERIENCE_KERNEL_CASES.map((entry) =>
        entry.run({ now: () => new Date("2026-07-26T08:00:00.000Z") })
      )
    );

    expect(observations.map(({ caseId, passed }) => ({ caseId, passed }))).toEqual(
      R41_PRODUCT_EXPERIENCE_CASE_IDS.map((caseId) => ({ caseId, passed: true }))
    );
    expect(observations.find(({ caseId }) => caseId.endsWith("registration-first-read@1"))).toEqual(
      expect.objectContaining({ boundary: "entrance_access", coreJourneySucceeded: true })
    );
    expect(observations.find(({ caseId }) => caseId.endsWith("result-guidance-classes@1"))).toEqual(
      expect.objectContaining({ boundary: "response_projection", unavailableMisclassified: false })
    );
    expect(observations.find(({ caseId }) => caseId.endsWith("branch-group-isolation@1"))).toEqual(
      expect.objectContaining({ boundary: "active_task_lifecycle", securityViolations: [] })
    );
  });
});
