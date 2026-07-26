import { createHash } from "node:crypto";

import type { LineReplyClient } from "../../types.js";
import type { RedisKernelLocalLiveChannel } from "./redis-channel.js";

export function createCaptureLineReplyClient(
  channel: RedisKernelLocalLiveChannel
): LineReplyClient {
  return {
    async replyText(replyToken, text, options) {
      await channel.writeReply({
        replyToken,
        replyHash: createHash("sha256").update(text, "utf8").digest("hex"),
        quickReplyLabels: options?.quickReplies?.map(({ label }) => label) ?? []
      });
    }
  };
}
