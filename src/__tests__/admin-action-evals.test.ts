import { describe, expect, it } from "vitest";

import { evaluateAdminActionTextForEval, getAdminActionEvalCases } from "../actions/admin-evals.js";

describe("admin action eval cases", () => {
  it("keeps invite-code natural language broad enough but denies unsafe vague admin requests", () => {
    for (const entry of getAdminActionEvalCases()) {
      expect(evaluateAdminActionTextForEval(entry.text)).toBe(entry.action);
    }
  });
});
