// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 SUPER SOLUTION LABS INC
/**
 * Translation of the strings the interaction layer produces itself: notices ("Block ID copied"), block-menu and turn-into labels,
 * shortcut descriptions and groups, slash-menu group titles and the markdown-shortcut help. The dictionary is keyed by the English
 * text (the way gettext keys by msgid), so a host passes only what it translates:
 *
 *     createInteraction(editor, { messages: { 'Block ID copied': '區塊 ID 已複製', Duplicate: '複製' } })
 *
 * Unlisted text stays English. Messages that come from the core (validation issues) are not translated here: map `issue.code`
 * in the host if they must be localized.
 */
export type InteractionMessages = Readonly<Record<string, string>>;
export type Translate = (text: string) => string;
export function translator(messages?: InteractionMessages): Translate {
  if (!messages) return (text) => text;
  return (text) => Object.prototype.hasOwnProperty.call(messages, text) ? messages[text]! : text;
}
