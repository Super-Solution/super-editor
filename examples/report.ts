import { createDocument, createEditor, type Editor } from '@super-editor/core';

/** Fictional fixed fixture. No account, market feed, secrets, or trade execution. */
export function createResearchExample(): Editor {
  const now = () => '2026-10-03T00:00:00.000Z';
  const editor = createEditor(createDocument({ id: 'weekly-research', title: 'Weekly research notebook' }, { now }), { now });
  const result = editor.apply({
    id: 'seed-report', actor: { id: 'example-author', kind: 'system' }, baseRevision: 0,
    operations: [
      { type: 'addCitation', citation: { id: 'source-method', title: 'Example methodology', url: 'https://example.com/research-method', accessedAt: now() } },
      { type: 'insertBlock', block: { id: 'macro', parentId: null, citationIds: [], content: { type: 'section', title: 'Macro outlook' } } },
      { type: 'insertBlock', block: { id: 'macro-heading', parentId: 'macro', citationIds: [], content: { type: 'heading', level: 2, text: 'A measured view of growth' } } },
      { type: 'insertBlock', block: { id: 'macro-summary', parentId: 'macro', citationIds: ['source-method'], content: { type: 'paragraph', runs: [{ text: 'Illustrative scenario: ', bold: true }, { text: 'growth moderates while inflation remains uneven. These fictional observations show a research workflow, not live data or recommendations.' }] } } },
      { type: 'insertBlock', block: { id: 'macro-trend', parentId: 'macro', citationIds: ['source-method'], content: { type: 'chart', spec: { kind: 'trend', title: 'Illustrative inflation path', labels: ['Q1', 'Q2', 'Q3', 'Q4'], series: [{ name: 'Scenario', values: [3.8, 3.3, 3.1, 2.9] }], unit: '%', asOf: now() } } } },
      { type: 'insertBlock', block: { id: 'portfolio', parentId: null, citationIds: [], content: { type: 'section', title: 'Portfolio research' } } },
      { type: 'insertBlock', block: { id: 'portfolio-heading', parentId: 'portfolio', citationIds: [], content: { type: 'heading', level: 3, text: 'Exposure and concentration' } } },
      { type: 'insertBlock', block: { id: 'portfolio-summary', parentId: 'portfolio', citationIds: [], content: { type: 'paragraph', runs: [{ text: 'Review concentration, duration, liquidity, and the assumptions behind each thesis. Allocation figures below are a fixture.' }] } } },
      { type: 'insertBlock', block: { id: 'allocation', parentId: 'portfolio', citationIds: [], content: { type: 'chart', spec: { kind: 'pie', title: 'Illustrative allocation', labels: ['Equity', 'Bonds', 'Cash'], series: [{ name: 'Weight', values: [55, 30, 15] }], unit: '%' } } } },
      { type: 'insertBlock', block: { id: 'factor', parentId: 'portfolio', citationIds: [], content: { type: 'chart', spec: { kind: 'bar', title: 'Illustrative factor exposure', labels: ['Quality', 'Value', 'Momentum'], series: [{ name: 'Score', values: [0.6, -0.2, 0.3] }] } } } },
      { type: 'insertBlock', block: { id: 'research-table', parentId: 'portfolio', citationIds: [], content: { type: 'table', columns: ['Research area', 'Review question'], rows: [['Stock / ETF', 'What changes the earnings or index thesis?'], ['Arbitrage research', 'Do costs, borrow constraints, and timing erase the spread?']] } } },
      { type: 'insertBlock', block: { id: 'next-steps', parentId: 'portfolio', citationIds: [], content: { type: 'list', ordered: false, items: ['Refresh source citations before distribution.', 'Separate observed data from scenario assumptions.', 'Record human review and unresolved questions.'] } } },
      { type: 'insertBlock', block: { id: 'chart-embed', parentId: 'portfolio', citationIds: [], content: { type: 'embed', provider: 'superchart', title: 'SuperChart provider slot', url: 'https://example.com/superchart-placeholder' } } },
      { type: 'insertBlock', block: { id: 'as-of', parentId: null, citationIds: [], content: { type: 'timestamp', label: 'Fixture as of', at: now() } } }
    ]
  });
  if (!result.ok) throw new Error(JSON.stringify(result.issues));
  // The fixture is the session baseline; undo should affect user/agent work, not erase the seed.
  return createEditor(result.document, { now });
}
