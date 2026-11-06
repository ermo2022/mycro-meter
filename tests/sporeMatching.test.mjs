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
new Function('require', 'module', 'exports', outputText)(() => ({}), module, module.exports)
const { areaGroup, bhattacharyyaDistance, isSporeMatch, watershedSegments, DIRECT_LIMITS, WATERSHED_LIMITS } = module.exports

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
