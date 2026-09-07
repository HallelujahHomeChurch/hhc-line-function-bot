import { describe, expect, it } from "vitest";
import { buildLineTextMessages } from "../line-reply.js";

describe("LINE text delivery", () => {
  it("keeps all bounded multi-tool results in legal text messages with actions only on the last", () => {
    const text = "甲".repeat(4900) + "\n\n" + "乙".repeat(4900);
    const result = buildLineTextMessages(text, [
      { label: "查看", action: { type: "message", label: "查看", text: "查看" } }
    ]);
    expect(result.map((message) => message.text).join("")).toBe(text);
    expect(result.every((message) => message.text.length <= 5000)).toBe(true);
    expect(result).toHaveLength(2);
    expect(result[0]?.quickReply).toBeUndefined();
    expect(result[1]?.quickReply?.items).toHaveLength(1);
  });
});

it("avoids wasting a message on an early newline and preserves surrogate pairs", () => {
  const text = "x\n" + "😀".repeat(11000);
  const result = buildLineTextMessages(text);
  expect(result.map((message) => message.text).join("")).toBe(text);
  expect(result).toHaveLength(5);
  expect(result.every((message) => !/[\uD800-\uDBFF]$/u.test(message.text))).toBe(true);
});
