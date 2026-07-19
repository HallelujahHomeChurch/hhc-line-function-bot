import { createHash, createHmac } from "node:crypto";

const OUTPUT_LENGTH = 16;

export interface ActorFingerprintInput {
  profileName: string;
  sourceType: "user" | "group" | "room";
  sourceId?: string;
  requesterUserId?: string;
}

export function createSupportId(requestId: string): string {
  return createHash("sha256")
    .update("hhc-line-function-bot:support-id:v1\0", "utf8")
    .update(requestId, "utf8")
    .digest("hex")
    .slice(0, OUTPUT_LENGTH);
}

export function createActorFingerprint(
  input: ActorFingerprintInput,
  hmacKey: string
): string | undefined {
  if (!input.requesterUserId) return undefined;
  return createHmac("sha256", hmacKey)
    .update("hhc-line-function-bot:actor:v1\0", "utf8")
    .update(
      JSON.stringify([
        input.profileName,
        input.sourceType,
        input.sourceId ?? "direct",
        input.requesterUserId
      ]),
      "utf8"
    )
    .digest("hex")
    .slice(0, OUTPUT_LENGTH);
}
