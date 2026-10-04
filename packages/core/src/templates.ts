import type { BlockContent, BlockInput } from './types.js';

/**
 * Report templates: pure functions that return ordered `BlockInput[]` ready for an `insertBlocks` operation.
 * They contain structure and guidance only (no market data), so an agent or a person fills the placeholders.
 * Every template ends with a "Data and methodology" section and an analysis-only note.
 */
export const TEMPLATE_KINDS = ['equity', 'macro', 'portfolio', 'strategy', 'arbitrage', 'comparison', 'blank'] as const;
export type TemplateKind = typeof TEMPLATE_KINDS[number];

export type TemplateOptions = {
  /** Prefix for every block ID (`<prefix>-<slug>`). Default: the template kind. Letters, digits, dot, underscore, colon and hyphen; at most 60 characters. */
  idPrefix?: string;
  /** What the report is about: a ticker, asset, theme or strategy name. A neutral placeholder is used when omitted. */
  subject?: string;
  /** Container that receives the top-level blocks. Default `null` (the document root). */
  parentId?: string | null;
};
export type TemplateInfo = { kind: TemplateKind; title: string; description: string; sections: string[] };
export type TemplateFunction = (options?: TemplateOptions) => BlockInput[];

const PREFIX = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,59}$/;
const SUBJECT_MAX = 200;
const DASH = '—';
const DISCLAIMER = 'This report is analysis for research purposes only. It is not investment advice or a recommendation, and past results do not predict future results.';

type Slot = { slug: string; content: BlockContent };
type Section = { slug: string; title: string; children: Slot[] };
type Resolved = { prefix: string; parentId: string | null; subject: string };

function resolve(kind: TemplateKind, options: TemplateOptions): Resolved {
  const prefix = options.idPrefix ?? kind;
  if (typeof prefix !== 'string' || !PREFIX.test(prefix)) throw new TypeError('idPrefix must start with a letter or digit and use only letters, digits, dot, underscore, colon and hyphen (at most 60 characters).');
  const subject = options.subject === undefined ? '' : cleanSubject(options.subject);
  const parentId = options.parentId ?? null;
  if (parentId !== null && (typeof parentId !== 'string' || parentId.length === 0)) throw new TypeError('parentId must be null or a block ID.');
  return { prefix, parentId, subject };
}
function cleanSubject(value: unknown): string {
  if (typeof value !== 'string') throw new TypeError('subject must be a string.');
  // Collapse whitespace and drop control characters so a subject cannot break the one-line titles.
  const cleaned = value.replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim();
  if (cleaned.length > SUBJECT_MAX) throw new TypeError(`subject must be at most ${SUBJECT_MAX} characters.`);
  return cleaned;
}

const text = (value: string): BlockContent => ({ type: 'paragraph', runs: [{ text: value }] });
const bullets = (items: string[]): BlockContent => ({ type: 'list', ordered: false, items, style: 'bullet' });
const todo = (items: string[]): BlockContent => ({ type: 'list', ordered: false, items, style: 'todo', checked: items.map(() => false) });
const steps = (items: string[]): BlockContent => ({ type: 'list', ordered: true, items, style: 'number' });
const guidance = (title: string, body: string): BlockContent => ({ type: 'callout', tone: 'note', title, runs: [{ text: body }] });
const table = (columns: string[], rows: string[][], caption: string, align?: ('left' | 'center' | 'right')[]): BlockContent =>
  ({ type: 'table', columns, rows, caption, ...(align ? { align } : {}) });
const kpis = (labels: string[], hint: string): BlockContent => ({ type: 'metrics', items: labels.map((label, index) => ({ label, value: DASH, tone: 'neutral' as const, ...(index === 0 ? { hint } : {}) })) });
const blank = (columns: number): string[] => Array.from({ length: columns }, () => '');
const rowsOf = (labels: string[], columns: number): string[][] => labels.map(label => [label, ...Array.from({ length: columns - 1 }, () => DASH)]);

function methodology(extra: string[]): Section {
  return { slug: 'methodology', title: 'Data and methodology', children: [
    { slug: 'methodology-list', content: bullets(['Data sources and the as-of date for each series.', 'Period, frequency and any gaps or adjustments in the data.', ...extra, 'Known limitations of the data and of the method.']) },
    { slug: 'disclaimer', content: { type: 'callout', tone: 'info', title: 'Analysis only', runs: [{ text: DISCLAIMER }] } },
  ] };
}

function assemble(resolved: Resolved, intro: Slot[], sections: Section[]): BlockInput[] {
  const blocks: BlockInput[] = [];
  const id = (slug: string): string => `${resolved.prefix}-${slug}`;
  for (const slot of intro) blocks.push({ id: id(slot.slug), parentId: resolved.parentId, content: slot.content, citationIds: [] });
  for (const section of sections) {
    blocks.push({ id: id(section.slug), parentId: resolved.parentId, content: { type: 'section', title: section.title }, citationIds: [] });
    for (const child of section.children) blocks.push({ id: id(child.slug), parentId: id(section.slug), content: child.content, citationIds: [] });
  }
  return blocks;
}

const subjectOr = (subject: string, fallback: string): string => subject || fallback;

/** Single-asset analysis: summary, performance, risk, indicators, catalysts and risks. */
export const equityTemplate: TemplateFunction = (options = {}) => {
  const r = resolve('equity', options);
  const name = subjectOr(r.subject, 'the asset');
  return assemble(r, [], [
    { slug: 'summary', title: 'Summary', children: [
      { slug: 'summary-kpis', content: kpis(['Last price', '1-year return', 'Annualized volatility', 'Max drawdown'], 'Replace the dashes with computed values and state the as-of date.') },
      { slug: 'summary-thesis', content: text(`State the thesis for ${name} in two or three sentences: what it is, what the data shows, and the main uncertainty.`) },
      { slug: 'summary-takeaways', content: bullets(['First finding, with the number that supports it.', 'Second finding.', 'Third finding or open question.']) },
    ] },
    { slug: 'performance', title: 'Price and performance', children: [
      { slug: 'performance-chart', content: guidance('Chart placeholder', 'Add a line or candlestick chart of the price history (add_chart), then delete this note.') },
      { slug: 'performance-text', content: text('Describe the trend, the largest drawdown and how performance compares with a benchmark over the same window.') },
    ] },
    { slug: 'risk', title: 'Risk profile', children: [
      { slug: 'risk-table', content: table(['Metric', 'Value', 'Reading'], ['Annualized volatility', 'Maximum drawdown', 'Sharpe ratio', 'Beta vs benchmark'].map(label => [label, DASH, '']), 'Risk metrics over the analysis window', ['left', 'right', 'left']) },
      { slug: 'risk-text', content: text('Explain which metric matters most for this asset and why.') },
    ] },
    { slug: 'indicators', title: 'Technical indicators', children: [
      { slug: 'indicators-checklist', content: todo(['Moving averages (SMA / EMA): trend and crossovers', 'RSI: momentum and overextension', 'MACD: momentum shifts', 'Bollinger bands: volatility regime']) },
      { slug: 'indicators-text', content: text('Summarize what the indicators agree on and where they disagree.') },
    ] },
    { slug: 'catalysts', title: 'Catalysts and risks', children: [
      { slug: 'catalysts-table', content: table(['Item', 'Type', 'Evidence'], [blank(3), blank(3)], 'Upcoming catalysts and key risks') },
    ] },
    methodology(['Benchmark used for relative performance and beta.']),
  ]);
};

/** Macro outlook: indicators, rates, calendar, scenarios and risks. */
export const macroTemplate: TemplateFunction = (options = {}) => {
  const r = resolve('macro', options);
  const name = subjectOr(r.subject, 'the economy');
  return assemble(r, [], [
    { slug: 'summary', title: 'Summary', children: [
      { slug: 'summary-kpis', content: kpis(['Growth', 'Inflation', 'Policy rate', '10-year yield'], 'Replace the dashes with the latest readings and state the as-of date.') },
      { slug: 'summary-view', content: text(`Give the overall view on ${name} in three sentences: where the cycle stands, what changed since the last report, and what to watch next.`) },
    ] },
    { slug: 'indicators', title: 'Growth, inflation and labour', children: [
      { slug: 'indicators-chart', content: guidance('Chart placeholder', 'Add a line chart of the key indicators (add_chart) and delete this note.') },
      { slug: 'indicators-text', content: text('Interpret the trend in each indicator and name the data release that would change the view.') },
    ] },
    { slug: 'rates', title: 'Rates and curve', children: [
      { slug: 'rates-chart', content: guidance('Chart placeholder', 'Add a line or area chart of policy and market rates, or a curve snapshot, and delete this note.') },
      { slug: 'rates-text', content: text('Describe the shape of the curve and what the market is pricing in.') },
    ] },
    { slug: 'calendar', title: 'Calendar', children: [
      { slug: 'calendar-table', content: table(['Date', 'Event', 'Prior', 'Consensus', 'Actual'], [blank(5), blank(5), blank(5)], 'Upcoming releases and events', ['left', 'left', 'right', 'right', 'right']) },
    ] },
    { slug: 'scenarios', title: 'Scenarios', children: [
      { slug: 'scenarios-table', content: table(['Scenario', 'Assumptions', 'Likelihood', 'What it would show in the data'], [['Base', '', '', ''], ['Upside', '', '', ''], ['Downside', '', '', '']], 'Scenario summary') },
    ] },
    { slug: 'risks', title: 'Risks to the view', children: [
      { slug: 'risks-list', content: steps(['Largest risk and the signal that would confirm it.', 'Second risk.', 'Third risk.']) },
    ] },
    methodology(['Release dates and any data revisions.']),
  ]);
};

/** Portfolio review: allocation, performance, risk, correlation and concentration. */
export const portfolioTemplate: TemplateFunction = (options = {}) => {
  const r = resolve('portfolio', options);
  const name = subjectOr(r.subject, 'the portfolio');
  return assemble(r, [], [
    { slug: 'summary', title: 'Summary', children: [
      { slug: 'summary-kpis', content: kpis(['Total return', 'Annualized volatility', 'Max drawdown', 'Sharpe ratio'], 'Replace the dashes with computed values for the analysis window.') },
      { slug: 'summary-view', content: text(`Summarize ${name} in three sentences: what drives returns, where the risk sits, and the one thing to review first.`) },
    ] },
    { slug: 'allocation', title: 'Allocation', children: [
      { slug: 'allocation-chart', content: guidance('Chart placeholder', 'Add a donut or pie chart of the weights (add_chart) and delete this note.') },
      { slug: 'allocation-table', content: table(['Asset', 'Weight', 'Return', 'Contribution'], [blank(4), blank(4), blank(4)], 'Holdings, weights and contribution to return', ['left', 'right', 'right', 'right']) },
    ] },
    { slug: 'performance', title: 'Performance vs benchmark', children: [
      { slug: 'performance-chart', content: guidance('Chart placeholder', 'Add a line chart of the rebased portfolio and benchmark (both start at 100) and delete this note.') },
      { slug: 'performance-text', content: text('Explain where the portfolio led or lagged the benchmark and why.') },
    ] },
    { slug: 'risk', title: 'Risk and correlation', children: [
      { slug: 'risk-chart', content: guidance('Chart placeholder', 'Add a heatmap of the correlation matrix and a bar chart of risk contribution, then delete this note.') },
      { slug: 'risk-text', content: text('Point out the most correlated pairs and the holdings that dominate risk.') },
    ] },
    { slug: 'concentration', title: 'Concentration observations', children: [
      { slug: 'concentration-list', content: bullets(['Largest single exposure and its share of risk.', 'Overlap between holdings.', 'Anything that would change if one holding were removed.']) },
    ] },
    methodology(['Rebalancing rule used in the history (none, weekly or monthly).']),
  ]);
};

/** Rule-based strategy backtest: rules, setup, results, robustness and limitations. */
export const strategyTemplate: TemplateFunction = (options = {}) => {
  const r = resolve('strategy', options);
  const name = subjectOr(r.subject, 'the strategy');
  return assemble(r, [], [
    { slug: 'summary', title: 'Summary', children: [
      { slug: 'summary-kpis', content: kpis(['CAGR', 'Max drawdown', 'Sharpe ratio', 'Win rate'], 'Replace the dashes with backtest results and name the test window.') },
      { slug: 'summary-view', content: text(`Describe ${name} in two sentences and state whether the backtest supports the idea once costs are included.`) },
    ] },
    { slug: 'rules', title: 'Strategy rules', children: [
      { slug: 'rules-table', content: table(['Component', 'Definition'], [['Universe', ''], ['Signal', ''], ['Parameters', ''], ['Rebalance frequency', '']], 'Rules as tested') },
    ] },
    { slug: 'setup', title: 'Backtest setup', children: [
      { slug: 'setup-table', content: table(['Assumption', 'Value'], [['Test window', ''], ['Data frequency', ''], ['Fees', ''], ['Slippage', ''], ['Starting capital', '']], 'Assumptions used in the backtest') },
    ] },
    { slug: 'results', title: 'Results', children: [
      { slug: 'results-chart', content: guidance('Chart placeholder', 'Add a line chart of the equity curve against a benchmark and an area chart of drawdown, then delete this note.') },
      { slug: 'results-text', content: text('Describe the return profile, the worst period and how long recovery took.') },
    ] },
    { slug: 'robustness', title: 'Robustness checks', children: [
      { slug: 'robustness-checklist', content: todo(['Parameter sensitivity: results across nearby settings', 'Sub-period stability: first half vs second half', 'Cost sensitivity: results with higher fees and slippage', 'Benchmark comparison: same window and data']) },
    ] },
    { slug: 'limitations', title: 'Limitations', children: [
      { slug: 'limitations-list', content: bullets(['Overfitting risk: the rules were chosen with hindsight.', 'The test window may not contain the conditions that matter.', 'Backtest results are hypothetical and exclude real-world frictions that were not modelled.']) },
    ] },
    methodology(['Exact rule definitions and parameter values.', 'Fee and slippage model.']),
  ]);
};

/** Pair or spread (relative-value) analysis: pair selection, hedge ratio, spread, signal rule and costs. */
export const arbitrageTemplate: TemplateFunction = (options = {}) => {
  const r = resolve('arbitrage', options);
  const name = subjectOr(r.subject, 'the pair');
  return assemble(r, [], [
    { slug: 'summary', title: 'Summary', children: [
      { slug: 'summary-kpis', content: kpis(['Hedge ratio', 'Spread z-score', 'Half-life (days)', 'Correlation'], 'Replace the dashes with computed values and state the window.') },
      { slug: 'summary-view', content: text(`Summarize the relationship in ${name}: how the two series move together, how stretched the spread is now, and how reliable the relationship has been.`) },
    ] },
    { slug: 'pair', title: 'Pair selection', children: [
      { slug: 'pair-chart', content: guidance('Chart placeholder', 'Add a line chart of the two series rebased to 100 and delete this note.') },
      { slug: 'pair-text', content: text('Explain why these two series should be related and what could break the relationship.') },
    ] },
    { slug: 'spread', title: 'Hedge ratio and spread', children: [
      { slug: 'spread-chart', content: guidance('Chart placeholder', 'Add a line chart of the spread z-score with annotations at the signal thresholds, then delete this note.') },
      { slug: 'spread-text', content: text('Report the regression hedge ratio, how stable it is over time, and the spread half-life.') },
    ] },
    { slug: 'signal', title: 'Signal rule backtest', children: [
      { slug: 'signal-table', content: table(['Item', 'Value'], [['Open threshold (z-score)', ''], ['Close threshold (z-score)', ''], ['Stop level (z-score)', ''], ['Hypothetical PnL', ''], ['Round trips', '']], 'Hypothetical backtest of the spread rule') },
      { slug: 'signal-text', content: text('Describe the results and how sensitive they are to the thresholds.') },
    ] },
    { slug: 'costs', title: 'Costs and frictions', children: [
      { slug: 'costs-list', content: bullets(['Fees on both legs.', 'Funding or borrow cost for holding the spread.', 'Slippage and timing gaps between the two legs.']) },
      { slug: 'costs-text', content: text('State how much of the hypothetical result remains after these costs.') },
    ] },
    { slug: 'risks', title: 'Risks', children: [
      { slug: 'risks-list', content: bullets(['Regime change: the relationship stops holding.', 'Liquidity: one leg cannot be sized as assumed.', 'Data quality: gaps, bad ticks or mismatched timestamps.']) },
    ] },
    methodology(['Regression method and window for the hedge ratio.', 'Definition of the spread and the z-score.']),
  ]);
};

/** Side-by-side comparison of two or more assets. */
export const comparisonTemplate: TemplateFunction = (options = {}) => {
  const r = resolve('comparison', options);
  const name = subjectOr(r.subject, 'the assets');
  return assemble(r, [], [
    { slug: 'summary', title: 'Summary', children: [
      { slug: 'summary-view', content: text(`Compare ${name} in three sentences: which leads on return, which on risk-adjusted return, and what separates them.`) },
      { slug: 'summary-takeaways', content: bullets(['Key difference in performance.', 'Key difference in risk.', 'What stays uncertain.']) },
    ] },
    { slug: 'metrics', title: 'Metric comparison', children: [
      { slug: 'metrics-table', content: table(['Metric', 'Asset A', 'Asset B', 'Asset C'], rowsOf(['Total return', 'Annualized volatility', 'Max drawdown', 'Sharpe ratio', 'Correlation with Asset A'], 4), 'Metrics over the same window', ['left', 'right', 'right', 'right']) },
    ] },
    { slug: 'performance', title: 'Rebased performance', children: [
      { slug: 'performance-chart', content: guidance('Chart placeholder', 'Add a line chart with every asset rebased to 100 at the start (add_chart) and delete this note.') },
      { slug: 'performance-text', content: text('Describe when the assets diverged and what drove it.') },
    ] },
    { slug: 'correlation', title: 'Correlation', children: [
      { slug: 'correlation-chart', content: guidance('Chart placeholder', 'Add a heatmap of the correlation matrix and delete this note.') },
      { slug: 'correlation-text', content: text('Explain how much diversification the assets offer each other.') },
    ] },
    methodology(['Common window and frequency used for every asset.']),
  ]);
};

/** A single empty paragraph, so an editor has a block to focus. */
export const blankTemplate: TemplateFunction = (options = {}) => {
  const r = resolve('blank', options);
  return assemble(r, [{ slug: 'intro', content: { type: 'paragraph', runs: [] } }], []);
};

export const TEMPLATES: Readonly<Record<TemplateKind, TemplateFunction>> = Object.freeze({
  equity: equityTemplate, macro: macroTemplate, portfolio: portfolioTemplate, strategy: strategyTemplate,
  arbitrage: arbitrageTemplate, comparison: comparisonTemplate, blank: blankTemplate,
});

const DESCRIPTIONS: Record<TemplateKind, { title: string; description: string }> = {
  equity: { title: 'Equity analysis', description: 'One asset: summary, price and performance, risk profile, indicators, catalysts and risks.' },
  macro: { title: 'Macro outlook', description: 'Growth, inflation and rates, an event calendar, scenarios and risks to the view.' },
  portfolio: { title: 'Portfolio review', description: 'Allocation, performance against a benchmark, risk and correlation, concentration.' },
  strategy: { title: 'Strategy backtest', description: 'Rules, backtest assumptions, results, robustness checks and limitations.' },
  arbitrage: { title: 'Pair and spread analysis', description: 'Pair selection, hedge ratio and spread, a hypothetical signal-rule backtest, costs and risks.' },
  comparison: { title: 'Asset comparison', description: 'A metric table, rebased performance and correlation for two or more assets.' },
  blank: { title: 'Untitled report', description: 'One empty paragraph.' },
};

export function isTemplateKind(value: unknown): value is TemplateKind {
  return typeof value === 'string' && (TEMPLATE_KINDS as readonly string[]).includes(value);
}

/** Document title that goes with a template, for example `BTC: equity analysis`. */
export function templateTitle(kind: TemplateKind, subject?: string): string {
  const cleaned = subject === undefined ? '' : cleanSubject(subject);
  const base = DESCRIPTIONS[kind].title;
  if (!cleaned || kind === 'blank') return base;
  return `${cleaned}: ${base.charAt(0).toLowerCase()}${base.slice(1)}`;
}

/** Template blocks for `kind`. Throws a TypeError for an unknown kind or invalid options. */
export function createTemplate(kind: TemplateKind, options: TemplateOptions = {}): BlockInput[] {
  if (!isTemplateKind(kind)) throw new TypeError(`Unknown template "${String(kind)}". Use one of: ${TEMPLATE_KINDS.join(', ')}.`);
  return TEMPLATES[kind](options);
}

export function listTemplates(): TemplateInfo[] {
  return TEMPLATE_KINDS.map(kind => ({
    kind, title: DESCRIPTIONS[kind].title, description: DESCRIPTIONS[kind].description,
    sections: createTemplate(kind).filter(block => block.content.type === 'section').map(block => block.content.type === 'section' ? block.content.title : ''),
  }));
}
