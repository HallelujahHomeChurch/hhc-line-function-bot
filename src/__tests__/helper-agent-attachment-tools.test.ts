import { describe, expect, it, vi } from "vitest";

import { createHelperAttachmentTools } from "../helper-agent/attachment-tools.js";
import type { FunctionHandlerContext } from "../types.js";

const context = {
  profile: { name: "helper", enabledFunctions: ["save_resource"] },
  event: { type: "message", source: { type: "user", userId: "requester" } }
} as FunctionHandlerContext;

describe("helper attachment draft tool", () => {
  it("rechecks authorization on every call and never exposes a commit argument", async () => {
    const updateDraft = vi.fn().mockResolvedValue({ ok: true, replyText: "草稿尚未提交" });
    const authorize = vi.fn().mockResolvedValueOnce(true).mockResolvedValue(false);
    const [tool] = createHelperAttachmentTools({ context, updateDraft, authorize });
    await expect(tool!.invoke({ title: "主日簡報" })).resolves.toMatchObject({ status: "success" });
    await expect(tool!.invoke({ title: "新名稱" })).resolves.toMatchObject({ status: "denied" });
    expect(updateDraft).toHaveBeenCalledTimes(1);
    await expect(tool!.invoke({ confirm: true })).rejects.toThrow();
    await expect(tool!.invoke({ purpose: "任意資料夾" })).rejects.toThrow();
    await expect(tool!.invoke({ title: "x".repeat(121) })).rejects.toThrow();
  });

  it("keeps file names and URLs out of model evidence", async () => {
    const [draftTool] = createHelperAttachmentTools({
      context,
      authorize: async () => true,
      updateDraft: async () => ({
        ok: true,
        replyText:
          "名稱：Test https://private.example/file\n檔名：Private.pptx\n來源：LINE 圖片\n大小：10 KB"
      })
    });
    const result = await draftTool!.invoke({});
    expect(JSON.stringify(result)).not.toMatch(/https:|Private.pptx|LINE 圖片/);
  });

  it("hides the tool from main, disabled functions and anonymous group requesters", () => {
    const options = { context, updateDraft: vi.fn(), authorize: vi.fn() };
    for (const guardedContext of [
      { ...context, profile: { ...context.profile, name: "main" } },
      { ...context, profile: { ...context.profile, enabledFunctions: [] } },
      {
        ...context,
        event: { ...context.event, source: { type: "group" as const, groupId: "group" } }
      }
    ]) {
      expect(createHelperAttachmentTools({ ...options, context: guardedContext })).toEqual([]);
    }
  });
});
