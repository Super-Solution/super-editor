/** Read-only preflight. Return a complete plan before any caller publishes bytes. */
export async function planPublication(items, lookup) {
  const pending = []; const skipped = [];
  for (const item of items) {
    const response = await lookup(item);
    if (response.status !== 200 && response.status !== 404) throw new Error(`Registry preflight failed (${response.status}): ${item.name}`);
    const existing = response.status === 404 ? undefined : response.document?.versions?.[item.version];
    if (existing) {
      if (!existing.dist?.integrity?.split(' ').includes(item.integrity)) throw new Error(`Immutable version already exists with different bytes: ${item.name}@${item.version}`);
      skipped.push(item);
    } else pending.push(item);
  }
  return { pending, skipped };
}
