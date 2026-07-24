import { describe, expect, it, vi } from "vitest";

import { createSheetMusicExternalSearchSummarizer } from "../search/sheet-music-external-summarizer.js";

describe("sheet music external search summarizer", () => {
  it("does not invoke a second semantic generator with the same provider name", async () => {
    const primaryCompleteText = vi.fn().mockRejectedValue(new Error("provider unavailable"));
    const fallbackCompleteText = vi.fn().mockResolvedValue("不應使用的第二次結果");
    const summarize = createSheetMusicExternalSearchSummarizer({
      primary: { completeText: primaryCompleteText, providerName: "deepseek" },
      fallback: { completeText: fallbackCompleteText, providerName: "deepseek" }
    });

    await expect(
      summarize({
        profileName: "helper",
        query: "奇異恩典",
        results: [
          {
            title: "Amazing Grace sheet music",
            snippet: "PDF",
            url: "https://example.test/amazing-grace.pdf"
          }
        ]
      })
    ).rejects.toThrow("sheet_music_external_summary_unavailable");
    expect(primaryCompleteText).toHaveBeenCalledOnce();
    expect(fallbackCompleteText).not.toHaveBeenCalled();
  });
});
