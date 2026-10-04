import type { BlockContent, CalloutTone, ChartKind, ChartSpec } from '@super-solution/editor-core';
import { blankContent } from './convert.js';

/** Everything the "/" menu and the "+" button can insert. Chart items insert a valid, clearly labelled placeholder chart. */
export type SlashInput = { kind: 'url'; label: string; placeholder: string };
export type SlashContext = { now: string; input?: string };
export type SlashItem = {
  id: string; label: string; description: string; group: string;
  /** Short decorative glyph; hosts may map `id` to their own icon set. */
  icon: string;
  keywords: readonly string[];
  /** Markdown shortcut that produces the same block, for example `##`. */
  hint?: string;
  /** Some blocks need one value before they exist (an https URL). The UI collects it and passes it as `context.input`. */
  input?: SlashInput;
  create(context: SlashContext): BlockContent;
};
export type SlashLabels = Readonly<Record<string, { label?: string; description?: string; keywords?: readonly string[] }>>;
export const SLASH_GROUPS = ['Basic blocks', 'Report', 'Charts'] as const;
const PLACEHOLDER = 'Placeholder data. Replace it with your own numbers.';

export const CHART_TEMPLATES: Readonly<Record<ChartKind, () => ChartSpec>> = {
  bar: () => ({ kind: 'bar', title: 'Bar chart', labels: ['Q1', 'Q2', 'Q3', 'Q4'], series: [{ name: 'Series A', values: [12, 19, 14, 22] }], caption: PLACEHOLDER }),
  line: () => ({ kind: 'line', title: 'Line chart', labels: ['Jan', 'Feb', 'Mar', 'Apr', 'May'], series: [{ name: 'Series A', values: [10, 14, 12, 18, 21] }], caption: PLACEHOLDER }),
  trend: () => ({ kind: 'trend', title: 'Trend', labels: ['Jan', 'Feb', 'Mar', 'Apr', 'May'], series: [{ name: 'Series A', values: [3.1, 3.4, 3.2, 3.8, 4.1] }], caption: PLACEHOLDER }),
  area: () => ({ kind: 'area', title: 'Area chart', labels: ['Jan', 'Feb', 'Mar', 'Apr', 'May'], series: [{ name: 'Series A', values: [8, 11, 9, 15, 17] }], caption: PLACEHOLDER }),
  pie: () => ({ kind: 'pie', title: 'Pie chart', labels: ['A', 'B', 'C'], series: [{ name: 'Share', values: [50, 30, 20] }], unit: '%', caption: PLACEHOLDER }),
  donut: () => ({ kind: 'donut', title: 'Donut chart', labels: ['A', 'B', 'C'], series: [{ name: 'Share', values: [50, 30, 20] }], unit: '%', caption: PLACEHOLDER }),
  scatter: () => ({ kind: 'scatter', title: 'Scatter plot', labels: ['P1', 'P2', 'P3', 'P4', 'P5'], series: [{ name: 'Series A', values: [2, 5, 3, 7, 6] }],
    points: [{ series: 'Series A', x: 1, y: 2 }, { series: 'Series A', x: 2, y: 5 }, { series: 'Series A', x: 3, y: 3 }, { series: 'Series A', x: 4, y: 7 }, { series: 'Series A', x: 5, y: 6 }], caption: PLACEHOLDER }),
  histogram: () => ({ kind: 'histogram', title: 'Histogram', labels: ['0-10', '10-20', '20-30', '30-40'], series: [{ name: 'Count', values: [4, 9, 6, 2] }], caption: PLACEHOLDER }),
  candlestick: () => ({ kind: 'candlestick', title: 'Candlestick', labels: ['Mon', 'Tue', 'Wed', 'Thu', 'Fri'], series: [{ name: 'Close', values: [104, 107, 105, 110, 108] }],
    ohlc: [{ t: 'Mon', o: 100, h: 105, l: 99, c: 104 }, { t: 'Tue', o: 104, h: 108, l: 103, c: 107 }, { t: 'Wed', o: 107, h: 108, l: 103, c: 105 }, { t: 'Thu', o: 105, h: 111, l: 104, c: 110 }, { t: 'Fri', o: 110, h: 111, l: 106, c: 108 }], caption: PLACEHOLDER }),
  heatmap: () => ({ kind: 'heatmap', title: 'Heatmap', labels: ['A', 'B', 'C'], series: [{ name: 'A', values: [1, 0.4, -0.2] }, { name: 'B', values: [0.4, 1, 0.3] }, { name: 'C', values: [-0.2, 0.3, 1] }],
    matrix: { rows: ['A', 'B', 'C'], columns: ['A', 'B', 'C'], values: [[1, 0.4, -0.2], [0.4, 1, 0.3], [-0.2, 0.3, 1]] }, caption: PLACEHOLDER }),
  waterfall: () => ({ kind: 'waterfall', title: 'Waterfall', labels: ['Revenue', 'Costs', 'Tax', 'Net'], series: [{ name: 'Change', values: [120, -45, -15, 60] }], caption: PLACEHOLDER }),
};
const CHART_ENTRIES: readonly { kind: ChartKind; label: string; description: string; keywords: readonly string[] }[] = [
  { kind: 'bar', label: 'Bar chart', description: 'Compare categories; grouped, stacked or horizontal', keywords: ['column', 'compare', 'histogram'] },
  { kind: 'line', label: 'Line chart', description: 'Values over time', keywords: ['time series', 'price', 'trend'] },
  { kind: 'area', label: 'Area chart', description: 'Filled line, optionally stacked', keywords: ['stacked', 'volume'] },
  { kind: 'trend', label: 'Trend chart', description: 'Simple trend line', keywords: ['sparkline', 'line'] },
  { kind: 'pie', label: 'Pie chart', description: 'Share of a whole', keywords: ['allocation', 'proportion', 'share'] },
  { kind: 'donut', label: 'Donut chart', description: 'Share of a whole with a centre label', keywords: ['allocation', 'ring', 'share'] },
  { kind: 'scatter', label: 'Scatter plot', description: 'Relationship between two numbers', keywords: ['correlation', 'xy', 'points'] },
  { kind: 'histogram', label: 'Histogram', description: 'Distribution of values in bins', keywords: ['distribution', 'bins', 'frequency'] },
  { kind: 'candlestick', label: 'Candlestick chart', description: 'Open, high, low and close prices', keywords: ['ohlc', 'price', 'candles', 'stock'] },
  { kind: 'heatmap', label: 'Heatmap', description: 'Matrix of values as colours', keywords: ['correlation', 'matrix', 'grid'] },
  { kind: 'waterfall', label: 'Waterfall chart', description: 'Step-by-step build-up of a total', keywords: ['bridge', 'delta', 'walk'] },
];
const calloutItem = (tone: CalloutTone, label: string, description: string, icon: string, keywords: readonly string[], hint?: string): SlashItem => ({
  id: `callout-${tone}`, label, description, group: 'Basic blocks', icon, keywords: ['callout', 'alert', 'note', ...keywords], ...(hint ? { hint } : {}),
  create: () => blankContent('callout', tone),
});
const item = (id: string, label: string, description: string, group: string, icon: string, keywords: readonly string[], create: SlashItem['create'], extra: Partial<SlashItem> = {}): SlashItem => ({ id, label, description, group, icon, keywords, create, ...extra });

export function createSlashCatalog(labels: SlashLabels = {}): SlashItem[] {
  const base: SlashItem[] = [
    item('paragraph', 'Text', 'Plain paragraph', 'Basic blocks', 'T', ['paragraph', 'plain', 'text', 'p'], () => blankContent('paragraph')),
    item('heading1', 'Heading 1', 'Large section heading', 'Basic blocks', 'H1', ['title', 'h1', 'heading'], () => blankContent('heading1'), { hint: '#' }),
    item('heading2', 'Heading 2', 'Medium heading', 'Basic blocks', 'H2', ['subtitle', 'h2', 'heading'], () => blankContent('heading2'), { hint: '##' }),
    item('heading3', 'Heading 3', 'Small heading', 'Basic blocks', 'H3', ['h3', 'heading'], () => blankContent('heading3'), { hint: '###' }),
    item('bullet', 'Bulleted list', 'A simple list of points', 'Basic blocks', '•', ['ul', 'unordered', 'bullets', 'list'], () => blankContent('bullet'), { hint: '-' }),
    item('number', 'Numbered list', 'A list with numbering', 'Basic blocks', '1.', ['ol', 'ordered', 'numbers', 'list'], () => blankContent('number'), { hint: '1.' }),
    item('todo', 'To-do list', 'Track tasks with checkboxes', 'Basic blocks', '☐', ['task', 'checkbox', 'checklist', 'todo'], () => blankContent('todo'), { hint: '[]' }),
    item('toggle', 'Toggle', 'Collapsible block that holds other blocks', 'Basic blocks', '▸', ['collapse', 'details', 'accordion', 'expand'], () => blankContent('toggle')),
    item('quote', 'Quote', 'Quote or excerpt with attribution', 'Basic blocks', '“', ['blockquote', 'citation', 'excerpt'], () => blankContent('quote'), { hint: '>' }),
    calloutItem('info', 'Callout', 'Highlight a key point', 'i', ['info', 'tip', 'highlight'], '!!'),
    calloutItem('success', 'Success callout', 'Positive outcome or confirmation', '✓', ['green', 'good', 'done']),
    calloutItem('warning', 'Warning callout', 'Caveat or risk to be aware of', '!', ['caution', 'risk', 'yellow']),
    calloutItem('danger', 'Danger callout', 'Serious problem or hard limit', '×', ['error', 'critical', 'red']),
    calloutItem('note', 'Note callout', 'Neutral side note', '✎', ['aside', 'remark', 'gray']),
    item('code', 'Code', 'Monospaced code block', 'Basic blocks', '</>', ['snippet', 'pre', 'monospace', 'program'], () => blankContent('code'), { hint: '```' }),
    item('divider', 'Divider', 'Visually separate parts of the page', 'Basic blocks', '—', ['hr', 'rule', 'line', 'separator'], () => ({ type: 'divider' }), { hint: '---' }),
    item('section', 'Section', 'A titled part of the report that holds other blocks', 'Report', '§', ['chapter', 'group', 'container'], () => blankContent('section')),
    item('table', 'Table', 'Rows and columns of text', 'Report', '▦', ['grid', 'spreadsheet', 'data'], () => ({ type: 'table', columns: ['Column 1', 'Column 2', 'Column 3'], rows: [['', '', ''], ['', '', '']] })),
    item('metrics', 'Key metrics', 'A row of headline numbers with changes', 'Report', 'Σ', ['kpi', 'stats', 'numbers', 'summary'], () => ({ type: 'metrics', items: [{ label: 'Metric', value: '0', tone: 'neutral' }] })),
    item('toc', 'Table of contents', 'Links to every heading and section', 'Report', '≡', ['contents', 'outline', 'index', 'navigation'], () => ({ type: 'toc' })),
    item('pageBreak', 'Page break', 'Start a new page when printing', 'Report', '⤕', ['print', 'pdf', 'new page'], () => ({ type: 'pageBreak' })),
    item('timestamp', 'Data timestamp', 'Mark when the data was checked', 'Report', '⏱', ['date', 'time', 'as of', 'updated'], (context) => ({ type: 'timestamp', at: context.now, label: 'Data as of' })),
    item('image', 'Image', 'An https image with caption', 'Report', '▣', ['picture', 'photo', 'figure', 'screenshot'], (context) => ({ type: 'image', url: context.input ?? '', alt: '' }), { input: { kind: 'url', label: 'Image URL', placeholder: 'https://example.com/figure.png' } }),
    item('embed', 'Super Chart embed', 'Embed an interactive chart by https link', 'Report', '⬡', ['superchart', 'iframe', 'interactive', 'live chart'], (context) => ({ type: 'embed', provider: 'superchart', url: context.input ?? '', title: 'Super Chart' }), { input: { kind: 'url', label: 'Chart URL', placeholder: 'https://charts.example.com/view/abc' } }),
    ...CHART_ENTRIES.map((entry) => item(`chart-${entry.kind}`, entry.label, entry.description, 'Charts', '◧', ['chart', 'graph', 'plot', entry.kind, ...entry.keywords], () => ({ type: 'chart', spec: CHART_TEMPLATES[entry.kind]() }))),
  ];
  return base.map((entry) => {
    const override = labels[entry.id];
    return override ? { ...entry, ...(override.label ? { label: override.label } : {}), ...(override.description ? { description: override.description } : {}), ...(override.keywords ? { keywords: [...entry.keywords, ...override.keywords] } : {}) } : entry;
  });
}
