import { createHmac, timingSafeEqual } from "node:crypto";

export function signLineBody(body: Buffer, channelSecret: string): string {
  return createHmac("sha256", channelSecret).update(body).digest("base64");
}

export function verifyLineSignature(
  body: Buffer,
  signature: string,
  channelSecret: string
): boolean {
  if (!signature) {
    return false;
  }

  const expected = Buffer.from(signLineBody(body, channelSecret), "utf8");
  const actual = Buffer.from(signature, "utf8");
  if (expected.length !== actual.length) {
    return false;
  }

  return timingSafeEqual(expected, actual);
}
