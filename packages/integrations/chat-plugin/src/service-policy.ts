// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 SUPER SOLUTION LABS INC

/**
 * Where a card may send the reader's browser. A card is content from the conversation (a model or another participant wrote it),
 * so the service address it names is not trusted. The rules are safe with no configuration at all:
 *
 * 1. An address on the page's own origin gets the host's credentials: it is the host's own server.
 * 2. Any other `https` address on a public host is read anonymously (no credentials, no cookies, no referrer).
 * 3. Everything else is refused: plain `http`, an address with a user name or password, `localhost`, a single-label or internal
 *    name, and a literal private, loopback, link-local, carrier-grade NAT, multicast or cloud-metadata IP address.
 *
 * A host that really talks to another origin lists it in `allowedServiceOrigins`; that only widens these rules for exactly that
 * origin. It is never required.
 *
 * Limit, stated plainly: a browser cannot see which IP address a public name resolves to, so a name that points at a private
 * address is not caught here. It is requested without credentials, cookies or referrer, with redirects refused, and its answer is
 * only ever parsed as a document and size-capped; the browser's own cross-origin rules still decide whether a script may read it.
 */
export type ServiceVerdict =
  | { allowed: true; url: string; credentials: boolean }
  | { allowed: false; reason: string };

/** Normalized origins for the host's optional allowlist. Throws on an entry that is not an origin, so a typo is never ignored. */
export function normalizeOrigins(origins: readonly string[] | undefined): ReadonlySet<string> {
  const result = new Set<string>();
  for (const entry of origins ?? []) {
    let origin = 'null';
    try { origin = new URL(entry).origin; } catch { /* reported below */ }
    if (origin === 'null') throw new TypeError(`allowedServiceOrigins: "${entry}" is not an origin such as "https://editor.example.com".`);
    result.add(origin);
  }
  return result;
}

const PRIVATE_NAME_SUFFIXES = ['.localhost', '.local', '.localdomain', '.internal', '.lan', '.home.arpa', '.intranet', '.corp'] as const;

/** Whether a dotted IPv4 address is in a range that is not the public internet. */
function privateIPv4(a: number, b: number, c: number): boolean {
  return a === 0 || a === 10 || a === 127 || a >= 224
    || (a === 100 && b >= 64 && b <= 127)
    || (a === 169 && b === 254)
    || (a === 172 && b >= 16 && b <= 31)
    || (a === 192 && b === 0 && (c === 0 || c === 2))
    || (a === 192 && b === 88 && c === 99)
    || (a === 192 && b === 168)
    || (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100)))
    || (a === 203 && b === 0 && c === 113);
}

function ipv6Groups(host: string): number[] | undefined {
  const halves = host.split('::');
  if (halves.length > 2) return undefined;
  const head = halves[0] ? halves[0].split(':') : [];
  const tail = halves.length === 2 && halves[1] ? halves[1].split(':') : [];
  const fill = halves.length === 2 ? 8 - head.length - tail.length : 0;
  if (halves.length === 2 ? fill < 1 : head.length !== 8) return undefined;
  const groups = [...head, ...Array<string>(fill).fill('0'), ...tail].map(group => (/^[0-9a-f]{1,4}$/i.test(group) ? parseInt(group, 16) : NaN));
  return groups.length === 8 && groups.every(Number.isInteger) ? groups : undefined;
}

/** True when the host is a literal address or a name that can only mean a private network. */
function privateHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/\.$/, '');
  if (host.startsWith('[')) {
    const groups = ipv6Groups(host.slice(1, -1));
    if (!groups) return true;
    // Only global unicast (2000::/3) can be the public internet; 6to4 (2002::/16) is public only when the IPv4 inside it is.
    if ((groups[0]! & 0xe000) !== 0x2000) return true;
    if (groups[0] === 0x2002) return privateIPv4(groups[1]! >> 8, groups[1]! & 0xff, groups[2]! >> 8);
    return false;
  }
  const quad = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (quad) return privateIPv4(Number(quad[1]), Number(quad[2]), Number(quad[3]));
  // The URL parser has already turned every numeric spelling (2130706433, 0x7f.1, 017700000001) into dotted form, so what is left is a name.
  if (!host.includes('.') || host === 'localhost') return true;
  return PRIVATE_NAME_SUFFIXES.some(suffix => host.endsWith(suffix));
}

/**
 * Decides whether `address` (named by a card) may be requested, and whether the host's credentials may go with it.
 * `pageOrigin` is the origin of the page showing the card (`undefined` when it has none); a relative address resolves against `pageHref`.
 */
export function judgeServiceUrl(address: string, pageHref: string | undefined, allowed: ReadonlySet<string>): ServiceVerdict {
  let url: URL;
  try { url = new URL(address, pageHref); } catch { return { allowed: false, reason: 'The editor service address is not a valid URL.' }; }
  const origin = url.origin;
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return { allowed: false, reason: 'The editor service address must use https.' };
  if (url.username || url.password) return { allowed: false, reason: 'The editor service address must not contain a user name or password.' };
  let pageOrigin: string | undefined;
  try { pageOrigin = pageHref === undefined ? undefined : new URL(pageHref).origin; } catch { pageOrigin = undefined; }
  if (pageOrigin !== undefined && pageOrigin !== 'null' && origin === pageOrigin) return { allowed: true, url: url.href, credentials: true };
  if (allowed.has(origin)) return { allowed: true, url: url.href, credentials: true };
  if (url.protocol !== 'https:') return { allowed: false, reason: 'The editor service address must use https (plain http is only read from the page\'s own origin or an origin the host lists).' };
  if (privateHost(url.hostname)) return { allowed: false, reason: 'The editor service address points at a local or private network, so it was not requested.' };
  return { allowed: true, url: url.href, credentials: false };
}
