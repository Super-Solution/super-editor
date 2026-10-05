import assert from 'node:assert/strict';
import test from 'node:test';
import type { ChartSpec } from '@super-solution/editor-core';
import {
  bandScale, chartDataTable, chartFileName, chartToSvg, createPaint, decimalsForStep, describeChart, formatCompact, formatCurrency, formatNumber, formatPercent, formatTick, formatValue,
  hitTest, isRenderedKind, labelStride, layoutChart, linearScale, niceNumber, niceTicks, pointScale, sceneToSvg, stepHit, tooltipPlacement, truncate, waterfallSteps, safeColor,
  contrastRatio, mixHex, parseColor, pickInk,
} from '@super-solution/editor-ui';
import type { ChartLayout, SceneNode } from '@super-solution/editor-ui';

const labels = ['Jan', 'Feb', 'Mar', 'Apr'];
const base = (over: Partial<ChartSpec> & { kind: string }): ChartSpec => ({ title: 'T', labels, series: [{ name: 'A', values: [1, 2, 3, 4] }], ...over });
const leaves = (nodes: readonly SceneNode[]): SceneNode[] => nodes.flatMap((node) => node.children ? leaves(node.children) : [node]);
const count = (layout: ChartLayout, tag: string): number => leaves(layout.scene).filter((node) => node.tag === tag).length;
const numericAttributes = (layout: ChartLayout): number[] => leaves(layout.scene).flatMap((node) => Object.values(node.attrs).filter((value): value is number => typeof value === 'number'));

test('niceTicks produces round, covering, ascending ticks', () => {
  const cases: [number, number, number][] = [[0, 100, 5], [0, 7, 5], [3.2, 97.8, 5], [-12, 48, 6], [0.001, 0.0093, 5], [1_200_000, 9_400_000, 5], [-5, -1, 4]];
  for (const [lo, hi, target] of cases) {
    const { ticks, min, max, step } = niceTicks(lo, hi, target);
    assert.ok(min <= lo + 1e-9 && max >= hi - 1e-9, `covers ${lo}..${hi}`);
    assert.ok(ticks.length >= 2 && ticks.length <= target + 3, `count for ${lo}..${hi}: ${ticks.length}`);
    for (let index = 1; index < ticks.length; index++) assert.ok(Math.abs(ticks[index]! - ticks[index - 1]! - step) < step * 1e-6, 'even steps');
    const mantissa = step / 10 ** Math.floor(Math.log10(step));
    assert.ok([1, 2, 5, 10].some((nice) => Math.abs(mantissa - nice) < 1e-9), `nice step ${step}`);
  }
  assert.deepEqual(niceTicks(0, 100, 5).ticks, [0, 20, 40, 60, 80, 100]);
  assert.deepEqual(niceTicks(0, 10, 6).ticks, [0, 2, 4, 6, 8, 10]);
  assert.deepEqual(niceTicks(0.1, 0.5, 5).ticks, [0.1, 0.2, 0.3, 0.4, 0.5]);
});

test('niceTicks widens a flat range and survives extreme magnitudes', () => {
  const flat = niceTicks(5, 5);
  assert.ok(flat.min < 5 && flat.max > 5);
  const zero = niceTicks(0, 0);
  assert.ok(zero.min < 0 && zero.max > 0);
  const extreme = niceTicks(-Number.MAX_VALUE, Number.MAX_VALUE);
  assert.ok(extreme.ticks.every(Number.isFinite) && extreme.ticks.length >= 2);
  assert.deepEqual(niceTicks(Number.NaN, 4).ticks.length > 1, true);
  assert.equal(niceNumber(0, true), 1);
  assert.equal(niceNumber(Number.POSITIVE_INFINITY, false), 1);
});

test('scales map domain to range, invert, and clamp bands', () => {
  const y = linearScale([0, 100], [200, 0]);
  assert.equal(y(0), 200); assert.equal(y(100), 0); assert.equal(y(50), 100); assert.equal(y.invert(100), 50);
  assert.equal(linearScale([5, 5], [0, 10])(5), 5, 'flat domain centers');
  assert.ok(Number.isFinite(linearScale([-Number.MAX_VALUE, Number.MAX_VALUE], [0, 100])(Number.MAX_VALUE)));
  const band = bandScale(4, [0, 400], 0.2, 0.1);
  assert.ok(Math.abs(band.step * (4 - 0.2 + 0.2) - 400) < 1e-9);
  assert.ok(band.bandwidth < band.step && band.center(0) > 0 && band.center(3) < 400);
  assert.equal(band.indexAt(-50), 0); assert.equal(band.indexAt(9999), 3);
  const points = pointScale(5, [0, 100]);
  assert.equal(points(0), 0); assert.equal(points(4), 100); assert.equal(points.indexAt(51), 2);
  assert.equal(pointScale(1, [0, 100])(0), 50);
});

test('label thinning and truncation never overflow', () => {
  assert.equal(labelStride(10, 500, 40), 1);
  assert.equal(labelStride(100, 500, 50), 10);
  assert.equal(labelStride(1, 10, 100), 1);
  assert.equal(truncate('short', 200, 11), 'short');
  const cut = truncate('A very long category label that cannot fit', 60, 11);
  assert.ok(cut.endsWith('…') && cut.length < 20);
});

test('number formats: number, percent, currency, compact and units', () => {
  assert.equal(formatNumber(1234567.891), '1,234,567.89');
  assert.equal(formatNumber(1234.5, 'en-US', 0), '1,235');
  assert.equal(formatNumber(-0), '0');
  assert.equal(formatNumber(Number.NaN), '–');
  assert.equal(formatNumber(Infinity), '∞');
  assert.equal(formatPercent(0.1234), '12.34%');
  assert.equal(formatPercent(0.5, 'en-US', 0), '50%');
  assert.equal(formatCurrency(1234.5), '$1,234.50');
  assert.match(formatCurrency(1234.5, 'EUR', 'de-DE'), /^1\.234,50\s€$/);
  assert.equal(formatCurrency(5, 'XXX9'), 'XXX9 5');
  assert.equal(formatCompact(1_200_000), '1.2M');
  assert.equal(formatCompact(950), '950');
  assert.equal(formatCompact(12_000, 'en-US', 0), '12K');
  assert.equal(formatNumber(Number.MAX_VALUE).includes('e+'), true);
  // Convention: percent is a ratio unless the unit is already "%".
  assert.equal(formatValue(0.25, { format: 'percent' }), '25%');
  assert.equal(formatValue(25, { format: 'number', unit: '%' }), '25%');
  assert.equal(formatValue(25, { format: 'percent', unit: '%' }), '25%');
  assert.equal(formatValue(3.5, { unit: 'bps' }), '3.5 bps');
  assert.equal(formatValue(1500, { format: 'compact', unit: 'USD' }), '1.5K USD');
  assert.equal(formatValue(99.5, { format: 'currency', currency: 'USD' }), '$99.50');
});

test('tick labels match the step so ticks never print rounding noise', () => {
  assert.equal(decimalsForStep(0.25), 2);
  assert.equal(decimalsForStep(5), 0);
  assert.equal(decimalsForStep(0.5), 1);
  assert.equal(formatTick(0.3, 0.1), '0.3');
  assert.equal(formatTick(1_500_000, 500_000), '1.5M');
  assert.equal(formatTick(0.05, 0.01, { format: 'percent' }), '5%');
  assert.equal(formatTick(40, 10, { unit: '%' }), '40%');
  assert.equal(formatTick(2500, 500, { format: 'currency', currency: 'USD' }), '$2,500');
});

test('every supported kind lays out finite geometry, a description and hover targets', () => {
  const specs: ChartSpec[] = [
    base({ kind: 'line' }), base({ kind: 'trend' }), base({ kind: 'area', stacked: true, series: [{ name: 'A', values: [1, 2, 3, 4] }, { name: 'B', values: [2, 2, 2, 2] }] }),
    base({ kind: 'bar' }), base({ kind: 'bar', stacked: true, series: [{ name: 'A', values: [1, -2, 3, 4] }, { name: 'B', values: [2, 2, -2, 2] }] }),
    base({ kind: 'bar', horizontal: true, series: [{ name: 'A', values: [1, 2, 3, 4] }, { name: 'B', values: [4, 3, 2, 1] }] }),
    base({ kind: 'pie' }), base({ kind: 'donut' }),
    base({ kind: 'histogram' }), base({ kind: 'waterfall', series: [{ name: 'D', values: [100, 10, -5, 105] }] }),
    base({ kind: 'scatter', points: [{ series: 'S', x: 1, y: 2 }, { series: 'S', x: 3, y: 5 }, { series: 'T', x: 4, y: 1 }] }),
    base({ kind: 'candlestick', ohlc: [{ t: 'a', o: 1, h: 3, l: 0.5, c: 2, v: 10 }, { t: 'b', o: 2, h: 3, l: 1, c: 1.5 }] }),
    base({ kind: 'heatmap', matrix: { rows: ['r1', 'r2'], columns: ['c1', 'c2', 'c3'], values: [[1, 2, 3], [-1, 0, 1]] } }),
  ];
  for (const spec of specs) {
    const layout = layoutChart(spec, { width: 640 });
    const name = `${spec.kind}${spec.stacked ? ' stacked' : ''}${spec.horizontal ? ' horizontal' : ''}`;
    assert.equal(layout.supported, true, name);
    assert.equal(layout.message, undefined, name);
    assert.ok(layout.scene.length > 0, `${name} draws`);
    assert.ok(layout.hits.length > 0, `${name} has hover targets`);
    assert.ok(layout.description.startsWith('T.'), `${name} description: ${layout.description}`);
    assert.ok(numericAttributes(layout).every(Number.isFinite), `${name} finite`);
    assert.ok(layout.width === 640 && layout.height >= 60, name);
    for (const hit of layout.hits) {
      assert.ok(Number.isFinite(hit.anchor.x) && Number.isFinite(hit.anchor.y), `${name} anchor`);
      assert.ok(hit.rows.length > 0 && hit.title, `${name} tooltip`);
    }
    const svg = sceneToSvg(layout.scene);
    assert.doesNotMatch(svg, /NaN|undefined|Infinity/, name);
  }
});

test('unknown kinds and degenerate data fall back to a message instead of throwing', () => {
  const unknown = layoutChart(base({ kind: 'sankey' }));
  assert.equal(unknown.supported, false);
  assert.match(unknown.message!, /No renderer registered for “sankey”/);
  assert.equal(unknown.scene.length, 0);
  assert.equal(isRenderedKind('sankey'), false);
  assert.equal(isRenderedKind('waterfall'), true);
  assert.match(layoutChart(base({ kind: 'bar', series: [{ name: 'A', values: [1, Number.NaN, 3, 4] }] })).message!, /invalid/i);
  assert.match(layoutChart(base({ kind: 'bar', series: [{ name: 'A', values: [1, 2] }] })).message!, /invalid/i);
  assert.match(layoutChart({ kind: 'bar', title: 'T', labels: [], series: [] }).message!, /No chart data/);
  assert.match(layoutChart(base({ kind: 'pie', series: [{ name: 'A', values: [Number.MAX_VALUE, Number.MAX_VALUE, 1, 1] }] })).message!, /finite/);
  assert.match(layoutChart(base({ kind: 'pie', series: [{ name: 'A', values: [1, -1, 1, 1] }] })).message!, /nonnegative/);
  assert.match(layoutChart(base({ kind: 'scatter' })).message!, /no points/i);
  assert.match(layoutChart(base({ kind: 'candlestick' })).message!, /no points/i);
  assert.match(layoutChart(base({ kind: 'heatmap', matrix: { rows: ['r'], columns: ['c'], values: [[Number.NaN]] } })).message!, /invalid/i);
});

test('a single point, a flat series and extreme values stay drawable', () => {
  for (const kind of ['line', 'area', 'bar', 'histogram']) {
    const one = layoutChart({ kind, title: 'One', labels: ['x'], series: [{ name: 'A', values: [5] }] });
    assert.ok(one.scene.length && numericAttributes(one).every(Number.isFinite), `${kind} single`);
    const flat = layoutChart({ kind, title: 'Flat', labels: ['x', 'y', 'z'], series: [{ name: 'A', values: [2, 2, 2] }] });
    assert.ok(flat.scene.length && numericAttributes(flat).every(Number.isFinite), `${kind} flat`);
    const huge = layoutChart({ kind, title: 'Huge', labels: ['a', 'b'], series: [{ name: 'A', values: [-Number.MAX_VALUE, Number.MAX_VALUE] }] });
    assert.ok(numericAttributes(huge).every(Number.isFinite), `${kind} extreme`);
  }
});

test('legend toggles remove a series and its hover rows; pie slices toggle individually', () => {
  const spec = base({ kind: 'line', series: [{ name: 'A', values: [1, 2, 3, 4] }, { name: 'B', values: [4, 3, 2, 1] }] });
  const both = layoutChart(spec), onlyB = layoutChart(spec, { hidden: new Set(['0']) });
  assert.deepEqual(both.legend.map((item) => [item.label, item.hidden]), [['A', false], ['B', false]]);
  assert.deepEqual(onlyB.legend.map((item) => [item.label, item.hidden]), [['A', true], ['B', false]]);
  assert.equal(count(both, 'polyline'), 2); assert.equal(count(onlyB, 'polyline'), 1);
  assert.equal(both.hits[0]!.rows.length, 2); assert.equal(onlyB.hits[0]!.rows.length, 1);
  const none = layoutChart(spec, { hidden: new Set(['0', '1']) });
  assert.match(none.message!, /hidden/i);
  assert.equal(none.legend.length, 2, 'the legend stays so a series can be turned back on');
  assert.equal(layoutChart(base({ kind: 'line' })).legend.length, 0, 'one series needs no legend');
  const pie = base({ kind: 'pie', series: [{ name: 'W', values: [50, 30, 20, 0] }] });
  const hidden = layoutChart(pie, { hidden: new Set(['0']) });
  assert.equal(hidden.hits.length, 2);
  assert.equal(layoutChart(pie).legend.length, 4);
  assert.equal(layoutChart(pie).hits.length, 3, 'zero-value slices have no hover target');
});

test('stacked bars stack, grouped bars sit side by side, horizontal bars swap axes', () => {
  const series = [{ name: 'A', values: [1, 2, 3, 4] }, { name: 'B', values: [1, 2, 3, 4] }];
  const rects = (layout: ChartLayout) => leaves(layout.scene).filter((node) => node.tag === 'rect' && node.attrs['data-series'] !== undefined);
  const grouped = rects(layoutChart(base({ kind: 'bar', series })));
  const stacked = rects(layoutChart(base({ kind: 'bar', stacked: true, series })));
  assert.equal(grouped.length, 8); assert.equal(stacked.length, 8);
  const [firstA, firstB] = [grouped[0]!, grouped[4]!];
  assert.equal(firstA.attrs.y, firstB.attrs.y, 'grouped bars share a baseline');
  assert.notEqual(firstA.attrs.x, firstB.attrs.x);
  const [stackA, stackB] = [stacked[0]!, stacked[4]!];
  assert.equal(stackA.attrs.x, stackB.attrs.x, 'stacked bars share a column');
  assert.ok(Number(stackB.attrs.y) < Number(stackA.attrs.y), 'the second series sits on top');
  const horizontal = layoutChart(base({ kind: 'bar', horizontal: true, series }));
  assert.ok(horizontal.height > 120);
  const bars = leaves(horizontal.scene).filter((node) => node.tag === 'rect' && node.attrs['data-series'] !== undefined);
  assert.ok(Number(bars[3]!.attrs.width) > Number(bars[0]!.attrs.width), 'bar length encodes value');
});

test('yAxis min, max and format drive the scale and tick labels', () => {
  const layout = layoutChart(base({ kind: 'line', series: [{ name: 'A', values: [10, 20, 30, 40] }], yAxis: { min: 0, max: 100, format: 'percent' } }));
  const ticks = leaves(layout.scene).filter((node) => node.tag === 'text').map((node) => node.text);
  assert.ok(ticks.includes('0%') || ticks.includes('0.00%') || ticks.length > 0);
  assert.ok(ticks.some((text) => text?.endsWith('%')));
  const top = leaves(layout.scene).filter((node) => node.tag === 'line' && node.attrs.y1 === node.attrs.y2).map((node) => Number(node.attrs.y1));
  assert.ok(Math.min(...top) >= layout.plot.y - 0.01 && Math.max(...top) <= layout.plot.y + layout.plot.height + 0.01, 'grid stays inside the plot');
  const currency = layoutChart(base({ kind: 'bar', series: [{ name: 'A', values: [1500, 2500, 3500, 4500] }], yAxis: { format: 'currency', currency: 'USD' } }));
  assert.ok(leaves(currency.scene).some((node) => node.tag === 'text' && /^\$[\d,]+$/.test(node.text ?? '')));
  const compact = layoutChart(base({ kind: 'bar', series: [{ name: 'A', values: [1_500_000, 2_500_000, 3_500_000, 4_500_000] }], yAxis: { format: 'compact' } }));
  assert.ok(leaves(compact.scene).some((node) => node.tag === 'text' && /M$/.test(node.text ?? '')));
  // Values above a pinned max are clamped to the plot instead of escaping it.
  const clipped = layoutChart(base({ kind: 'bar', series: [{ name: 'A', values: [1, 2, 3, 400] }], yAxis: { min: 0, max: 5 } }));
  const tall = leaves(clipped.scene).filter((node) => node.tag === 'rect' && node.attrs['data-series'] !== undefined);
  assert.ok(tall.every((node) => Number(node.attrs.y) >= clipped.plot.y - 0.01));
});

test('annotations attach to their label and add a marker when a value is given', () => {
  const layout = layoutChart(base({ kind: 'line', annotations: [{ label: 'Halving', at: 'Mar' }, { label: 'ETF', at: 'Apr', value: 4 }] }));
  const texts = leaves(layout.scene).filter((node) => node.tag === 'text').map((node) => node.text);
  assert.ok(texts.includes('Halving') && texts.includes('ETF'));
  const dashed = leaves(layout.scene).filter((node) => node.tag === 'line' && node.attrs['stroke-dasharray'] === '4 3');
  assert.equal(dashed.length, 2);
  assert.ok(leaves(layout.scene).some((node) => node.tag === 'circle' && node.attrs['stroke-width'] === 2));
  const none = layoutChart(base({ kind: 'line', annotations: [{ label: 'Lost', at: 'Nowhere' }] }));
  assert.ok(!leaves(none.scene).some((node) => node.text === 'Lost'), 'annotations on unknown labels are skipped');
});

test('waterfall steps classify totals and keep a running balance', () => {
  const steps = waterfallSteps(['Start', 'Trading', 'Fees', 'End'], [100, 12, -3, 109]);
  assert.deepEqual(steps.map((step) => step.role), ['total', 'up', 'down', 'total']);
  assert.deepEqual(steps.map((step) => step.running), [100, 112, 109, 109]);
  assert.equal(steps[3]!.start, 0);
  assert.deepEqual(waterfallSteps(['a', 'b'], [5, -2]).map((step) => [step.start, step.end]), [[0, 5], [5, 3]]);
  const layout = layoutChart(base({ kind: 'waterfall', labels: ['Start', 'Trading', 'Fees', 'End'], series: [{ name: 'D', values: [100, 12, -3, 109] }] }));
  assert.deepEqual(layout.legend.map((item) => item.label), ['Increase', 'Decrease', 'Total']);
  assert.ok(layout.legend.every((item) => !item.toggle));
  assert.equal(layout.hits[1]!.rows[0]!.value, '+12');
  assert.equal(layout.hits[1]!.rows[1]!.label, 'Running total');
});

test('hit testing finds bands, circles and slices; keyboard stepping clamps', () => {
  const line = layoutChart(base({ kind: 'line' }), { width: 640 });
  const target = hitTest(line, line.plot.x + line.plot.width * 0.5, line.plot.y + 5);
  assert.ok(target && ['1', '2'].includes(target.id));
  assert.equal(hitTest(line, -10, -10), undefined);
  assert.deepEqual(target!.rows.map((row) => row.label), ['A']);
  assert.ok(target!.crosshair && target!.markers?.length === 1);
  const scatter = layoutChart(base({ kind: 'scatter', points: [{ series: 'S', x: 0, y: 0 }, { series: 'S', x: 10, y: 10 }] }));
  const near = scatter.hits[1]!;
  const circle = near.shape;
  assert.equal(circle.type, 'circle');
  if (circle.type === 'circle') assert.equal(hitTest(scatter, circle.cx + 2, circle.cy + 2)?.id, near.id);
  const pie = layoutChart(base({ kind: 'pie', series: [{ name: 'W', values: [25, 25, 25, 25] }] }));
  const first = pie.hits[0]!.shape;
  if (first.type === 'arc') {
    const middle = (first.start + first.end) / 2, radius = (first.inner + first.outer) / 2;
    assert.equal(hitTest(pie, first.cx + radius * Math.cos(middle), first.cy + radius * Math.sin(middle))?.id, '0');
    assert.equal(hitTest(pie, first.cx + (first.outer + 40) * Math.cos(middle), first.cy + (first.outer + 40) * Math.sin(middle)), undefined);
  } else assert.fail('pie hit should be an arc');
  assert.equal(stepHit(line, undefined, 1)?.id, '0');
  assert.equal(stepHit(line, '3', 1)?.id, '3');
  assert.equal(stepHit(line, '1', -9)?.id, '0');
  assert.equal(stepHit({ ...line, hits: [] }, undefined, 1), undefined);
  const place = tooltipPlacement(line.hits[0]!, line);
  assert.equal(place.horizontal, 'start');
  assert.equal(tooltipPlacement(line.hits[3]!, line).horizontal, 'end');
});

test('responsive layout: narrow widths relayout with fewer ticks and thinned labels', () => {
  const many = Array.from({ length: 40 }, (_, index) => `Label ${index}`);
  const spec = { kind: 'bar', title: 'Wide data', labels: many, series: [{ name: 'A', values: many.map((_, index) => index) }] };
  const wide = layoutChart(spec, { width: 900 }), narrow = layoutChart(spec, { width: 300 });
  const xLabels = (layout: ChartLayout) => leaves(layout.scene).filter((node) => node.tag === 'text' && node.text?.startsWith('Label')).length;
  assert.ok(xLabels(narrow) < xLabels(wide));
  assert.ok(xLabels(narrow) <= 8);
  assert.equal(narrow.width, 300);
  assert.equal(layoutChart(spec, { width: 20 }).width, 160, 'a minimum width keeps the layout sane');
});

test('colors: palette resolves per mode and theme, and only safe colors pass', () => {
  const css = createPaint(), fixed = createPaint({ mode: 'static', theme: 'dark' });
  assert.match(css.series(0), /^var\(--se-series-1, #2563eb\)$/);
  assert.equal(fixed.series(0), '#60a5fa');
  assert.equal(css.series(10), css.series(0), 'the palette wraps');
  assert.equal(css.series(1, '#abcdef'), '#abcdef');
  assert.match(css.series(1, 'url(javascript:alert(1))'), /var\(--se-series-2/);
  assert.equal(safeColor('red'), 'red'); assert.equal(safeColor('var(--brand)'), 'var(--brand)');
  assert.equal(safeColor('expression(alert(1))'), null); assert.equal(safeColor(5), null);
  assert.match(css.mix('heatMid', 'heatPos', 0.5), /^color-mix\(in srgb, var\(--se-heat-high/);
  assert.match(fixed.mix('heatMid', 'heatPos', 0.5), /^#[0-9a-f]{6}$/);
});

test('scene serializer escapes text and attributes', () => {
  const svg = sceneToSvg([{ tag: 'text', attrs: { x: 1, y: 2, 'aria-label': 'a"b<c>' }, text: '<script>alert(1)</script> & more' }]);
  assert.match(svg, /&lt;script&gt;alert\(1\)&lt;\/script&gt; &amp; more/);
  assert.match(svg, /aria-label="a&quot;b&lt;c&gt;"/);
  assert.doesNotMatch(svg, /<script/);
});

test('data table fallback exists for every kind, with exact values', () => {
  const line = chartDataTable(base({ kind: 'line', unit: 'USD' }));
  assert.equal(line.caption, 'T (USD) — data');
  assert.deepEqual(line.headers, ['Label', 'A']);
  assert.deepEqual(line.rows[0], ['Jan', '1']);
  assert.deepEqual(chartDataTable(base({ kind: 'scatter', points: [{ series: 'S', x: 1.5, y: 2 }] })).headers, ['Series', 'X', 'Y']);
  const candles = chartDataTable(base({ kind: 'candlestick', ohlc: [{ t: 'd1', o: 1, h: 2, l: 0.5, c: 1.5, v: 9 }] }));
  assert.deepEqual(candles.headers, ['Time', 'Open', 'High', 'Low', 'Close', 'Volume']); assert.deepEqual(candles.rows[0], ['d1', '1', '2', '0.5', '1.5', '9']);
  const heat = chartDataTable(base({ kind: 'heatmap', matrix: { rows: ['r1'], columns: ['a', 'b'], values: [[1, 2]] } }));
  assert.deepEqual(heat.headers, ['Row', 'a', 'b']); assert.deepEqual(heat.rows[0], ['r1', '1', '2']);
  assert.equal(chartDataTable(base({ kind: 'sankey' })).rows.length, 4, 'unknown kinds still get a table');
  assert.match(describeChart(base({ kind: 'line' })), /^T\. Line chart\. 1 series and 4 points\. A ranges from 1 to 4\.$/);
  assert.match(describeChart(base({ kind: 'candlestick', ohlc: [{ t: 'd1', o: 1, h: 2, l: 0.5, c: 1.5 }] })), /1 candle\./);
});

test('exported SVG is self-contained: resolved colors, title, legend and provenance', () => {
  const spec = base({ kind: 'line', title: 'BTC <vs> ETH', series: [{ name: 'BTC', values: [1, 2, 3, 4] }, { name: 'ETH', values: [2, 1, 4, 3] }], source: 'OKX daily candles', asOf: '2026-10-05T00:00:00.000Z', caption: 'A caption' });
  const light = chartToSvg(spec, { width: 800 });
  assert.equal(light.width, 800);
  assert.match(light.svg, /^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg"/);
  assert.doesNotMatch(light.svg, /var\(--/, 'no CSS variables survive');
  assert.match(light.svg, /BTC &lt;vs&gt; ETH/);
  assert.match(light.svg, /Source: OKX daily candles/);
  assert.match(light.svg, /As of: 2026-10-05/);
  assert.match(light.svg, />ETH</);
  assert.match(light.svg, /#2563eb/);
  const dark = chartToSvg(spec, { theme: 'dark', hidden: new Set(['1']) });
  assert.match(dark.svg, /#60a5fa/); assert.match(dark.svg, /fill="#15181d"/);
  assert.match(dark.svg, /text-decoration="line-through"/, 'hidden series are struck through in the legend');
  assert.ok(dark.height > 200);
  const failed = chartToSvg(base({ kind: 'sankey' }));
  assert.match(failed.svg, /No renderer registered/);
  assert.equal(chartFileName(base({ kind: 'line', title: 'BTC / ETH: weekly (2026)' }), 'png'), 'btc-eth-weekly-2026.png');
  assert.equal(chartFileName(base({ kind: 'line', title: '!!!' }), 'svg'), 'chart.svg');
  assert.equal(chartFileName(base({ kind: 'line', title: '比特幣 週報' }), 'svg'), '比特幣-週報.svg');
});

// ---- heat-map label contrast ---------------------------------------------------------------------------------------------------------

/** Each cell's fill and the ink of its value label (the label follows its cell's rect in the scene). */
function heatCells(layout: ChartLayout): { fill: string; ink: string }[] {
  const nodes = leaves(layout.scene), cells: { fill: string; ink: string }[] = [];
  nodes.forEach((node, index) => {
    const before = nodes[index - 1];
    if (node.tag === 'text' && node.attrs['text-anchor'] === 'middle' && before?.tag === 'rect' && before.attrs.rx === 2) cells.push({ fill: String(before.attrs.fill), ink: String(node.attrs.fill) });
  });
  return cells;
}
const ramp = (rows: number, columns: number, low: number, high: number): number[][] => Array.from({ length: rows }, (_, r) => Array.from({ length: columns }, (_, c) => low + (high - low) * ((r * columns + c) / (rows * columns - 1))));
const heatSpec = (values: number[][]): ChartSpec => base({ kind: 'heatmap', matrix: { rows: values.map((_, index) => `r${index}`), columns: values[0]!.map((_, index) => `c${index}`), values } });
const inkOf = (cell: { ink: string }): string => /ink-(\w+)/.exec(cell.ink)![1]!;

test('contrastRatio, pickInk and parseColor follow WCAG and CSS', () => {
  assert.equal(contrastRatio('#000000', '#ffffff'), 21);
  assert.equal(contrastRatio('#ffffff', '#ffffff'), 1);
  assert.ok(contrastRatio('#767676', '#ffffff') >= 4.5 && contrastRatio('#777777', '#ffffff') < 4.5, 'the well-known AA edge: #767676 passes on white and #777777 does not');
  const dark = { color: '#000000', value: 'dark' }, light = { color: '#ffffff', value: 'light' };
  assert.equal(pickInk('#ffffff', dark, light), 'dark');
  assert.equal(pickInk('#000000', dark, light), 'light');
  assert.equal(pickInk('#2563eb', dark, light), 'light', 'only white reaches 4.5:1 on the series blue');
  assert.equal(pickInk('#ea580c', dark, light), 'dark', 'only black reaches 4.5:1 on the heat orange');
  // Neither reaches it: the better one still wins.
  assert.equal(pickInk('#808080', { color: '#707070', value: 'a' }, { color: '#a0a0a0', value: 'b' }), 'b');
  assert.equal(pickInk('#808080', { color: '#303030', value: 'a' }, { color: '#9a9a9a', value: 'b' }), 'a');
  // Both reach it: the larger ratio.
  assert.equal(pickInk('#f0f0f0', { color: '#000000', value: 'a' }, { color: '#222222', value: 'b' }), 'a');
  for (const [text, hex] of [
    ['#abc', '#aabbcc'], ['#AABBCC', '#aabbcc'], ['#aabbccdd', '#aabbcc'], ['rgb(37, 99, 235)', '#2563eb'], ['rgb(37 99 235 / 50%)', '#2563eb'], ['rgba(37,99,235,.5)', '#2563eb'], ['rgb(100% 0% 0%)', '#ff0000'],
    ['hsl(221 83% 53%)', '#2463eb'], ['hsl(0, 100%, 50%)', '#ff0000'], ['oklch(0.546 0.245 262.881)', '#155dfc'], ['oklch(100% 0 0)', '#ffffff'], ['oklab(0 0 0)', '#000000'], ['white', '#ffffff'], ['black', '#000000'], ['  #FFF ', '#ffffff'],
  ] as const) assert.equal(parseColor(text), hex, text);
  for (const text of ['', 'none', 'var(--x)', 'color-mix(in srgb, red, blue)', 'rgb(none 0 0)', 'currentColor', 'Canvas', '#12', 'rgb(1 2)', 'rebeccapurple', 'oklch(from red l c h)']) assert.equal(parseColor(text), null, text);
});

test('heat-map labels reach WCAG 4.5:1 on every cell, in the light and dark palettes, in the layout and in the exported SVG', () => {
  for (const values of [ramp(10, 10, -1, 1), ramp(10, 10, 0, 100), ramp(6, 8, -250, 40), ramp(5, 5, 3, 3.0001), [[-1, 0, 1]]]) {
    for (const theme of ['light', 'dark'] as const) {
      const layout = layoutChart(heatSpec(values), { width: 800, paint: createPaint({ mode: 'static', theme }) });
      const cells = heatCells(layout);
      assert.equal(cells.length, values.length * values[0]!.length, `${theme}: every cell is labelled`);
      for (const { fill, ink } of cells) {
        assert.match(fill, /^#[0-9a-f]{6}$/, 'a static export has resolved fills');
        assert.ok(contrastRatio(fill, ink) >= 4.5, `${theme}: ${ink} on ${fill} is ${contrastRatio(fill, ink).toFixed(2)}:1`);
      }
    }
  }
  // Both inks are in use when the fills run from pale to saturated (so the check above is not satisfied by one color for everything).
  for (const theme of ['light', 'dark'] as const) {
    const inks = new Set(heatCells(layoutChart(heatSpec(ramp(10, 10, -1, 1)), { width: 800, paint: createPaint({ mode: 'static', theme }) })).map((cell) => cell.ink));
    assert.deepEqual([...inks].sort(), ['#000000', '#ffffff'], theme);
  }
  // The exported SVG carries them as plain colors, and nothing of the old fixed ink is left.
  for (const theme of ['light', 'dark'] as const) {
    const { svg } = chartToSvg(heatSpec(ramp(8, 8, -1, 1)), { theme, width: 800 });
    assert.doesNotMatch(svg, /#111827|var\(--/);
    assert.match(svg, /<text[^>]*fill="#000000"[^>]*text-anchor="middle"/);
    assert.match(svg, /<text[^>]*fill="#ffffff"[^>]*text-anchor="middle"/);
  }
  // The zero cell of a diverging map is the neutral color: pale on light, near black on dark. That is where a fixed dark ink failed.
  for (const [theme, expected] of [['light', '#000000'], ['dark', '#ffffff']] as const) {
    const zero = heatCells(layoutChart(heatSpec([[-1, 0, 1]]), { width: 640, paint: createPaint({ mode: 'static', theme }) }))[1]!;
    assert.equal(zero.ink, expected, `${theme} zero cell`);
  }
});

test('heat-map labels follow the colors a page really uses (host palettes, dark pages), and fall back to the better ink when none reaches 4.5:1', () => {
  // A deterministic sweep of host palettes: the ink must be the better one, and 4.5:1 whenever either ink reaches it.
  let seed = 7;
  const random = (): number => { seed = (seed * 1664525 + 1013904223) % 4294967296; return seed / 4294967296; };
  const hex = (): string => `#${Math.floor(random() * 0x1000000).toString(16).padStart(6, '0')}`;
  const values = ramp(6, 6, -1, 1);
  for (const [inkDark, inkLight] of [['#000000', '#ffffff'], ['#111827', '#ffffff'], ['#1f2937', '#f9fafb'], ['#404040', '#d0d0d0']] as const) {
    for (let round = 0; round < 80; round++) {
      const colors = { heatMid: hex(), heatPos: hex(), heatNeg: hex(), inkDark, inkLight };
      const layout = layoutChart(heatSpec(values), { width: 640, paint: createPaint({ colors }) });
      const flat = values.flat(), limit = Math.max(...flat.map(Math.abs));
      const cells = heatCells(layout);
      assert.equal(cells.length, flat.length);
      cells.forEach((cell, index) => {
        const value = flat[index]!;
        const background = mixHex(colors.heatMid, value < 0 ? colors.heatNeg : colors.heatPos, Math.abs(value) / limit);
        const onDark = contrastRatio(background, inkDark), onLight = contrastRatio(background, inkLight);
        const expected = (onDark >= 4.5) !== (onLight >= 4.5) ? (onDark >= 4.5 ? 'dark' : 'light') : (onDark >= onLight ? 'dark' : 'light');
        assert.equal(inkOf(cell), expected, `${JSON.stringify(colors)} value ${value}`);
        if (inkDark === '#000000') assert.ok(Math.max(onDark, onLight) >= 4.5, 'pure black and white can always reach 4.5:1');
      });
    }
  }
  // The label is painted from the ink token (so a host can restyle it) with the built-in color as the fallback.
  const sample = heatCells(layoutChart(heatSpec([[0, 1]]), { width: 640, paint: createPaint({ colors: { heatMid: '#ffffff', heatPos: '#000000' } }) }));
  assert.deepEqual(sample.map((cell) => cell.ink), ['var(--se-chart-ink-dark, #000000)', 'var(--se-chart-ink-light, #ffffff)']);
  // A dark page: near zero the cell is dark, so the ink is light, and it stays painted from the live tokens.
  const darkPage = { heatMid: '#1c2026', heatPos: '#60a5fa', heatNeg: '#fb923c' };
  const near = heatCells(layoutChart(heatSpec([[-1, -.05, 0, .05, 1]]), { width: 640, paint: createPaint({ colors: darkPage }) }));
  assert.deepEqual(near.map(inkOf), ['dark', 'light', 'light', 'light', 'dark']);
  assert.match(near[2]!.fill, /^color-mix\(in srgb, var\(--se-heat-high, #2563eb\) 0%, var\(--se-heat-mid, #f8fafc\)\)$/);
  // Without live colors the built-in light palette is assumed, which is what the markup of a server render uses.
  assert.deepEqual(heatCells(layoutChart(heatSpec([[-1, 0, 1]]), { width: 640 })).map(inkOf), ['dark', 'dark', 'light']);
  // For paper: print.css swaps in the light palette whatever the screen shows, so each label also says which ink suits those cells.
  const printed = leaves(layoutChart(heatSpec([[-1, 0, 1]]), { width: 640, paint: createPaint({ colors: darkPage }) }).scene).filter((node) => node.attrs['data-print-ink'] !== undefined);
  assert.deepEqual(printed.map((node) => node.attrs['data-print-ink']), ['dark', 'dark', 'light']);
  assert.equal(leaves(layoutChart(heatSpec([[-1, 0, 1]]), { width: 640, paint: createPaint({ mode: 'static' }) }).scene).filter((node) => node.attrs['data-print-ink'] !== undefined).length, 0, 'not in exports');
});
