import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import test from 'node:test'
import ts from 'typescript'

const require = createRequire(import.meta.url)
const cv = await require('@techstark/opencv-js')
let imageSource
let imageRect
const browserCv = new Proxy(cv, {
  get(target, name) {
    if (name === 'imread') return canvas => extractPatch(cv, imageSource, { ...imageRect, width: canvas.width, height: canvas.height })
    return target[name]
  },
})
const source = readFileSync(new URL('../src/referenceFeatures.ts', import.meta.url), 'utf8')
const { outputText } = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
})
const module = { exports: {} }
new Function('require', 'module', 'exports', outputText)(() => ({ loadOpenCv: async () => browserCv }), module, module.exports)
const { analyzeReferencePatch, analyzeReferenceContext, extractPatch, extractReferenceFeatures } = module.exports

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

test('body smoothing changes the outline without changing the appearance histogram', () => {
  const patch = ringPatch(60, 20, 10, 40, 230, 220)
  try {
    const sharp = analyzeReferencePatch(cv, patch, 0)
    const smooth = analyzeReferencePatch(cv, patch, 3)
    assert.deepEqual(smooth.histogram, sharp.histogram)
    assert.notDeepEqual(smooth.outline, sharp.outline)
    assert.ok(smooth.area > 0)
    assert.equal(smooth.polarity, sharp.polarity)
  } finally {
    patch.delete()
  }
})

test('reference context recovers a rim outside the tight box without expanding its histogram', () => {
  const context = ringPatch(80, 25, 19, 40, 220, 220)
  const width = 48
  const padding = 16
  const tight = context.roi(new cv.Rect(padding, padding, width, width))
  try {
    const original = analyzeReferencePatch(cv, tight, 0.5)
    const recovered = analyzeReferenceContext(cv, context, width, width, padding, 0.5)
    assert.deepEqual(recovered.histogram, original.histogram)
    assert.ok(recovered.area > Math.PI * 25 ** 2 * 0.85, `area ${recovered.area}`)
    assert.ok(recovered.outline.some(point => point.x < padding || point.x >= padding + width))
    assert.ok(recovered.outline.every(point => point.x > 0 && point.y > 0 && point.x < 79 && point.y < 79))
  } finally {
    tight.delete()
    context.delete()
  }
})

test('padded reference ignores background contours touching the search boundary', () => {
  const context = ringPatch(80, 25, 19, 40, 220, 220)
  try {
    for (let row = 0; row < 12; row += 1) {
      for (let column = 0; column < 12; column += 1) context.ucharPtr(row, column)[0] = 40
    }
    const result = analyzeReferenceContext(cv, context, 48, 48, 16, 0.5)
    assert.ok(result.area > 1600 && result.area < 2300, `area ${result.area}`)
    assert.ok(result.outline.every(point => point.x >= 14 && point.y >= 14 && point.x <= 66 && point.y <= 66))
  } finally {
    context.delete()
  }
})

test('rotated padded reference preserves manual geometry and tight-box appearance in source pixels', async () => {
  const gray = ringPatch(120, 25, 19, 40, 220, 220)
  imageSource = new cv.Mat()
  cv.cvtColor(gray, imageSource, cv.COLOR_GRAY2RGBA)
  imageRect = { centerX: 60, centerY: 60, width: 48, height: 48, angle: 37 }
  const tightRgba = extractPatch(cv, imageSource, imageRect)
  const tightGray = new cv.Mat()
  const originalDocument = globalThis.document
  globalThis.document = { createElement: () => ({ getContext: () => ({ translate() {}, rotate() {}, drawImage() {} }) }) }
  try {
    cv.cvtColor(tightRgba, tightGray, cv.COLOR_RGBA2GRAY)
    const original = analyzeReferencePatch(cv, tightGray, 0.5)
    const result = await extractReferenceFeatures({ naturalWidth: 120, naturalHeight: 120 }, imageRect, 0.5 / 48 * 100)
    assert.equal(result.width, imageRect.width)
    assert.equal(result.height, imageRect.height)
    assert.equal(result.q, 1)
    assert.deepEqual(result.histogram, original.histogram)
    assert.equal(result.polarity, original.polarity)
    assert.ok(result.area > 1600, `area ${result.area}`)
    assert.ok(result.outline.every(point => Math.hypot(point.x - 60, point.y - 60) > 23 && Math.hypot(point.x - 60, point.y - 60) < 27))
    assert.deepEqual(imageRect, { centerX: 60, centerY: 60, width: 48, height: 48, angle: 37 })
  } finally {
    gray.delete()
    imageSource.delete()
    imageSource = undefined
    tightRgba.delete()
    tightGray.delete()
    if (originalDocument === undefined) delete globalThis.document
    else globalThis.document = originalDocument
  }
})
