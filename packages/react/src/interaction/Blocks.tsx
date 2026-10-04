import { createElement, useRef } from 'react';
import type { CSSProperties, ReactNode } from 'react';
import type { Block, BlockContent } from '@super-solution/editor-core';
import { TONE_ICONS, attachEditable, cellField, itemField, listChecked, listIndent, parseField } from '@super-solution/editor-ui';
import type { FieldKey, Interaction } from '@super-solution/editor-ui';
import { useInteraction, useInteractionLabels, useInteractionState } from './context.js';
import { keepFocus, useIsoLayoutEffect } from './util.js';

type ListContent = Extract<BlockContent, { type: 'list' }>;
type TableContent = Extract<BlockContent, { type: 'table' }>;

/**
 * One editable text field. React renders only the empty element: its contents belong to the DOM binding (attachEditable),
 * which keeps the caret, marks and IME composition intact between renders.
 */
export type EditableFieldProps = {
  blockId: string; field: FieldKey; mode: 'rich' | 'plain'; tag?: string; className?: string; placeholder?: string; label?: string; style?: CSSProperties; id?: string;
  /** Show the placeholder even when the field is not focused. */
  alwaysPlaceholder?: boolean;
};
export function EditableField({ blockId, field, mode, tag = 'div', className, placeholder, label, style, id, alwaysPlaceholder }: EditableFieldProps): ReactNode {
  const interaction = useInteraction(), ref = useRef<HTMLElement>(null);
  useIsoLayoutEffect(() => {
    const element = ref.current;
    if (!element) return;
    const binding = attachEditable(element, {
      interaction, blockId, field, mode, ...(placeholder ? { placeholder } : {}), ...(label ? { label } : {}),
      citationLabel: (citationId) => String(interaction.editor.getSnapshot().citations.findIndex((citation) => citation.id === citationId) + 1),
    });
    return () => binding.destroy();
  }, [interaction, blockId, field, mode, placeholder, label]);
  return createElement(tag, { ref, id, className: `se-editable${alwaysPlaceholder ? ' se-placeholder-always' : ''}${className ? ` ${className}` : ''}`, style, suppressContentEditableWarning: true });
}

/** Content the user currently sees: the draft while they type, the document otherwise. Re-renders when a re-sync is requested. */
function useVisibleContent(interaction: Interaction, block: Block): BlockContent {
  useInteractionState(interaction, (state) => state.sync?.seq ?? 0);
  return interaction.edit.draftContent(block.id) ?? block.content;
}

/**
 * The toggle's own row: a disclosure button (the open state is saved in the document) and a title that is edited in place.
 * Its nested blocks are drawn by the document view right after this row and hidden by CSS while the toggle is closed.
 */
function ToggleHead({ block, editing }: { block: Block; editing: boolean }): ReactNode {
  const interaction = useInteraction(), labels = useInteractionLabels();
  const readOnly = useInteractionState(interaction, (state) => state.readOnly);
  const content = useVisibleContent(interaction, block);
  if (content.type !== 'toggle') return null;
  return <div className="se-toggle-head" data-open={String(content.open)}>
    <button type="button" className="se-toggle-handle" data-se-no-edit aria-expanded={content.open} aria-label={content.open ? labels.toggleClose : labels.toggleOpen} disabled={readOnly}
      onMouseDown={keepFocus} onClick={() => interaction.commands.setOpen(block.id, !content.open)}><span className="se-toggle-caret" aria-hidden="true">{'▸'}</span></button>
    {editing ? <EditableField blockId={block.id} field="main" mode="plain" tag="span" className="se-toggle-name" placeholder={labels.placeholderToggle} alwaysPlaceholder />
      : <span className="se-toggle-name" tabIndex={readOnly ? undefined : 0}
        // Tabbing onto the title (but not clicking it) starts editing, so keyboard users get the same path as the mouse.
        onFocus={(event) => { let visible = false; try { visible = event.currentTarget.matches(':focus-visible'); } catch { /* unsupported selector */ } if (visible && !readOnly) interaction.edit.start(block.id, { caret: 'end' }); }}>
        {content.title || <span className="se-placeholder">{labels.placeholderToggle}</span>}</span>}
  </div>;
}

function EditableList({ block, content }: { block: Block; content: ListContent }): ReactNode {
  const interaction = useInteraction(), labels = useInteractionLabels();
  const indent = listIndent(content), checked = listChecked(content), todo = content.style === 'todo';
  const style = todo ? 'todo' : content.ordered ? 'number' : 'bullet';
  const items = content.items.map((item, index) => <li key={index} className={todo ? 'se-todo-item' : undefined} data-checked={todo ? String(checked[index]) : undefined} style={indent[index] ? { marginLeft: `${indent[index]! * 1.5}rem` } : undefined}>
    {todo ? <span className="se-todo-label">
      <input className="se-todo-box" type="checkbox" checked={checked[index]} aria-label={labels.toggleTodo(item)} onMouseDown={keepFocus} onChange={(event) => interaction.commands.setChecked(block.id, index, event.target.checked)} />
      <EditableField blockId={block.id} field={itemField(index)} mode="plain" tag="span" className="se-todo-text" placeholder={labels.placeholderListItem} alwaysPlaceholder={content.items.length === 1} />
    </span> : <EditableField blockId={block.id} field={itemField(index)} mode="plain" tag="span" className="se-list-text" placeholder={labels.placeholderListItem} alwaysPlaceholder={content.items.length === 1} />}
  </li>);
  return content.ordered ? <ol className={`se-list se-list-${style}`}>{items}</ol> : <ul className={`se-list se-list-${style}`}>{items}</ul>;
}

function TableToolbar({ block, content }: { block: Block; content: TableContent }): ReactNode {
  const interaction = useInteraction(), labels = useInteractionLabels();
  const field = useInteractionState(interaction, (state) => state.editing?.blockId === block.id ? state.editing.field : null);
  const cell = field ? parseField(field) : null, current = cell && cell.kind === 'cell' ? cell : { row: content.rows.length - 1, col: content.columns.length - 1 };
  const run = (label: string, glyph: string, action: () => void, disabled = false): ReactNode => <button type="button" className="se-tool" aria-label={label} title={label} disabled={disabled} onClick={action}><span aria-hidden="true">{glyph}</span></button>;
  return <div className="se-toolbar se-table-toolbar" data-se-popup role="toolbar" aria-label={labels.tableToolbar} onMouseDown={keepFocus}>
    {run(labels.addRow, '☰+', () => interaction.commands.table.addRow(block.id, current.row + 1))}
    {run(labels.addColumn, '║+', () => interaction.commands.table.addColumn(block.id, current.col + 1))}
    {run(labels.removeRow, '☰−', () => interaction.commands.table.removeRow(block.id, current.row), current.row < 0 || content.rows.length === 0)}
    {run(labels.removeColumn, '║−', () => interaction.commands.table.removeColumn(block.id, current.col), content.columns.length <= 1)}
    {run(labels.alignLeft, '⭰', () => interaction.commands.table.setAlign(block.id, current.col, 'left'))}
    {run(labels.alignCenter, '≡', () => interaction.commands.table.setAlign(block.id, current.col, 'center'))}
    {run(labels.alignRight, '⭲', () => interaction.commands.table.setAlign(block.id, current.col, 'right'))}
  </div>;
}
function EditableTable({ block, content }: { block: Block; content: TableContent }): ReactNode {
  const labels = useInteractionLabels();
  const align = (col: number): string => `se-align-${content.align?.[col] ?? 'left'}`;
  return <div className="se-table-edit">
    <TableToolbar block={block} content={content} />
    <div className="se-table-wrap">
      <table className="se-table">
        {content.caption ? <caption>{content.caption}</caption> : null}
        <thead><tr>{content.columns.map((_column, col) => <th key={col} scope="col" className={align(col)}><EditableField blockId={block.id} field={cellField(-1, col)} mode="plain" tag="div" className="se-cell" placeholder={labels.placeholderCell} /></th>)}</tr></thead>
        <tbody>{content.rows.map((row, r) => <tr key={r}>{row.map((_cell, col) => <td key={col} className={align(col)}><EditableField blockId={block.id} field={cellField(r, col)} mode="plain" tag="div" className="se-cell" placeholder={labels.placeholderCell} /></td>)}</tr>)}</tbody>
      </table>
    </div>
  </div>;
}

function CodeEditable({ block, content }: { block: Block; content: Extract<BlockContent, { type: 'code' }> }): ReactNode {
  const interaction = useInteraction(), labels = useInteractionLabels();
  return <div className="se-code">
    <div className="se-code-bar">
      <input key={content.language} className="se-code-language-input" data-se-no-edit aria-label={labels.codeLanguage} defaultValue={content.language} placeholder="language" spellCheck={false} maxLength={40}
        onBlur={(event) => { if (event.target.value !== content.language) interaction.commands.setCodeLanguage(block.id, event.target.value); }}
        onKeyDown={(event) => { if (event.key === 'Enter') { event.preventDefault(); (event.target as HTMLInputElement).blur(); } }} />
    </div>
    <pre><EditableField blockId={block.id} field="main" mode="plain" tag="code" className="se-code-text" placeholder={labels.placeholderCode} /></pre>
  </div>;
}

/** The in-place editing view of a block. It reuses the class names of the normal view, so a block looks the same while it is edited. */
export function EditableBlock({ block }: { block: Block }): ReactNode {
  const interaction = useInteraction(), labels = useInteractionLabels();
  const content = useVisibleContent(interaction, block);
  switch (content.type) {
    case 'paragraph': return <EditableField blockId={block.id} field="main" mode="rich" tag="p" className="se-paragraph" placeholder={labels.placeholderParagraph} />;
    case 'heading': return <EditableField blockId={block.id} field="main" mode="plain" tag={content.level === 1 ? 'h1' : content.level === 2 ? 'h2' : 'h3'} className="se-heading" placeholder={`${labels.placeholderHeading} ${content.level}`} alwaysPlaceholder />;
    case 'section': return <EditableField blockId={block.id} field="main" mode="plain" tag="h2" id={`${block.id}-title`} className="se-section-title" placeholder={labels.placeholderSection} alwaysPlaceholder />;
    case 'quote': return <blockquote className="se-quote">
      <EditableField blockId={block.id} field="main" mode="rich" tag="p" placeholder={labels.placeholderQuote} alwaysPlaceholder />
      {content.attribution ? <footer>{'— '}<cite>{content.attribution}</cite></footer> : null}
    </blockquote>;
    case 'callout': return <div className="se-callout" data-tone={content.tone} role="note">
      <svg className="se-callout-icon" viewBox="0 0 16 16" width={16} height={16} fill="none" stroke="currentColor" strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d={TONE_ICONS[content.tone]} /></svg>
      <div className="se-callout-body">
        {content.title ? <strong className="se-callout-title">{content.title}</strong> : null}
        <EditableField blockId={block.id} field="main" mode="rich" tag="p" placeholder={labels.placeholderCallout} alwaysPlaceholder />
      </div>
    </div>;
    case 'code': return <CodeEditable block={block} content={content} />;
    case 'list': return <EditableList block={block} content={content} />;
    case 'table': return <EditableTable block={block} content={content} />;
    case 'toggle': return <ToggleHead block={block} editing />;
    default: return null;
  }
}

/** Decides, per block, between the host's normal view and the editing view. Subscribes to the interaction itself, so it is correct even when the document view memoizes block elements. */
export function BlockSlot({ block, view }: { block: Block; view: () => ReactNode }): ReactNode {
  const interaction = useInteraction();
  const editing = useInteractionState(interaction, (state) => state.editing?.blockId === block.id && !state.readOnly);
  if (block.content.type === 'toggle') return <ToggleHead block={block} editing={editing} />;
  if (editing) return <EditableBlock block={block} />;
  return <>{view()}</>;
}
