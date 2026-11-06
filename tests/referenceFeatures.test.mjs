import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import test from 'node:test'
import ts from 'typescript'

const require = createRequire(import.meta.url)
const cv = await require('@techstark/opencv-js')
const source = readFileSync(new URL('../src/referenceFeatures.ts', import.meta.url), 'utf8')
const { outputText } = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
})
const module = { exports: {} }
new Function('require', 'module', 'exports', outputText)(() => ({}), module, module.exports)
const { analyzeReferencePatch, extractPatch } = module.exports

function ringPatch(size, outerRadius, innerRadius, spore, hole, background) {
  const data = new Uint8Array(size * size)
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const radius = Math.hypot(x + 0.5 - size / 2, y + 0.5 - size / 2)
      data[y * size + x] = radius <= innerRadius ? hole : radius <= outerRadius ? spore : background
    }
  }
  return cv.matFromArray(size, size, cv.CV_8UC1, data)
}

test('reference area fills refraction holes in a dark spore', () => {
  const patch = ringPatch(60, 20, 10, 40, 230, 220)
  try {
    const result = analyzeReferencePatch(cv, patch)
    assert.ok(Math.abs(result.area - Math.PI * 20 ** 2) < Math.PI * 20 ** 2 * 0.08, `area ${result.area}`)
    assert.ok(result.outline.length > 4)
    assert.ok(Math.abs(result.histogram.reduce((total, value) => total + value, 0) - 1) < 1e-9)
    assert.equal(result.polarity, 'dark')
  } finally {
    patch.delete()
  }
})

test('reference area detects a bright spore on a dark background', () => {
  const patch = ringPatch(60, 18, 0, 220, 220, 30)
  try {
    const result = analyzeReferencePatch(cv, patch)
    assert.ok(Math.abs(result.area - Math.PI * 18 ** 2) < Math.PI * 18 ** 2 * 0.08, `area ${result.area}`)
    assert.equal(result.polarity, 'bright')
  } finally {
    patch.delete()
  }
})

test('extractPatch samples an axis-aligned box without shifting pixels', () => {
  const data = new Uint8Array(20 * 20).map((_, index) => index % 251)
  const gray = cv.matFromArray(20, 20, cv.CV_8UC1, data)
  const patch = extractPatch(cv, gray, { centerX: 10, centerY: 8, width: 6, height: 4, angle: 0 })
  try {
    assert.equal(patch.cols, 6)
    assert.equal(patch.rows, 4)
    assert.equal(patch.ucharAt(0, 0), data[6 * 20 + 7])
    assert.equal(patch.ucharAt(3, 5), data[9 * 20 + 12])
  } finally {
    gray.delete()
    patch.delete()
  }
})
