import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import type { CSSProperties, KeyboardEvent, PointerEvent, ReactNode } from 'react';
import type { ChartSpec } from '@super-solution/editor-core';
import {
  chartDataTable, chartFileName, chartToPng, chartToSvg, createPaint, downloadBlob, hitTest, hoverScene, layoutChart, stepHit, template, tooltipPlacement,
} from '@super-solution/editor-ui';
import type { ChartLabels, ChartTheme, Hit, SceneNode } from '@super-solution/editor-ui';
import { useLabels } from './context.js';

/** Scene attributes use SVG names (`stroke-width`); React wants camelCase, except data-* and aria-*. */
export function reactAttributes(attrs: Record<string, string | number>): Record<string, string | number> {
  const out: Record<string, string | number> = {};
  for (const [key, value] of Object.entries(attrs)) out[key.startsWith('data-') || key.startsWith('aria-') ? key : key === 'class' ? 'className' : key.replace(/-([a-z])/g, (_, letter: string) => letter.toUpperCase())] = value;
  return out;
}
/** Renders scene nodes as React SVG elements. Geometry and text come only from the chart engine; text is a child string, never markup. */
export function SceneNodes({ nodes }: { nodes: readonly SceneNode[] }): ReactNode {
  return <>{nodes.map((node, index) => {
    const attrs = reactAttributes(node.attrs);
    const children = <>{node.children ? <SceneNodes nodes={node.children} /> : null}{node.text}</>;
    switch (node.tag) {
      case 'g': return <g key={index} {...attrs}>{children}</g>;
      case 'rect': return <rect key={index} {...attrs}>{children}</rect>;
      case 'path': return <path key={index} {...attrs} />;
      case 'line': return <line key={index} {...attrs} />;
      case 'circle': return <circle key={index} {...attrs} />;
      case 'polyline': return <polyline key={index} {...attrs} />;
      case 'polygon': return <polygon key={index} {...attrs} />;
      case 'text': return <text key={index} {...attrs}>{children}</text>;
      case 'title': return <title key={index}>{node.text}</title>;
    }
  })}</>;
}

export type ChartViewProps = {
  spec: ChartSpec;
  /** Overrides for the chart strings; normally these come from the `labels` prop of ReportView. */
  labels?: Partial<ChartLabels>;
  locale?: string;
  /** Show the toolbar (view data, export). Default true. */
  actions?: boolean;
  /** Hover tooltips, legend toggles and keyboard navigation. Default true. */
  interactive?: boolean;
  /** Fixed pixel width. Without it the chart follows its container with a ResizeObserver. */
  width?: number;
  exportTheme?: ChartTheme;
};

/**
 * An accessible, interactive chart: SVG plot, legend with series toggles, hover tooltip and crosshair, keyboard navigation,
 * a data table that stays in the DOM (visually hidden until "View data"), and SVG/PNG export. No charting dependency.
 */
export function ChartView({ spec, labels: chartLabelOverride, locale, actions = true, interactive = true, width: fixedWidth, exportTheme }: ChartViewProps): ReactNode {
  const ui = useLabels(), id = useId();
  const labels = useMemo<ChartLabels>(() => chartLabelOverride ? { ...ui.chart, ...chartLabelOverride, kindNames: { ...ui.chart.kindNames, ...chartLabelOverride.kindNames } } : ui.chart, [ui.chart, chartLabelOverride]);
  const stage = useRef<HTMLDivElement>(null), svg = useRef<SVGSVGElement>(null);
  const [width, setWidth] = useState(fixedWidth ?? 640);
  const [hidden, setHidden] = useState<ReadonlySet<string>>(() => new Set());
  const [activeId, setActiveId] = useState<string | undefined>();
  const [showData, setShowData] = useState(false), [status, setStatus] = useState('');
  useEffect(() => { if (fixedWidth !== undefined) setWidth(fixedWidth); }, [fixedWidth]);
  useEffect(() => {
    const target = stage.current;
    if (fixedWidth !== undefined || !target || typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver((entries) => {
      const next = Math.round(entries[0]?.contentRect.width ?? 0);
      if (next >= 160) setWidth((current) => Math.abs(next - current) >= 8 ? next : current);
    });
    observer.observe(target);
    return () => observer.disconnect();
  }, [fixedWidth]);
  const layout = useMemo(() => layoutChart(spec, { width, hidden, labels, locale }), [spec, width, hidden, labels, locale]);
  const table = useMemo(() => chartDataTable(spec, labels), [spec, labels]);
  const active: Hit | undefined = activeId === undefined ? undefined : layout.hits.find((hit) => hit.id === activeId);
  const paint = useMemo(() => createPaint(), []);
  const message = layout.message ?? layout.note;

  const toUnits = useCallback((event: PointerEvent): { x: number; y: number } | null => {
    const box = svg.current?.getBoundingClientRect();
    if (!box || !box.width || !box.height) return null;
    return { x: (event.clientX - box.left) * layout.width / box.width, y: (event.clientY - box.top) * layout.height / box.height };
  }, [layout.width, layout.height]);
  const onMove = (event: PointerEvent): void => {
    const point = toUnits(event);
    if (!point) return;
    const hit = hitTest(layout, point.x, point.y);
    setActiveId((current) => current === hit?.id ? current : hit?.id);
  };
  const onKey = (event: KeyboardEvent): void => {
    if (event.key === 'Escape') { setActiveId(undefined); return; }
    const delta = event.key === 'ArrowRight' || event.key === 'ArrowDown' ? 1 : event.key === 'ArrowLeft' || event.key === 'ArrowUp' ? -1 : event.key === 'Home' ? -layout.hits.length : event.key === 'End' ? layout.hits.length : 0;
    if (!delta) return;
    event.preventDefault();
    setActiveId(stepHit(layout, activeId, delta)?.id);
  };
  const toggle = (key: string): void => { setActiveId(undefined); setHidden((current) => { const next = new Set(current); if (next.has(key)) next.delete(key); else next.add(key); return next; }); };
  const exportAs = async (kind: 'svg' | 'png'): Promise<void> => {
    try {
      const options = { theme: exportTheme, hidden, labels, locale };
      if (kind === 'svg') downloadBlob(new Blob([chartToSvg(spec, options).svg], { type: 'image/svg+xml;charset=utf-8' }), chartFileName(spec, 'svg'));
      else downloadBlob(await chartToPng(spec, options), chartFileName(spec, 'png'));
      setStatus(labels.exported);
    } catch { setStatus(labels.exportFailed); }
  };
  const place = active ? tooltipPlacement(active, layout) : undefined;
  const hasScene = layout.scene.length > 0;

  return <figure className="super-editor-chart se-chart" data-chart-kind={spec.kind}>
    <figcaption className="se-chart-title">{spec.title}</figcaption>
    {actions ? <div className="se-chart-toolbar" role="group" aria-label={labels.actions}>
      <button type="button" className="se-chart-button" aria-expanded={showData} aria-controls={`${id}-data`} onClick={() => setShowData((open) => !open)}>{showData ? labels.hideData : labels.viewData}</button>
      <button type="button" className="se-chart-button" onClick={() => void exportAs('svg')}>{labels.exportSvg}</button>
      <button type="button" className="se-chart-button" onClick={() => void exportAs('png')}>{labels.exportPng}</button>
    </div> : null}
    {message ? <p className="se-chart-message">{message}</p> : null}
    <div className="se-chart-stage" ref={stage} hidden={!hasScene} tabIndex={interactive && layout.hits.length ? 0 : undefined}
      aria-describedby={interactive && layout.hits.length ? `${id}-tip` : undefined}
      onKeyDown={interactive ? onKey : undefined} onFocus={interactive ? () => setActiveId((current) => current ?? stepHit(layout, undefined, 0)?.id) : undefined} onBlur={interactive ? () => setActiveId(undefined) : undefined}>
      {hasScene ? <svg ref={svg} className="se-chart-svg" viewBox={`0 0 ${layout.width} ${layout.height}`} role="img" aria-label={layout.description} preserveAspectRatio="xMidYMid meet" style={{ aspectRatio: `${layout.width} / ${layout.height}` }}
        onPointerMove={interactive ? onMove : undefined} onPointerDown={interactive ? onMove : undefined} onPointerLeave={interactive ? () => setActiveId(undefined) : undefined}>
        <title>{spec.title}</title>
        <SceneNodes nodes={layout.scene} />
        <g className="se-chart-overlay" pointerEvents="none">{active ? <SceneNodes nodes={hoverScene(active, paint.token('text'), paint.token('surface'))} /> : null}</g>
      </svg> : null}
      <div className="se-tooltip" id={`${id}-tip`} role="tooltip" hidden={!active} data-h={place?.horizontal} data-v={place?.vertical} style={place ? { left: `${place.left}%`, top: `${place.top}%` } : undefined}>
        {active ? <>
          <strong className="se-tooltip-title">{active.title}</strong>
          <ul className="se-tooltip-rows">{active.rows.map((row, index) => <li key={index}>
            <span className="se-swatch" aria-hidden="true" style={{ '--se-swatch': row.color } as CSSProperties} />
            <span className="se-tooltip-label">{row.label}</span><span className="se-tooltip-value">{row.value}</span>
          </li>)}</ul>
        </> : null}
      </div>
    </div>
    {layout.legend.length ? <ul className="se-legend" aria-label={labels.legend}>{layout.legend.map((item) => <li key={item.key} className="se-legend-item" data-hidden={item.hidden || undefined}>
      {item.toggle && interactive
        ? <button type="button" className="se-legend-button" aria-pressed={!item.hidden} aria-label={template(labels.toggleSeries, { name: item.label })} data-key={item.key} onClick={() => toggle(item.key)}>
          <span className="se-swatch" aria-hidden="true" style={{ '--se-swatch': item.color } as CSSProperties} /><span>{item.label}</span></button>
        : <><span className="se-swatch" aria-hidden="true" style={{ '--se-swatch': item.color } as CSSProperties} /><span>{item.label}</span></>}
    </li>)}</ul> : null}
    <div className="se-chart-data" id={`${id}-data`} data-open={showData}>
      <table>
        <caption>{table.caption}</caption>
        <thead><tr>{table.headers.map((header, index) => <th scope="col" key={index}>{header}</th>)}</tr></thead>
        <tbody>{table.rows.map((row, index) => <tr key={index}>{row.map((cell, column) => column === 0 ? <th scope="row" key={column}>{cell}</th> : <td key={column}>{cell}</td>)}</tr>)}</tbody>
      </table>
    </div>
    {spec.caption ? <p className="se-chart-caption">{spec.caption}</p> : null}
    {spec.asOf || spec.source ? <p className="se-chart-meta">
      {spec.asOf ? <time dateTime={spec.asOf}>{labels.asOf}: {spec.asOf}</time> : null}
      {spec.asOf && spec.source ? ' · ' : null}
      {spec.source ? <span>{labels.source}: {spec.source}</span> : null}
    </p> : null}
    <span className="se-sr" role="status">{status}</span>
  </figure>;
}
