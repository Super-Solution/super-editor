import type { ChartSpec } from '@super-solution/editor-core';
import { layoutCandles } from './candles.js';
import { layoutCartesian } from './cartesian.js';
import { layoutHeatmap } from './heatmap.js';
import { template } from './labels.js';
import { layoutRadial } from './radial.js';
import { layoutScatter } from './scatter.js';
import { describeChart } from './table.js';
import { emptyLayout, makeContext } from './shared.js';
import type { ChartLayout, ChartLayoutOptions, Hit, HitShape } from './types.js';
import { circle, line, type SceneNode } from './scene.js';

export const CHART_KINDS_RENDERED = ['bar', 'trend', 'line', 'area', 'histogram', 'waterfall', 'pie', 'donut', 'scatter', 'candlestick', 'heatmap'] as const;

/**
 * Pure layout: turns a ChartSpec into an SVG scene, a legend and hover targets at a given pixel width.
 * Deterministic and DOM-free, so it works on the server, in tests and for exports.
 */
export function layoutChart(spec: ChartSpec, options: ChartLayoutOptions = {}): ChartLayout {
  const ctx = makeContext(spec, options);
  switch (spec.kind) {
    case 'bar': case 'trend': case 'line': case 'area': case 'histogram': case 'waterfall': return layoutCartesian(ctx);
    case 'pie': case 'donut': return layoutRadial(ctx);
    case 'scatter': return layoutScatter(ctx);
    case 'candlestick': return layoutCandles(ctx);
    case 'heatmap': return layoutHeatmap(ctx);
    default:
      return emptyLayout(ctx, template(ctx.labels.noRenderer, { kind: spec.kind }), { supported: false, description: describeChart(spec, ctx.labels) });
  }
}

/** Whether a built-in renderer exists for the kind. */
export function isRenderedKind(kind: string): boolean { return (CHART_KINDS_RENDERED as readonly string[]).includes(kind); }

function contains(shape: HitShape, x: number, y: number): number | null {
  switch (shape.type) {
    case 'rect': return x >= shape.x && x <= shape.x + shape.width && y >= shape.y && y <= shape.y + shape.height ? 0 : null;
    case 'circle': { const distance = Math.hypot(x - shape.cx, y - shape.cy); return distance <= shape.r ? distance : null; }
    case 'arc': {
      const dx = x - shape.cx, dy = y - shape.cy, radius = Math.hypot(dx, dy);
      if (radius < shape.inner || radius > shape.outer + 8) return null;
      const full = Math.PI * 2;
      let angle = Math.atan2(dy, dx), start = ((shape.start % full) + full) % full, end = start + (shape.end - shape.start);
      angle = ((angle % full) + full) % full;
      if (angle < start) angle += full;
      return angle >= start && angle <= end ? radius : null;
    }
  }
}
/** The hover target under a point in SVG user units. Circles prefer the nearest center. */
export function hitTest(layout: ChartLayout, x: number, y: number): Hit | undefined {
  let best: Hit | undefined, bestDistance = Infinity;
  for (const hit of layout.hits) {
    const distance = contains(hit.shape, x, y);
    if (distance === null) continue;
    if (hit.shape.type !== 'circle') return hit;
    if (distance < bestDistance) { best = hit; bestDistance = distance; }
  }
  return best;
}
/**
 * Keyboard navigation between hover targets: `delta` steps from the current one and clamps at the ends.
 * With nothing current, +1 is the first target, -1 the last, and a larger magnitude jumps further (Home and End pass ±count).
 */
export function stepHit(layout: ChartLayout, currentId: string | undefined, delta: number): Hit | undefined {
  const { hits } = layout;
  if (!hits.length) return undefined;
  const index = hits.findIndex((hit) => hit.id === currentId);
  const next = index < 0 ? (delta > 0 ? delta - 1 : delta < 0 ? hits.length + delta : 0) : index + delta;
  return hits[Math.max(0, Math.min(hits.length - 1, next))];
}
/** Scene nodes drawn over the chart while a target is hovered: highlight band, crosshair and point markers. */
export function hoverScene(hit: Hit, stroke: string, surface: string): SceneNode[] {
  const nodes: SceneNode[] = [...(hit.highlight ?? [])];
  if (hit.crosshair) nodes.push(line(hit.crosshair.x1, hit.crosshair.y1, hit.crosshair.x2, hit.crosshair.y2, { stroke, 'stroke-width': 1, 'stroke-dasharray': '3 3', opacity: .65 }));
  for (const marker of hit.markers ?? []) nodes.push(circle(marker.cx, marker.cy, marker.r, { fill: marker.color, stroke: surface, 'stroke-width': 2 }));
  return nodes;
}
/** CSS-friendly tooltip placement from the hit anchor, as percentages of the chart box. */
export function tooltipPlacement(hit: Hit, layout: ChartLayout): { left: number; top: number; horizontal: 'start' | 'center' | 'end'; vertical: 'above' | 'below' } {
  const left = Math.max(0, Math.min(100, hit.anchor.x / layout.width * 100)), top = Math.max(0, Math.min(100, hit.anchor.y / layout.height * 100));
  return { left, top, horizontal: left < 22 ? 'start' : left > 78 ? 'end' : 'center', vertical: top < 30 ? 'below' : 'above' };
}
