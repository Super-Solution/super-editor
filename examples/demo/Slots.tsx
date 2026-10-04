import { useEffect } from 'react';
import type { ReactNode } from 'react';
import type { BlockContent } from '@super-solution/editor-core';
import type { Interaction } from '@super-solution/editor-ui';
import { EditorControls, EmptyDocumentState, useCommands, type QuickStartKind } from '@super-solution/editor-react';

/** The two pieces a page puts into `ReportEditor` through its slots: `emptyState` and `renderControls`. */

const STARTERS: Record<QuickStartKind, BlockContent> = {
  heading: { type: 'heading', level: 1, text: 'Untitled' },
  paragraph: { type: 'paragraph', runs: [] },
  list: { type: 'list', ordered: false, items: ['First item', 'Second item'], style: 'bullet' },
  table: { type: 'table', columns: ['Column A', 'Column B'], rows: [['', ''], ['', '']] },
  chart: { type: 'chart', spec: { kind: 'bar', title: 'Untitled chart', labels: ['A', 'B', 'C'], series: [{ name: 'Value', values: [3, 5, 2] }] } },
  callout: { type: 'callout', tone: 'info', title: 'Note', runs: [{ text: 'Something worth remembering.' }] },
};

/** The empty document's quick start. It renders inside `ReportEditor`, so `useCommands` reaches the same attributed, guarded commands as the / menu. */
export function QuickStart(): ReactNode {
  const commands = useCommands();
  return <EmptyDocumentState onInsert={(kind) => commands.insertBlocks([STARTERS[kind]])} />;
}

/** Hands the editor's interaction object up, so the page header can open the shortcut help. The default controls still render. */
export function Controls({ interaction, onReady }: { interaction: Interaction; onReady(interaction: Interaction | null): void }): ReactNode {
  useEffect(() => { onReady(interaction); return () => onReady(null); }, [interaction, onReady]);
  return <EditorControls interaction={interaction} />;
}
