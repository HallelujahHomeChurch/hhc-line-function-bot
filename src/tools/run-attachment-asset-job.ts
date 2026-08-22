import { pathToFileURL } from "node:url";

import { runAttachmentWorker } from "./run-attachment-worker.js";

export {
  assetAccessTokenScope,
  attachmentWorkerDeadlines as attachmentAssetDeadlines,
  readAttachmentWorkerEnvironment as readAttachmentAssetJobEnvironment,
  runAttachmentWorker as runAttachmentAssetJob,
  runAttachmentWorkerQueueLease as runAttachmentAssetQueueLease
} from "./run-attachment-worker.js";

async function main(): Promise<void> {
  const result = await runAttachmentWorker();
  process.stdout.write(`${JSON.stringify(result.status)}\n`);
  process.exitCode = result.exitCode;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) void main();
