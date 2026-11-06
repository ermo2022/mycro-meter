import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import test from 'node:test'
import ts from 'typescript'

const require = createRequire(import.meta.url)
const cv = await require('@techstark/opencv-js')

const source = readFileSync(new URL('../src/sporeMatching.ts', import.meta.url), 'utf8')
const { outputText } = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
})
const module = { exports: {} }
const geometrySource = readFileSync(new URL('../src/boxGeometry.ts', import.meta.url), 'utf8')
const geometryModule = { exports: {} }
new Function('module', 'exports', ts.transpileModule(geometrySource, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText)(geometryModule, geometryModule.exports)
let imagePixels
let illuminationCorrections = 0
let combinedMasks = 0
const detectionCv = new Proxy(cv, {
  get(target, name) {
    if (name === 'imread') return (canvas) => cv.matFromArray(canvas.height, canvas.width, cv.CV_8UC4, imagePixels)
    if (name === 'subtract') return (...args) => { illuminationCorrections += 1; return target.subtract(...args) }
    if (name === 'bitwise_or') return (...args) => { combinedMasks += 1; return target.bitwise_or(...args) }
    return target[name]
  },
})
const dependencies = (name) => {
  if (name === './boxGeometry') return geometryModule.exports
  if (name === './objectDetection') return { loadOpenCv: async () => detectionCv }
  if (name === './referenceFeatures') return referenceModule.exports
  return {}
}
const referenceModule = { exports: {} }
new Function('require', 'module', 'exports', ts.transpileModule(
  readFileSync(new URL('../src/referenceFeatures.ts', import.meta.url), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  },
).outputText)(dependencies, referenceModule, referenceModule.exports)
new Function('require', 'module', 'exports', outputText)(dependencies, module, module.exports)
const { areaGroup, bhattacharyyaDistance, findMatchingSpores, matchSporePixels, isSporeMatch, overlapsReference, watershedSegments, DIRECT_LIMITS, WATERSHED_LIMITS, DEFAULT_CANDIDATE_PREPROCESSING } = module.exports

test('full-image matching excludes the golden spore but keeps an identical nearby spore', async () => {
  const width = 240
  const height = 140
  imagePixels = new Uint8Array(width * height * 4)
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const inside = [60, 180].some((centerX) => ((x - centerX) / 24) ** 2 + ((y - 70) / 12) ** 2 <= 1)
      const offset = (y * width + x) * 4
      imagePixels.fill(inside ? 40 : 220, offset, offset + 3)
      imagePixels[offset + 3] = 255
    }
  }
  const rgba = cv.matFromArray(height, width, cv.CV_8UC4, imagePixels)
  const gray = new cv.Mat()
  const rect = { centerX: 60.5, centerY: 70.5, width: 48, height: 24, angle: 0 }
  const originalDocument = globalThis.document
  globalThis.document = { createElement: () => ({ getContext: () => ({ drawImage() {} }) }) }
  try {
    cv.cvtColor(rgba, gray, cv.COLOR_RGBA2GRAY)
    const patch = referenceModule.exports.extractPatch(cv, gray, rect)
    let features
    try {
      features = referenceModule.exports.analyzeReferencePatch(cv, patch)
    } finally {
      patch.delete()
    }
    const reference = { ...features, width: rect.width, height: rect.height, q: rect.width / rect.height }
    const image = { naturalWidth: width, naturalHeight: height }
    illuminationCorrections = 0
    combinedMasks = 0
    const baseline = await findMatchingSpores(image, reference, { ...rect, centerX: -100 })
    assert.equal(baseline.matches.length, 2)
    const result = await findMatchingSpores(image, reference, rect)
    assert.equal(result.matches.length, 1, JSON.stringify(result))
    assert.ok(Math.abs(result.matches[0].centerX - 180.5) < 2)
    assert.deepEqual(DEFAULT_CANDIDATE_PREPROCESSING, { mask: 'adaptive', correctIllumination: true })
    assert.equal(illuminationCorrections, 2)
    assert.equal(combinedMasks, 0)
    assert.deepEqual(result, matchSporePixels(cv, rgba, reference, rect, 1, undefined, { mask: 'adaptive', correctIllumination: true }))
  } finally {
    rgba.delete()
    gray.delete()
    if (originalDocument === undefined) delete globalThis.document
    else globalThis.document = originalDocument
  }
})

test('reference overlap excludes the reference and partial overlaps in source-image coordinates', () => {
  const reference = { centerX: 100, centerY: 100, width: 40, height: 20, angle: 0 }
  assert.equal(overlapsReference(reference, reference, 1), true)
  assert.equal(overlapsReference({ ...reference, width: 50, height: 30 }, reference, 1), true)
  assert.equal(overlapsReference({ ...reference, centerX: 135 }, reference, 1), true)
  assert.equal(overlapsReference({ ...reference, centerX: 150 }, reference, 1), false)
  assert.equal(overlapsReference({ ...reference, centerX: 50, centerY: 50, width: 20, height: 10 }, reference, 0.5), true)
  assert.equal(overlapsReference({ ...reference, centerX: 75, centerY: 50, width: 20, height: 10 }, reference, 0.5), false)
})

test('reference overlap uses rotated boxes, not their axis-aligned bounds', () => {
  const reference = { centerX: 100, centerY: 100, width: 40, height: 4, angle: 45 }
  assert.equal(overlapsReference({ ...reference, angle: -45 }, reference, 1), true)
  assert.equal(overlapsReference({ ...reference, centerY: 110 }, reference, 1), false)
})

test('watershedSegments splits two touching spores into image-coordinate contours', () => {
  const width = 80
  const height = 50
  const data = new Uint8Array(width * height).fill(220)
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      if (Math.hypot(x - 28, y - 25) <= 12 || Math.hypot(x - 50, y - 25) <= 12) data[y * width + x] = 40
    }
  }
  const gray = cv.matFromArray(height, width, cv.CV_8UC1, data)
  const binary = new cv.Mat()
  const contours = new cv.MatVector()
  const hierarchy = new cv.Mat()
  try {
    cv.threshold(gray, binary, 128, 255, cv.THRESH_BINARY_INV)
    cv.findContours(binary, contours, hierarchy, cv.RETR_EXTERNAL, cv.CHAIN_APPROX_SIMPLE)
    assert.equal(contours.size(), 1)
    const blob = contours.get(0)
    const segments = watershedSegments(cv, gray, blob)
    blob.delete()
    assert.equal(segments.length, 2)
    const centers = segments.map((segment) => {
      const rect = cv.boundingRect(segment)
      const area = cv.contourArea(segment)
      segment.delete()
      assert.ok(area > Math.PI * 12 ** 2 * 0.7, `area ${area}`)
      return rect.x + rect.width / 2
    }).sort((a, b) => a - b)
    assert.ok(Math.abs(centers[0] - 28) < 3 && Math.abs(centers[1] - 50) < 3, `centers ${centers}`)
  } finally {
    gray.delete()
    binary.delete()
    contours.delete()
    hierarchy.delete()
  }
})

test('bhattacharyyaDistance is 0 for identical and 1 for disjoint histograms', () => {
  assert.equal(bhattacharyyaDistance([0.5, 0.5, 0], [0.5, 0.5, 0]), 0)
  assert.equal(bhattacharyyaDistance([1, 0], [0, 1]), 1)
})

test('areaGroup applies hard filters and splits direct matches from clusters', () => {
  assert.equal(areaGroup(59, 100), 'reject')
  assert.equal(areaGroup(65, 100), 'reject')
  assert.equal(areaGroup(70, 100), 'direct')
  assert.equal(areaGroup(130, 100), 'direct')
  assert.equal(areaGroup(131, 100), 'cluster')
  assert.equal(areaGroup(400, 100), 'cluster')
  assert.equal(areaGroup(401, 100), 'reject')
  assert.equal(areaGroup(125, 100, WATERSHED_LIMITS), 'cluster')
})

test('isSporeMatch requires both histogram similarity and aspect ratio', () => {
  const reference = { q: 2 }
  assert.equal(isSporeMatch(2.3, 0.2, reference, DIRECT_LIMITS), true)
  assert.equal(isSporeMatch(2.5, 0.2, reference, DIRECT_LIMITS), false)
  assert.equal(isSporeMatch(2, 0.3, reference, DIRECT_LIMITS), false)
  assert.equal(isSporeMatch(2.35, 0.2, reference, WATERSHED_LIMITS), false)
  assert.equal(isSporeMatch(2.35, 0.2, reference, DIRECT_LIMITS), true)
})
