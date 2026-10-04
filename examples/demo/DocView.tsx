import { useCallback, useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import { revealBlock, type Density, type DiffMarks, type FindHighlight, type Interaction, type ThemeName } from '@super-solution/editor-ui';
import { DocumentHeader, FindReplace, ReportEditor, StatusBar, diffMarks, feedbackToToast, useEditorDocument, useRevisionDiff, useToasts, type RevisionEntry } from '@super-solution/editor-react';
import { AgentTab } from './AgentTab.js';
import { REVIEWER, type Step } from './agent.js';
import type { Doc } from './documents.js';
import { EXPORTS, download } from './export.js';
import { HistoryTab } from './HistoryTab.js';
import { PartsTab, type Parts } from './PartsTab.js';
import { restoreRevision } from './restore.js';
import { Controls, QuickStart } from './Slots.js';
import { SourcesTab } from './SourcesTab.js';
import { Icon, Menu, Tabs } from './ui.js';
import { useSaveState } from './useSaveState.js';

export type PanelTab = 'history' | 'agent' | 'sources' | 'parts';
type Props = {
  doc: Doc; theme: ThemeName; density: Density; parts: Parts; onParts(parts: Parts): void; tab: PanelTab; onTab(tab: PanelTab): void;
  panelOpen: boolean; onClosePanel(): void; centerRef(element: HTMLElement | null): void;
};

/** Everything that belongs to one page: the center column, the right panel and the status bar. The app remounts it when the page changes. */
export function DocView({ doc, theme, density, parts, onParts, tab, onTab, panelOpen, onClosePanel, centerRef }: Props): ReactNode {
  const { editor } = doc;
  const report = useEditorDocument(editor);
  const toasts = useToasts();
  const [interaction, setInteraction] = useState<Interaction | null>(null);
  const [findOpen, setFindOpen] = useState(false);
  const [find, setFind] = useState<FindHighlight | null>(null);
  const [selected, setSelected] = useState<number | null>(null);
  const [flash, setFlash] = useState<DiffMarks | null>(null);
  const [reloads, setReloads] = useState(0);
  const save = useSaveState(report.revision);

  // "Reload" drops any half-typed draft and draws the document again. The editor already holds the live document, so that is all it takes.
  const reload = useCallback(() => setReloads((count) => count + 1), []);
  useEffect(() => {
    if (!flash) return;
    const timer = setTimeout(() => setFlash(null), 5_000);
    return () => clearTimeout(timer);
  }, [flash]);

  // Compare the selected revision with now. The marks outline added, changed and moved blocks in the document.
  const diff = useRevisionDiff(selected === null ? null : doc.snapshots.get(selected), report);
  const marks = tab === 'history' ? diffMarks(diff) : flash ?? undefined;

  const restore = (entry: RevisionEntry): void => {
    const target = doc.snapshots.get(entry.revision);
    if (!target) return;
    const result = restoreRevision(editor, target, REVIEWER);
    if (!result.ok) { toasts.notifyApplyResult(result, { onReload: reload }); return; }
    setSelected(null);
    toasts.success(`Restored revision ${entry.revision} as revision ${result.revision.number}.`);
  };
  const onSteps = (steps: Step[]): void => {
    const last = steps.at(-1);
    if (!last) return;
    if (!last.outcome.ok) { toasts.notifyApplyResult(last.outcome, { onReload: reload }); return; }
    toasts.success(`${last.actor === 'agent' ? 'Agent' : 'Person'}: ${last.outcome.summary}`);
    const touched = last.outcome.dryRun ? undefined : last.outcome.marks;
    if (!touched) return;
    setFlash(touched);
    const first = touched.added[0] ?? touched.changed[0];
    if (first) revealBlock(document, first, { focus: false });
  };

  const sources = report.citations.length;
  return <>
    <main className="center" id="main" ref={centerRef} aria-label="Document">
      <div className="find-dock"><FindReplace editor={editor} actor={REVIEWER} open={findOpen} onOpenChange={setFindOpen} onFindChange={setFind} readOnly={parts.readOnly}
        onResult={(result) => toasts.notifyApplyResult(result, { onReload: reload })} /></div>
      <div className="page" data-page={report.format.page} data-se-theme={theme} data-se-density={density} data-finding={findOpen || undefined}>
        <DocumentHeader document={report} editor={editor} actor={REVIEWER} onResult={(result) => toasts.notifyApplyResult(result, { onReload: reload })}
          meta={<span className="se-badge">{doc.kind}</span>}
          actions={<>
            <button type="button" className="se-button" onClick={() => setFindOpen(true)} aria-keyshortcuts="Control+F Meta+F">Find</button>
            <Menu label="Export" items={[...EXPORTS.map((format) => ({ label: format.label, onSelect: () => download(report, format) })), { label: 'Print…', onSelect: () => window.print() }]} />
            <button type="button" className="se-button" disabled={!interaction} onClick={() => interaction?.toggleHelp()} aria-keyshortcuts="Control+/ Meta+/">Shortcuts</button>
          </>} />
        <ReportEditor key={reloads} editor={editor} actor={REVIEWER} theme={theme} density={density} showHeader={false} {...parts}
          {...(find ? { find } : {})} {...(marks ? { diff: marks } : {})} emptyState={<QuickStart />}
          onFeedback={(event) => toasts.show(feedbackToToast(event, undefined, { onReload: reload }))}
          renderControls={({ interaction: current }) => current ? <Controls interaction={current} onReady={setInteraction} /> : null} />
      </div>
    </main>

    <aside className="panel" data-open={panelOpen || undefined} aria-label="Workspace panels">
      <div className="panel-head">
        <Tabs label="Panels" value={tab} onChange={onTab} tabs={[{ id: 'history', label: 'History', count: editor.getRevisions().length }, { id: 'agent', label: 'Agent' }, { id: 'sources', label: 'Sources', count: sources }, { id: 'parts', label: 'Parts' }]} />
        <button type="button" className="se-icon-button drawer-close" aria-label="Close panel" onClick={onClosePanel}><Icon name="close" /></button>
      </div>
      <div className="panel-body">
        <div role="tabpanel" id="panel-history" aria-labelledby="tab-history" hidden={tab !== 'history'}><HistoryTab doc={doc} report={report} selected={selected} diff={diff} onSelect={setSelected} onRestore={restore} /></div>
        <div role="tabpanel" id="panel-agent" aria-labelledby="tab-agent" hidden={tab !== 'agent'}><AgentTab editor={editor} onSteps={onSteps} /></div>
        <div role="tabpanel" id="panel-sources" aria-labelledby="tab-sources" hidden={tab !== 'sources'}>
          <SourcesTab report={report} onAgent={() => onTab('agent')} />
        </div>
        <div role="tabpanel" id="panel-parts" aria-labelledby="tab-parts" hidden={tab !== 'parts'}><PartsTab parts={parts} onChange={onParts} /></div>
      </div>
    </aside>

    <StatusBar className="status" document={report} save={{ state: save.state, ...(save.savedAt ? { savedAt: save.savedAt } : {}) }} />
  </>;
}
