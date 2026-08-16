import { QueueClient } from "@azure/storage-queue";

export interface AttachmentScanQueue {
  enqueue(workId: string, kind?: "attachment" | "media-sync"): Promise<void>;
}

export class InMemoryAttachmentScanQueue implements AttachmentScanQueue {
  readonly workIds: string[] = [];
  readonly workItems: Array<{ kind: "attachment" | "media-sync"; workId: string }> = [];

  async enqueue(workId: string, kind: "attachment" | "media-sync" = "attachment"): Promise<void> {
    this.workIds.push(workId);
    this.workItems.push({ kind, workId });
  }
}

export interface AzureAttachmentScanQueueClient {
  sendMessage(messageText: string): Promise<unknown>;
}

export class AzureAttachmentScanQueue implements AttachmentScanQueue {
  constructor(private readonly client: AzureAttachmentScanQueueClient) {}

  async enqueue(workId: string, kind?: "attachment" | "media-sync"): Promise<void> {
    await this.client.sendMessage(JSON.stringify(kind ? { kind, workId } : { workId }));
  }
}

export function createAzureAttachmentScanQueue(queueUrl: string): AttachmentScanQueue {
  return new AzureAttachmentScanQueue(new QueueClient(queueUrl));
}
