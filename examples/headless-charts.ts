import { pathToFileURL } from 'node:url';
import { b, chart, createDocument, createEditor, stats, toMarkdown, transaction, type Editor } from '@super-solution/editor-core';

/**
 * Headless: no DOM, no network. An analysis step produces numbers; the chart builders turn them into serializable specs;
 * a guarded transaction puts them in the document. Run it with:
 *   npx tsx --conditions=development examples/headless-charts.ts
 */
export function buildChartReport(): Editor {
  const now = () => '2026-10-05T09:00:00.000Z';
  const editor = createEditor(createDocument({ id: 'headless-charts', title: 'Headless chart report' }, { now }), { now });

  // 1. Pretend analysis output (fictional daily closes and a correlation matrix).
  const days = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri'];
  const alpha = [100, 102, 101, 104, 107];
  const beta = [100, 100.5, 99, 101, 102];
  const correlation = [[1, 0.71], [0.71, 1]];

  // 2. Build blocks. Specs are plain data, so they can be stored, sent over HTTP or handed to any renderer.
  const result = transaction(editor, { id: 'analysis-job', kind: 'agent' })
    .addCitation({ id: 'src-prices', title: 'Example price feed', url: 'https://example.com/prices', accessedAt: now() })
    .insert([
      b.section('performance', 'Performance'),
      b.chart('rebased', chart.line({ title: 'Rebased performance (start = 100)', labels: days, series: [{ name: 'Alpha', values: alpha }, { name: 'Beta', values: beta }], yAxis: { label: 'Index', format: 'number' }, source: 'Example price feed', asOf: now(), annotations: [{ label: 'Rate decision', at: 'Thu' }] }), { parentId: 'performance', citationIds: ['src-prices'] }),
      b.chart('candles', chart.candlestick({ title: 'Alpha daily candles', ohlc: [{ t: 'Mon', o: 99, h: 102, l: 98, c: 100 }, { t: 'Tue', o: 100, h: 103, l: 99.5, c: 102 }, { t: 'Wed', o: 102, h: 103, l: 100, c: 101 }] }), { parentId: 'performance' }),
      b.chart('corr', chart.heatmap({ title: 'Correlation', rows: ['Alpha', 'Beta'], columns: ['Alpha', 'Beta'], values: correlation }), { parentId: 'performance' }),
      b.paragraph('read', 'Alpha led Beta by **5 points** over the week.[^src-prices]', { parentId: 'performance' }),
    ])
    .commit();
  if (!result.ok) throw new Error(JSON.stringify(result.issues));
  return editor;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const editor = buildChartReport();
  const snapshot = editor.getSnapshot();
  console.log(toMarkdown(snapshot));
  console.log(JSON.stringify(stats(snapshot), null, 2));
}
