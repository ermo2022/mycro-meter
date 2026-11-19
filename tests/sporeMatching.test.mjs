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

function matchingFixture(secondRadius = 24) {
  const width = 240
  const height = 140
  const pixels = new Uint8Array(width * height * 4)
  for (let row = 0; row < height; row += 1) {
    for (let column = 0; column < width; column += 1) {
      const inside = ((column - 60) / 24) ** 2 + ((row - 70) / 12) ** 2 <= 1 ||
        ((column - 180) / secondRadius) ** 2 + ((row - 70) / 12) ** 2 <= 1
      const offset = (row * width + column) * 4
      pixels.fill(inside ? 40 : 220, offset, offset + 3)
      pixels[offset + 3] = 255
    }
  }
  const rgba = cv.matFromArray(height, width, cv.CV_8UC4, pixels)
  const gray = new cv.Mat()
  const rect = { centerX: 60.5, centerY: 70.5, width: 48, height: 24, angle: 0 }
  cv.cvtColor(rgba, gray, cv.COLOR_RGBA2GRAY)
  const patch = referenceModule.exports.extractPatch(cv, gray, rect)
  try {
    const features = referenceModule.exports.analyzeReferencePatch(cv, patch, rect.height * 0.02)
    return { rgba, rect, reference: { ...features, width: rect.width, height: rect.height, q: 2 } }
  } finally {
    gray.delete()
    patch.delete()
  }
}

function histogramForBox(rgba, box, scale = 1) {
  const gray = new cv.Mat()
  cv.cvtColor(rgba, gray, cv.COLOR_RGBA2GRAY)
  const patch = referenceModule.exports.extractPatch(cv, gray, {
    ...box, centerX: box.centerX * scale, centerY: box.centerY * scale, width: box.width * scale, height: box.height * scale,
  })
  try {
    return referenceModule.exports.analyzeReferencePatch(cv, patch).histogram
  } finally {
    gray.delete()
    patch.delete()
  }
}

test('tuned matching returns copied contours in source coordinates after downscaling', () => {
  const { rgba, rect, reference } = matchingFixture()
  const reduced = new cv.Mat()
  try {
    cv.resize(rgba, reduced, new cv.Size(120, 70), 0, 0, cv.INTER_AREA)
    const trace = []
    const options = {
      ...DEFAULT_CANDIDATE_PREPROCESSING, tuning: { smoothing: 2, sensitivity: 5, sizeTolerance: 30 },
    }
    matchSporePixels(cv, reduced, reference, rect, 0.5, event => trace.push(event), options)
    const candidate = trace.find(event => event.stage === 'evaluated' && event.box.centerX > 150)
    assert.ok(candidate)
    const compatibleReference = { ...reference, histogram: histogramForBox(reduced, candidate.box, 0.5) }
    const result = matchSporePixels(cv, reduced, compatibleReference, rect, 0.5, undefined, options)
    assert.equal(result.matches.length, 1, JSON.stringify(trace))
    const outline = result.matches[0].outline
    assert.ok(outline.length > 8)
    assert.ok(outline.every(point => point.x > 150 && point.x < 210 && point.y > 50 && point.y < 90))
    assert.ok(outline.some(point => point.x > 195))
    assert.ok(Array.isArray(result.rejectedOutlines))
  } finally {
    reduced.delete()
    rgba.delete()
  }
})

test('size tolerance admits a larger elliptical body and exposes rejected outlines', () => {
  const { rgba, rect, reference } = matchingFixture(28)
  try {
    const options = { ...DEFAULT_CANDIDATE_PREPROCESSING, tuning: { smoothing: 2, sensitivity: 5, sizeTolerance: 5 } }
    const strict = matchSporePixels(cv, rgba, reference, rect, 1, undefined, options)
    const trace = []
    const relaxedOptions = {
      ...options, tuning: { ...options.tuning, sizeTolerance: 60 },
    }
    matchSporePixels(cv, rgba, reference, rect, 1, event => trace.push(event), relaxedOptions)
    const candidate = trace.find(event => event.stage === 'evaluated' && event.box.centerX > 150)
    assert.ok(candidate)
    const compatibleReference = { ...reference, histogram: histogramForBox(rgba, candidate.box) }
    const relaxed = matchSporePixels(cv, rgba, compatibleReference, rect, 1, undefined, relaxedOptions)
    const compatibleStrict = matchSporePixels(cv, rgba, compatibleReference, rect, 1, undefined, options)
    assert.equal(compatibleStrict.matches.length, 0)
    assert.equal(strict.matches.length, 0)
    assert.ok(strict.rejectedOutlines.some(outline => outline.some(point => point.x > 180)))
    assert.equal(relaxed.matches.length, 1, JSON.stringify(trace))
    assert.ok(relaxed.matches[0].q > 2)
  } finally {
    rgba.delete()
  }
})

test('smoothing and boundary sliders control Gaussian scale and polarity-aware thresholds', () => {
  const { rgba, rect, reference } = matchingFixture()
  const calls = { sigmas: [], offsets: [] }
  const tracked = new Proxy(cv, {
    get(target, name) {
      if (name === 'GaussianBlur') return (...args) => { calls.sigmas.push(args[3]); return target.GaussianBlur(...args) }
      if (name === 'adaptiveThreshold') return (...args) => { calls.offsets.push(args[6]); return target.adaptiveThreshold(...args) }
      return target[name]
    },
  })
  try {
    const options = { mask: 'adaptive', tuning: { smoothing: 8, sensitivity: 9, sizeTolerance: 30 } }
    matchSporePixels(tracked, rgba, reference, rect, 1, undefined, options)
    assert.ok(calls.sigmas.includes(reference.height * 0.08))
    assert.equal(calls.offsets.at(-1), 1)
    matchSporePixels(tracked, rgba, { ...reference, polarity: 'bright' }, rect, 1, undefined, options)
    assert.equal(calls.offsets.at(-1), 9)
    calls.sigmas.length = 0
    matchSporePixels(tracked, rgba, reference, rect, 1, undefined, { ...options, tuning: { ...options.tuning, smoothing: 0 } })
    assert.ok(!calls.sigmas.includes(reference.height * 0.08))
  } finally {
    rgba.delete()
  }
})

test('contrast-relative histograms match brightness shifts without changing the input', () => {
  const { normalizeContrastHistogram } = module.exports
  const histogram = new Array(256).fill(0)
  histogram[40] = 0.3
  histogram[100] = 0.4
  histogram[160] = 0.3
  const shifted = new Array(256).fill(0)
  shifted[70] = 0.3
  shifted[130] = 0.4
  shifted[190] = 0.3
  const original = [...histogram]
  assert.ok(bhattacharyyaDistance(histogram, shifted) > 0.9)
  assert.deepEqual(normalizeContrastHistogram(histogram), normalizeContrastHistogram(shifted))
  assert.deepEqual(histogram, original)
  const flat = new Array(256).fill(0)
  flat[128] = 1
  assert.equal(normalizeContrastHistogram(flat).span, 0)
})

test('initial and reset matching defaults use the reviewed Pluteus settings', () => {
  assert.deepEqual(module.exports.DEFAULT_MATCHING_SETTINGS, {
    smoothing: 2, sensitivity: 5, sizeTolerance: 45, relativeContrast: true, recoverIncompleteRims: true,
  })
})

test('rim support distinguishes a mostly supported perimeter from an unsupported hull', () => {
  const { rimBoundarySupport } = module.exports
  const contour = cv.matFromArray(7, 1, cv.CV_32SC2, [10, 10, 50, 10, 50, 50, 10, 50, 10, 30, 11, 30, 11, 10])
  const sparse = cv.matFromArray(6, 1, cv.CV_32SC2, [10, 10, 50, 10, 50, 11, 11, 11, 11, 50, 10, 50])
  const hull = new cv.Mat()
  const sparseHull = new cv.Mat()
  try {
    cv.convexHull(contour, hull)
    cv.convexHull(sparse, sparseHull)
    assert.ok(rimBoundarySupport(cv, contour, hull, 2) >= 0.7)
    assert.ok(rimBoundarySupport(cv, sparse, sparseHull, 1) < 0.7)
  } finally {
    contour.delete()
    sparse.delete()
    hull.delete()
    sparseHull.delete()
  }
})

test('contrast-relative matching is opt-in and flags brightness-shift recoveries', () => {
  const { rgba, rect, reference } = matchingFixture()
  try {
    for (let offset = 0; offset < rgba.data.length; offset += 4) {
      for (let channel = 0; channel < 3; channel += 1) rgba.data[offset + channel] += 30
    }
    const options = { ...DEFAULT_CANDIDATE_PREPROCESSING, tuning: { smoothing: 2, sensitivity: 5, sizeTolerance: 30 } }
    const baseline = matchSporePixels(cv, rgba, reference, rect, 1, undefined, options)
    const enabled = matchSporePixels(cv, rgba, reference, rect, 1, undefined, { ...options, tuning: { ...options.tuning, relativeContrast: true } })
    assert.equal(baseline.matches.length, 0)
    assert.equal(enabled.matches.length, 1)
    assert.equal(enabled.matches[0].recovery, 'contrast')
    assert.ok(enabled.matches[0].distance >= DIRECT_LIMITS.maxDistance)
    assert.ok(Math.abs(enabled.matches[0].centerX - 180.5) < 2)
    assert.deepEqual(matchSporePixels(cv, rgba, reference, rect, 1, undefined, { ...options, tuning: { ...options.tuning, relativeContrast: false, recoverIncompleteRims: false } }), baseline)
  } finally {
    rgba.delete()
  }
})

test('incomplete-rim recovery retains the measured contour rather than replacing it with a hull', () => {
  const { rgba, rect, reference } = matchingFixture()
  try {
    for (let row = 0; row < rgba.rows; row += 1) {
      for (let column = 120; column < rgba.cols; column += 1) {
        const horizontal = (column - 180) / 24
        const vertical = (row - 70) / 12
        const radius = Math.hypot(horizontal, vertical)
        const angle = Math.atan2(vertical, horizontal)
        const rim = radius >= 0.88 && radius <= 1.04 && Math.abs(angle) > Math.PI / 6
        const offset = (row * rgba.cols + column) * 4
        rgba.data.fill(rim ? 40 : 220, offset, offset + 3)
      }
    }
    const options = { mask: 'edges', tuning: { smoothing: 2, sensitivity: 5, sizeTolerance: 30 } }
    const trace = []
    matchSporePixels(cv, rgba, reference, rect, 1, event => trace.push(event), options)
    const candidate = trace.filter(event => event.stage === 'generated' && Math.abs(event.box.centerX - 180) < 20).sort((first, second) => second.box.width - first.box.width)[0]
    assert.ok(candidate)
    const compatibleReference = { ...reference, histogram: histogramForBox(rgba, candidate.box) }
    const baseline = matchSporePixels(cv, rgba, compatibleReference, rect, 1, undefined, options)
    const enabled = matchSporePixels(cv, rgba, compatibleReference, rect, 1, undefined, { ...options, tuning: { ...options.tuning, recoverIncompleteRims: true } })
    assert.equal(baseline.matches.length, 0)
    assert.equal(enabled.matches.length, 1, JSON.stringify(enabled))
    const recovered = enabled.matches[0]
    assert.equal(recovered.recovery, 'rim')
    assert.ok(recovered.area < reference.area * 0.7)
    assert.ok(recovered.outline.length > 8)
    assert.ok(recovered.outline.every(point => point.x > 145 && point.x < 215 && point.y > 45 && point.y < 95))
    const adaptive = matchSporePixels(cv, rgba, compatibleReference, rect, 1, undefined, {
      ...options, mask: 'adaptive', tuning: { ...options.tuning, recoverIncompleteRims: true },
    })
    assert.equal(adaptive.matches.length, 1, JSON.stringify(adaptive))
  } finally {
    rgba.delete()
  }
})

test('detected boxes become editable measurement records and calibrated CSV rows', () => {
  const csvModule = { exports: {} }
  new Function('require', 'module', 'exports', ts.transpileModule(
    readFileSync(new URL('../src/measurementCsv.ts', import.meta.url), 'utf8'), {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
    },
  ).outputText)(() => geometryModule.exports, csvModule, csvModule.exports)
  const { detectionsToMeasurements, rawMeasurementsCsv, imageRecordCsv, parseImageRecordCsv, validateImageMeasurementData } = csvModule.exports
  const detections = [{ id: 'match-1', centerX: 60, centerY: 40, width: 20, height: 40, angle: 30, recovery: 'rim', outline: [{ x: 1, y: 1 }] }]
  const existing = [{ id: 1000, kind: 'box', objectId: 'manual', rect: { centerX: 15, centerY: 15, width: 10, height: 5, angle: 0 }, name: 'B3' }]
  const unchanged = structuredClone(existing)
  const records = detectionsToMeasurements(detections, existing, 1000)
  assert.equal(records[0].id, 1001)
  assert.equal(records[0].name, 'B4')
  assert.match(records[0].objectId, /^auto-/)
  assert.deepEqual(records[0].rect, { centerX: 60, centerY: 40, width: 40, height: 20, angle: -60 })
  assert.deepEqual(existing, unchanged)
  assert.equal(detections[0].width, 20)
  const calibration = { pixelsPerUnit: 10, unit: 'µm' }
  validateImageMeasurementData({ imageName: 'spores.png', imageWidth: 120, imageHeight: 100, calibration, measurements: [...existing, ...records] })
  const csv = rawMeasurementsCsv(records, calibration)
  assert.ok(csv.includes('"B4","Box","4","2","2.0000","µm","40","20","-60"'))
  const imported = parseImageRecordCsv(imageRecordCsv(records, calibration, 'spores.png', { x: 120, y: 100 }))
  assert.equal(imported.imageName, 'spores.png')
  assert.deepEqual(imported.calibration, calibration)
  assert.deepEqual(imported.measurements[0].rect, records[0].rect)
  const next = detectionsToMeasurements(detections, [...existing, ...records], 1000)
  assert.equal(next[0].id, 1002)
  assert.equal(next[0].name, 'B5')
  assert.throws(() => detectionsToMeasurements(Array(10001).fill(detections[0])), /Measurement limit/)
})

test('recording duplicate checks use rotated-box overlap', () => {
  const { boxIntersectionOverUnion } = module.exports
  const box = { centerX: 50, centerY: 50, width: 40, height: 10, angle: 40 }
  assert.ok(boxIntersectionOverUnion(cv, box, box) > 0.99)
  assert.ok(boxIntersectionOverUnion(cv, box, { ...box, centerX: 51 }) > 0.5)
  assert.ok(boxIntersectionOverUnion(cv, box, { ...box, angle: -40 }) < 0.5)
  assert.equal(boxIntersectionOverUnion(cv, box, { ...box, centerX: 200 }), 0)
})
