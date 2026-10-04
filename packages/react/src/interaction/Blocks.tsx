import { createElement, useRef } from 'react';
import type { CSSProperties, ReactNode } from 'react';
import type { Block, BlockContent } from '@super-solution/editor-core';
import { attachEditable, cellField, itemField, listChecked, listIndent, parseField } from '@super-solution/editor-ui';
import type { FieldKey, Interaction } from '@super-solution/editor-ui';
import { useInteraction, useInteractionState, useLabels } from './context.js';
import { keepFocus, useIsoLayoutEffect } from './util.js';

type ListContent = Extract<BlockContent, { type: 'list' }>;
type TableContent = Extract<BlockContent, { type: 'table' }>;

/**
 * One editable text field. React renders only the empty element: its contents belong to the DOM binding (attachEditable),
 * which keeps the caret, marks and IME composition intact between renders.
 */
export type EditableFieldProps = {
  blockId: string; field: FieldKey; mode: 'rich' | 'plain'; tag?: string; className?: string; placeholder?: string; label?: string; style?: CSSProperties;
  /** Show the placeholder even when the field is not focused. */
  alwaysPlaceholder?: boolean;
};
export function EditableField({ blockId, field, mode, tag = 'div', className, placeholder, label, style, alwaysPlaceholder }: EditableFieldProps): ReactNode {
  const interaction = useInteraction(), ref = useRef<HTMLElement>(null);
  useIsoLayoutEffect(() => {
    const element = ref.current;
    if (!element) return;
    const binding = attachEditable(element, {
      interaction, blockId, field, mode, ...(placeholder ? { placeholder } : {}), ...(label ? { label } : {}),
      citationLabel: (id) => String(interaction.editor.getSnapshot().citations.findIndex((citation) => citation.id === id) + 1),
    });
    return () => binding.destroy();
  }, [interaction, blockId, field, mode, placeholder, label]);
  return createElement(tag, { ref, className: `se-editable${alwaysPlaceholder ? ' se-placeholder-always' : ''}${className ? ` ${className}` : ''}`, style, suppressContentEditableWarning: true });
}

/** Content the user currently sees: the draft while they type, the document otherwise. Re-renders when a re-sync is requested. */
function useVisibleContent(interaction: Interaction, block: Block): BlockContent {
  useInteractionState(interaction, (state) => state.sync?.seq ?? 0);
  return interaction.edit.draftContent(block.id) ?? block.content;
}

function ToggleHead({ block, editing }: { block: Block; editing: boolean }): ReactNode {
  const interaction = useInteraction(), labels = useLabels();
  const readOnly = useInteractionState(interaction, (state) => state.readOnly);
  const content = useVisibleContent(interaction, block);
  if (content.type !== 'toggle') return null;
  return <div className="se-toggle-head" data-open={String(content.open)}>
    <button type="button" className="se-toggle-button" data-se-no-edit aria-expanded={content.open} aria-label={content.open ? labels.toggleClose : labels.toggleOpen} disabled={readOnly}
      onMouseDown={keepFocus} onClick={() => interaction.commands.setOpen(block.id, !content.open)}><span aria-hidden="true">{content.open ? '▾' : '▸'}</span></button>
    {editing ? <EditableField blockId={block.id} field="main" mode="plain" tag="span" className="se-toggle-title" placeholder={labels.placeholderToggle} alwaysPlaceholder />
      : <span className="se-toggle-title" tabIndex={readOnly ? undefined : 0}
        // Tabbing onto the title (but not clicking it) starts editing, so keyboard users get the same path as the mouse.
        onFocus={(event) => { let visible = false; try { visible = event.currentTarget.matches(':focus-visible'); } catch { /* unsupported selector */ } if (visible && !readOnly) interaction.edit.start(block.id, { caret: 'end' }); }}>
        {content.title || <span className="se-placeholder">{labels.placeholderToggle}</span>}</span>}
  </div>;
}

/** Checklist that works without entering edit mode: ticking a box is a guarded update. */
export function TodoListView({ block }: { block: Block }): ReactNode {
  const interaction = useInteraction(), labels = useLabels();
  const readOnly = useInteractionState(interaction, (state) => state.readOnly);
  const content = block.content;
  if (content.type !== 'list' || content.style !== 'todo') return null;
  const checked = listChecked(content), indent = listIndent(content);
  return <ul className="se-todo-list" role="list">
    {content.items.map((item, index) => <li key={index} className="se-todo-item" data-checked={String(checked[index])} style={indent[index] ? { marginLeft: `${indent[index]! * 1.5}rem` } : undefined}>
      <input type="checkbox" checked={checked[index]} disabled={readOnly} aria-label={labels.toggleTodo(item)} onChange={(event) => interaction.commands.setChecked(block.id, index, event.target.checked)} />
      <span className="se-todo-text">{item}</span>
    </li>)}
  </ul>;
}

function EditableList({ block, content }: { block: Block; content: ListContent }): ReactNode {
  const interaction = useInteraction(), labels = useLabels();
  const indent = listIndent(content), checked = listChecked(content), todo = content.style === 'todo';
  const items = content.items.map((_item, index) => <li key={index} className={todo ? 'se-todo-item' : undefined} data-checked={todo ? String(checked[index]) : undefined} style={indent[index] ? { marginLeft: `${indent[index]! * 1.5}rem` } : undefined}>
    {todo ? <input type="checkbox" checked={checked[index]} aria-label={labels.toggleTodo(content.items[index] ?? '')} onMouseDown={keepFocus} onChange={(event) => interaction.commands.setChecked(block.id, index, event.target.checked)} /> : null}
    <EditableField blockId={block.id} field={itemField(index)} mode="plain" tag="span" className="se-list-text" placeholder={labels.placeholderListItem} alwaysPlaceholder={content.items.length === 1} />
  </li>);
  return content.ordered ? <ol className="se-list-edit" data-style="number">{items}</ol> : <ul className={`se-list-edit${todo ? ' se-todo-list' : ''}`} data-style={todo ? 'todo' : 'bullet'} role="list">{items}</ul>;
}

function TableToolbar({ block, content }: { block: Block; content: TableContent }): ReactNode {
  const interaction = useInteraction(), labels = useLabels();
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
  const labels = useLabels();
  const align = (col: number): CSSProperties | undefined => content.align?.[col] ? { textAlign: content.align[col] } : undefined;
  return <div className="se-table-edit">
    <TableToolbar block={block} content={content} />
    <table>
      {content.caption ? <caption>{content.caption}</caption> : null}
      <thead><tr>{content.columns.map((_column, col) => <th key={col} scope="col" style={align(col)}><EditableField blockId={block.id} field={cellField(-1, col)} mode="plain" tag="div" className="se-cell" placeholder={labels.placeholderCell} /></th>)}</tr></thead>
      <tbody>{content.rows.map((row, r) => <tr key={r}>{row.map((_cell, col) => <td key={col} style={align(col)}><EditableField blockId={block.id} field={cellField(r, col)} mode="plain" tag="div" className="se-cell" placeholder={labels.placeholderCell} /></td>)}</tr>)}</tbody>
    </table>
  </div>;
}

function CodeEditable({ block, content }: { block: Block; content: Extract<BlockContent, { type: 'code' }> }): ReactNode {
  const interaction = useInteraction(), labels = useLabels();
  return <div className="se-code-edit">
    <input key={content.language} className="se-code-language" data-se-no-edit aria-label={labels.codeLanguage} defaultValue={content.language} placeholder="language" spellCheck={false} maxLength={40}
      onBlur={(event) => { if (event.target.value !== content.language) interaction.commands.setCodeLanguage(block.id, event.target.value); }}
      onKeyDown={(event) => { if (event.key === 'Enter') { event.preventDefault(); (event.target as HTMLInputElement).blur(); } }} />
    <pre><EditableField blockId={block.id} field="main" mode="plain" tag="code" className="se-code-text" placeholder={labels.placeholderCode} /></pre>
  </div>;
}

/** The in-place editing view of a block. Rendered instead of the normal view while the block is being edited. */
export function EditableBlock({ block }: { block: Block }): ReactNode {
  const interaction = useInteraction(), labels = useLabels();
  const content = useVisibleContent(interaction, block);
  switch (content.type) {
    case 'paragraph': return <EditableField blockId={block.id} field="main" mode="rich" tag="p" className="se-paragraph" placeholder={labels.placeholderParagraph} />;
    case 'heading': return <EditableField blockId={block.id} field="main" mode="plain" tag={content.level === 1 ? 'h1' : content.level === 2 ? 'h2' : 'h3'} className="se-heading" placeholder={`${labels.placeholderHeading} ${content.level}`} alwaysPlaceholder />;
    case 'section': return <EditableField blockId={block.id} field="main" mode="plain" tag="h2" className="se-heading" placeholder={labels.placeholderSection} alwaysPlaceholder />;
    case 'quote': return <><EditableField blockId={block.id} field="main" mode="rich" tag="blockquote" className="se-quote" placeholder={labels.placeholderQuote} alwaysPlaceholder />{content.attribution ? <cite>{content.attribution}</cite> : null}</>;
    case 'callout': return <aside data-tone={content.tone} className="se-callout-edit">{content.title ? <strong>{content.title}</strong> : null}<EditableField blockId={block.id} field="main" mode="rich" tag="p" className="se-paragraph" placeholder={labels.placeholderCallout} alwaysPlaceholder /></aside>;
    case 'code': return <CodeEditable block={block} content={content} />;
    case 'list': return <EditableList block={block} content={content} />;
    case 'table': return <EditableTable block={block} content={content} />;
    case 'toggle': return <ToggleHead block={block} editing />;
    default: return null;
  }
}

/** Decides, per block, between the host's normal view and the editing view. Subscribes to the interaction itself, so it is correct even when a parent memoizes block elements. */
export function BlockSlot({ block, view, keepHostList }: { block: Block; view: () => ReactNode; keepHostList: boolean }): ReactNode {
  const interaction = useInteraction();
  const editing = useInteractionState(interaction, (state) => state.editing?.blockId === block.id && !state.readOnly);
  if (block.content.type === 'toggle') return <ToggleHead block={block} editing={editing} />;
  if (editing) return <EditableBlock block={block} />;
  if (block.content.type === 'list' && block.content.style === 'todo' && !keepHostList) return <TodoListView block={block} />;
  return <>{view()}</>;
}
