// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 SUPER SOLUTION LABS INC
import type { Block, FormatWarning } from '@supersolutions/super-editor-core';

/** What the exporter asks the host for. The package never fetches `url` itself: it may be any https address an author or an agent wrote. */
export type DocxImageRequest = { url: string; alt: string; /** The first block that uses this address (an address is asked for once). */ blockId: string };
/**
 * The host's way to turn an image block's address into the picture's bytes (PNG, JPEG or GIF), by fetching it, reading a local file or a
 * cache. Return `null` or `undefined` to leave that image as a link. May be asynchronous; a thrown error or a rejection is treated like `null`
 * and reported in the warning, never thrown out of the export.
 *
 * **Security.** The address comes from the document, and a document can be edited by an agent: a resolver that fetches over the network is an
 * SSRF risk. Allow only the hosts you trust, refuse private and loopback addresses, cap size and time, and do not forward credentials.
 */
export type ResolveImage = (request: DocxImageRequest) => Uint8Array | null | undefined | Promise<Uint8Array | null | undefined>;

/** What the exporter will embed, per export. */
export const IMAGE_LIMITS = Object.freeze({
  /** Distinct addresses asked for; further ones stay links. */
  images: 500,
  /** Bytes of one picture. */
  perImageBytes: 10 * 1024 * 1024,
  /** Bytes of all pictures together. */
  totalBytes: 64 * 1024 * 1024,
  /** Pixels on either side of a picture. */
  pixels: 30_000,
});

export type Embedded = { part: string; mime: string; ext: string; data: Uint8Array; widthPx: number; heightPx: number; relationshipId: string };
export type Reason = 'not-returned' | 'resolver-failed' | 'unsupported-type' | 'unreadable' | 'too-large' | 'over-limit';
const REASONS: Record<Reason, string> = {
  'not-returned': 'the resolver returned nothing', 'resolver-failed': 'the resolver failed', 'unsupported-type': 'not a PNG, JPEG or GIF', unreadable: 'unreadable image data',
  'too-large': 'over the size limit', 'over-limit': 'over the limit on how many pictures are embedded',
};

/** Type and pixel size from the file's own header, or why it cannot be used. Nothing is decoded. */
export function sniffImage(bytes: Uint8Array): { mime: string; ext: string; widthPx: number; heightPx: number } | Reason {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const png = bytes.length >= 24 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47 && bytes[4] === 0x0d && bytes[5] === 0x0a && bytes[6] === 0x1a && bytes[7] === 0x0a;
  const gif = bytes.length >= 10 && bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x38 && (bytes[4] === 0x37 || bytes[4] === 0x39) && bytes[5] === 0x61;
  const jpeg = bytes.length >= 4 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
  let found: { mime: string; ext: string; widthPx: number; heightPx: number } | undefined;
  if (png) {
    // The first chunk must be IHDR: length 13, then the type, then width and height.
    if (view.getUint32(8) === 13 && view.getUint32(12) === 0x49484452) found = { mime: 'image/png', ext: 'png', widthPx: view.getUint32(16), heightPx: view.getUint32(20) };
  } else if (gif) found = { mime: 'image/gif', ext: 'gif', widthPx: view.getUint16(6, true), heightPx: view.getUint16(8, true) };
  else if (jpeg) {
    // Walk the marker segments to the first start-of-frame, which holds the size.
    let at = 2;
    while (at + 9 < bytes.length) {
      if (bytes[at] !== 0xff) { at++; continue; }
      const marker = bytes[at + 1]!;
      if (marker === 0xff) { at++; continue; }
      if (marker === 0xd8 || (marker >= 0xd0 && marker <= 0xd7) || marker === 0x01) { at += 2; continue; }
      const length = view.getUint16(at + 2);
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) { found = { mime: 'image/jpeg', ext: 'jpg', heightPx: view.getUint16(at + 5), widthPx: view.getUint16(at + 7) }; break; }
      if (length < 2) break;
      at += 2 + length;
    }
  } else return 'unsupported-type';
  if (!found || found.widthPx < 1 || found.heightPx < 1 || found.widthPx > IMAGE_LIMITS.pixels || found.heightPx > IMAGE_LIMITS.pixels) return 'unreadable';
  return found;
}

export type ImageBatch = { found: Map<string, Omit<Embedded, 'relationshipId'>>; skipped: { blockId: string; reason: Reason }[]; asked: number };

/**
 * Asks the host for every distinct image address in the document, in document order, a few at a time. The result does not depend on
 * how fast each answer arrives: parts are numbered in order of first use. Never throws.
 */
export async function resolveImages(blocks: readonly Block[], resolve: ResolveImage): Promise<ImageBatch> {
  const requests: DocxImageRequest[] = [], seen = new Set<string>(), skipped: ImageBatch['skipped'] = [];
  const blocksByUrl = new Map<string, string[]>();
  for (const block of blocks) if (block.content.type === 'image') {
    const url = block.content.url;
    blocksByUrl.set(url, [...(blocksByUrl.get(url) ?? []), block.id]);
    if (!seen.has(url)) { seen.add(url); requests.push({ url, alt: block.content.alt, blockId: block.id }); }
  }
  const outcomes = new Map<string, Omit<Embedded, 'relationshipId'> | Reason>();
  const asked = requests.slice(0, IMAGE_LIMITS.images);
  for (const request of requests.slice(IMAGE_LIMITS.images)) outcomes.set(request.url, 'over-limit');
  const one = async (request: DocxImageRequest): Promise<void> => {
    let data: Uint8Array | null | undefined;
    try { data = await resolve({ ...request }); } catch { outcomes.set(request.url, 'resolver-failed'); return; }
    if (data === null || data === undefined) { outcomes.set(request.url, 'not-returned'); return; }
    if (!(data instanceof Uint8Array)) { outcomes.set(request.url, 'unreadable'); return; }
    if (data.length > IMAGE_LIMITS.perImageBytes) { outcomes.set(request.url, 'too-large'); return; }
    const sniffed = sniffImage(data);
    if (typeof sniffed === 'string') { outcomes.set(request.url, sniffed); return; }
    outcomes.set(request.url, { ...sniffed, data: new Uint8Array(data), part: '' });
  };
  for (let start = 0; start < asked.length; start += 4) await Promise.all(asked.slice(start, start + 4).map(one));
  // Numbering and the total budget follow document order, never the order answers came back in.
  const found: ImageBatch['found'] = new Map();
  let total = 0;
  for (const request of requests) {
    const outcome = outcomes.get(request.url)!;
    if (typeof outcome === 'string') { for (const blockId of blocksByUrl.get(request.url)!) skipped.push({ blockId, reason: outcome }); continue; }
    if (total + outcome.data.length > IMAGE_LIMITS.totalBytes) { for (const blockId of blocksByUrl.get(request.url)!) skipped.push({ blockId, reason: 'too-large' }); continue; }
    total += outcome.data.length;
    found.set(request.url, { ...outcome, part: `word/media/image${found.size + 1}.${outcome.ext}` });
  }
  skipped.sort((a, b) => blocks.findIndex(block => block.id === a.blockId) - blocks.findIndex(block => block.id === b.blockId));
  return { found, skipped, asked: asked.length };
}

/** One warning for every image that stayed a link although `resolveImage` was given: how many, why, and which blocks. */
export function notEmbeddedWarning(skipped: ImageBatch['skipped']): FormatWarning | undefined {
  if (!skipped.length) return undefined;
  const reasons = new Map<Reason, number>();
  for (const entry of skipped) reasons.set(entry.reason, (reasons.get(entry.reason) ?? 0) + 1);
  const why = [...reasons].map(([reason, count]) => `${count} ${REASONS[reason]}`).join(', ');
  return {
    code: 'image-not-embedded', feature: 'image', count: skipped.length, blockIds: skipped.slice(0, 20).map(entry => entry.blockId),
    message: `${skipped.length} ${skipped.length === 1 ? 'image was' : 'images were'} not embedded (${why}) and ${skipped.length === 1 ? 'is' : 'are'} written as a link instead.`,
    hint: 'Return PNG, JPEG or GIF bytes (each at most 10 MB, 64 MB in all) from resolveImage for these addresses, or accept the link.',
  };
}
