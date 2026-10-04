import type { BlockContent } from '@super-solution/editor-core';
import { deleteRange, runsPlainText } from './inline.js';

/**
 * Markdown-style input rules, evaluated while typing at the start of a paragraph:
 * `# ` `## ` `### ` heading, `- ` `* ` `+ ` bullets, `1. ` numbers, `[] ` to-do, `> ` quote, `!! ` callout,
 * a fenced ```lang code block, and `---` divider.
 */
export type InputRuleTrigger = 'space' | 'enter' | 'input';
export type InputRuleMatch = {
  rule: string;
  content: BlockContent;
  /** Characters removed from the start of the block text. */
  consumed: number;
  /** After this rule an empty paragraph should follow so typing can continue (divider). */
  followWithParagraph?: boolean;
};
export const INPUT_RULE_DOCS: readonly { rule: string; example: string; result: string }[] = [
  { rule: 'heading', example: '# ', result: 'Heading 1 (## Heading 2, ### Heading 3)' },
  { rule: 'bullet', example: '- ', result: 'Bulleted list (also * and +)' },
  { rule: 'number', example: '1. ', result: 'Numbered list' },
  { rule: 'todo', example: '[] ', result: 'To-do list ([x] starts checked)' },
  { rule: 'quote', example: '> ', result: 'Quote' },
  { rule: 'callout', example: '!! ', result: 'Callout' },
  { rule: 'code', example: '```ts', result: 'Code block with a language' },
  { rule: 'divider', example: '---', result: 'Divider' },
];

export function matchInputRule(content: BlockContent, caret: number, trigger: InputRuleTrigger): InputRuleMatch | null {
  if (content.type !== 'paragraph') return null;
  const text = runsPlainText(content.runs), before = text.slice(0, caret);
  const rest = (consumed: number) => deleteRange(content.runs, 0, consumed);
  const restText = (consumed: number) => text.slice(consumed);
  if (trigger === 'input') {
    if (before === '---' && text === '---') return { rule: 'divider', content: { type: 'divider' }, consumed: 3, followWithParagraph: true };
    if (before === '```' && text === '```') return { rule: 'code', content: { type: 'code', language: '', text: '' }, consumed: 3 };
    return null;
  }
  if (trigger === 'enter') {
    const fence = /^```([A-Za-z0-9+#._-]{0,40})$/.exec(text);
    if (fence && caret === text.length) return { rule: 'code', content: { type: 'code', language: fence[1] ?? '', text: '' }, consumed: text.length };
    if (/^(---|\*\*\*|___)$/.test(text) && caret === text.length) return { rule: 'divider', content: { type: 'divider' }, consumed: text.length, followWithParagraph: true };
    return null;
  }
  // Space: the caret sits right after a space that ends a recognised prefix at the very start of the block.
  if (!before.endsWith(' ')) return null;
  const prefix = before.slice(0, -1), consumed = before.length;
  const heading = /^(#{1,3})$/.exec(prefix);
  if (heading) return { rule: 'heading', content: { type: 'heading', level: heading[1]!.length as 1 | 2 | 3, text: restText(consumed) }, consumed };
  if (/^[-*+]$/.test(prefix)) return { rule: 'bullet', content: { type: 'list', ordered: false, style: 'bullet', items: [restText(consumed)] }, consumed };
  if (/^\d{1,9}[.)]$/.test(prefix)) return { rule: 'number', content: { type: 'list', ordered: true, style: 'number', items: [restText(consumed)] }, consumed };
  const todo = /^\[([ xX]?)\]$/.exec(prefix);
  if (todo) return { rule: 'todo', content: { type: 'list', ordered: false, style: 'todo', items: [restText(consumed)], checked: [todo[1] === 'x' || todo[1] === 'X'] }, consumed };
  if (prefix === '>') return { rule: 'quote', content: { type: 'quote', runs: rest(consumed) }, consumed };
  if (prefix === '!!') return { rule: 'callout', content: { type: 'callout', tone: 'info', runs: rest(consumed) }, consumed };
  const fence = /^```([A-Za-z0-9+#._-]{1,40})$/.exec(prefix);
  if (fence) return { rule: 'code', content: { type: 'code', language: fence[1]!, text: restText(consumed) }, consumed };
  return null;
}
