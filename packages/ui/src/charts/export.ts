import type { ChartSpec } from '@super-solution/editor-core';
import { layoutChart } from './layout.js';
import { resolveChartLabels, type ChartLabels } from './labels.js';
import { createPaint, type ChartTheme } from './palette.js';
import { textWidth, truncate } from './scale.js';
import { g, line, rect, sceneToSvg, text, type SceneNode } from './scene.js';
import type { ChartLayout } from './types.js';

export type ChartExportOptions = {
  /** Output width in CSS px. Default 800. */
  width?: number | undefined;
  height?: number | undefined;
  theme?: ChartTheme | undefined;
  /** Legend items to hide, as in the on-page chart. */
  hidden?: ReadonlySet<string> | undefined;
  labels?: Partial<ChartLabels> | undefined;
  locale?: string | undefined;
  /** Fill the background with the surface color. Default true. */
  background?: boolean | undefined;
};
export type ChartSvgExport = { svg: string; width: number; height: number; layout: ChartLayout };

const FONT_FAMILY = "system-ui, -apple-system, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif";

/**
 * A self-contained SVG for the chart: title, plot, legend and provenance footer, with every color resolved
 * (no CSS variables), so it renders identically in an image viewer, a slide or a PDF.
 */
export function chartToSvg(spec: ChartSpec, options: ChartExportOptions = {}): ChartSvgExport {
  const width = Math.max(320, Math.min(2400, Math.round(options.width ?? 800)));
  const theme = options.theme ?? 'light';
  const paint = createPaint({ mode: 'static', theme });
  const labels = resolveChartLabels(options.labels);
  const layout = layoutChart(spec, { width, height: options.height, hidden: options.hidden, paint, locale: options.locale, labels: options.labels });
  const pad = 16, inner = width - pad * 2;
  const nodes: SceneNode[] = [];
  let cursor = pad;
  nodes.push(text(pad, cursor + 14, truncate(spec.title, inner, 16), { 'font-size': 16, 'font-weight': 700, fill: paint.token('text') }));
  cursor += 26;
  const chartTop = cursor;
  if (layout.message && !layout.scene.length) {
    nodes.push(text(pad, cursor + 16, truncate(layout.message, inner, 12), { 'font-size': 12, fill: paint.token('muted') }));
    cursor += 28;
  } else {
    nodes.push(g({ transform: `translate(0 ${chartTop})` }, layout.scene));
    cursor += layout.height;
  }
  // Legend
  let x = pad, y = cursor + 10;
  for (const item of layout.legend) {
    const label = truncate(item.label, inner - 24, 12), size = textWidth(label, 12) + 30;
    if (x + size > width - pad && x > pad) { x = pad; y += 18; }
    nodes.push(rect(x, y - 9, 10, 10, { fill: item.color, rx: 2, ...(item.hidden ? { opacity: .3 } : {}) }));
    nodes.push(text(x + 15, y, label, { 'font-size': 12, fill: paint.token(item.hidden ? 'muted' : 'text'), ...(item.hidden ? { 'text-decoration': 'line-through' } : {}) }));
    x += size;
  }
  if (layout.legend.length) cursor = y + 10;
  // Footer: caption, as-of and source.
  const footer: string[] = [];
  if (spec.caption) footer.push(spec.caption);
  const meta = [spec.asOf ? `${labels.asOf}: ${spec.asOf}` : '', spec.source ? `${labels.source}: ${spec.source}` : ''].filter(Boolean).join('  ·  ');
  if (meta) footer.push(meta);
  if (footer.length) {
    nodes.push(line(pad, cursor + 4, width - pad, cursor + 4, { stroke: paint.token('grid'), 'stroke-width': 1 }));
    cursor += 8;
    for (const entry of footer) { cursor += 15; nodes.push(text(pad, cursor, truncate(entry, inner, 11), { 'font-size': 11, fill: paint.token('muted') })); }
  }
  const height = Math.ceil(cursor + pad);
  const root: SceneNode[] = [];
  if (options.background !== false) root.push(rect(0, 0, width, height, { fill: paint.token('surface') }));
  root.push(...nodes);
  const svg = sceneToSvg(root, { viewBox: `0 0 ${width} ${height}`, width, height, 'font-family': FONT_FAMILY, role: 'img', 'aria-label': layout.description || spec.title });
  return { svg, width, height, layout };
}

/** A file-system friendly name derived from the chart title. */
export function chartFileName(spec: ChartSpec, extension: 'svg' | 'png'): string {
  const slug = spec.title.normalize('NFKD').replace(/[^\p{L}\p{N}]+/gu, '-').replace(/^-+|-+$/g, '').toLowerCase().slice(0, 60);
  return `${slug || 'chart'}.${extension}`;
}

/** Rasterizes the standalone SVG in a browser. Rejects where canvas is unavailable (servers, jsdom). */
export async function chartToPng(spec: ChartSpec, options: ChartExportOptions & { scale?: number } = {}): Promise<Blob> {
  if (typeof document === 'undefined' || typeof Image === 'undefined') throw new Error('PNG export requires a browser.');
  const { svg, width, height } = chartToSvg(spec, options);
  const scale = Math.max(1, Math.min(4, options.scale ?? 2));
  const url = URL.createObjectURL(new Blob([svg], { type: 'image/svg+xml;charset=utf-8' }));
  try {
    const image = new Image();
    image.decoding = 'async';
    await new Promise<void>((resolve, reject) => { image.onload = () => resolve(); image.onerror = () => reject(new Error('The chart image could not be decoded.')); image.src = url; });
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(width * scale); canvas.height = Math.round(height * scale);
    const context = canvas.getContext('2d');
    if (!context) throw new Error('Canvas is not available.');
    context.scale(scale, scale); context.drawImage(image, 0, 0, width, height);
    return await new Promise<Blob>((resolve, reject) => canvas.toBlob((blob) => blob ? resolve(blob) : reject(new Error('The chart image could not be encoded.')), 'image/png'));
  } finally { URL.revokeObjectURL(url); }
}

/** Starts a browser download of `blob`. */
export function downloadBlob(blob: Blob, filename: string, doc: Document = document): void {
  const url = URL.createObjectURL(blob);
  const anchor = doc.createElement('a');
  anchor.href = url; anchor.download = filename; anchor.rel = 'noopener'; anchor.style.display = 'none';
  doc.body.append(anchor); anchor.click(); anchor.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1_000);
}
