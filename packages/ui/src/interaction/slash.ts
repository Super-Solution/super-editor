import type { SlashItem } from './catalog.js';

/** Fuzzy scoring for the slash menu. 0 means "does not match"; higher is better. */
const normalize = (value: string): string => value.toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '');
function subsequenceScore(query: string, text: string): number {
  let position = 0, score = 0, streak = 0;
  for (const char of query) {
    const found = text.indexOf(char, position);
    if (found === -1) return 0;
    streak = found === position && position > 0 ? streak + 1 : 0;
    score += 1 + streak * 2 + (found === 0 || /[\s\-_/]/.test(text[found - 1] ?? '') ? 3 : 0);
    position = found + 1;
  }
  return score;
}
export function fuzzyScore(query: string, text: string): number {
  const q = normalize(query).trim(), t = normalize(text);
  if (!q) return 1;
  if (t === q) return 1_000;
  if (t.startsWith(q)) return 800 - Math.min(t.length - q.length, 100);
  const words = t.split(/[\s\-_/]+/);
  if (words.some((word) => word.startsWith(q))) return 600 - Math.min(t.length, 100);
  const at = t.indexOf(q);
  if (at !== -1) return 400 - Math.min(at + t.length, 200);
  // Multi-word queries match when every word matches somewhere ("bar chart" ~ "chart bar").
  const parts = q.split(/\s+/).filter(Boolean);
  if (parts.length > 1 && parts.every((part) => t.includes(part))) return 300;
  const sub = subsequenceScore(q.replace(/\s+/g, ''), t);
  return sub > 0 ? Math.min(sub, 120) : 0;
}
export function slashScore(query: string, item: SlashItem): number {
  if (!query.trim()) return 1;
  const label = fuzzyScore(query, item.label) * 1;
  const keyword = Math.max(0, ...item.keywords.map((keyword) => fuzzyScore(query, keyword) * .8));
  const hint = item.hint && normalize(item.hint) === normalize(query).trim() ? 700 : 0;
  const description = fuzzyScore(query, item.description) * .25;
  const group = fuzzyScore(query, item.group) * .15;
  return Math.max(label, keyword, hint, description, group);
}
/** Matching items, best first. Ties keep catalog order, so an empty query returns the catalog as is. */
export function filterSlashItems<T extends SlashItem>(items: readonly T[], query: string): T[] {
  if (!query.trim()) return [...items];
  return items.map((item, index) => ({ item, index, score: slashScore(query, item) })).filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score || a.index - b.index).map((entry) => entry.item);
}
export type SlashGroup<T extends SlashItem = SlashItem> = { group: string; items: T[] };
/** Consecutive grouping keeps the filtered ranking visible: a group header appears wherever the group changes. */
export function groupSlashItems<T extends SlashItem>(items: readonly T[]): SlashGroup<T>[] {
  const groups: SlashGroup<T>[] = [];
  for (const item of items) {
    const last = groups[groups.length - 1];
    if (last && last.group === item.group) last.items.push(item); else groups.push({ group: item.group, items: [item] });
  }
  return groups;
}
