import fastify from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  internalDiagnosticFetch,
  readDiagnosticJSON,
  registerHTTPDiagnostics,
  transportCorrelation
} from "../observability/http-diagnostics.js";

afterEach(() => vi.restoreAllMocks());
describe("safe transport diagnostics", () => {
  it("joins concurrent unsampled requests without private data", async () => {
    const logs = vi.spyOn(console, "error").mockImplementation(() => {});
    const app = fastify();
    registerHTTPDiagnostics(app);
    const seen: string[] = [];
    const fetcher = internalDiagnosticFetch(
      vi.fn(async (_input, init) => {
        await new Promise((resolve) => setTimeout(resolve, 1));
        const headers = new Headers(init?.headers);
        seen.push(headers.get("traceparent")!);
        expect(headers.has("baggage")).toBe(false);
        return new Response("secret provider body", { status: 503 });
      })
    );
    app.get("/private/:member", async (_request, reply) => {
      await fetcher("https://internal.example/private?secret=one", {
        headers: { baggage: "secret" }
      });
      return reply.code(503).send({ secret: "payload" });
    });
    try {
      await Promise.all(
        ["1", "2"].map((digit) =>
          app.inject({
            url: "/private/member@example.test?secret=two",
            headers: {
              traceparent: `00-${digit.repeat(32)}-${"3".repeat(16)}-00`,
              authorization: "secret"
            }
          })
        )
      );
      expect(
        seen.some((value) => value.startsWith(`00-${"1".repeat(32)}-`) && value.endsWith("-00"))
      ).toBe(true);
      expect(
        seen.some((value) => value.startsWith(`00-${"2".repeat(32)}-`) && value.endsWith("-00"))
      ).toBe(true);
      const output = JSON.stringify(logs.mock.calls);
      expect(output).toContain("client_headers");
      expect(output).toContain("server");
      for (const privateValue of ["secret", "member@example.test", "internal.example", "payload"])
        expect(output).not.toContain(privateValue);
    } finally {
      await app.close();
    }
  });
  it("rejects malformed and duplicate correlation and records body faults", async () => {
    for (const parent of ["bad", ["a", "b"], `00-${"0".repeat(32)}-${"1".repeat(16)}-01`]) {
      const value = transportCorrelation({ traceparent: parent, "x-hhc-request-id": "secret" });
      expect(value.flags).toBe("00");
      expect(value.requestId).toMatch(/^[a-f0-9]{32}$/u);
    }
    const logs = vi.spyOn(console, "error").mockImplementation(() => {});
    const fetcher = internalDiagnosticFetch(
      vi.fn(async () => new Response("private invalid json"))
    );
    await expect(readDiagnosticJSON(await fetcher("https://internal.example"))).rejects.toThrow();
    expect(JSON.stringify(logs.mock.calls)).toContain("client_body");
    expect(JSON.stringify(logs.mock.calls)).not.toContain("private invalid json");
  });
});
