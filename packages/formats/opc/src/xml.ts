// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 SUPER SOLUTION LABS INC

/**
 * XML 1.0 can not hold most control characters or U+FFFE/U+FFFF, even escaped, but a document may contain them. `xmlText` replaces
 * each one with U+FFFD and says how many it replaced, so a caller can report it instead of producing a file Word refuses to open.
 * Lone surrogates are replaced the same way (documents never contain them, but a caller of this package might pass one).
 */
export function xmlText(text: string): { text: string; replaced: number } {
  let out = '', replaced = 0;
  for (let index = 0; index < text.length; index++) {
    const unit = text.charCodeAt(index);
    let valid = unit === 0x9 || unit === 0xa || unit === 0xd || (unit >= 0x20 && unit <= 0xd7ff) || (unit >= 0xe000 && unit <= 0xfffd);
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = text.charCodeAt(index + 1);
      if (next >= 0xdc00 && next <= 0xdfff) { out += text[index]! + text[index + 1]!; index++; continue; }
    }
    if (!valid) { out += '�'; replaced++; continue; }
    out += text[index]!;
  }
  return { text: out, replaced };
}
/** Escapes text for element content. Run it on the output of `xmlText`. */
export const escapeXmlText = (text: string): string => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
/** Escapes text for a double-quoted attribute value. Whitespace characters are written as references so they survive attribute-value normalisation. */
export const escapeXmlAttribute = (text: string): string => escapeXmlText(text).replace(/"/g, '&quot;').replace(/\t/g, '&#9;').replace(/\n/g, '&#10;').replace(/\r/g, '&#13;');
