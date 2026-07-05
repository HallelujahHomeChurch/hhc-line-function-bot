import type { z } from "zod";

import {
  findPopSheetMusicArgumentsSchema,
  findPptSlidesArgumentsSchema,
  queryServiceScheduleArgumentsSchema
} from "../function-arguments.js";
import type { FunctionName, JsonRecord } from "../types.js";

export interface FunctionKeywordFallback {
  keywords: string[];
  stripWords: string[];
  defaultArguments?: JsonRecord;
}

export interface FunctionDefinition {
  name: FunctionName;
  description: string;
  argumentSchema: z.ZodType;
  quickReply: {
    label: string;
    command: string;
  };
  keywordFallback?: FunctionKeywordFallback;
}

const commonStripWords = ["小哈", "請", "幫我", "幫忙", "查詢", "查", "找", "搜尋"];

export const FUNCTION_DEFINITIONS: FunctionDefinition[] = [
  {
    name: "find_ppt_slides",
    description:
      '- find_ppt_slides: find church PowerPoint/PDF slide files by title or keyword. Arguments: {"query":"extracted filename/title keyword", "originalQuery":"full user request optional", "fileType":"ppt|pdf|any optional", "includePdf": boolean optional, "matchMode":"fuzzy|exact optional"}. Use fuzzy for typo-tolerant song/title lookup.',
    argumentSchema: findPptSlidesArgumentsSchema,
    quickReply: {
      label: "查投影片",
      command: "小哈 查投影片"
    },
    keywordFallback: {
      keywords: ["投影片", "ppt", "powerpoint", "slides"],
      stripWords: [...commonStripWords, "投影片", "ppt", "powerpoint", "slides", "pdf"],
      defaultArguments: { matchMode: "fuzzy" }
    }
  },
  {
    name: "query_service_schedule",
    description:
      '- query_service_schedule: query church meeting service schedule or serving assignments. Arguments: {"query":"original user request text", "dateIntent":"today|tomorrow|day_after_tomorrow|this_week|next_meeting|specific_date|upcoming optional", "specificDate":"YYYY-MM-DD required for specific_date", "meeting":"text optional", "role":"text optional", "limit": number optional}. For requests like 下一場/最近一場, use dateIntent next_meeting.',
    argumentSchema: queryServiceScheduleArgumentsSchema,
    quickReply: {
      label: "查服事表",
      command: "小哈 查服事表"
    },
    keywordFallback: {
      keywords: ["服事表", "服事"],
      stripWords: [...commonStripWords]
    }
  },
  {
    name: "find_pop_sheet_music",
    description:
      '- find_pop_sheet_music: find pop song sheet music PDF/image files by title or artist. Arguments: {"query":"song title keyword", "artist":"artist optional", "fileType":"pdf|image|any optional", "matchMode":"fuzzy|exact optional"}. Use this only for 流行歌譜, 流行歌曲樂譜, 樂譜, or sheet music requests.',
    argumentSchema: findPopSheetMusicArgumentsSchema,
    quickReply: {
      label: "查流行歌譜",
      command: "小哈 查流行歌譜"
    },
    keywordFallback: {
      keywords: ["流行歌譜", "流行歌曲樂譜", "樂譜", "歌譜", "sheet music"],
      stripWords: [
        ...commonStripWords,
        "流行歌譜",
        "流行歌曲樂譜",
        "流行歌曲",
        "樂譜",
        "歌譜",
        "sheet music",
        "pdf",
        "jpg",
        "jpeg",
        "png",
        "圖片",
        "image"
      ],
      defaultArguments: { fileType: "pdf", matchMode: "fuzzy" }
    }
  }
];

export function getFunctionDefinition(name: FunctionName): FunctionDefinition | undefined {
  return FUNCTION_DEFINITIONS.find((definition) => definition.name === name);
}

export function getFunctionDefinitions(names: FunctionName[]): FunctionDefinition[] {
  return names
    .map((name) => getFunctionDefinition(name))
    .filter((definition): definition is FunctionDefinition => Boolean(definition));
}
