import { useRef } from 'react';
import type { KeyboardEvent, ReactNode } from 'react';
import { INPUT_RULE_DOCS, compatibleChartKinds } from '@super-solution/editor-ui';
import type { Interaction, ShortcutInfo } from '@super-solution/editor-ui';
import { OverlayPortal } from '../portal.js';
import { useBlockRect, useDocumentRevision, useInteraction, useInteractionState, useInteractionLabels, useSurface } from './context.js';
import { useIsoLayoutEffect } from './util.js';

function groupShortcuts(list: readonly ShortcutInfo[]): { group: string; items: ShortcutInfo[] }[] {
  const groups = new Map<string, ShortcutInfo[]>();
  for (const entry of list) {
    if (entry.hidden || entry.disabled) continue;
    const items = groups.get(entry.group);
    if (items) items.push(entry); else groups.set(entry.group, [entry]);
  }
  return [...groups].map(([group, items]) => ({ group, items }));
}
/**
 * Modal list of every shortcut (platform-aware) and the markdown shortcuts. Opens with Mod+/ or "?".
 * It is drawn with `position: fixed`, so it renders through a portal (see `OverlayPortal`): an editor inside an element with a
 * `transform`, `filter` or `container-type` still gets a dialog that covers the viewport.
 */
export function ShortcutHelp({ interaction: explicit }: { interaction?: Interaction }): ReactNode {
  const interaction = useInteraction(explicit), labels = useInteractionLabels();
  const open = useInteractionState(interaction, (state) => state.help);
  const dialog = useRef<HTMLDivElement>(null), close = useRef<HTMLButtonElement>(null);
  useIsoLayoutEffect(() => {
    if (!open || typeof document === 'undefined') return;
    const before = document.activeElement as HTMLElement | null;
    close.current?.focus();
    return () => { before?.focus?.({ preventScroll: true }); };
  }, [open]);
  if (!open) return null;
  const titleId = `${interaction.id}-shortcuts-title`;
  const onKeyDown = (event: KeyboardEvent): void => {
    if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); interaction.closeHelp(); return; }
    if (event.key !== 'Tab') return;
    const nodes = [...(dialog.current?.querySelectorAll<HTMLElement>('button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])') ?? [])];
    if (!nodes.length) return;
    const first = nodes[0]!, last = nodes[nodes.length - 1]!;
    if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); } else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
  };
  // data-se-owner: focus moving into the dialog is not "leaving the editor" (the dialog is no longer inside the surface element).
  return <OverlayPortal><div className="se-dialog-backdrop" data-se-popup data-se-owner={interaction.id} onMouseDown={(event) => { if (event.target === event.currentTarget) interaction.closeHelp(); }}>
    <div ref={dialog} className="se-popup se-dialog se-shortcuts" role="dialog" aria-modal="true" aria-labelledby={titleId} onKeyDown={onKeyDown}>
      <header className="se-dialog-header"><h2 id={titleId}>{labels.shortcutHelp}</h2>
        <button ref={close} type="button" className="se-button" onClick={() => interaction.closeHelp()} aria-label={labels.shortcutHelpClose}><span aria-hidden="true">{'×'}</span></button></header>
      <div className="se-dialog-body">
        {groupShortcuts(interaction.shortcuts.list()).map((group) => <section key={group.group} className="se-shortcut-group"><h3>{group.group}</h3>
          <dl>{group.items.map((entry) => <div key={entry.id} className="se-shortcut-row"><dt>{entry.description}</dt><dd>{entry.display.map((keys, index) => <kbd key={index}>{keys}</kbd>)}</dd></div>)}</dl></section>)}
        <section className="se-shortcut-group"><h3>{labels.markdownShortcuts}</h3>
          <dl>{INPUT_RULE_DOCS.map((rule) => <div key={rule.rule} className="se-shortcut-row"><dt>{rule.result}</dt><dd><kbd>{rule.example}</kbd></dd></div>)}</dl></section>
      </div>
      <footer className="se-dialog-footer">{labels.shortcutHelpHint}</footer>
    </div>
  </div></OverlayPortal>;
}

/** Quick settings for the selected chart: title, type, caption, source and bar layout. Only types the data can be drawn as are offered. */
export function ChartEditor({ interaction: explicit }: { interaction?: Interaction }): ReactNode {
  const interaction = useInteraction(explicit), labels = useInteractionLabels(), binding = useSurface();
  const id = useInteractionState(interaction, (state) => state.chartEditor);
  useDocumentRevision(interaction);
  const rect = useBlockRect(id);
  const first = useRef<HTMLInputElement>(null);
  const shown = !!id && !!rect;
  useIsoLayoutEffect(() => { if (shown) first.current?.focus({ preventScroll: true }); }, [shown]);
  const block = id ? interaction.editor.getSnapshot().blocks.find((entry) => entry.id === id) : undefined;
  if (!id || !rect || !block || block.content.type !== 'chart') return null;
  const spec = block.content.spec, kinds = compatibleChartKinds(spec), bar = spec.kind === 'bar';
  const close = (): void => { interaction.closeChartEditor(); binding?.root.focus({ preventScroll: true }); };
  const text = (name: 'title' | 'caption' | 'source', value: string | undefined, label: string, ref?: typeof first): ReactNode => (
    <label className="se-field"><span className="se-field-label">{label}</span>
      <input ref={ref} key={`${name}:${value ?? ''}`} type="text" defaultValue={value ?? ''} onBlur={(event) => { if (event.target.value !== (value ?? '')) interaction.commands.patchChart(id, { [name]: event.target.value }); }}
        onKeyDown={(event) => { if (event.key === 'Enter') { event.preventDefault(); (event.target as HTMLInputElement).blur(); } }} /></label>);
  return <div className="se-popup se-chart-editor" data-se-popup role="dialog" aria-label={labels.chartEditor} style={{ left: rect.left + 16, top: rect.top + 16 }}
    onKeyDown={(event) => { if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close(); } }}>
    {text('title', spec.title, labels.chartTitle, first)}
    <label className="se-field"><span className="se-field-label">{labels.chartKind}</span>
      <select value={spec.kind} onChange={(event) => interaction.commands.patchChart(id, { kind: event.target.value })}>{kinds.map((kind) => <option key={kind} value={kind}>{kind}</option>)}</select></label>
    {text('caption', spec.caption, labels.chartCaption)}
    {text('source', spec.source, labels.chartSource)}
    {bar ? <div className="se-field-row">
      <label className="se-check"><input type="checkbox" checked={!!spec.stacked} onChange={(event) => interaction.commands.patchChart(id, { stacked: event.target.checked })} /> {labels.chartStacked}</label>
      <label className="se-check"><input type="checkbox" checked={!!spec.horizontal} onChange={(event) => interaction.commands.patchChart(id, { horizontal: event.target.checked })} /> {labels.chartHorizontal}</label>
    </div> : null}
    <div className="se-popup-actions"><button type="button" className="se-button se-button-primary" onClick={close}>{labels.done}</button></div>
  </div>;
}
