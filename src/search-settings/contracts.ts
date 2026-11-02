import { z } from "zod";

export const searchSettingsInput = z
  .object({
    enabled: z.boolean(),
    directDailyLimit: z.number().int().min(0).max(10_000),
    groupDailyLimit: z.number().int().min(0).max(10_000),
    revision: z.number().int().positive().max(2_147_483_646)
  })
  .strict();
export type SearchSettingsInput = z.infer<typeof searchSettingsInput>;
export type SearchSettings = SearchSettingsInput & { updatedAt: string; updatedBy: string | null };
export interface SearchSettingsChange {
  revision: number;
  changedAt: string;
  changedBy: string;
  before: SearchSettingsInput;
  after: SearchSettingsInput;
}
export interface SearchSettingsStore {
  get(): Promise<SearchSettings>;
  history(): Promise<SearchSettingsChange[]>;
  update(input: SearchSettingsInput, actor: string): Promise<SearchSettings | undefined>;
}
