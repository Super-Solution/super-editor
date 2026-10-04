import { textParts } from './text.js';
import type { BlockType, ResearchDocument } from './types.js';

export type DocumentStats = {
  /** Words in the body text (the title is not counted). Each Chinese, Japanese kana or Han character counts as one word. */
  words: number;
  /** Characters of body text, spaces included. */
  characters: number;
  charactersNoSpaces: number;
  blocks: number;
  blocksByType: Partial<Record<BlockType, number>>;
  charts: number;
  tables: number;
  images: number;
  citations: number;
  /** Rounded up; 0 for an empty document. Uses 220 words and 400 CJK characters per minute. */
  readingMinutes: number;
};

const CJK = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/gu;
const TOKEN = /[\p{L}\p{N}\p{M}]+(?:['’.,-][\p{L}\p{N}\p{M}]+)*/gu;
/** Counts words in one string: latin-style tokens plus CJK characters. */
export function countWords(text: string): { latin: number; cjk: number } {
  return { latin: (text.replace(CJK, ' ').match(TOKEN) ?? []).length, cjk: (text.match(CJK) ?? []).length };
}

export function stats(document: Pick<ResearchDocument, 'blocks' | 'citations'>): DocumentStats {
  let latin = 0, cjk = 0, characters = 0, charactersNoSpaces = 0;
  const blocksByType: Partial<Record<BlockType, number>> = {};
  for (const block of document.blocks) {
    blocksByType[block.content.type] = (blocksByType[block.content.type] ?? 0) + 1;
    for (const part of textParts(block.content)) {
      const counted = countWords(part); latin += counted.latin; cjk += counted.cjk;
      characters += [...part].length; charactersNoSpaces += [...part.replace(/\s/gu, '')].length;
    }
  }
  const minutes = latin / 220 + cjk / 400;
  return { words: latin + cjk, characters, charactersNoSpaces, blocks: document.blocks.length, blocksByType, charts: blocksByType.chart ?? 0, tables: blocksByType.table ?? 0, images: blocksByType.image ?? 0,
    citations: document.citations.length, readingMinutes: minutes > 0 ? Math.max(1, Math.ceil(minutes)) : 0 };
}
