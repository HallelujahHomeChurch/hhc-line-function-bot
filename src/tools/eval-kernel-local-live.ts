import { readFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

import {
  selectKernelLocalLiveCases,
  validateKernelLocalLiveCost
} from "../evals/kernel/local-live/cases.js";
import {
  finalizeKernelLocalLiveSuiteResult,
  runKernelLocalLiveDriver
} from "../evals/kernel/local-live/driver.js";
import { writeKernelLocalLiveReport } from "../evals/kernel/local-live/report.js";

export async function runKernelLocalLiveCli(
  args: string[] = process.argv.slice(2),
  environment: Record<string, string | undefined> = process.env
): Promise<0 | 1 | 2> {
  try {
    if (args[0] === "--validate-case" && args.length <= 2) {
      const cases = selectKernelLocalLiveCases(args[1]);
      const cost = validateKernelLocalLiveCost(cases);
      console.log(
        `Kernel v1 local live selection: cases=${cases.map(({ id }) => id).join(",")} deepseek<=${cost.deepSeekMax} embedding<=${cost.embeddingBatchMax}`
      );
      return 0;
    }
    if (args.length === 1 && args[0] === "--finalize-cleanup") {
      const root = environment.KERNEL_LOCAL_LIVE_ARTIFACT_ROOT ?? "/app";
      const suite = JSON.parse(
        await readFile(path.join(root, "artifacts/kernel-v1/local-live-suite-result.json"), "utf8")
      ) as unknown;
      const report = finalizeKernelLocalLiveSuiteResult(suite, {
        compose: environment.KERNEL_LOCAL_LIVE_COMPOSE_CLEAN === "true",
        secretFiles: environment.KERNEL_LOCAL_LIVE_SECRET_FILES_CLEAN === "true"
      });
      await writeKernelLocalLiveReport(report, root);
      const passedCases = report.cases.filter(({ passed }) => passed).length;
      console.log(
        `Kernel v1 local live: ${report.passed ? "PASS" : "FAIL"} cases=${passedCases} deepseek=${report.providers.deepSeekRequests} embedding=${report.providers.embeddingBatches} cleanup=${report.cleanup.passed ? "PASS" : "FAIL"}`
      );
      return report.passed ? 0 : 1;
    }
    if (args.length !== 0) throw new Error("kernel_local_live_cli_arguments_invalid");
    return await runKernelLocalLiveDriver(environment);
  } catch {
    console.error("kernel_local_live_failed");
    return 2;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await runKernelLocalLiveCli();
}
