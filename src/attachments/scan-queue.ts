import { QueueClient } from "@azure/storage-queue";

export interface AttachmentScanQueue {
  enqueue(workId: string): Promise<void>;
}

export class InMemoryAttachmentScanQueue implements AttachmentScanQueue {
  readonly workIds: string[] = [];

  async enqueue(workId: string): Promise<void> {
    this.workIds.push(workId);
  }
}

export interface AzureAttachmentScanQueueClient {
  sendMessage(messageText: string): Promise<unknown>;
}

export class AzureAttachmentScanQueue implements AttachmentScanQueue {
  constructor(private readonly client: AzureAttachmentScanQueueClient) {}

  async enqueue(workId: string): Promise<void> {
    await this.client.sendMessage(JSON.stringify({ workId }));
  }
}

export function createAzureAttachmentScanQueue(queueUrl: string): AttachmentScanQueue {
  return new AzureAttachmentScanQueue(new QueueClient(queueUrl));
}
