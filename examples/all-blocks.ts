import { b, chart, createDocument, createEditor, createReportService, transaction, type Editor } from '@super-solution/editor-core';

/**
 * A fictional document that uses every block type, every chart kind, every inline mark, every callout tone and every list style.
 * It is the visual regression fixture for renderers and the sample for exporters. All numbers are invented.
 */
export function createAllBlocksExample(): Editor {
  const at = '2026-10-05T00:00:00.000Z';
  const now = () => at;
  const editor = createEditor(createDocument({ id: 'all-blocks', title: 'Sample report: every block and chart' }, { now }), { now });
  const tx = transaction(editor, { id: 'fixture-author', kind: 'system' }, { id: 'seed-all-blocks' });
  tx.setTitle('Sample report: every block and chart')
    .addCitation({ id: 'src-method', title: 'Example methodology note', url: 'https://example.com/methodology', accessedAt: at, publishedAt: '2026-09-30T00:00:00.000Z' })
    .addCitation({ id: 'src-data', title: 'Example data provider', url: 'https://example.com/data', accessedAt: at });

  const labels = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun'];
  tx.insert([
    b.heading('title', 1, 'Sample report'),
    b.paragraph('intro', 'Every block below is **fictional sample data**: _italic_, ~~strike~~, `code` and a [link](https://example.com/page) are inline marks.[^src-method]'),
    b.toc('toc'),
    b.metrics('kpis', [
      { label: 'Return', value: '12.4%', change: 1.5, tone: 'up', hint: 'Year to date' },
      { label: 'Volatility', value: '18.1%', change: -0.4, tone: 'down' },
      { label: 'Max drawdown', value: '-9.7%', tone: 'neutral' },
      { label: 'Sharpe ratio', value: '1.31' },
    ]),
    b.divider('rule-1'),

    b.section('text-blocks', 'Text blocks'),
    b.heading('h2', 2, 'Heading level 2', { parentId: 'text-blocks' }),
    b.heading('h3', 3, 'Heading level 3', { parentId: 'text-blocks' }),
    b.paragraph('marks', 'Plain, **bold**, _italic_, `code`, ~~strike~~ and a [link](https://example.com/marks).', { parentId: 'text-blocks' }),
    b.paragraph('marks-extra', [
      { text: 'Underline', underline: true }, { text: ', ' },
      ...(['yellow', 'green', 'blue', 'pink', 'gray'] as const).flatMap(color => [{ text: `${color} highlight`, highlight: color }, { text: ' ' }]),
      { text: 'and a sourced claim', bold: true }, { text: '', citationId: 'src-data' }, { text: '.' },
    ], { parentId: 'text-blocks' }),
    b.quote('quote', 'Markets can stay irrational longer than a model can stay solvent.', { parentId: 'text-blocks', attribution: 'A fictional strategist' }),
    b.code('code-ts', 'ts', 'const rebased = prices.map(price => (price / prices[0]) * 100);', { parentId: 'text-blocks' }),
    b.callout('tone-info', 'info', 'Information: a neutral note.', { parentId: 'text-blocks', title: 'Info' }),
    b.callout('tone-success', 'success', 'Success: a check that passed.', { parentId: 'text-blocks', title: 'Success' }),
    b.callout('tone-warning', 'warning', 'Warning: the data is **delayed**.', { parentId: 'text-blocks', title: 'Warning', citationIds: ['src-data'] }),
    b.callout('tone-danger', 'danger', 'Danger: a limit was breached.', { parentId: 'text-blocks', title: 'Danger' }),
    b.callout('tone-note', 'note', 'Note: something to remember.', { parentId: 'text-blocks' }),

    b.section('lists-tables', 'Lists and tables'),
    b.list('bullets', ['Growth is slowing', 'Inflation is falling', 'Rates are on hold'], { parentId: 'lists-tables', indent: [0, 1, 0] }),
    b.list('steps', ['Collect data', 'Clean it', 'Chart it'], { parentId: 'lists-tables', style: 'number' }),
    b.list('todo', ['Draft', 'Review', 'Publish'], { parentId: 'lists-tables', checked: [true, true, false] }),
    b.table('table', ['Asset', 'Weight', 'Return'], [['Alpha', '40%', '+12.4%'], ['Beta', '35%', '+8.1%'], ['Gamma', '25%', '-1.2%']], { parentId: 'lists-tables', align: ['left', 'right', 'right'], caption: 'Sample allocation', headerColumn: true }),

    b.section('charts', 'Charts'),
    b.chart('chart-line', chart.line({ title: 'Rebased performance', labels, series: [{ name: 'Alpha', values: [100, 103, 101, 106, 109, 112] }, { name: 'Benchmark', values: [100, 101, 100, 103, 104, 106] }], yAxis: { label: 'Index (start = 100)', format: 'number' }, source: 'Sample data', caption: 'Both series start at 100.', annotations: [{ label: 'Rate decision', at: 'Apr' }] }), { parentId: 'charts', citationIds: ['src-data'] }),
    b.chart('chart-trend', chart.trend({ title: 'Inflation path', labels, values: [3.8, 3.5, 3.4, 3.1, 3, 2.9], unit: '%', asOf: at }), { parentId: 'charts' }),
    b.chart('chart-area', chart.area({ title: 'Cumulative flow', labels, series: [{ name: 'Inflow', values: [1, 2, 4, 5, 7, 9] }, { name: 'Outflow', values: [0.5, 1, 2, 2.5, 3, 4] }], stacked: true }), { parentId: 'charts' }),
    b.chart('chart-bar', chart.bar({ title: 'Quarterly revenue', labels: ['Q1', 'Q2', 'Q3', 'Q4'], series: [{ name: 'This year', values: [12, 14, 13, 17] }, { name: 'Last year', values: [10, 11, 12, 13] }], yAxis: { format: 'currency', currency: 'USD' }, unit: 'M' }), { parentId: 'charts' }),
    b.chart('chart-bar-stacked', chart.bar({ title: 'Revenue by region (stacked)', labels: ['Q1', 'Q2', 'Q3', 'Q4'], series: [{ name: 'North', values: [5, 6, 5, 8] }, { name: 'South', values: [4, 5, 5, 6] }, { name: 'East', values: [3, 3, 3, 3] }], stacked: true }), { parentId: 'charts' }),
    b.chart('chart-bar-horizontal', chart.bar({ title: 'Factor exposure', labels: ['Quality', 'Value', 'Momentum', 'Size'], values: [0.6, -0.2, 0.3, -0.4], horizontal: true }), { parentId: 'charts' }),
    b.chart('chart-pie', chart.pie({ title: 'Allocation', labels: ['Alpha', 'Beta', 'Gamma'], values: [40, 35, 25], unit: '%' }), { parentId: 'charts' }),
    b.chart('chart-donut', chart.donut({ title: 'Risk contribution', labels: ['Alpha', 'Beta', 'Gamma'], values: [55, 30, 15], unit: '%' }), { parentId: 'charts' }),
    b.chart('chart-scatter', chart.scatter({ title: 'Risk and return', points: [{ series: 'Alpha', x: 18, y: 12 }, { series: 'Beta', x: 12, y: 8 }, { series: 'Gamma', x: 25, y: -1 }], xLabel: 'Volatility (%)', yAxis: { label: 'Return (%)' } }), { parentId: 'charts' }),
    b.chart('chart-histogram', chart.histogram({ title: 'Daily return distribution', labels: ['<-2%', '-2..-1%', '-1..0%', '0..1%', '1..2%', '>2%'], values: [3, 12, 41, 46, 15, 4], xLabel: 'Daily return' }), { parentId: 'charts' }),
    b.chart('chart-candles', chart.candlestick({ title: 'Sample candles', ohlc: [{ t: 'd1', o: 100, h: 104, l: 99, c: 103, v: 1200 }, { t: 'd2', o: 103, h: 106, l: 101, c: 102, v: 900 }, { t: 'd3', o: 102, h: 107, l: 100, c: 106, v: 1500 }, { t: 'd4', o: 106, h: 108, l: 103, c: 104, v: 1100 }] }), { parentId: 'charts' }),
    b.chart('chart-heatmap', chart.heatmap({ title: 'Correlation matrix', rows: ['Alpha', 'Beta', 'Gamma'], columns: ['Alpha', 'Beta', 'Gamma'], values: [[1, 0.62, -0.1], [0.62, 1, 0.05], [-0.1, 0.05, 1]] }), { parentId: 'charts' }),
    b.chart('chart-waterfall', chart.waterfall({ title: 'Return attribution', labels: ['Start', 'Selection', 'Allocation', 'Costs', 'End'], values: [0, 9.1, 4.2, -0.9, 12.4], unit: '%' }), { parentId: 'charts' }),

    b.section('media', 'Media and structure'),
    b.image('image', 'https://example.com/images/sample-chart.png', 'A sample chart image', { parentId: 'media', caption: 'Figure 1: an image block (HTTPS only).', width: 'wide' }),
    b.embed('embed', 'https://example.com/superchart/sample', 'Embedded chart slot', { parentId: 'media', height: 400 }),
    b.timestamp('asof', at, 'Data as of', { parentId: 'media' }),
    b.toggle('details', 'Details (a toggle holds blocks)', { parentId: 'media', open: true }),
    b.paragraph('details-text', 'A toggle is a container, like a section.', { parentId: 'details' }),
    b.list('details-list', ['Nested content', 'inside a toggle'], { parentId: 'details' }),
    b.pageBreak('break'),
    b.section('methodology', 'Data and methodology'),
    b.paragraph('methodology-text', 'All data in this document is invented to exercise the editor. It is analysis for research purposes only.', { parentId: 'methodology', citationIds: ['src-method'] }),
  ]);
  const result = tx.commit();
  if (!result.ok) throw new Error(`all-blocks fixture is invalid: ${JSON.stringify(result.issues)}`);
  // The fixture is the session baseline; undo should affect later edits, not erase the sample.
  return createEditor(result.document, { now });
}

/** Same document through the shared service, for hosts that only hold a ReportService. */
export const createAllBlocksService = () => createReportService(createAllBlocksExample());
