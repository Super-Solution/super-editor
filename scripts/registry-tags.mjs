import { randomUUID } from 'node:crypto';
import { registry, packageOrder, packageName } from './release-contract.mjs';

export const repairVersion = '0.1.0-next.0';
export const repairNames = packageOrder.map(packageName);

export async function readRegistry(name) {
  const url = `${registry}${encodeURIComponent(name)}?tag-check=${randomUUID()}`;
  const response = await fetch(url, {
    signal: AbortSignal.timeout(15_000),
    headers: { accept: 'application/json', 'cache-control': 'no-cache' },
  });
  if (response.status === 404) return undefined;
  if (!response.ok) throw new Error(`Registry read failed (${response.status}): ${name}`);
  return response.json();
}

/**
 * The `latest` tag a `next` publication must leave untouched (checkPublishedTags
 * verifies it afterwards). A prerelease `latest` is the known legacy state from
 * 0.1.0-next.0; its repair (npm-tag-repair.md) is deferred by the owner, so it
 * is reported, not fatal: publishing to `next` neither moves nor worsens it.
 */
export function checkPrereleaseBaseline(name, document, warn = message => console.warn(message)) {
  const latest = document?.['dist-tags']?.latest;
  if (latest !== undefined && !/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(latest)) {
    warn(`Prerelease latest already present: ${name}@${latest}; publishing to next leaves it unchanged (repair is tracked separately).`);
  }
  return latest;
}

export function checkPublishedTags(item, beforeLatest, document) {
  const tags = document?.['dist-tags'];
  if (tags?.[item.channel] !== item.version) throw new Error(`Published channel mismatch: ${item.name}`);
  if (item.channel === 'next' && tags?.latest !== beforeLatest) {
    throw new Error(`Prerelease changed latest: ${item.name}; tag verification is read-only and will not repair it.`);
  }
}

// Compare the published version set and every tarball descriptor, including integrity.
export function versionSnapshot(document) {
  return Object.fromEntries(Object.entries(document?.versions ?? {}).sort(([a], [b]) => a.localeCompare(b))
    .map(([version, value]) => [version, value.dist ?? null]));
}
const canonical = value => JSON.stringify(value, (_, item) => item && typeof item === 'object' && !Array.isArray(item)
  ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b))) : item);

function checkRepairTarget(name, document) {
  const tags = document?.['dist-tags'];
  if (!document?.versions?.[repairVersion] || tags?.next !== repairVersion) throw new Error(`Repair next/version guard failed: ${name}`);
  if (tags.latest !== undefined && tags.latest !== repairVersion) throw new Error(`Repair latest guard failed: ${name}@${tags.latest}`);
}
function checkPreserved(name, before, after) {
  checkRepairTarget(name, after);
  const otherTags = document => Object.fromEntries(Object.entries(document['dist-tags']).filter(([tag]) => tag !== 'latest'));
  if (canonical(otherTags(before)) !== canonical(otherTags(after)) || canonical(versionSnapshot(before)) !== canonical(versionSnapshot(after))) {
    throw new Error(`Registry versions, tarballs or other tags changed: ${name}`);
  }
}

/** Fixed six-package repair. Callers supply the credential-bearing operation; reads are public. */
export async function repairLatest({ lookup = readRegistry, removeLatest, audit = [] }) {
  const baseline = new Map();
  // Validate the entire allowlist before any mutation.
  for (const name of repairNames) {
    const document = await lookup(name);
    checkRepairTarget(name, document);
    baseline.set(name, document);
    audit.push({ phase: 'before', name, tags: document['dist-tags'], versions: versionSnapshot(document) });
  }
  for (const name of repairNames) {
    const current = await lookup(name);
    checkPreserved(name, baseline.get(name), current);
    if (current['dist-tags'].latest === repairVersion) {
      await removeLatest(name);
      audit.push({ phase: 'removed', name });
    } else audit.push({ phase: 'already-absent', name });
    const after = await lookup(name);
    checkPreserved(name, baseline.get(name), after);
    if (after['dist-tags'].latest !== undefined) throw new Error(`Repair readback still has latest: ${name}`);
    audit.push({ phase: 'after', name, tags: after['dist-tags'], versions: versionSnapshot(after) });
  }
  // Final complete readback also detects changes to earlier packages during this run.
  for (const name of repairNames) {
    const document = await lookup(name);
    checkPreserved(name, baseline.get(name), document);
    if (document['dist-tags'].latest !== undefined) throw new Error(`Final readback has latest: ${name}`);
    audit.push({ phase: 'final', name, tags: document['dist-tags'], versions: versionSnapshot(document) });
  }
  return audit;
}
