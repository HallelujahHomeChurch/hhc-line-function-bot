import { readFileSync } from "node:fs";
import { z } from "zod";
import type { HistoryConfig } from "./types.js";
const positive = z.number().int().positive();
export const historyConfigSchema = z
  .object({
    enabled: z.boolean().default(false),
    generation: positive.max(Number.MAX_SAFE_INTEGER),
    restoreEpoch: z.string().min(16).max(128),
    retentionDays: positive.max(90).default(90),
    maxGroupMessages: positive.max(100000),
    maxGroupBytes: positive.max(100000000),
    maxTotalMessages: positive.max(1000000),
    maxTotalBytes: positive.max(1000000000),
    maxMessageBytes: positive.max(8000),
    policies: z
      .array(
        z
          .object({
            profileName: z.literal("helper"),
            groupId: z.string().min(1).max(255),
            revision: z.string().min(1).max(128),
            enabledAt: z.iso.datetime(),
            excludedRequesterIds: z.array(z.string().min(1).max(255)).max(1000).default([])
          })
          .strict()
      )
      .max(100)
  })
  .strict()
  .superRefine((c, ctx) => {
    if (
      c.maxGroupMessages > c.maxTotalMessages ||
      c.maxGroupBytes > c.maxTotalBytes ||
      c.maxMessageBytes > c.maxGroupBytes
    )
      ctx.addIssue({ code: "custom", message: "history_capacity_order_invalid" });
  });
export function loadHistoryConfig(path: string | undefined): HistoryConfig | undefined {
  if (!path) return undefined;
  const config = historyConfigSchema.parse(JSON.parse(readFileSync(path, "utf8")));
  return config;
}
