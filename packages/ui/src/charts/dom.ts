import type { ChartSpec } from '@super-solution/editor-core';
import { attributes, element, sceneToDom, srOnly, svgElement, timeElement } from '../render/dom.js';
import { chartFileName, chartToPng, chartToSvg, downloadBlob } from './export.js';
import { resolveChartLabels, template, type ChartLabels } from './labels.js';
import { hitTest, hoverScene, layoutChart, stepHit, tooltipPlacement } from './layout.js';
import { readTokenColors, tokenColorsKey, watchTheme } from './live.js';
import { createPaint, type ChartTheme, type TokenColors } from './palette.js';
import { chartDataTable } from './table.js';
import type { ChartLayout, Hit } from './types.js';

export type ChartFigureOptions = {
  document?: Document;
  labels?: Partial<ChartLabels>;
  locale?: string;
  /** Show the toolbar (view data, export). Default true. */
  actions?: boolean;
  /** Hover tooltips, legend toggles and keyboard navigation. Default true. */
  interactive?: boolean;
  /** Fixed pixel width. Without it the chart follows its container with a ResizeObserver. */
  width?: number;
  /** Theme used for SVG/PNG exports. Default light. */
  exportTheme?: ChartTheme;
};

let nextFigure = 0;

/**
 * An accessible, interactive chart: title, toolbar, SVG, legend with series toggles, hover tooltip and crosshair,
 * a data table that is always in the DOM (visually hidden until "View data"), and provenance. Pure SVG, no dependencies.
 */
export function renderChartFigure(spec: ChartSpec, options: ChartFigureOptions = {}): HTMLElement {
  const doc = options.document ?? globalThis.document;
  const labels = resolveChartLabels(options.labels), interactive = options.interactive !== false;
  const id = `se-chart-${++nextFigure}`;
  const figure = element(doc, 'figure', undefined, 'super-editor-chart se-chart');
  figure.dataset.chartKind = spec.kind;
  const caption = element(doc, 'figcaption', spec.title, 'se-chart-title');
  figure.append(caption);

  const hidden = new Set<string>();
  // Heat-map labels are inked by contrast against the colors the page's tokens really have, which are known once the figure is attached.
  const heat = spec.kind === 'heatmap';
  let colors: TokenColors = {}, colorsKey = tokenColorsKey(colors);
  let width = options.width ?? 640, layout: ChartLayout = layoutChart(spec, { width, hidden, labels, locale: options.locale });
  let active: Hit | undefined, showData = false;

  // Toolbar
  const toolbar = element(doc, 'div', undefined, 'se-chart-toolbar');
  attributes(toolbar, { role: 'group', 'aria-label': labels.actions });
  const dataButton = element(doc, 'button', labels.viewData, 'se-chart-button');
  dataButton.type = 'button';
  attributes(dataButton, { 'aria-expanded': 'false', 'aria-controls': `${id}-data` });
  const svgButton = element(doc, 'button', labels.exportSvg, 'se-chart-button'), pngButton = element(doc, 'button', labels.exportPng, 'se-chart-button');
  svgButton.type = 'button'; pngButton.type = 'button';
  const status = srOnly(doc, '');
  status.setAttribute('role', 'status');
  if (options.actions !== false) { toolbar.append(dataButton, svgButton, pngButton); figure.append(toolbar); }

  const message = element(doc, 'p', undefined, 'se-chart-message');
  const stage = element(doc, 'div', undefined, 'se-chart-stage');
  const refreshColors = (): boolean => {
    if (!heat || !figure.isConnected) return false;
    const next = readTokenColors(stage), key = tokenColorsKey(next);
    if (key === colorsKey) return false;
    colors = next; colorsKey = key;
    return true;
  };
  const svg = svgElement(doc, 'svg', { role: 'img', preserveAspectRatio: 'xMidYMid meet', class: 'se-chart-svg' });
  const overlay = svgElement(doc, 'g', { class: 'se-chart-overlay', 'pointer-events': 'none' });
  const tooltip = element(doc, 'div', undefined, 'se-tooltip');
  tooltip.setAttribute('role', 'tooltip'); tooltip.hidden = true; tooltip.id = `${id}-tip`;
  stage.append(tooltip);
  const legend = element(doc, 'ul', undefined, 'se-legend');
  legend.setAttribute('aria-label', labels.legend);
  const dataRegion = element(doc, 'div', undefined, 'se-chart-data');
  dataRegion.id = `${id}-data`;
  const meta = element(doc, 'p', undefined, 'se-chart-meta');
  figure.append(message, stage, legend, dataRegion);
  if (spec.caption) figure.append(element(doc, 'p', spec.caption, 'se-chart-caption'));
  if (spec.asOf || spec.source) {
    if (spec.asOf) meta.append(timeElement(doc, spec.asOf, labels.asOf));
    if (spec.asOf && spec.source) meta.append(doc.createTextNode(' · '));
    if (spec.source) meta.append(element(doc, 'span', `${labels.source}: ${spec.source}`));
    figure.append(meta);
  }
  figure.append(status);

  // Data table (always present for assistive tech).
  const data = chartDataTable(spec, labels);
  const table = element(doc, 'table');
  table.append(element(doc, 'caption', data.caption));
  const head = element(doc, 'thead'), headRow = element(doc, 'tr');
  data.headers.forEach((label) => { const th = element(doc, 'th', label); th.scope = 'col'; headRow.append(th); });
  head.append(headRow); table.append(head);
  const body = element(doc, 'tbody');
  for (const cells of data.rows) {
    const row = element(doc, 'tr');
    cells.forEach((cell, index) => { const node = element(doc, index === 0 ? 'th' : 'td', cell); if (index === 0) node.scope = 'row'; row.append(node); });
    body.append(row);
  }
  table.append(body); dataRegion.append(table);
  const setData = (open: boolean): void => {
    showData = open; dataRegion.dataset.open = String(open);
    dataButton.setAttribute('aria-expanded', String(open)); dataButton.textContent = open ? labels.hideData : labels.viewData;
  };
  setData(false);

  const syncOverlay = (): void => {
    overlay.replaceChildren();
    if (!active) { tooltip.hidden = true; svg.removeAttribute('aria-describedby'); return; }
    const paint = createPaint();
    sceneToDom(doc, hoverScene(active, paint.token('text'), paint.token('surface')), overlay);
    tooltip.replaceChildren(element(doc, 'strong', active.title, 'se-tooltip-title'));
    const list = element(doc, 'ul', undefined, 'se-tooltip-rows');
    for (const row of active.rows) {
      const item = element(doc, 'li');
      const swatch = element(doc, 'span', undefined, 'se-swatch'); swatch.style.setProperty('--se-swatch', row.color); swatch.setAttribute('aria-hidden', 'true');
      item.append(swatch, element(doc, 'span', row.label, 'se-tooltip-label'), element(doc, 'span', row.value, 'se-tooltip-value'));
      list.append(item);
    }
    tooltip.append(list);
    const place = tooltipPlacement(active, layout);
    tooltip.style.left = `${place.left}%`; tooltip.style.top = `${place.top}%`;
    tooltip.dataset.h = place.horizontal; tooltip.dataset.v = place.vertical; tooltip.hidden = false;
  };

  const draw = (): void => {
    layout = layoutChart(spec, { width, hidden, labels, locale: options.locale, paint: createPaint({ colors }) });
    if (active) active = layout.hits.find((hit) => hit.id === active!.id);
    const showSvg = layout.scene.length > 0;
    svg.replaceChildren();
    stage.hidden = !showSvg;
    if (showSvg) { if (!svg.parentNode) stage.prepend(svg); } else svg.remove();
    if (showSvg) {
      svg.setAttribute('viewBox', `0 0 ${layout.width} ${layout.height}`);
      svg.setAttribute('aria-label', layout.description);
      svg.style.aspectRatio = `${layout.width} / ${layout.height}`;
      const title = svgElement(doc, 'title'); title.textContent = spec.title;
      svg.append(title);
      sceneToDom(doc, layout.scene, svg);
      svg.append(overlay);
    }
    const text = layout.message ?? layout.note ?? '';
    message.textContent = text; message.hidden = !text;
    stage.tabIndex = interactive && layout.hits.length ? 0 : -1;
    if (stage.tabIndex < 0) stage.removeAttribute('tabindex');
    legend.replaceChildren();
    for (const item of layout.legend) {
      const entry = element(doc, 'li', undefined, 'se-legend-item');
      const swatch = element(doc, 'span', undefined, 'se-swatch'); swatch.style.setProperty('--se-swatch', item.color); swatch.setAttribute('aria-hidden', 'true');
      if (item.toggle && interactive) {
        const button = element(doc, 'button', undefined, 'se-legend-button');
        button.type = 'button';
        attributes(button, { 'aria-pressed': String(!item.hidden), 'aria-label': template(labels.toggleSeries, { name: item.label }), 'data-key': item.key });
        button.append(swatch, element(doc, 'span', item.label));
        button.addEventListener('click', () => { if (hidden.has(item.key)) hidden.delete(item.key); else hidden.add(item.key); active = undefined; draw(); });
        entry.append(button);
      } else entry.append(swatch, element(doc, 'span', item.label));
      if (item.hidden) entry.dataset.hidden = 'true';
      legend.append(entry);
    }
    legend.hidden = !layout.legend.length;
    syncOverlay();
  };
  draw();

  if (interactive) {
    const toUnits = (event: PointerEvent): { x: number; y: number } | null => {
      const box = svg.getBoundingClientRect();
      if (!box.width || !box.height) return null;
      return { x: (event.clientX - box.left) * layout.width / box.width, y: (event.clientY - box.top) * layout.height / box.height };
    };
    const move = (event: PointerEvent): void => {
      const point = toUnits(event);
      if (!point) return;
      const hit = hitTest(layout, point.x, point.y);
      if ((hit?.id ?? null) === (active?.id ?? null)) return;
      active = hit; syncOverlay();
    };
    svg.addEventListener('pointermove', move);
    svg.addEventListener('pointerdown', move);
    svg.addEventListener('pointerleave', () => { if (active) { active = undefined; syncOverlay(); } });
    stage.addEventListener('keydown', (event) => {
      const delta = event.key === 'ArrowRight' || event.key === 'ArrowDown' ? 1 : event.key === 'ArrowLeft' || event.key === 'ArrowUp' ? -1 : event.key === 'Home' ? -Infinity : event.key === 'End' ? Infinity : 0;
      if (event.key === 'Escape') { active = undefined; syncOverlay(); return; }
      if (!delta) return;
      event.preventDefault();
      active = stepHit(layout, active?.id, Math.max(-layout.hits.length, Math.min(layout.hits.length, delta))); syncOverlay();
    });
    stage.addEventListener('focus', () => { if (!active) { active = stepHit(layout, undefined, 0); syncOverlay(); } });
    stage.addEventListener('blur', () => { active = undefined; syncOverlay(); });
    stage.setAttribute('aria-describedby', tooltip.id);
    dataButton.addEventListener('click', () => setData(!showData));
    const exportWith = async (kind: 'svg' | 'png'): Promise<void> => {
      try {
        const exportOptions = { theme: options.exportTheme, hidden, labels, locale: options.locale };
        if (kind === 'svg') downloadBlob(new Blob([chartToSvg(spec, exportOptions).svg], { type: 'image/svg+xml;charset=utf-8' }), chartFileName(spec, 'svg'), doc);
        else downloadBlob(await chartToPng(spec, exportOptions), chartFileName(spec, 'png'), doc);
        status.textContent = labels.exported;
      } catch { status.textContent = labels.exportFailed; }
    };
    svgButton.addEventListener('click', () => void exportWith('svg'));
    pngButton.addEventListener('click', () => void exportWith('png'));
    const Observer = doc.defaultView?.ResizeObserver ?? (typeof ResizeObserver === 'undefined' ? undefined : ResizeObserver);
    const follow = options.width === undefined;
    if (Observer && (follow || heat)) {
      let watching = false;
      new Observer((entries) => {
        let changed = false;
        if (follow) {
          const next = Math.round(entries[0]?.contentRect.width ?? 0);
          if (next >= 160 && Math.abs(next - width) >= 8) { width = next; changed = true; }
        }
        // The first callback means the figure is on the page: read the tokens, and keep reading them when the theme changes.
        if (heat && figure.isConnected) {
          if (!watching) { watching = true; watchTheme(stage, () => { if (refreshColors()) draw(); }); }
          if (refreshColors()) changed = true;
        }
        if (changed) draw();
      }).observe(stage);
    }
  }
  return figure;
}
