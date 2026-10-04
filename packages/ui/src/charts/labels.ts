/** Every user-visible string a chart can show. Templates use `{name}` placeholders. */
export type ChartLabels = {
  label: string; series: string; x: string; y: string; value: string; row: string;
  time: string; open: string; high: string; low: string; close: string; volume: string; change: string;
  increase: string; decrease: string; total: string; runningTotal: string; share: string;
  up: string; down: string;
  viewData: string; hideData: string; exportSvg: string; exportPng: string; actions: string;
  legend: string; toggleSeries: string;
  noData: string; invalidData: string; noRenderer: string; pieInvalid: string; pieExtraSeries: string;
  noPoints: string; allHidden: string;
  asOf: string; source: string; dataSuffix: string;
  describe: string; describeRange: string; kindNames: Record<string, string>;
  exported: string; exportFailed: string;
};

export const defaultChartLabels: ChartLabels = {
  label: 'Label', series: 'Series', x: 'X', y: 'Y', value: 'Value', row: 'Row',
  time: 'Time', open: 'Open', high: 'High', low: 'Low', close: 'Close', volume: 'Volume', change: 'Change',
  increase: 'Increase', decrease: 'Decrease', total: 'Total', runningTotal: 'Running total', share: 'Share',
  up: 'Up', down: 'Down',
  viewData: 'View data', hideData: 'Hide data', exportSvg: 'Export SVG', exportPng: 'Export PNG', actions: 'Chart actions',
  legend: 'Legend', toggleSeries: 'Show or hide {name}',
  noData: 'No chart data.', invalidData: 'Chart data is invalid.',
  noRenderer: 'No renderer registered for “{kind}”.',
  pieInvalid: 'Pie charts require nonnegative values with a finite positive total.',
  pieExtraSeries: 'Pie displays {name}; all series appear in the table.',
  noPoints: 'This chart has no points to draw.',
  allHidden: 'Every item is hidden. Use the legend to show one.',
  asOf: 'As of', source: 'Source', dataSuffix: 'data',
  describe: '{kind} chart. {series} and {points}.',
  describeRange: '{name} ranges from {min} to {max}.',
  kindNames: {
    bar: 'Bar', trend: 'Line', line: 'Line', area: 'Area', pie: 'Pie', donut: 'Donut', scatter: 'Scatter', histogram: 'Histogram',
    candlestick: 'Candlestick', heatmap: 'Heatmap', waterfall: 'Waterfall',
  },
  exported: 'Chart exported.', exportFailed: 'The chart could not be exported.',
};

export function template(text: string, values: Record<string, string | number>): string {
  return text.replace(/\{(\w+)\}/g, (match, key: string) => Object.hasOwn(values, key) ? String(values[key]) : match);
}
export function resolveChartLabels(partial?: Partial<ChartLabels>): ChartLabels {
  if (!partial) return defaultChartLabels;
  return { ...defaultChartLabels, ...partial, kindNames: { ...defaultChartLabels.kindNames, ...partial.kindNames } };
}
