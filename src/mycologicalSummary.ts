export type SummaryStats = { n: number; mean: number; sampleSd: number | null; min: number; max: number; median: number; p05: number; p10: number; p90: number; p95: number }
export type SummaryMethod = 'p10-p90' | 'p05-p95' | 'sd1' | 'sd2'
export type SummarySettings = { method: SummaryMethod; extremes: boolean; decimals: 1 | 2 }

export function summarize(values: number[]): SummaryStats {
  if (!values.length) return { n: 0, mean: 0, sampleSd: null, min: 0, max: 0, median: 0, p05: 0, p10: 0, p90: 0, p95: 0 }
  const sorted = [...values].sort((a, b) => a - b)
  const mean = values.reduce((total, value) => total + value, 0) / values.length
  const sampleSd = values.length < 2
    ? null
    : Math.sqrt(values.reduce((total, value) => total + (value - mean) ** 2, 0) / (values.length - 1))
  const percentile = (fraction: number) => {
    const position = (sorted.length - 1) * fraction
    const lower = Math.floor(position)
    const upper = Math.ceil(position)
    return sorted[lower] + (sorted[upper] - sorted[lower]) * (position - lower)
  }
  return {
    n: values.length,
    mean,
    sampleSd,
    min: sorted[0],
    max: sorted[sorted.length - 1],
    median: percentile(0.5),
    p05: percentile(0.05),
    p10: percentile(0.1),
    p90: percentile(0.9),
    p95: percentile(0.95),
  }
}

export function formatMycologicalNumber(value: number, decimals: 1 | 2 = 1) {
  return Number(value.toFixed(decimals)).toString()
}

export function formatMycologicalRange(stats: SummaryStats) {
  const lower = stats.min < stats.p10 ? `(${formatMycologicalNumber(stats.min)}) ` : ''
  const upper = stats.max > stats.p90 ? ` (${formatMycologicalNumber(stats.max)})` : ''
  return `${lower}${formatMycologicalNumber(stats.p10)}–${formatMycologicalNumber(stats.p90)}${upper}`
}

export function formatSummary(stats: SummaryStats, unit: string) {
  if (!stats.n) return '—'
  if (stats.sampleSd === null) return `${formatMycologicalNumber(stats.mean)} (SD n/a)${unit ? ` ${unit}` : ''}`
  return `${formatMycologicalNumber(stats.mean)} ± ${formatMycologicalNumber(stats.sampleSd)}${unit ? ` ${unit}` : ''}`
}

export function formatDeciles(stats: SummaryStats, unit: string) {
  if (!stats.n) return '—'
  return `${formatMycologicalRange(stats)}${unit ? ` ${unit}` : ''}`
}

export function formatMycologicalSummary(length: SummaryStats, width: SummaryStats, q: SummaryStats, unit: string, settings: SummarySettings, sdUnavailable: string) {
  const number = (value: number) => formatMycologicalNumber(value, settings.decimals)
  const format = (stats: SummaryStats) => {
    if (settings.method === 'sd1' || settings.method === 'sd2') {
      const value = stats.sampleSd === null
        ? `${number(stats.mean)} (${sdUnavailable})`
        : `(${number(stats.mean)} ± ${number(stats.sampleSd * (settings.method === 'sd2' ? 2 : 1))})`
      return settings.extremes && stats.min !== stats.max ? `${value} [${number(stats.min)}–${number(stats.max)}]` : value
    }
    const lower = settings.method === 'p05-p95' ? stats.p05 : stats.p10
    const upper = settings.method === 'p05-p95' ? stats.p95 : stats.p90
    const min = settings.extremes && stats.min < lower ? `(${number(stats.min)}) ` : ''
    const max = settings.extremes && stats.max > upper ? ` (${number(stats.max)})` : ''
    return `${min}${number(lower)}–${number(upper)}${max}`
  }
  const count = settings.extremes ? `N = ${length.n}, ` : ''
  return `${format(length)} × ${format(width)} ${unit}, Q = ${format(q)}; ${count}Me = ${number(length.median)} × ${number(width.median)} ${unit}; Qe = ${number(q.median)}`
}
