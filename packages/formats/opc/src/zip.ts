// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 SUPER SOLUTION LABS INC
import { crc32 } from './crc32.js';

/** A ZIP problem, with a code to branch on. Bad or unsupported files are refused, never half read. */
export class ZipError extends Error {
  constructor(readonly code: 'not-a-zip' | 'corrupt' | 'unsupported' | 'too-large' | 'unsafe-path' | 'duplicate' | 'invalid-input', message: string) { super(message); this.name = 'ZipError'; }
}

const encoder = new TextEncoder();
const MAX32 = 0xffffffff;
export type ZipEntryInput = { path: string; data: Uint8Array | string };
export type WriteZipOptions = {
  /** Modification time stored for every entry (UTC, 2-second resolution, 1980 to 2107). Default 1980-01-01, so the same input gives the same bytes. */
  modified?: Date | string;
  /** Deflate entries when that makes them smaller. Default true. It needs `CompressionStream` (Node 18+, current browsers); without it entries are stored. */
  compress?: boolean;
};

/** Paths in a ZIP (and so OPC part names) use `/`, start with a name, and never climb out with `..`. Returns a problem or undefined. */
export function pathProblem(path: string): string | undefined {
  if (path === '' || path.length > 512) return 'A path must be 1 to 512 characters.';
  if (/[\\\u0000-\u001f\u007f]/u.test(path)) return 'A path must not contain backslashes or control characters.';
  if (path.startsWith('/') || /^[A-Za-z]:/.test(path)) return 'A path must be relative, without a leading slash or drive letter.';
  if (path.split('/').some(segment => segment === '' || segment === '.' || segment === '..')) return 'A path must not contain empty, "." or ".." segments (and must not end with "/").';
  return undefined;
}

function dosDateTime(modified: Date): { time: number; date: number } {
  const year = modified.getUTCFullYear();
  if (!Number.isFinite(modified.getTime()) || year < 1980 || year > 2107) throw new ZipError('invalid-input', 'The modification time must be between 1980 and 2107.');
  return { time: (modified.getUTCHours() << 11) | (modified.getUTCMinutes() << 5) | (modified.getUTCSeconds() >> 1), date: ((year - 1980) << 9) | ((modified.getUTCMonth() + 1) << 5) | modified.getUTCDate() };
}

async function drain(stream: ReadableStream<Uint8Array>, limit = Infinity): Promise<Uint8Array> {
  const reader = stream.getReader(), chunks: Uint8Array[] = []; let length = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    length += value.length;
    if (length > limit) { await reader.cancel(); throw new ZipError('too-large', `An entry inflates beyond ${limit} bytes.`); }
    chunks.push(value);
  }
  const out = new Uint8Array(length); let offset = 0;
  for (const chunk of chunks) { out.set(chunk, offset); offset += chunk.length; }
  return out;
}
const pipeThrough = (data: Uint8Array, transform: CompressionStream | DecompressionStream): ReadableStream<Uint8Array> =>
  new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(data); controller.close(); } }).pipeThrough(transform as unknown as ReadableWritablePair<Uint8Array, Uint8Array>);
async function deflateRaw(data: Uint8Array): Promise<Uint8Array | undefined> {
  if (typeof CompressionStream === 'undefined' || data.length < 64) return undefined;
  const packed = await drain(pipeThrough(data, new CompressionStream('deflate-raw')));
  return packed.length < data.length ? packed : undefined;
}

/**
 * Writes a ZIP archive: UTF-8 names, STORE or DEFLATE, CRC-32, no encryption, no ZIP64 (so under 4 GiB and 65 535 entries; more is an error).
 * Entries are written in the order given. Deterministic for the same input and platform.
 */
export async function writeZip(entries: readonly ZipEntryInput[], options: WriteZipOptions = {}): Promise<Uint8Array> {
  if (entries.length > 0xfffe) throw new ZipError('too-large', 'A ZIP without ZIP64 holds at most 65 534 entries.');
  const { time, date } = dosDateTime(options.modified === undefined ? new Date(Date.UTC(1980, 0, 1)) : new Date(options.modified));
  const seen = new Set<string>(), locals: Uint8Array[] = [], centrals: Uint8Array[] = []; let offset = 0;
  for (const entry of entries) {
    const problem = pathProblem(entry.path);
    if (problem) throw new ZipError('unsafe-path', `${problem} Got "${entry.path}".`);
    const key = entry.path.toLowerCase();
    if (seen.has(key)) throw new ZipError('duplicate', `Two entries have the path "${entry.path}" (paths are compared without regard to case).`);
    seen.add(key);
    const name = encoder.encode(entry.path), data = typeof entry.data === 'string' ? encoder.encode(entry.data) : entry.data;
    const packed = options.compress === false ? undefined : await deflateRaw(data), stored = packed ?? data, method = packed ? 8 : 0, crc = crc32(data);
    if (data.length > MAX32 || stored.length > MAX32 || offset > MAX32) throw new ZipError('too-large', 'A ZIP without ZIP64 holds at most 4 GiB.');
    const local = new Uint8Array(30 + name.length), lv = new DataView(local.buffer);
    lv.setUint32(0, 0x04034b50, true); lv.setUint16(4, 20, true); lv.setUint16(6, 0x0800, true); lv.setUint16(8, method, true); lv.setUint16(10, time, true); lv.setUint16(12, date, true);
    lv.setUint32(14, crc, true); lv.setUint32(18, stored.length, true); lv.setUint32(22, data.length, true); lv.setUint16(26, name.length, true); local.set(name, 30);
    const central = new Uint8Array(46 + name.length), cv = new DataView(central.buffer);
    cv.setUint32(0, 0x02014b50, true); cv.setUint16(4, 20, true); cv.setUint16(6, 20, true); cv.setUint16(8, 0x0800, true); cv.setUint16(10, method, true); cv.setUint16(12, time, true); cv.setUint16(14, date, true);
    cv.setUint32(16, crc, true); cv.setUint32(20, stored.length, true); cv.setUint32(24, data.length, true); cv.setUint16(28, name.length, true); cv.setUint32(42, offset, true); central.set(name, 46);
    locals.push(local, stored); centrals.push(central); offset += local.length + stored.length;
  }
  const directory = centrals.reduce((sum, part) => sum + part.length, 0);
  if (offset + directory > MAX32) throw new ZipError('too-large', 'A ZIP without ZIP64 holds at most 4 GiB.');
  const end = new Uint8Array(22), ev = new DataView(end.buffer);
  ev.setUint32(0, 0x06054b50, true); ev.setUint16(8, entries.length, true); ev.setUint16(10, entries.length, true); ev.setUint32(12, directory, true); ev.setUint32(16, offset, true);
  const out = new Uint8Array(offset + directory + 22); let at = 0;
  for (const part of [...locals, ...centrals, end]) { out.set(part, at); at += part.length; }
  return out;
}

export type ReadZipLimits = {
  /** Most entries accepted. Default 5 000. */
  maxEntries?: number;
  /** Largest entry after inflating. Default 32 MiB. */
  maxEntryBytes?: number;
  /** All entries after inflating. Default 128 MiB. The limit that stops a ZIP bomb. */
  maxTotalBytes?: number;
};

/**
 * Reads every file of a ZIP into memory, keyed by path. Refuses (with a `ZipError`): anything that is not a ZIP, truncated or
 * inconsistent files (sizes and CRC are checked), encryption, ZIP64, methods other than STORE and DEFLATE, paths that are absolute or
 * climb out with `..`, duplicate paths, and sizes beyond the limits. Directory entries are skipped. Inflating stops as soon as an entry
 * exceeds what it declared, so a small file cannot expand without bound.
 */
export async function readZip(bytes: Uint8Array, limits: ReadZipLimits = {}): Promise<Map<string, Uint8Array>> {
  const maxEntries = limits.maxEntries ?? 5_000, maxEntry = limits.maxEntryBytes ?? 32 * 1024 * 1024, maxTotal = limits.maxTotalBytes ?? 128 * 1024 * 1024;
  if (!(bytes instanceof Uint8Array) || bytes.length < 22) throw new ZipError('not-a-zip', 'The input is too short to be a ZIP file.');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.length), decoder = new TextDecoder('utf-8', { fatal: true });
  let end = -1;
  for (let at = bytes.length - 22; at >= Math.max(0, bytes.length - 22 - 0xffff); at--) if (view.getUint32(at, true) === 0x06054b50) { end = at; break; }
  if (end < 0) throw new ZipError('not-a-zip', 'No ZIP end-of-directory record was found; this is not a ZIP file, or it is truncated.');
  const count = view.getUint16(end + 10, true), directorySize = view.getUint32(end + 12, true), directoryAt = view.getUint32(end + 16, true);
  if (count === 0xffff || directorySize === MAX32 || directoryAt === MAX32) throw new ZipError('unsupported', 'ZIP64 archives are not supported.');
  if (count > maxEntries) throw new ZipError('too-large', `The ZIP has ${count} entries; the limit is ${maxEntries}.`);
  if (directoryAt + directorySize > end) throw new ZipError('corrupt', 'The ZIP directory lies outside the file.');
  const files = new Map<string, Uint8Array>(), seen = new Set<string>(); let total = 0, at = directoryAt;
  for (let index = 0; index < count; index++) {
    if (at + 46 > end || view.getUint32(at, true) !== 0x02014b50) throw new ZipError('corrupt', `ZIP directory entry ${index + 1} is damaged.`);
    const flags = view.getUint16(at + 8, true), method = view.getUint16(at + 10, true), crc = view.getUint32(at + 16, true), packedSize = view.getUint32(at + 20, true), size = view.getUint32(at + 24, true);
    const nameLength = view.getUint16(at + 28, true), extraLength = view.getUint16(at + 30, true), commentLength = view.getUint16(at + 32, true), localAt = view.getUint32(at + 42, true);
    if (at + 46 + nameLength + extraLength + commentLength > end) throw new ZipError('corrupt', `ZIP directory entry ${index + 1} is damaged.`);
    let path: string;
    try { path = decoder.decode(bytes.subarray(at + 46, at + 46 + nameLength)); } catch { throw new ZipError('corrupt', `ZIP entry ${index + 1} has a name that is not valid UTF-8.`); }
    at += 46 + nameLength + extraLength + commentLength;
    if (path.endsWith('/') && size === 0) continue;
    const problem = pathProblem(path);
    if (problem) throw new ZipError('unsafe-path', `${problem} Got "${path}".`);
    if (flags & 1 || flags & 0x40) throw new ZipError('unsupported', `"${path}" is encrypted; encrypted ZIP entries are not supported.`);
    if (method !== 0 && method !== 8) throw new ZipError('unsupported', `"${path}" uses compression method ${method}; only STORE (0) and DEFLATE (8) are supported.`);
    if (packedSize === MAX32 || size === MAX32 || localAt === MAX32) throw new ZipError('unsupported', 'ZIP64 archives are not supported.');
    const key = path.toLowerCase();
    if (seen.has(key)) throw new ZipError('duplicate', `Two entries have the path "${path}" (compared without regard to case).`);
    seen.add(key);
    if (size > maxEntry) throw new ZipError('too-large', `"${path}" is ${size} bytes inflated; the limit is ${maxEntry}.`);
    total += size;
    if (total > maxTotal) throw new ZipError('too-large', `The entries inflate to more than ${maxTotal} bytes in all.`);
    if (localAt + 30 > directoryAt || view.getUint32(localAt, true) !== 0x04034b50) throw new ZipError('corrupt', `The data of "${path}" is missing.`);
    const start = localAt + 30 + view.getUint16(localAt + 26, true) + view.getUint16(localAt + 28, true);
    if (start + packedSize > directoryAt) throw new ZipError('corrupt', `The data of "${path}" runs past the end of the file.`);
    const packed = bytes.subarray(start, start + packedSize);
    let data: Uint8Array;
    if (method === 0) data = packed.slice();
    else {
      if (typeof DecompressionStream === 'undefined') throw new ZipError('unsupported', 'Reading compressed entries needs DecompressionStream (Node 18+ or a current browser).');
      try { data = await drain(pipeThrough(packed, new DecompressionStream('deflate-raw')), size); } catch (error) { if (error instanceof ZipError) throw error; throw new ZipError('corrupt', `The data of "${path}" is not valid DEFLATE.`); }
    }
    if (data.length !== size) throw new ZipError('corrupt', `"${path}" is ${data.length} bytes inflated but the directory says ${size}.`);
    if (crc32(data) !== crc) throw new ZipError('corrupt', `"${path}" fails its CRC-32 check.`);
    files.set(path, data);
  }
  return files;
}
