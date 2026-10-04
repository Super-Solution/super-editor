import type { ChartSpec } from '@super-solution/editor-core';
import type { FormatOptions } from './format.js';
import type { ChartLabels } from './labels.js';
import type { Paint } from './palette.js';
import type { SceneNode } from './scene.js';

export type Rect = { x: number; y: number; width: number; height: number };
export type TooltipRow = { color: string; label: string; value: string };
export type HitShape =
  | { type: 'rect'; x: number; y: number; width: number; height: number }
  | { type: 'circle'; cx: number; cy: number; r: number }
  | { type: 'arc'; cx: number; cy: number; inner: number; outer: number; start: number; end: number };
/** One hoverable thing: a category band, a point, a pie slice or a heat cell. */
export type Hit = {
  id: string;
  shape: HitShape;
  /** Where the tooltip attaches, in SVG user units. */
  anchor: { x: number; y: number };
  title: string;
  rows: TooltipRow[];
  crosshair?: { x1: number; y1: number; x2: number; y2: number };
  markers?: { cx: number; cy: number; r: number; color: string }[];
  /** Drawn while hovered (a band, an outline, a slice pulled out). */
  highlight?: SceneNode[];
};
export type LegendItem = { key: string; label: string; color: string; hidden: boolean; toggle: boolean };
export type ChartLayout = {
  kind: string;
  /** False when no renderer exists for the kind: show `message` and the data table. */
  supported: boolean;
  message?: string;
  /** Informational text shown next to a working chart, for example "Pie displays Weight". */
  note?: string;
  width: number; height: number;
  scene: SceneNode[];
  legend: LegendItem[];
  hits: Hit[];
  plot: Rect;
  /** Plain-language summary used as the accessible name. */
  description: string;
};
export type ChartLayoutOptions = {
  width?: number | undefined;
  height?: number | undefined;
  /** Keys of hidden legend items (`String(seriesIndex)`, or the slice index for pie and donut). */
  hidden?: ReadonlySet<string> | undefined;
  paint?: Paint | undefined;
  locale?: string | undefined;
  labels?: Partial<ChartLabels> | undefined;
};
/** Everything a family-specific layout needs. */
export type ChartContext = {
  spec: ChartSpec;
  width: number; height: number;
  paint: Paint; locale: string; labels: ChartLabels;
  hidden: ReadonlySet<string>;
  /** Value formatting for axis and tooltips (yAxis.format, currency, unit). */
  format: FormatOptions;
  compact: boolean;
};
