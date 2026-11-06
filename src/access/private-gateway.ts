import { timingSafeEqual } from "node:crypto";
import type { IncomingHttpHeaders } from "node:http";

export function verifyPrivateGateway(
  headers: IncomingHttpHeaders,
  token: string | undefined
): boolean | undefined {
  if (!Object.hasOwn(headers, "x-hhc-line-gateway-token")) return undefined;
  const value = headers["x-hhc-line-gateway-token"];
  return Boolean(
    token &&
    typeof value === "string" &&
    /^[a-f0-9]{64}$/u.test(value) &&
    ![
      "dapr-caller-app-id",
      "dapr-api-token",
      "x-internal-caller-app-id",
      "x-hhc-caller-app-id"
    ].some((header) => Object.hasOwn(headers, header)) &&
    Buffer.byteLength(value) === Buffer.byteLength(token) &&
    timingSafeEqual(Buffer.from(value), Buffer.from(token))
  );
}
