/** Number formatting for chart axes and tooltips. Pure, locale-aware, and deterministic for a given locale. */
export type NumberFormat = 'number' | 'percent' | 'currency' | 'compact';
export type FormatOptions = {
  format?: NumberFormat | undefined;
  currency?: string | undefined;
  /** `%` means values are already percentage points; any other unit is appended after the number. */
  unit?: string | undefined;
  locale?: string | undefined;
  /** Fixed number of fraction digits. Axis ticks derive it from the tick step. */
  decimals?: number | undefined;
};

const cache = new Map<string, Intl.NumberFormat>();
function formatter(locale: string, options: Intl.NumberFormatOptions): Intl.NumberFormat {
  const key = `${locale}|${JSON.stringify(options)}`;
  let found = cache.get(key);
  if (!found) {
    try { found = new Intl.NumberFormat(locale, options); } catch { found = new Intl.NumberFormat('en-US', options); }
    if (cache.size > 200) cache.clear();
    cache.set(key, found);
  }
  return found;
}
const clean = (text: string): string => text.replace(/^[-−]0(?:\.0+)?(?=\D*$)/, '0');

/** Fraction digits needed to print multiples of `step` exactly (0.25 needs 2, 5 needs 0). */
export function decimalsForStep(step: number): number {
  if (!Number.isFinite(step) || step <= 0) return 0;
  const digits = Math.ceil(-Math.log10(step) - 1e-9);
  return Math.max(0, Math.min(8, digits));
}

export function formatNumber(value: number, locale = 'en-US', decimals?: number): string {
  if (Number.isNaN(value)) return '–';
  if (!Number.isFinite(value)) return value > 0 ? '∞' : '−∞';
  if (Math.abs(value) >= 1e21) return value.toExponential(2);
  const options: Intl.NumberFormatOptions = decimals === undefined ? { maximumFractionDigits: 2 } : { minimumFractionDigits: decimals, maximumFractionDigits: decimals };
  return clean(formatter(locale, options).format(value));
}
export function formatCompact(value: number, locale = 'en-US', decimals?: number): string {
  if (!Number.isFinite(value)) return formatNumber(value, locale);
  if (Math.abs(value) >= 1e21) return value.toExponential(2);
  return clean(formatter(locale, { notation: 'compact', maximumFractionDigits: decimals === undefined ? 1 : Math.min(decimals, 2) }).format(value));
}
/** `value` is a ratio: 0.125 prints as 12.5%. */
export function formatPercent(value: number, locale = 'en-US', decimals?: number): string {
  if (!Number.isFinite(value)) return formatNumber(value, locale);
  return clean(formatter(locale, decimals === undefined ? { style: 'percent', maximumFractionDigits: 2 } : { style: 'percent', minimumFractionDigits: decimals, maximumFractionDigits: decimals }).format(value));
}
export function formatCurrency(value: number, currency = 'USD', locale = 'en-US', decimals?: number): string {
  if (!Number.isFinite(value)) return formatNumber(value, locale);
  if (Math.abs(value) >= 1e21) return `${currency} ${value.toExponential(2)}`;
  const base: Intl.NumberFormatOptions = { style: 'currency', currency };
  try {
    return formatter(locale, decimals === undefined ? { ...base, maximumFractionDigits: 2 } : { ...base, minimumFractionDigits: decimals, maximumFractionDigits: decimals }).format(value);
  } catch { return `${currency} ${formatNumber(value, locale, decimals)}`; }
}

/**
 * Formats one value for a tooltip or table. Convention: `percent` treats the value as a ratio (0.25 is 25%),
 * except when the chart `unit` is "%", where values are already percentage points (25 is 25%).
 */
export function formatValue(value: number, options: FormatOptions = {}): string {
  const { format, currency, unit, locale = 'en-US', decimals } = options;
  if (unit === '%' && (format === undefined || format === 'number' || format === 'percent')) return `${formatNumber(value, locale, decimals)}%`;
  switch (format) {
    case 'percent': return formatPercent(value, locale, decimals);
    case 'currency': return formatCurrency(value, currency, locale, decimals);
    case 'compact': return unit ? `${formatCompact(value, locale, decimals)} ${unit}` : formatCompact(value, locale, decimals);
    default: return unit ? `${formatNumber(value, locale, decimals)} ${unit}` : formatNumber(value, locale, decimals);
  }
}

/** Axis ticks: no unit suffix on each tick (the axis title carries it), but `%`, currency and compact stay. */
export function formatTick(value: number, step: number, options: FormatOptions = {}): string {
  const { format, currency, unit, locale = 'en-US' } = options;
  const decimals = decimalsForStep(step);
  if (unit === '%' && (format === undefined || format === 'number' || format === 'percent')) return `${formatNumber(value, locale, decimals)}%`;
  switch (format) {
    case 'percent': return formatPercent(value, locale, decimalsForStep(step * 100));
    case 'currency': return formatCurrency(value, currency, locale, decimals);
    case 'compact': return formatCompact(value, locale, decimals);
    default: return Math.abs(value) >= 1e6 && format === undefined ? formatCompact(value, locale, decimals) : formatNumber(value, locale, decimals);
  }
}
