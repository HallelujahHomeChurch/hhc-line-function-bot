import { evaluateAdminActionTextForEval, getAdminActionEvalCases } from "../actions/admin-evals.js";

const failures: string[] = [];

for (const entry of getAdminActionEvalCases()) {
  const actual = evaluateAdminActionTextForEval(entry.text);
  if (actual !== entry.action) {
    failures.push(
      [`text: ${entry.text}`, `expected: ${entry.action}`, `actual: ${actual}`].join("\n")
    );
  }
}

if (failures.length > 0) {
  console.error(`Admin action eval failed: ${failures.length} case(s)`);
  console.error(failures.join("\n\n"));
  process.exitCode = 1;
} else {
  console.log(`Admin action eval passed: ${getAdminActionEvalCases().length} case(s)`);
}
