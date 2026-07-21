import { pathToFileURL } from "node:url";

import { evaluateKernelGate } from "../evals/kernel/evaluate.js";
import { writeKernelReport } from "../evals/kernel/report.js";

export async function runKernelCli(
  outputDirectory = "artifacts/kernel-v1"
): Promise<0 | 1 | 2> {
  try {
    const report = await evaluateKernelGate({
      now: () => new Date("2026-07-21T00:00:00.000Z")
    });
    await writeKernelReport(report, outputDirectory);
    console.log(`Kernel v1: ${report.passed ? "PASS" : "FAIL"} cases=${report.totalCases}`);
    for (const [name, metric] of Object.entries(report.metrics)) {
      console.log(
        `${name}: ${metric.numerator}/${metric.denominator} value=${metric.value ?? "incomplete"} threshold=${metric.threshold} result=${metric.passed && !metric.incomplete ? "PASS" : "FAIL"}`
      );
    }
    return report.passed ? 0 : 1;
  } catch {
    console.error("kernel_eval_failed");
    return 2;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await runKernelCli();
}
