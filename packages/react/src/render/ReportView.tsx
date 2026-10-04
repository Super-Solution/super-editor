import { Component, memo, useEffect, useMemo, useRef, useState } from 'react';
import type { ReactNode, MutableRefObject } from 'react';
import type { Block, Citation, ResearchDocument } from '@super-solution/editor-core';
import { blockText } from '@super-solution/editor-core';
import { citationsKey, hostOf, outlineKey, renderRoots, template, dependsOnDocument, VIRTUALIZE_THRESHOLD } from '@super-solution/editor-ui';
import type { Labels } from '@super-solution/editor-ui';
import { DefaultBlockView, SafeLink } from './blocks.js';
import { LabelsContext, useResolvedLabels } from './context.js';
import { DocumentSkeleton } from '../panels/Skeleton.js';
import type { ReactRenderContext, ReportViewProps } from './types.js';

/** Catches a render error in one block so the rest of the document stays usable. */
export class BlockErrorBoundary extends Component<{ block: Block; labels: Labels; onError?: ((error: unknown, block: Block) => void) | undefined; resetKey: string; children?: ReactNode }, { error: unknown }> {
  override state = { error: null as unknown };
  static getDerivedStateFromError(error: unknown): { error: unknown } { return { error: error ?? new Error('Unknown render error') }; }
  override componentDidCatch(error: unknown): void { this.props.onError?.(error, this.props.block); }
  override componentDidUpdate(previous: { resetKey: string }): void { if (previous.resetKey !== this.props.resetKey && this.state.error !== null) this.setState({ error: null }); }
  override render(): ReactNode {
    if (this.state.error === null) return this.props.children;
    return <div className="se-block-error-card" role="alert">
      <strong>{this.props.labels.blocks.renderError}</strong>
      <button type="button" onClick={() => this.setState({ error: null })}>{this.props.labels.blocks.retry}</button>
    </div>;
  }
}

const ESTIMATES: Record<string, number> = { chart: 360, table: 220, image: 260, embed: 400, metrics: 110, code: 140, paragraph: 56, list: 90, callout: 80, quote: 70, toc: 160 };

/** Mounts children only while near the viewport; off-screen blocks keep their last measured height as a placeholder. */
function Lazy({ eager, type, children }: { eager: boolean; type: string; children: ReactNode }): ReactNode {
  const node = useRef<HTMLDivElement>(null), height = useRef(ESTIMATES[type] ?? 48);
  const supported = typeof IntersectionObserver !== 'undefined';
  const [visible, setVisible] = useState(eager || !supported);
  useEffect(() => {
    const target = node.current;
    if (eager || !supported || !target) return;
    const observer = new IntersectionObserver((entries) => {
      for (const entry of entries) {
        if (!entry.isIntersecting && node.current && node.current.offsetHeight > 0) height.current = node.current.offsetHeight;
        setVisible(entry.isIntersecting);
      }
    }, { rootMargin: '1200px 0px' });
    observer.observe(target);
    return () => observer.disconnect();
  }, [eager, supported]);
  return <div ref={node} className="se-lazy" data-visible={visible} style={visible ? undefined : { minHeight: height.current }}>{visible ? children : null}</div>;
}

type Shared = {
  contextRef: MutableRefObject<ReactRenderContext>;
  children: Map<string | null, Block[]>;
  /** Changes whenever an option that affects every block changes. */
  epoch: number;
  citationsKey: string; outlineKey: string;
  virtual: boolean; eagerIds: Set<string>;
  marks: { added: Set<string>; changed: Set<string>; moved: Set<string> };
  findKey: (block: Block) => string;
};

type NodeProps = { block: Block; shared: Shared; memoKey: string };
/** Calls the host renderer or the default view inside the error boundary, so a throwing renderer is contained too. */
function BlockBody({ block, contextRef, nested }: { block: Block; contextRef: MutableRefObject<ReactRenderContext>; nested: ReactNode }): ReactNode {
  const context = contextRef.current, renderer = context.options.blockRenderers?.[block.content.type];
  const custom = renderer ? renderer(block, context) : undefined;
  return <>{custom ?? <DefaultBlockView block={block} context={context}>{nested}</DefaultBlockView>}</>;
}
function BlockNodeImpl({ block, shared }: NodeProps): ReactNode {
  const context = shared.contextRef.current, { options, labels } = context;
  const nestedBlocks = shared.children.get(block.id) ?? [];
  const childNodes = nestedBlocks.length ? nestedBlocks.map((child) => <BlockNode key={child.id} block={child} shared={shared} memoKey={memoKeyFor(child, shared)} />) : null;
  const custom = options.blockRenderers?.[block.content.type] !== undefined;
  const inside = block.content.type === 'toggle' && !custom;
  const body = <BlockErrorBoundary block={block} labels={labels} onError={options.onRenderError} resetKey={`${block.id}:${block.version}`}>
    <BlockBody block={block} contextRef={shared.contextRef} nested={inside ? childNodes : null} />
  </BlockErrorBoundary>;
  const mark = shared.marks.added.has(block.id) ? 'added' : shared.marks.changed.has(block.id) ? 'changed' : shared.marks.moved.has(block.id) ? 'moved' : undefined;
  const lazy = shared.virtual && block.content.type !== 'section' && block.content.type !== 'toggle';
  const inner = lazy ? <Lazy eager={shared.eagerIds.has(block.id)} type={block.content.type}>{body}</Lazy> : body;
  const sources = block.citationIds.length ? <small className="super-editor-block-sources">{template(labels.document.blockSources, { list: block.citationIds.map((id) => context.report.citations.find((citation) => citation.id === id)?.title ?? id).join('; ') })}</small> : null;
  const actions = options.renderBlockActions?.(block);
  const rest = inside ? null : childNodes;
  const common = { id: block.id, className: 'super-editor-block se-block', 'data-block-id': block.id, 'data-block-type': block.content.type, 'data-diff': mark } as const;
  return block.content.type === 'section'
    ? <section {...common} aria-labelledby={`${block.id}-title`}>{inner}{sources}{actions}{rest}</section>
    : <div {...common}>{inner}{sources}{actions}{rest}</div>;
}
function memoKeyFor(block: Block, shared: Shared): string {
  const dependency = dependsOnDocument(block);
  return [block.id, block.version, block.updatedAt, shared.epoch, dependency === 'toc' ? shared.outlineKey : dependency === 'citations' ? shared.citationsKey : '', shared.marks.added.has(block.id) ? 'a' : shared.marks.changed.has(block.id) ? 'c' : shared.marks.moved.has(block.id) ? 'm' : '', shared.findKey(block), shared.children.get(block.id)?.map((child) => memoKeyFor(child, shared)).join(',') ?? ''].join('|');
}
const BlockNode = memo(BlockNodeImpl, (previous, next) => previous.memoKey === next.memoKey);

function shallowSame(a: object | undefined, b: object | undefined): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  const left = Object.entries(a), right = Object.entries(b);
  return left.length === right.length && left.every(([key, value]) => Object.hasOwn(b, key) && (b as Record<string, unknown>)[key] === value);
}

function Sources({ citations, labels }: { citations: readonly Citation[]; labels: Labels }): ReactNode {
  if (!citations.length) return null;
  return <section className="super-editor-citations se-sources" aria-label={labels.document.sources}>
    <h2>{labels.document.sources}</h2>
    <ol>{citations.map((citation) => <li key={citation.id} id={`cite-${citation.id}`} data-citation-id={citation.id}>
      <SafeLink url={citation.url} unsafe={labels.document.unsafeUrl}>{citation.title}</SafeLink>
      {hostOf(citation.url) ? <> <span className="se-cite-host">{hostOf(citation.url)}</span></> : null}
      <small><time dateTime={citation.accessedAt}>{labels.document.accessed}: {citation.accessedAt}</time>{citation.publishedAt ? <> · <time dateTime={citation.publishedAt}>{labels.document.published}: {citation.publishedAt}</time></> : null}</small>
    </li>)}</ol>
  </section>;
}

/** Polite live region: announces when the document moves to a new revision (an agent edit, a restore, a reload). */
function useAnnouncement(report: ResearchDocument, labels: Labels, enabled: boolean, lastActor: ReportViewProps['lastActor']): string {
  const [message, setMessage] = useState('');
  const previous = useRef<{ id: string; revision: number }>({ id: report.id, revision: report.revision });
  useEffect(() => {
    if (!enabled) return;
    const before = previous.current;
    previous.current = { id: report.id, revision: report.revision };
    if (before.id !== report.id || before.revision === report.revision) return;
    const actor = lastActor === 'agent' ? labels.document.actorAgent : lastActor === 'human' ? labels.document.actorHuman : lastActor === 'system' ? labels.document.actorSystem : null;
    setMessage(actor ? template(labels.document.announceUpdatedBy, { revision: report.revision, actor }) : template(labels.document.announceUpdated, { revision: report.revision }));
  }, [report.id, report.revision, enabled, lastActor, labels]);
  return message;
}

/**
 * Renders a document. Blocks are memoized by id and version, so an agent editing one paragraph does not re-render
 * the rest; documents over 300 blocks mount blocks only near the viewport; each block has its own error boundary.
 */
export function ReportView(props: ReportViewProps): ReactNode {
  const report = props.document;
  const labels = useResolvedLabels(props.labels);
  const contextRef = useRef<ReactRenderContext>(null as unknown as ReactRenderContext);
  const context: ReactRenderContext = { report, options: props, labels, renderDefaultBlock: (block) => <DefaultBlockView block={block} context={contextRef.current}>{null}</DefaultBlockView> };
  contextRef.current = context;

  // Everything that changes how *every* block renders bumps the epoch; per-block facts live in each block's memo key.
  const epochRef = useRef({ epoch: 0, blockRenderers: props.blockRenderers, chartRenderers: props.chartRenderers, renderBlockActions: props.renderBlockActions, labels, embed: '', locale: props.locale, chartActions: props.chartActions, todo: !!props.onToggleTodo, exportTheme: props.exportTheme, memoize: props.memoize, reportId: report.id });
  const embedKey = props.embedPolicy ? JSON.stringify(props.embedPolicy) : '';
  const previous = epochRef.current;
  if (!shallowSame(previous.blockRenderers, props.blockRenderers) || !shallowSame(previous.chartRenderers, props.chartRenderers) || previous.renderBlockActions !== props.renderBlockActions || previous.labels !== labels
    || previous.embed !== embedKey || previous.locale !== props.locale || previous.chartActions !== props.chartActions || previous.todo !== !!props.onToggleTodo || previous.exportTheme !== props.exportTheme || previous.reportId !== report.id || props.memoize === false) {
    epochRef.current = { epoch: previous.epoch + 1, blockRenderers: props.blockRenderers, chartRenderers: props.chartRenderers, renderBlockActions: props.renderBlockActions, labels, embed: embedKey, locale: props.locale, chartActions: props.chartActions, todo: !!props.onToggleTodo, exportTheme: props.exportTheme, memoize: props.memoize, reportId: report.id };
  }
  const epoch = epochRef.current.epoch;

  const { roots, children, orphans } = useMemo(() => renderRoots(report), [report]);
  const cKey = useMemo(() => citationsKey(report), [report]);
  const oKey = useMemo(() => outlineKey(report), [report]);
  const marks = useMemo(() => ({ added: new Set(props.diff?.added ?? []), changed: new Set(props.diff?.changed ?? []), moved: new Set(props.diff?.moved ?? []) }), [props.diff]);
  const find = props.find;
  const findKey = useMemo(() => (block: Block): string => {
    if (!find?.query) return '';
    const text = blockText(block), needle = find.caseSensitive ? find.query : find.query.toLowerCase();
    return (find.caseSensitive ? text : text.toLowerCase()).includes(needle) ? `${find.query}|${find.caseSensitive ? 1 : 0}|${find.activeBlockId === block.id ? 1 : 0}` : '';
  }, [find?.query, find?.caseSensitive, find?.activeBlockId]); // eslint-disable-line react-hooks/exhaustive-deps
  const threshold = props.virtualize === false ? Infinity : typeof props.virtualize === 'number' ? props.virtualize : VIRTUALIZE_THRESHOLD;
  const virtual = report.blocks.length > threshold;
  const eagerIds = new Set(report.blocks.slice(0, 40).map((block) => block.id));
  const shared: Shared = { contextRef, children, epoch, citationsKey: cKey, outlineKey: oKey, virtual, eagerIds, marks, findKey };
  const announcement = useAnnouncement(report, labels, props.announce !== false, props.lastActor);

  const titleId = `${report.id}-title`;
  const top = [...roots, ...orphans];
  return <LabelsContext.Provider value={labels}>
    <article className={`super-editor-document${props.className ? ` ${props.className}` : ''}`} aria-labelledby={titleId} aria-busy={props.loading || undefined}
      data-document-id={report.id} data-page={report.format.page} data-font={report.format.font} data-se-theme={props.theme} data-se-density={props.density} data-large={report.blocks.length > VIRTUALIZE_THRESHOLD ? 'true' : undefined}
      style={{ fontSize: report.format.fontSize, lineHeight: report.format.lineHeight }}>
      {props.showHeader === false ? <h1 className="se-sr" id={titleId}>{report.title || labels.document.untitled}</h1>
        : props.header ?? <header className="se-header">
          <h1 id={titleId}>{report.title || labels.document.untitled}</h1>
          <p className="super-editor-metadata">{template(labels.document.revision, { revision: report.revision })} · <time dateTime={report.updatedAt}>{labels.document.updated}: {report.updatedAt}</time></p>
        </header>}
      {props.loading ? <DocumentSkeleton /> : <>
        {top.length === 0 && props.emptyState !== false ? props.emptyState ?? <p className="se-empty-note">{labels.document.empty}</p> : null}
        {top.map((block) => <BlockNode key={block.id} block={block} shared={shared} memoKey={memoKeyFor(block, shared)} />)}
        <Sources citations={report.citations} labels={labels} />
      </>}
      <div className="se-sr" role="status" aria-live="polite" aria-atomic="true">{announcement}</div>
    </article>
  </LabelsContext.Provider>;
}
