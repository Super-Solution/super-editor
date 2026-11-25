// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 SUPER SOLUTION LABS INC
import { template } from '../charts/labels.js';

/**
 * Translation of the strings the interaction layer produces itself: notices ("Block ID copied"), block-menu and turn-into labels,
 * shortcut descriptions and groups, slash-menu group titles and the markdown-shortcut help. The dictionary is keyed by the English
 * text (the way gettext keys by msgid), so a host passes only what it translates:
 *
 *     createInteraction(editor, { messages: { 'Block ID copied': '區塊 ID 已複製', Duplicate: '複製' } })
 *
 * A message that carries a number or a name is a template with `{name}` placeholders, and the template is the key:
 *
 *     messages: { 'Pasted {count} blocks': '已貼上 {count} 個區塊', 'Pasted {count} block': '已貼上 {count} 個區塊' }
 *
 * English has two forms where a count is involved (`'Pasted {count} block'` for 1, `'Pasted {count} blocks'` otherwise), so there
 * are two keys. A language with other plural rules gives a function instead of a string: it receives the parameters and returns the
 * text, so it can use `Intl.PluralRules`:
 *
 *     messages: { 'Pasted {count} blocks': ({ count }) => new Intl.PluralRules('ru').select(Number(count)) === 'one' ? `…` : `…` }
 *
 * Unlisted text stays English (its placeholders are still filled in). A placeholder that has no parameter is left as written.
 * Messages that come from the core (validation issues) are not translated here: map `issue.code` in the host if they must be
 * localized.
 */
export type MessageParams = Readonly<Record<string, string | number>>;
export type InteractionMessages = Readonly<Record<string, string | ((params: MessageParams) => string)>>;
export type Translate = (text: string, params?: MessageParams) => string;
const fill = (text: string, params: MessageParams | undefined): string => params ? template(text, params) : text;
export function translator(messages?: InteractionMessages): Translate {
  return (text, params) => {
    const entry = messages && Object.prototype.hasOwnProperty.call(messages, text) ? messages[text] : undefined;
    return typeof entry === 'function' ? entry(params ?? {}) : fill(entry ?? text, params);
  };
}
/** The English template for a count: `one` for exactly 1, else `other`. Pass the result and `{ count }` to a `Translate`. */
export const counted = (count: number, one: string, other: string): string => count === 1 ? one : other;
