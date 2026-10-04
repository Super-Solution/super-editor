import { useEffect, useRef, useState } from 'react';
import type { SaveState } from '@super-solution/editor-react';

/**
 * A pretend server for `SaveIndicator`. Each new revision marks the page unsaved; once edits pause for `delay` ms the "save" runs
 * (briefly "saving") and finishes. A real host does the same with its own API and maps failures to `error`, `offline` or `conflict`.
 */
export function useSaveState(revision: number, delay = 800): { state: SaveState; savedAt?: number } {
  const [save, setSave] = useState<{ state: SaveState; savedAt?: number }>({ state: 'saved' });
  const seen = useRef(revision);
  useEffect(() => {
    if (revision === seen.current) return;
    seen.current = revision;
    setSave((previous) => ({ ...previous, state: 'unsaved' }));
    const start = setTimeout(() => setSave((previous) => ({ ...previous, state: 'saving' })), delay);
    const done = setTimeout(() => setSave({ state: 'saved', savedAt: Date.now() }), delay + 450);
    return () => { clearTimeout(start); clearTimeout(done); };
  }, [revision, delay]);
  return save;
}
