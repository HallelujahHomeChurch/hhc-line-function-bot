export const CAPABILITY_NAMES = [
  "download_weekly_paper",
  "update_own_profile",
  "find_ppt_slides",
  "query_schedule",
  "query_knowledge",
  "save_schedule",
  "find_sheet_music",
  "find_resource",
  "query_wikipedia",
  "save_memory",
  "save_resource",
  "retrieve_memory"
] as const;

export type CapabilityName = (typeof CAPABILITY_NAMES)[number];
