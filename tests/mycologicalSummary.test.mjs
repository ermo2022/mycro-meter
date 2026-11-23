import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import ts from 'typescript'

const source = readFileSync(new URL('../src/mycologicalSummary.ts', import.meta.url), 'utf8')
const { outputText } = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } })
const module = { exports: {} }
new Function('module', 'exports', outputText)(module, module.exports)
const { summarize, formatMycologicalSummary } = module.exports

const length = summarize([30, 10, 20])
const width = summarize([8, 4, 6])
const q = summarize([3, 1, 2])
const format = (settings) => formatMycologicalSummary(length, width, q, 'µm', settings, 'SD n/a')

test('percentile summaries interpolate for length, width and Q, with optional extremes', () => {
  assert.equal(format({ method: 'p10-p90', extremes: true, decimals: 1 }),
    '(10) 12–28 (30) × (4) 4.4–7.6 (8) µm, Q = (1) 1.2–2.8 (3); N = 3, Me = 20 × 6 µm; Qe = 2')
  assert.equal(format({ method: 'p05-p95', extremes: false, decimals: 2 }),
    '11–29 × 4.2–7.8 µm, Q = 1.1–2.9; Me = 20 × 6 µm; Qe = 2')
})

test('mean summaries use one or two sample standard deviations and optional observed extremes', () => {
  assert.equal(format({ method: 'sd1', extremes: true, decimals: 1 }),
    '(20 ± 10) [10–30] × (6 ± 2) [4–8] µm, Q = (2 ± 1) [1–3]; N = 3, Me = 20 × 6 µm; Qe = 2')
  assert.equal(format({ method: 'sd2', extremes: false, decimals: 1 }),
    '(20 ± 20) × (6 ± 4) µm, Q = (2 ± 2); Me = 20 × 6 µm; Qe = 2')
})

test('precision applies to ranges, medians and SD; one box does not claim an SD', () => {
  const stats = summarize([1.13, 1.37])
  assert.equal(formatMycologicalSummary(stats, stats, stats, 'mm', { method: 'p10-p90', extremes: false, decimals: 2 }, 'SD n/a'),
    '1.15–1.35 × 1.15–1.35 mm, Q = 1.15–1.35; Me = 1.25 × 1.25 mm; Qe = 1.25')
  const single = summarize([1.13])
  assert.match(formatMycologicalSummary(single, single, single, 'mm', { method: 'sd2', extremes: true, decimals: 2 }, 'SD n/a'),
    /^1\.13 \(SD n\/a\) × 1\.13 \(SD n\/a\) mm, Q = 1\.13 \(SD n\/a\); N = 1/)
})
