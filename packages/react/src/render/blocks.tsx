import { useId, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { getOutline, safeUrl } from '@super-solution/editor-core';
import type { Block, BlockContent, OutlineItem } from '@super-solution/editor-core';
import { allowedEmbedUrl, embedHeight, imageModel, listModel, metricModels, revealBlock, TONE_ICONS, tableModel, template } from '@super-solution/editor-ui';
import type { ListItemNode } from '@super-solution/editor-ui';
import { ChartView } from './chart.js';
import { HighlightedText, Runs } from './runs.js';
import type { ReactRenderContext } from './types.js';

export function SafeLink({ url, children, unsafe = '(unsafe URL omitted)' }: { url: string; children: ReactNode; unsafe?: string }): ReactNode {
  const safe = safeUrl(url);
  return safe ? <a href={safe} target="_blank" rel="noopener noreferrer">{children}</a> : <span>{children} {unsafe}</span>;
}

function Text({ text, context, block }: { text: string; context: ReactRenderContext; block: Block }): ReactNode {
  return <HighlightedText text={text} options={context.options} blockId={block.id} />;
}

function ListView({ block, content, context }: { block: Block; content: Extract<BlockContent, { type: 'list' }>; context: ReactRenderContext }): ReactNode {
  const model = listModel(content), { labels } = context, onToggle = context.options.onToggleTodo;
  const build = (items: readonly ListItemNode[]): ReactNode => {
    const Tag = model.style === 'number' ? 'ol' : 'ul';
    return <Tag className={`se-list se-list-${model.style}`}>{items.map((item) => <li key={item.index} className={model.style === 'todo' ? 'se-todo-item' : undefined} data-checked={model.style === 'todo' ? String(item.checked === true) : undefined}>
      {model.style === 'todo'
        ? <label className="se-todo-label">
          <input className="se-todo-box" type="checkbox" checked={item.checked === true} disabled={!onToggle} readOnly={!onToggle}
            aria-label={`${item.text} — ${item.checked ? labels.blocks.todoDone : labels.blocks.todoOpen}`}
            onChange={onToggle ? (event) => onToggle(block, item.index, event.target.checked) : undefined} />
          <span className="se-todo-text"><Text text={item.text} context={context} block={block} /></span>
        </label>
        : <Text text={item.text} context={context} block={block} />}
      {item.children.length ? build(item.children) : null}
    </li>)}</Tag>;
  };
  return <>{build(model.items)}</>;
}

function TableView({ block, content, context }: { block: Block; content: Extract<BlockContent, { type: 'table' }>; context: ReactRenderContext }): ReactNode {
  const model = tableModel(content);
  return <div className="se-table-wrap" role="region" tabIndex={0} aria-label={model.caption ?? context.labels.chart.dataSuffix} data-long={model.rows.length > 14 ? 'true' : undefined}>
    <table className="se-table">
      {model.caption ? <caption><Text text={model.caption} context={context} block={block} /></caption> : null}
      <thead><tr>{model.columns.map((column, index) => <th scope="col" key={index} className={`se-align-${column.align}`}><Text text={column.label} context={context} block={block} /></th>)}</tr></thead>
      <tbody>{model.rows.map((row, index) => <tr key={index}>{row.cells.map((cell, column) => {
        const className = `se-align-${cell.align}${cell.numeric ? ' se-numeric' : ''}`;
        return cell.header ? <th scope="row" key={column} className={className}><Text text={cell.text} context={context} block={block} /></th> : <td key={column} className={className}><Text text={cell.text} context={context} block={block} /></td>;
      })}</tr>)}</tbody>
    </table>
  </div>;
}

function TocView({ context }: { context: ReactRenderContext }): ReactNode {
  const { labels, report } = context, outline = getOutline(report);
  if (!outline.length) return <nav className="se-toc" aria-label={labels.blocks.toc}><p className="se-toc-empty">{labels.blocks.tocEmpty}</p></nav>;
  const build = (items: readonly OutlineItem[]): ReactNode => <ol>{items.map((item) => <li key={item.id} data-level={item.level}>
    <a href={`#${item.id}`} onClick={(event) => { if (revealBlock(event.currentTarget.ownerDocument, item.id)) event.preventDefault(); }}>{item.title}</a>
    {item.children.length ? build(item.children) : null}
  </li>)}</ol>;
  return <nav className="se-toc" aria-label={labels.blocks.toc}>{build(outline)}</nav>;
}

function CodeView({ content, context }: { content: Extract<BlockContent, { type: 'code' }>; context: ReactRenderContext }): ReactNode {
  const { labels } = context;
  const [state, setState] = useState<'idle' | 'copied' | 'failed'>('idle');
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const copy = (): void => {
    const done = (next: 'copied' | 'failed'): void => { setState(next); clearTimeout(timer.current); timer.current = setTimeout(() => setState('idle'), 1600); };
    const clipboard = typeof navigator === 'undefined' ? undefined : navigator.clipboard;
    if (!clipboard?.writeText) { done('failed'); return; }
    clipboard.writeText(content.text).then(() => done('copied'), () => done('failed'));
  };
  const text = state === 'copied' ? labels.blocks.copied : state === 'failed' ? labels.blocks.copyFailed : labels.blocks.copyCode;
  return <div className="se-code">
    <div className="se-code-bar">
      {content.language ? <span className="se-code-language">{content.language}</span> : null}
      <button type="button" className="se-code-copy" onClick={copy}>{text}</button>
      <span className="se-sr" role="status">{state === 'idle' ? '' : text}</span>
    </div>
    <pre tabIndex={0}><code data-language={content.language || undefined} className={content.language ? `language-${content.language}` : undefined}>{content.text}</code></pre>
  </div>;
}

function ImageView({ content, context }: { content: Extract<BlockContent, { type: 'image' }>; context: ReactRenderContext }): ReactNode {
  const model = imageModel(content), [broken, setBroken] = useState(false);
  return <figure className="super-editor-image se-image" data-width={model.width}>
    {model.src && !broken
      ? <img src={model.src} alt={model.alt} loading="lazy" decoding="async" referrerPolicy="no-referrer" onError={() => setBroken(true)} />
      : <p className="se-image-broken" role={model.src ? 'img' : undefined} aria-label={model.src ? model.alt || context.labels.blocks.imageBroken : undefined}>{model.src ? context.labels.blocks.imageBroken : model.alt || content.url}</p>}
    {model.caption ? <figcaption>{model.caption}</figcaption> : null}
  </figure>;
}

/** The embed block: a sandboxed iframe when the policy allows the origin, always with a link card as the fallback. */
function EmbedView({ content, context }: { content: Extract<BlockContent, { type: 'embed' }>; context: ReactRenderContext }): ReactNode {
  const { labels } = context, url = allowedEmbedUrl(content.url, context.options.embedPolicy);
  return <figure className="super-editor-embed se-embed" data-provider={content.provider} data-state={url ? 'live' : 'card'}>
    <div className="se-embed-card">
      <span className="se-embed-provider">SuperChart</span>
      <SafeLink url={content.url} unsafe={labels.document.unsafeUrl}>{content.title}</SafeLink>
      {url ? null : <span className="se-embed-note">{labels.blocks.embedBlocked}</span>}
    </div>
    {url ? <iframe className="se-embed-frame" src={url} title={content.title} sandbox="allow-scripts" referrerPolicy="no-referrer" loading="lazy" style={{ height: embedHeight(content.height) }} /> : null}
  </figure>;
}

function ToggleView({ block, content, context, children }: { block: Block; content: Extract<BlockContent, { type: 'toggle' }>; context: ReactRenderContext; children?: ReactNode }): ReactNode {
  const { labels } = context, bodyId = useId();
  const [open, setOpen] = useState(content.open), [seen, setSeen] = useState(block.version);
  // A new version from the document (another editor, an agent) wins over local expansion.
  if (seen !== block.version) { setSeen(block.version); setOpen(content.open); }
  const flip = (): void => { setOpen(!open); context.options.onToggle?.(block, !open); };
  return <div className="se-toggle" data-open={String(open)}>
    <button type="button" className="se-toggle-button" aria-expanded={open} aria-controls={bodyId} aria-label={template(open ? labels.blocks.collapse : labels.blocks.expand, { title: content.title })} onClick={flip}>
      <span className="se-toggle-caret" aria-hidden="true">▸</span><span className="se-toggle-title"><Text text={content.title} context={context} block={block} /></span>
    </button>
    <div className="se-toggle-body" id={bodyId} role="group" aria-label={content.title} hidden={!open} data-se-children="">{children}</div>
  </div>;
}

function MetricsView({ content, context }: { content: Extract<BlockContent, { type: 'metrics' }>; context: ReactRenderContext }): ReactNode {
  const { labels } = context;
  return <dl className="se-metrics">{metricModels(content).map((metric, index) => <div className="se-metric" data-tone={metric.tone} key={index}>
    <dt className="se-metric-label">{metric.label}</dt>
    <dd className="se-metric-value">{metric.value}</dd>
    {metric.change !== undefined ? <dd className="se-metric-change"><span aria-hidden="true">{metric.arrow}</span><span className="se-sr">{metric.tone === 'up' ? labels.blocks.metricUp : metric.tone === 'down' ? labels.blocks.metricDown : labels.blocks.metricFlat} </span>{metric.change}</dd> : null}
    {metric.hint ? <dd className="se-metric-hint">{metric.hint}</dd> : null}
  </div>)}</dl>;
}

/** Renders one block with the built-in view. `children` is where a container (toggle) places its nested blocks. */
export function DefaultBlockView({ block, context, children }: { block: Block; context: ReactRenderContext; children?: ReactNode }): ReactNode {
  const { content } = block, { labels, report } = context;
  switch (content.type) {
    case 'section': return <h2 className="se-section-title" id={`${block.id}-title`}><Text text={content.title} context={context} block={block} /></h2>;
    case 'heading': { const inner = <Text text={content.text} context={context} block={block} />; return content.level === 1 ? <h1 className="se-heading">{inner}</h1> : content.level === 2 ? <h2 className="se-heading">{inner}</h2> : <h3 className="se-heading">{inner}</h3>; }
    case 'paragraph': return <p className="se-paragraph"><Runs runs={content.runs} report={report} labels={labels} options={context.options} block={block} /></p>;
    case 'list': return <ListView block={block} content={content} context={context} />;
    case 'table': return <TableView block={block} content={content} context={context} />;
    case 'chart': {
      const registry = context.options.chartRenderers;
      const renderer = registry && hasOwn(registry, content.spec.kind) ? registry[content.spec.kind] : undefined;
      return renderer?.(content.spec, context) ?? <ChartView spec={content.spec} actions={context.options.chartActions !== false} {...(context.options.locale ? { locale: context.options.locale } : {})} {...(context.options.exportTheme ? { exportTheme: context.options.exportTheme } : {})} />;
    }
    case 'embed': return <EmbedView content={content} context={context} />;
    case 'timestamp': return <time className="se-timestamp" dateTime={content.at}>{content.label}: {content.at}</time>;
    case 'quote': return <blockquote className="se-quote"><p><Runs runs={content.runs} report={report} labels={labels} options={context.options} block={block} /></p>{content.attribution ? <footer>— <cite>{content.attribution}</cite></footer> : null}</blockquote>;
    case 'callout': return <div className="se-callout" data-tone={content.tone} role="note" aria-label={labels.blocks.toneNames[content.tone]}>
      <svg className="se-callout-icon" viewBox="0 0 16 16" width={16} height={16} fill="none" stroke="currentColor" strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d={TONE_ICONS[content.tone]} /></svg>
      <div className="se-callout-body">
        {content.title ? <strong className="se-callout-title"><Text text={content.title} context={context} block={block} /></strong> : null}
        <p><Runs runs={content.runs} report={report} labels={labels} options={context.options} block={block} /></p>
      </div>
    </div>;
    case 'code': return <CodeView content={content} context={context} />;
    case 'divider': return <hr className="se-divider" />;
    case 'image': return <ImageView content={content} context={context} />;
    case 'toggle': return <ToggleView block={block} content={content} context={context}>{children}</ToggleView>;
    case 'metrics': return <MetricsView content={content} context={context} />;
    case 'toc': return <TocView context={context} />;
    case 'pageBreak': return <div className="se-page-break super-editor-page-break" role="separator" aria-label={labels.blocks.pageBreak}><span>{labels.blocks.pageBreak}</span></div>;
  }
}
const hasOwn = (target: object, key: string): boolean => Object.hasOwn(target, key);
