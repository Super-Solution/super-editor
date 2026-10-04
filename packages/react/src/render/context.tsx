import { createContext, useContext, useMemo } from 'react';
import type { ReactNode } from 'react';
import { defaultLabels, resolveLabels } from '@super-solution/editor-ui';
import type { Labels, PartialLabels } from '@super-solution/editor-ui';

const LabelsContext = createContext<Labels>(defaultLabels);

/** Resolves a partial `labels` prop. The result is stable while the label values do not change. */
export function useResolvedLabels(partial?: PartialLabels): Labels {
  const key = partial ? JSON.stringify(partial) : '';
  // eslint-disable-next-line react-hooks/exhaustive-deps
  return useMemo(() => resolveLabels(partial ? JSON.parse(key) as PartialLabels : undefined), [key]);
}
/** Labels from the nearest `LabelsProvider` (or `ReportView`), with an optional partial override for one component. */
export function useLabels(override?: PartialLabels): Labels {
  const inherited = useContext(LabelsContext);
  const key = override ? JSON.stringify(override) : '';
  // eslint-disable-next-line react-hooks/exhaustive-deps
  return useMemo(() => key ? mergeOver(inherited, JSON.parse(key) as PartialLabels) : inherited, [inherited, key]);
}
function mergeOver(base: Labels, patch: PartialLabels): Labels {
  const out = JSON.parse(JSON.stringify(base)) as Record<string, unknown>;
  const walk = (target: Record<string, unknown>, source: Record<string, unknown>): void => {
    for (const [name, value] of Object.entries(source)) {
      if (value === undefined || !Object.hasOwn(target, name)) continue;
      const current = target[name];
      if (current && typeof current === 'object' && value && typeof value === 'object') walk(current as Record<string, unknown>, value as Record<string, unknown>); else target[name] = value;
    }
  };
  walk(out, patch as Record<string, unknown>);
  return out as unknown as Labels;
}
/** Provides one set of UI strings to every panel and view below it. */
export function LabelsProvider({ labels, children }: { labels?: PartialLabels; children?: ReactNode }): ReactNode {
  const resolved = useResolvedLabels(labels);
  return <LabelsContext.Provider value={resolved}>{children}</LabelsContext.Provider>;
}
export { LabelsContext };
