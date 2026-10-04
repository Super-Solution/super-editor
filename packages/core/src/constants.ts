import type { BlockType, CalloutTone, ChartKind, Highlight, Operation } from './types.js';

/** Runtime value lists for the closed unions in types.ts. UIs, slash menus and transports enumerate these. */
export const BLOCK_TYPES = ['section', 'heading', 'paragraph', 'list', 'table', 'chart', 'embed', 'timestamp', 'quote', 'callout', 'code', 'divider', 'image', 'toggle', 'metrics', 'toc', 'pageBreak'] as const satisfies readonly BlockType[];
export const CHART_KINDS = ['pie', 'donut', 'bar', 'trend', 'line', 'area', 'scatter', 'histogram', 'candlestick', 'heatmap', 'waterfall'] as const satisfies readonly ChartKind[];
export const HIGHLIGHTS = ['yellow', 'green', 'blue', 'pink', 'gray'] as const satisfies readonly Highlight[];
export const CALLOUT_TONES = ['info', 'success', 'warning', 'danger', 'note'] as const satisfies readonly CalloutTone[];
export const OPERATION_TYPES = ['insertBlock', 'updateBlock', 'moveBlock', 'deleteBlock', 'setTitle', 'setFormat', 'addCitation', 'insertBlocks', 'duplicateBlock', 'replaceText', 'deleteBlocks', 'moveBlocks', 'updateCitation', 'removeCitation'] as const satisfies readonly Operation['type'][];
export const IMAGE_WIDTHS = ['narrow', 'normal', 'wide', 'full'] as const;
export const LIST_STYLES = ['bullet', 'number', 'todo'] as const;
export const TABLE_ALIGNMENTS = ['left', 'center', 'right'] as const;
export const METRIC_TONES = ['up', 'down', 'neutral'] as const;
export const AXIS_FORMATS = ['number', 'percent', 'currency', 'compact'] as const;
/** Block types that may be the `parentId` of other blocks. */
export const CONTAINER_TYPES = ['section', 'toggle'] as const satisfies readonly BlockType[];

type Exhaustive<All extends string, List extends readonly string[]> = [Exclude<All, List[number]>] extends [never] ? true : never;
// Compile-time guards: adding a union member without listing it here fails the build.
export const exhaustive: [
  Exhaustive<BlockType, typeof BLOCK_TYPES>, Exhaustive<ChartKind, typeof CHART_KINDS>, Exhaustive<Highlight, typeof HIGHLIGHTS>,
  Exhaustive<CalloutTone, typeof CALLOUT_TONES>, Exhaustive<Operation['type'], typeof OPERATION_TYPES>,
] = [true, true, true, true, true];

export function isContainerType(type: string): boolean { return (CONTAINER_TYPES as readonly string[]).includes(type); }
