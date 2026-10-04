import { useState, useSyncExternalStore } from 'react';
import type { ReactNode } from 'react';
import { safeUrl } from '@super-solution/editor-core';
import type { Actor, ApplyResult, Block, BlockContent, ChartSpec, Editor, InlineRun, Operation, ResearchDocument } from '@super-solution/editor-core';
import { allowedEmbedUrl, contentWithText, editableText, getChartModel, localId } from '@super-solution/editor-ui';
import type { EmbedPolicy, Interaction } from '@super-solution/editor-ui';
import { InteractiveReportEditor } from './interaction/ReportEditor.js';
import type { InteractionProps } from './interaction/ReportEditor.js';

export function useEditor(editor: Editor): ResearchDocument {
  return useSyncExternalStore(editor.subscribe, editor.getSnapshot, editor.getSnapshot);
}

export type ReactRenderContext = {
  report: ResearchDocument; options: ReportViewProps;
  renderDefaultBlock(block: Block): ReactNode;
};
export type ReactBlockRenderer = (block: Block, context: ReactRenderContext) => ReactNode;
export type ReactChartRenderer = (spec: ChartSpec, context: ReactRenderContext) => ReactNode;
export type ReportViewProps = {
  document: ResearchDocument;
  className?: string;
  blockRenderers?: Partial<Record<BlockContent['type'], ReactBlockRenderer>>;
  chartRenderers?: Record<string, ReactChartRenderer>;
  embedPolicy?: EmbedPolicy;
  renderBlockActions?: (block: Block) => ReactNode;
};

function SafeLink({ url, children }: { url: string; children: ReactNode }): ReactNode {
  const safe = safeUrl(url);
  return safe ? <a href={safe} target="_blank" rel="noopener noreferrer">{children}</a> : <span>{children} (unsafe URL omitted)</span>;
}

export function ChartView({ spec }: { spec: ChartSpec }): ReactNode {
  const model = getChartModel(spec);
  return <figure className="super-editor-chart">
    <figcaption>{spec.title}</figcaption>
    {model.message ? <p>{model.message}</p> : null}
    {model.shapes.length ? <svg viewBox="0 0 640 280" role="img" aria-label={`${spec.title}. ${spec.kind} chart; exact values in the following table.`}>
      <title>{spec.title}</title>
      {model.shapes.map((shape, index) => {
        // Geometry comes exclusively from typed finite numeric data, never report-provided HTML.
        const attributes = Object.fromEntries(Object.entries(shape.attributes).map(([key, value]) => [key === 'stroke-width' ? 'strokeWidth' : key, value]));
        switch (shape.tag) {
          case 'rect': return <rect key={index} {...attributes} />;
          case 'path': return <path key={index} {...attributes} />;
          case 'polyline': return <polyline key={index} {...attributes} />;
          case 'circle': return <circle key={index} {...attributes} />;
          case 'line': return <line key={index} {...attributes} />;
        }
      })}
    </svg> : null}
    {spec.kind === 'pie' && spec.series.length > 1 ? <p>Pie displays {spec.series[0]!.name}; all series appear in the table.</p> : null}
    <table>
      <caption>{spec.title}{spec.unit ? ` (${spec.unit})` : ''} — data</caption>
      <thead><tr><th scope="col">Label</th>{spec.series.map((series, index) => <th scope="col" key={index}>{series.name}</th>)}</tr></thead>
      <tbody>{spec.labels.map((label, index) => <tr key={index}><th scope="row">{label}</th>{spec.series.map((series, seriesIndex) => <td key={seriesIndex}>{series.values[index] ?? ''}</td>)}</tr>)}</tbody>
    </table>
    {spec.asOf ? <time dateTime={spec.asOf}>As of: {spec.asOf}</time> : null}
  </figure>;
}

function Runs({ runs, report }: { runs: readonly InlineRun[]; report: ResearchDocument }): ReactNode {
  return <>{runs.map((run, index) => {
    let node: ReactNode = run.text;
    if (run.code) node = <code>{node}</code>;
    if (run.italic) node = <em>{node}</em>;
    if (run.bold) node = <strong>{node}</strong>;
    // v0.2 fallback; full renderer in SE2b
    if (run.strike) node = <s>{node}</s>;
    if (run.underline) node = <u>{node}</u>;
    if (run.highlight) node = <mark data-highlight={run.highlight}>{node}</mark>;
    if (run.href) node = <SafeLink url={run.href}>{node}</SafeLink>;
    return <span key={index}>{node}{run.citationId ? <sup data-citation-id={run.citationId}>[{report.citations.findIndex((citation) => citation.id === run.citationId) + 1}]</sup> : null}</span>;
  })}</>;
}

export function DefaultBlockView({ block, context }: { block: Block; context: ReactRenderContext }): ReactNode {
  const { content } = block;
  switch (content.type) {
    case 'section': return <h2>{content.title}</h2>;
    case 'heading': return content.level === 1 ? <h1>{content.text}</h1> : content.level === 2 ? <h2>{content.text}</h2> : <h3>{content.text}</h3>;
    case 'paragraph': return <p><Runs runs={content.runs} report={context.report} /></p>;
    case 'list': {
      // v0.2 fallback; full renderer in SE2b: todo state is shown as a text prefix and indent is ignored.
      const items = content.items.map((item, index) => <li key={index}>{content.style === 'todo' ? `${content.checked?.[index] ? '☑' : '☐'} ${item}` : item}</li>);
      return content.ordered ? <ol>{items}</ol> : <ul>{items}</ul>;
    }
    case 'table': return <table>{content.caption ? <caption>{content.caption}</caption> : null}<thead><tr>{content.columns.map((column, index) => <th scope="col" key={index} style={content.align?.[index] ? { textAlign: content.align[index] } : undefined}>{column}</th>)}</tr></thead><tbody>{content.rows.map((row, index) => <tr key={index}>{row.map((cell, column) => <td key={column} style={content.align?.[column] ? { textAlign: content.align[column] } : undefined}>{cell}</td>)}</tr>)}</tbody></table>;
    case 'chart': {
      const registry = context.options.chartRenderers;
      const renderer = registry && Object.hasOwn(registry, content.spec.kind) ? registry[content.spec.kind] : undefined;
      return renderer?.(content.spec, context) ?? <ChartView spec={content.spec} />;
    }
    case 'embed': {
      const url = allowedEmbedUrl(content.url, context.options.embedPolicy);
      return <figure className="super-editor-embed"><SafeLink url={content.url}>{content.title}</SafeLink>{url ? <iframe src={url} title={content.title} sandbox="allow-scripts" referrerPolicy="no-referrer" loading="lazy" /> : null}</figure>;
    }
    case 'timestamp': return <time dateTime={content.at}>{content.label}: {content.at}</time>;
    // v0.2 fallback; full renderer in SE2b. Everything below is deliberately plain.
    case 'quote': return <blockquote><Runs runs={content.runs} report={context.report} />{content.attribution ? <cite>{content.attribution}</cite> : null}</blockquote>;
    case 'callout': return <aside data-tone={content.tone}>{content.title ? <strong>{content.title}</strong> : null}<p><Runs runs={content.runs} report={context.report} /></p></aside>;
    case 'code': return <pre><code data-language={content.language || undefined}>{content.text}</code></pre>;
    case 'divider': return <hr />;
    case 'image': return <figure className="super-editor-image"><SafeLink url={content.url}>{content.alt || content.url}</SafeLink>{content.caption ? <figcaption>{content.caption}</figcaption> : null}</figure>;
    case 'toggle': return <p>▸ {content.title}</p>;
    case 'metrics': return <ul>{content.items.map((item, index) => <li key={index}>{item.label}: {item.value}</li>)}</ul>;
    case 'toc': return <nav aria-label="Table of contents"><ol>{context.report.blocks.flatMap((entry) => entry.content.type === 'heading' ? [<li key={entry.id}>{entry.content.text}</li>] : entry.content.type === 'section' ? [<li key={entry.id}>{entry.content.title}</li>] : [])}</ol></nav>;
    case 'pageBreak': return <hr className="super-editor-page-break" />;
  }
}

export function ReportView(props: ReportViewProps): ReactNode {
  const report = props.document;
  const context: ReactRenderContext = { report, options: props, renderDefaultBlock: (block) => <DefaultBlockView block={block} context={context} /> };
  const children = new Map<string | null, Block[]>();
  report.blocks.forEach((block) => { const siblings = children.get(block.parentId) ?? []; siblings.push(block); children.set(block.parentId, siblings); });
  const visited = new Set<string>();
  const renderBlock = (block: Block): ReactNode => {
    if (visited.has(block.id)) return null;
    visited.add(block.id);
    const content = <>
      {props.blockRenderers?.[block.content.type]?.(block, context) ?? <DefaultBlockView block={block} context={context} />}
      {block.citationIds.length ? <small className="super-editor-block-sources">Sources: {block.citationIds.map((id) => report.citations.find((citation) => citation.id === id)?.title ?? id).join('; ')}</small> : null}
      {props.renderBlockActions?.(block)}
      {(children.get(block.id) ?? []).map(renderBlock)}
    </>;
    return block.content.type === 'section' ? <section id={block.id} className="super-editor-block" data-block-id={block.id} data-block-type={block.content.type} key={block.id}>{content}</section> : <div id={block.id} className="super-editor-block" data-block-id={block.id} data-block-type={block.content.type} key={block.id}>{content}</div>;
  };
  const blocks = (children.get(null) ?? []).map(renderBlock);
  report.blocks.filter((block) => !visited.has(block.id)).forEach((block) => blocks.push(renderBlock(block)));
  return <article className={`super-editor-document${props.className ? ` ${props.className}` : ''}`} data-document-id={report.id} data-page={report.format.page} data-font={report.format.font} style={{ fontSize: report.format.fontSize, lineHeight: report.format.lineHeight }}>
    <h1>{report.title}</h1>
    <p className="super-editor-metadata">Revision {report.revision} · <time dateTime={report.updatedAt}>Updated: {report.updatedAt}</time></p>
    {blocks}
    {report.citations.length ? <section className="super-editor-citations" aria-label="Sources"><h2>Sources</h2><ol>{report.citations.map((citation) => <li key={citation.id} data-citation-id={citation.id}>
      <SafeLink url={citation.url}>{citation.title}</SafeLink>
      <small><time dateTime={citation.accessedAt}>Accessed: {citation.accessedAt}</time>{citation.publishedAt ? <> · <time dateTime={citation.publishedAt}>Published: {citation.publishedAt}</time></> : null}</small>
    </li>)}</ol></section> : null}
  </article>;
}

export type ReactControlsContext = { editor: Editor; report: ResearchDocument; actor: Actor; applyResult(result: ApplyResult): void; interaction?: Interaction };
export type ReportEditorProps = Omit<ReportViewProps, 'document' | 'renderBlockActions'> & InteractionProps & {
  editor: Editor; actor?: Actor;
  renderControls?: false | ((context: ReactControlsContext) => ReactNode);
};
type Draft = { text: string; baseRevision: number; version: number; block: Block };
const defaultActor: Actor = { id: 'local-human', kind: 'human' };

function DefaultControls({ editor, report, actor, applyResult }: ReactControlsContext): ReactNode {
  const [type, setType] = useState('paragraph'), [parent, setParent] = useState('');
  const apply = (operations: Operation[], baseRevision: number) => applyResult(editor.apply({ id: localId('human'), actor, baseRevision, operations }));
  const add = () => {
    const current = editor.getSnapshot(), siblings = current.blocks.filter((block) => block.parentId === (parent || null));
    const content: BlockContent = type === 'paragraph' ? { type: 'paragraph', runs: [{ text: 'New paragraph' }] } : type === 'section' ? { type: 'section', title: 'New section' } : { type: 'heading', level: type === 'heading3' ? 3 : 2, text: 'New heading' };
    apply([{ type: 'insertBlock', block: { id: localId('block'), parentId: parent || null, citationIds: [], content }, afterId: siblings.at(-1)?.id ?? null }], current.revision);
  };
  return <div className="super-editor-controls" role="toolbar" aria-label="Document controls">
    <button type="button" onClick={() => applyResult(editor.undo(actor, editor.getSnapshot().revision))}>Undo</button>
    <button type="button" onClick={() => applyResult(editor.redo(actor, editor.getSnapshot().revision))}>Redo</button>
    <select aria-label="New block type" value={type} onChange={(event) => setType(event.target.value)}><option value="paragraph">Paragraph</option><option value="heading2">Heading 2</option><option value="heading3">Heading 3</option><option value="section">Section</option></select>
    <select aria-label="New block section" value={parent} onChange={(event) => setParent(event.target.value)}><option value="">Document</option>{report.blocks.filter((block) => block.content.type === 'section').map((block) => <option key={block.id} value={block.id}>{(block.content as Extract<BlockContent, { type: 'section' }>).title}</option>)}</select>
    <button type="button" onClick={add}>Add block</button>
    <select aria-label="Document font" value={report.format.font} onChange={(event) => { const current = editor.getSnapshot(); apply([{ type: 'setFormat', format: { ...current.format, font: event.target.value as ResearchDocument['format']['font'] } }], current.revision); }}><option value="sans">sans</option><option value="serif">serif</option><option value="mono">mono</option></select>
    <select aria-label="Page format" value={report.format.page} onChange={(event) => { const current = editor.getSnapshot(); apply([{ type: 'setFormat', format: { ...current.format, page: event.target.value as ResearchDocument['format']['page'] } }], current.revision); }}><option value="screen">screen</option><option value="A4">A4</option><option value="letter">letter</option></select>
  </div>;
}

const editorKeys = new WeakMap<Editor, number>();
let nextEditorKey = 0;

/**
 * The editor. By default it composes the interaction layer (in-place editing, "/" menu, hover gutter, drag and drop, selection,
 * shortcuts, formatting toolbar, history); every part has an opt-out prop. `interaction={false}` restores the classic
 * "Edit" button per block with a plain-text draft.
 */
export function ReportEditor(props: ReportEditorProps): ReactNode {
  if (props.interaction === false) return <ClassicReportEditor {...props} />;
  return <InteractiveReportEditor {...props} />;
}
const INTERACTION_PROPS = ['interaction', 'readOnly', 'labels', 'shortcuts', 'slashItems', 'slashLabels', 'commitDelayMs', 'linkSchemes', 'onConflict', 'onFeedback', 'surface',
  'gutter', 'hoverOutline', 'selectionOverlay', 'dropIndicator', 'slashMenu', 'formattingToolbar', 'selectionToolbar', 'blockMenu', 'linkEditor', 'shortcutHelp', 'chartEditor', 'conflictNotice', 'feedback'] as const;
function ClassicReportEditor(allProps: ReportEditorProps): ReactNode {
  const props = { ...allProps } as ReportEditorProps;
  for (const name of INTERACTION_PROPS) delete (props as Record<string, unknown>)[name];
  // Draft state belongs to one editor instance, including when a host swaps the editor prop.
  let key = editorKeys.get(props.editor);
  if (key === undefined) { key = ++nextEditorKey; editorKeys.set(props.editor, key); }
  return <ReportEditorSurface key={key} {...props} />;
}

function ReportEditorSurface({ editor, actor = defaultActor, renderControls, ...viewProps }: ReportEditorProps): ReactNode {
  const report = useEditor(editor);
  const [drafts, setDrafts] = useState<Map<string, Draft>>(() => new Map()), [error, setError] = useState('');
  const applyResult = (outcome: ApplyResult): void => setError(outcome.ok ? '' : outcome.issues.map((issue) => issue.message).join(' '));
  const discard = (id: string): void => { setDrafts((previous) => { const next = new Map(previous); next.delete(id); return next; }); setError(''); };
  const begin = (block: Block): void => { setDrafts((previous) => new Map(previous).set(block.id, { text: editableText(block)!, baseRevision: report.revision, version: block.version, block })); };
  const change = (id: string, text: string): void => { setDrafts((previous) => { const draft = previous.get(id); return draft ? new Map(previous).set(id, { ...draft, text }) : previous; }); };
  const save = (block: Block, draft: Draft): void => {
    const outcome = editor.apply({ id: localId('human'), actor, baseRevision: draft.baseRevision, operations: [{ type: 'updateBlock', blockId: block.id, expectedVersion: draft.version, content: contentWithText(draft.block, draft.text) }] });
    if (outcome.ok) discard(block.id);
    applyResult(outcome);
  };
  const controls = { editor, report, actor, applyResult };
  return <div className="super-editor">
    {renderControls === false ? null : renderControls ? renderControls(controls) : <DefaultControls {...controls} />}
    {error ? <p className="super-editor-error" role="alert">{error}</p> : null}
    <ReportView {...viewProps} document={report} renderBlockActions={(block) => {
      const draft = drafts.get(block.id);
      if (!draft && editableText(block) === null) return null;
      if (!draft) return <button type="button" onClick={() => begin(block)}>Edit {block.content.type}</button>;
      return <div className="super-editor-block-edit">
        <textarea aria-label={`Edit block ${block.id}`} value={draft.text} onChange={(event) => change(block.id, event.target.value)} />
        <small>Plain text editing replaces inline formatting when text changes.</small>
        {draft.version !== block.version || draft.baseRevision !== report.revision ? <p>Document changed since this draft began (revision {draft.baseRevision}). Read current content and discard or reconcile your draft before saving.</p> : null}
        <button type="button" onClick={() => save(block, draft)}>Save block</button><button type="button" onClick={() => discard(block.id)}>Discard draft</button>
      </div>;
    }} />
    {[...drafts].filter(([id]) => !report.blocks.some((block) => block.id === id)).map(([id, draft]) => <div className="super-editor-block-edit" key={id}><p>Block {id} was deleted. Your unsaved draft is preserved.</p><textarea aria-label={`Deleted block draft ${id}`} value={draft.text} readOnly /><button type="button" onClick={() => discard(id)}>Discard draft</button></div>)}
  </div>;
}

export * from './interaction/index.js';
