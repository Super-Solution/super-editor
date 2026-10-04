/** A tiny renderer-neutral SVG scene. The DOM, React and string serializers all consume the same nodes. */
export type SceneTag = 'g' | 'rect' | 'path' | 'line' | 'circle' | 'text' | 'polyline' | 'polygon' | 'title';
export type SceneNode = {
  tag: SceneTag;
  attrs: Record<string, string | number>;
  children?: SceneNode[];
  /** Text content (never markup). */
  text?: string;
};
export const SVG_NS = 'http://www.w3.org/2000/svg';

/** Rounds a coordinate to 2 decimals and guards against NaN/Infinity so a bad number can never reach an attribute. */
export function n(value: number): number {
  if (!Number.isFinite(value)) return 0;
  const rounded = Math.round(value * 100) / 100;
  return Object.is(rounded, -0) ? 0 : rounded;
}
export const g = (attrs: SceneNode['attrs'], children: SceneNode[]): SceneNode => ({ tag: 'g', attrs, children });
export const rect = (x: number, y: number, width: number, height: number, attrs: SceneNode['attrs'] = {}): SceneNode =>
  ({ tag: 'rect', attrs: { x: n(x), y: n(y), width: n(Math.max(0, width)), height: n(Math.max(0, height)), ...attrs } });
export const line = (x1: number, y1: number, x2: number, y2: number, attrs: SceneNode['attrs'] = {}): SceneNode =>
  ({ tag: 'line', attrs: { x1: n(x1), y1: n(y1), x2: n(x2), y2: n(y2), ...attrs } });
export const circle = (cx: number, cy: number, r: number, attrs: SceneNode['attrs'] = {}): SceneNode =>
  ({ tag: 'circle', attrs: { cx: n(cx), cy: n(cy), r: n(Math.max(0, r)), ...attrs } });
export const path = (d: string, attrs: SceneNode['attrs'] = {}): SceneNode => ({ tag: 'path', attrs: { d, ...attrs } });
export const polyline = (points: readonly (readonly [number, number])[], attrs: SceneNode['attrs'] = {}): SceneNode =>
  ({ tag: 'polyline', attrs: { points: points.map(([x, y]) => `${n(x)},${n(y)}`).join(' '), ...attrs } });
export const text = (x: number, y: number, content: string, attrs: SceneNode['attrs'] = {}): SceneNode =>
  ({ tag: 'text', attrs: { x: n(x), y: n(y), ...attrs }, text: content });

/** SVG path for a polyline-ish sequence of absolute points. */
export function linePath(points: readonly (readonly [number, number])[]): string {
  return points.map(([x, y], index) => `${index ? 'L' : 'M'}${n(x)} ${n(y)}`).join(' ');
}
/** Annular sector. Angles are in radians, 0 at 3 o'clock, increasing clockwise (SVG y-down). */
export function arcPath(cx: number, cy: number, inner: number, outer: number, start: number, end: number): string {
  const sweep = end - start;
  if (sweep >= Math.PI * 2 - 1e-6) {
    const ring = (radius: number, direction: 0 | 1): string => `M${n(cx + radius)} ${n(cy)} A${n(radius)} ${n(radius)} 0 1 ${direction} ${n(cx - radius)} ${n(cy)} A${n(radius)} ${n(radius)} 0 1 ${direction} ${n(cx + radius)} ${n(cy)} Z`;
    return inner > 0 ? `${ring(outer, 1)} ${ring(inner, 0)}` : ring(outer, 1);
  }
  const large = sweep > Math.PI ? 1 : 0;
  const point = (radius: number, angle: number): string => `${n(cx + radius * Math.cos(angle))} ${n(cy + radius * Math.sin(angle))}`;
  if (inner <= 0) return `M${n(cx)} ${n(cy)} L${point(outer, start)} A${n(outer)} ${n(outer)} 0 ${large} 1 ${point(outer, end)} Z`;
  return `M${point(outer, start)} A${n(outer)} ${n(outer)} 0 ${large} 1 ${point(outer, end)} L${point(inner, end)} A${n(inner)} ${n(inner)} 0 ${large} 0 ${point(inner, start)} Z`;
}

const escapeText = (value: string): string => value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const escapeAttribute = (value: string): string => escapeText(value).replace(/"/g, '&quot;');
export function nodeToSvg(node: SceneNode): string {
  const attrs = Object.entries(node.attrs).map(([key, value]) => ` ${key}="${escapeAttribute(String(value))}"`).join('');
  const inner = (node.children ?? []).map(nodeToSvg).join('') + (node.text === undefined ? '' : escapeText(node.text));
  return inner ? `<${node.tag}${attrs}>${inner}</${node.tag}>` : `<${node.tag}${attrs}/>`;
}
/** Serializes nodes into a standalone `<svg>` string. All text and attribute values are escaped. */
export function sceneToSvg(nodes: readonly SceneNode[], attrs: Record<string, string | number> = {}): string {
  const root = Object.entries({ xmlns: SVG_NS, ...attrs }).map(([key, value]) => ` ${key}="${escapeAttribute(String(value))}"`).join('');
  return `<svg${root}>${nodes.map(nodeToSvg).join('')}</svg>`;
}

/** Flattens a scene into its leaf shapes (used by the 0.1-compatible `getChartModel`). */
export function flatten(nodes: readonly SceneNode[]): SceneNode[] {
  return nodes.flatMap((node) => node.children ? flatten(node.children) : [node]);
}
