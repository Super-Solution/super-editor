import { useRef, useState } from 'react';
import type { FormEvent, ReactNode, RefObject } from 'react';
import { TURN_INTO_TARGETS, blockRoots, canTurnInto, formatShortcut, selectionClientRect } from '@super-solution/editor-ui';
import type { Interaction, InteractionState, Mark, TurnIntoTarget } from '@super-solution/editor-ui';
import { HIGHLIGHTS } from '@super-solution/editor-core';
import type { Highlight } from '@super-solution/editor-core';
import { useBlockRect, useDocumentRevision, useInteraction, useInteractionState, useInteractionLabels, useSurface } from './context.js';
import { keepFocus, useIsoLayoutEffect, useKeepInViewport } from './util.js';

type Point = { x: number; y: number };
/** Content-space point above the current text selection (or above the block when the environment cannot measure the selection). */
function useSelectionAnchor(active: boolean, blockId: string | null, field: string | null): Point | null {
  const binding = useSurface();
  const blockRect = useBlockRect(active ? blockId : null);
  const [point, setPoint] = useState<Point | null>(null);
  useIsoLayoutEffect(() => {
    if (!active || !binding || !blockId) { setPoint((previous) => previous === null ? previous : null); return; }
    const element = [...binding.root.querySelectorAll<HTMLElement>('[data-se-editable]')].find((node) => node.getAttribute('data-se-block-id') === blockId && node.getAttribute('data-field') === field);
    const rect = element ? selectionClientRect(element) : null;
    const next = rect ? { ...binding.toContent((rect.left + rect.right) / 2, rect.top) } : blockRect ? { x: blockRect.left + 24, y: blockRect.top } : null;
    setPoint((previous) => previous && next && previous.x === next.x && previous.y === next.y ? previous : next);
  });
  return point;
}

const MARK_BUTTONS: readonly { mark: Mark; glyph: ReactNode; label: 'bold' | 'italic' | 'underline' | 'strike' | 'code'; shortcut: string }[] = [
  { mark: 'bold', glyph: <strong>B</strong>, label: 'bold', shortcut: 'text.bold' },
  { mark: 'italic', glyph: <em>I</em>, label: 'italic', shortcut: 'text.italic' },
  { mark: 'underline', glyph: <u>U</u>, label: 'underline', shortcut: 'text.underline' },
  { mark: 'strike', glyph: <s>S</s>, label: 'strike', shortcut: 'text.strike' },
  { mark: 'code', glyph: <code>{'</>'}</code>, label: 'code', shortcut: 'text.code' },
];
const hint = (interaction: Interaction, id: string): string => { const key = interaction.shortcuts.keysFor(id)[0]; return key ? ` (${formatShortcut(key, interaction.platform)})` : ''; };

/** Floating toolbar over selected text: bold, italic, underline, strike, code, highlight and link. Buttons keep the editor's focus and selection. */
export function FormattingToolbar({ interaction: explicit }: { interaction?: Interaction }): ReactNode {
  const interaction = useInteraction(explicit), labels = useInteractionLabels();
  const selection = useInteractionState(interaction, (state) => state.textSelection);
  const hidden = useInteractionState(interaction, (state) => state.slash !== null || state.prompt !== null || state.drag !== null || state.readOnly || state.editing === null);
  useDocumentRevision(interaction);
  const visible = !!selection && selection.start !== selection.end && !hidden;
  const point = useSelectionAnchor(visible, selection?.blockId ?? null, selection?.field ?? null);
  const [colors, setColors] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const shift = useKeepInViewport(ref, visible);
  if (!visible || !selection || !point) return null;
  const supported = selection.field === 'main' && (interaction.edit.draftContent(selection.blockId)?.type === 'paragraph' || interaction.edit.draftContent(selection.blockId)?.type === 'quote' || interaction.edit.draftContent(selection.blockId)?.type === 'callout');
  if (!supported) return null;
  return <div ref={ref} className="se-popup se-toolbar se-format-toolbar" data-se-popup role="toolbar" aria-label={labels.formattingToolbar} aria-orientation="horizontal"
    style={{ left: point.x, top: point.y - 8 - shift, transform: 'translate(-50%, -100%)' }} onMouseDown={keepFocus}>
    {MARK_BUTTONS.map((entry) => <button key={entry.mark} type="button" className="se-tool" aria-pressed={selection.marks[entry.mark] === 'all' ? true : selection.marks[entry.mark] === 'some' ? 'mixed' : false}
      aria-label={labels[entry.label]} title={`${labels[entry.label]}${hint(interaction, entry.shortcut)}`} onClick={() => interaction.format.toggle(entry.mark)}>{entry.glyph}</button>)}
    <button type="button" className="se-tool" aria-pressed={selection.highlight !== null && selection.highlight !== 'mixed' ? true : selection.highlight === 'mixed' ? 'mixed' : false} aria-haspopup="true" aria-expanded={colors}
      aria-label={labels.highlight} title={`${labels.highlight}${hint(interaction, 'text.highlight')}`} onClick={() => setColors((open) => !open)}><span className="se-tool-highlight" aria-hidden="true">A</span></button>
    <button type="button" className="se-tool" aria-pressed={selection.link !== null} aria-label={labels.link} title={`${labels.link}${hint(interaction, 'text.link')}`} onClick={() => interaction.format.openLink()}>
      <span aria-hidden="true">{'\u{1F517}︎'}</span></button>
    {colors ? <div className="se-swatches" role="group" aria-label={labels.highlight}>
      {HIGHLIGHTS.map((color: Highlight) => <button key={color} type="button" className="se-swatch" data-highlight={color} aria-label={labels.highlightColor(color)} aria-pressed={selection.highlight === color}
        onClick={() => { interaction.format.highlight(color); setColors(false); }} />)}
      <button type="button" className="se-swatch se-swatch-none" aria-label={labels.clearHighlight} onClick={() => { interaction.format.highlight(null); setColors(false); }}><span aria-hidden="true">{'×'}</span></button>
    </div> : null}
  </div>;
}

/** The link popover: https validation with an inline message, apply, remove and cancel. */
export function LinkEditor({ interaction: explicit }: { interaction?: Interaction }): ReactNode {
  const interaction = useInteraction(explicit);
  const prompt = useInteractionState(interaction, (state) => state.prompt);
  const link = prompt && prompt.kind === 'link' ? prompt : null;
  const point = useSelectionAnchor(!!link, link?.blockId ?? null, link?.field ?? null);
  const ref = useRef<HTMLDivElement>(null);
  const shift = useKeepInViewport(ref, !!link);
  if (!link || !point) return null;
  return <LinkForm key={`${link.blockId}:${link.field}:${link.start}:${link.end}`} interaction={interaction} link={link} popupRef={ref} left={point.x} top={point.y - 8 - shift} />;
}
function LinkForm({ interaction, link, popupRef, left, top }: { interaction: Interaction; link: Extract<NonNullable<InteractionState['prompt']>, { kind: 'link' }>; popupRef: RefObject<HTMLDivElement | null>; left: number; top: number }): ReactNode {
  const labels = useInteractionLabels();
  const [text, setText] = useState(link.href);
  const refocus = (): void => { interaction.edit.start(link.blockId, { field: link.field, caret: link.end }); };
  const submit = (event: FormEvent): void => { event.preventDefault(); if (interaction.format.applyLink(text)) refocus(); };
  return <div ref={popupRef} className="se-popup se-link-editor" data-se-popup role="dialog" aria-label={labels.linkDialog} style={{ left, top, transform: 'translate(-50%, -100%)' }}
    onKeyDown={(event) => { if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); interaction.format.closePrompt(); refocus(); } }}>
    <form onSubmit={submit}>
      <label className="se-field"><span className="se-field-label">{labels.linkUrl}</span>
        <input autoFocus type="text" inputMode="url" autoComplete="off" spellCheck={false} value={text} aria-invalid={link.error ? true : undefined} aria-describedby={link.error ? `${interaction.id}-link-error` : undefined}
          placeholder="https://example.com" onChange={(event) => setText(event.target.value)} /></label>
      {link.error ? <p id={`${interaction.id}-link-error`} className="se-field-error" role="alert">{link.error}</p> : null}
      <div className="se-popup-actions">
        <button type="submit" className="se-button se-button-primary">{labels.linkApply}</button>
        {link.href && !link.error ? <button type="button" className="se-button" onClick={() => { if (interaction.format.applyLink('')) refocus(); }}>{labels.linkRemove}</button> : null}
        <button type="button" className="se-button" onClick={() => { interaction.format.closePrompt(); refocus(); }}>{labels.cancel}</button>
      </div>
    </form>
  </div>;
}

/** Asks for the https address an image or embed needs before it can be inserted. */
export function UrlPrompt({ interaction: explicit }: { interaction?: Interaction }): ReactNode {
  const interaction = useInteraction(explicit), labels = useInteractionLabels();
  const prompt = useInteractionState(interaction, (state) => state.prompt);
  const url = prompt && prompt.kind === 'url' ? prompt : null;
  const rect = useBlockRect(url?.blockId ?? null);
  const [text, setText] = useState('');
  if (!url || !rect) return null;
  return <div className="se-popup se-link-editor" data-se-popup role="dialog" aria-label={url.item.input?.label ?? labels.urlDialog} style={{ left: rect.left, top: rect.bottom + 4 }}
    onKeyDown={(event) => { if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); interaction.format.closePrompt(); } }}>
    <form onSubmit={(event) => { event.preventDefault(); if (interaction.slash.submitInput(text)) setText(''); }}>
      <label className="se-field"><span className="se-field-label">{url.item.input?.label ?? labels.urlDialog}</span>
        <input autoFocus type="text" inputMode="url" autoComplete="off" spellCheck={false} value={text} placeholder={url.item.input?.placeholder} aria-invalid={url.error ? true : undefined}
          onChange={(event) => setText(event.target.value)} /></label>
      {url.error ? <p className="se-field-error" role="alert">{url.error}</p> : null}
      <div className="se-popup-actions"><button type="submit" className="se-button se-button-primary">{labels.urlInsert}</button><button type="button" className="se-button" onClick={() => interaction.format.closePrompt()}>{labels.cancel}</button></div>
    </form>
  </div>;
}

/** Appears over a block selection: how many blocks, plus duplicate, move, turn into, copy, delete and clear. */
export function SelectionToolbar({ interaction: explicit }: { interaction?: Interaction }): ReactNode {
  const interaction = useInteraction(explicit), labels = useInteractionLabels();
  const ids = useInteractionState(interaction, (state) => state.selection.ids, (a, b) => a === b);
  const hidden = useInteractionState(interaction, (state) => state.editing !== null || state.drag !== null || state.menu !== null || state.readOnly);
  useDocumentRevision(interaction);
  const document = interaction.editor.getSnapshot();
  const roots = blockRoots(document, ids);
  const rect = useBlockRect(!hidden ? roots[0] ?? null : null);
  const ref = useRef<HTMLDivElement>(null);
  if (hidden || !roots.length || !rect) return null;
  const blocks = roots.map((id) => document.blocks.find((block) => block.id === id)!).filter(Boolean);
  const targets = TURN_INTO_TARGETS.filter((entry) => blocks.every((block) => canTurnInto(block.content, entry.id, document.blocks.some((child) => child.parentId === block.id))));
  const top = rect.top - 44 < 0 ? rect.bottom + 6 : rect.top - 44;
  const action = (label: string, glyph: string, run: () => void, danger = false): ReactNode => <button type="button" className={`se-tool${danger ? ' se-tool-danger' : ''}`} aria-label={label} title={label} onClick={run}><span aria-hidden="true">{glyph}</span></button>;
  return <div ref={ref} className="se-popup se-toolbar se-selection-toolbar" data-se-popup role="toolbar" aria-label={labels.selectionToolbar} style={{ left: rect.left, top }}>
    <span className="se-toolbar-count" role="status">{labels.blocksSelected(roots.length)}</span>
    {targets.length ? <select className="se-turn-into" aria-label={labels.turnInto} value="" onChange={(event) => { if (event.target.value) interaction.commands.turnInto(event.target.value as TurnIntoTarget, roots); }}>
      <option value="">{labels.turnInto}</option>{targets.map((entry) => <option key={entry.id} value={entry.id}>{entry.label}</option>)}
    </select> : null}
    {action(labels.moveUp, '↑', () => interaction.commands.moveStep('up', roots))}
    {action(labels.moveDown, '↓', () => interaction.commands.moveStep('down', roots))}
    {action(labels.duplicate, '⧉', () => interaction.commands.duplicateBlocks(roots))}
    {action(labels.copy, '⎘', () => { void interaction.clipboard.copyToSystem(roots); })}
    {action(labels.delete, '✕', () => interaction.commands.deleteBlocks(roots), true)}
    {action(labels.clearSelection, '×', () => interaction.selection.clear())}
  </div>;
}
