import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { PNG } from 'pngjs'
import { analyzeDataset, associateBoxes, boxIou, comparePreprocessing, loadDataset, quantile, reportMarkdown } from '../scripts/tuneSpores.mjs'

const cv = await createRequire(import.meta.url)('@techstark/opencv-js')
const box = { centerX: 60.5, centerY: 70.5, width: 48, height: 24, angle: 0 }

test('rotated IoU distinguishes identical, disjoint and differently rotated boxes', () => {
  assert.ok(Math.abs(boxIou(cv, box, box) - 1) < 1e-6)
  assert.equal(boxIou(cv, box, { ...box, centerX: 160 }), 0)
  assert.ok(Math.abs(boxIou(cv, box, { ...box, angle: 90 }) - 1 / 3) < 1e-6)
})

test('one-to-one association does not count duplicates and finds maximum recovery', () => {
  assert.equal(associateBoxes(cv, [box, box], [box]).length, 1)
  const other = { ...box, centerX: box.centerX + 20 }
  const shared = { ...box, centerX: box.centerX + 10 }
  assert.equal(associateBoxes(cv, [shared, box], [box, other]).length, 2)
})

test('quantiles interpolate without changing observations and handle no observations', () => {
  const values = [4, 1, 3, 2]
  assert.equal(quantile(values, 0.5), 2.5)
  assert.deepEqual(values, [4, 1, 3, 2])
  assert.equal(quantile([], 0.95), null)
})

test('offline analysis uses shared matcher and excludes the selected reference from recall', async () => {
  const width = 240
  const height = 140
  const data = new Uint8Array(width * height * 4)
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const inside = [60, 180].some(centerX => ((x - centerX) / 24) ** 2 + ((y - 70) / 12) ** 2 <= 1)
      const offset = (y * width + x) * 4
      data.fill(inside ? 40 : 220, offset, offset + 3)
      data[offset + 3] = 255
    }
  }
  const sets = [{ name: 'Synthetic', path: 'synthetic', items: [{
    path: 'synthetic/items/item_001', imageName: 'synthetic.png', png: { width, height, data },
    boxes: [{ id: 1, box }, { id: 2, box: { ...box, centerX: 180.5 } }],
  }] }]
  const report = await analyzeDataset(sets)
  assert.ok(reportMarkdown(report).includes('Evaluated candidate preprocessing: combined; illumination correction disabled'))
  assert.ok(reportMarkdown(report).includes('Browser Auto-detect uses illumination-corrected adaptive preprocessing'))
  assert.equal(report.summary.positives, 2)
  assert.equal(report.summary.baselineRecall, 1)
  assert.equal(report.images[0].pairs.length, 2)
  assert.equal(report.images[0].trials.length, 2)
  assert.equal(report.images[0].trials[0].eligible, 1)
  assert.deepEqual(report.images[0].trials[0].recoveredIds, [2])
  assert.equal(report.heldOut[0].positiveOnlyLimits.qTolerance, null)
  const stress = await analyzeDataset([{ ...sets[0], evaluationGroup: 'stress', evaluationNote: 'Spiny spores' }])
  assert.equal(stress.summary.baselineRecall, 1)
  assert.equal(stress.summary.standardSetRecall, null)
  assert.equal(stress.sets[0].evaluationNote, 'Spiny spores')
  const traced = await analyzeDataset(sets, { stages: true })
  assert.deepEqual(traced.images[0].trials.map(trial => trial.matches), report.images[0].trials.map(trial => trial.matches))
  for (const value of Object.values(traced.summary.stageRecall)) assert.equal(value, 1)
  assert.equal(traced.images[0].trials[0].stages.targets[0].firstMissingStage, null)
  assert.equal(traced.images[0].trials[0].stages.targets[0].recovered, true)
  assert.equal(traced.images[0].trials[0].stages.targets[0].failure, null)
  const clippedWidth = 200
  const clippedData = new Uint8Array(clippedWidth * height * 4)
  for (let row = 0; row < height; row += 1) clippedData.set(data.subarray(row * width * 4, (row * width + clippedWidth) * 4), row * clippedWidth * 4)
  const clippedSets = [{ ...sets[0], items: [{ ...sets[0].items[0], png: { width: clippedWidth, height, data: clippedData } }] }]
  const clipped = await analyzeDataset(clippedSets, { stages: true })
  const missed = clipped.images[0].trials[0].stages.targets[0]
  assert.equal(missed.firstMissingStage, 'framePassed')
  assert.equal(missed.failure.reason, 'frame')
  assert.equal(missed.recovered, false)
  const featuresOnly = await analyzeDataset(sets, { baseline: false })
  assert.equal(featuresOnly.summary.baselineRecall, null)
  assert.equal(featuresOnly.images[0].pairs.length, 2)
  const comparison = await comparePreprocessing(sets, { stages: true })
  assert.equal(comparison.length, 6)
  assert.deepEqual(comparison[0].report.images[0].trials.map(trial => trial.matches), report.images[0].trials.map(trial => trial.matches))
  assert.equal(comparison[0].summary.gainedTargetComparisons, 0)
  assert.equal(comparison[0].summary.additionalUnreviewedPerReference, 0)
  for (const variant of comparison) {
    assert.deepEqual(variant.report.currentLimits, report.currentLimits)
    assert.ok(variant.summary.recall >= 0 && variant.summary.recall <= 1)
    assert.deepEqual(variant.report.images[0].positives, report.images[0].positives)
  }
})

test('dataset loader normalizes exported boxes and analysis rejects image dimension mismatches', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'spore-tuning-'))
  const setDirectory = join(directory, 'example-set')
  const itemDirectory = join(setDirectory, 'items', 'item_001')
  mkdirSync(itemDirectory, { recursive: true })
  const metadata = { imageName: 'example.png', imageWidth: 240, imageHeight: 140, measurements: [{ id: 1, kind: 'box', rect: { ...box, width: 24, height: 48 } }] }
  try {
    writeFileSync(join(setDirectory, 'project_manifest.json'), JSON.stringify({ format: 'mycrometer', version: 1, kind: 'set', name: 'Example', items: [{ path: 'items/item_001' }] }))
    writeFileSync(join(itemDirectory, 'metadata.json'), JSON.stringify(metadata))
    writeFileSync(join(itemDirectory, 'image.png'), PNG.sync.write(new PNG({ width: 240, height: 140 })))
    const sets = loadDataset(directory)
    assert.equal(sets.length, 1)
    assert.equal(sets[0].items[0].boxes[0].box.width, 48)
    assert.equal(sets[0].items[0].boxes[0].box.height, 24)
    assert.equal(sets[0].items[0].png, undefined)
    writeFileSync(join(directory, 'evaluation.json'), JSON.stringify({ version: 1, excludedImages: {}, stressSets: { 'example-set': 'Spiny spores' } }))
    const profiled = loadDataset(directory)
    assert.equal(profiled[0].evaluationGroup, 'stress')
    assert.equal(profiled[0].evaluationNote, 'Spiny spores')
    const secondDirectory = join(setDirectory, 'items', 'item_002')
    mkdirSync(secondDirectory, { recursive: true })
    writeFileSync(join(secondDirectory, 'metadata.json'), JSON.stringify(metadata))
    writeFileSync(join(secondDirectory, 'image.png'), PNG.sync.write(new PNG({ width: 240, height: 140 })))
    writeFileSync(join(setDirectory, 'project_manifest.json'), JSON.stringify({ format: 'mycrometer', version: 1, kind: 'set', name: 'Example', items: [{ path: 'items/item_001' }, { path: 'items/item_002' }] }))
    writeFileSync(join(directory, 'evaluation.json'), JSON.stringify({ version: 1, excludedImages: { 'example-set/items/item_001': 'Poor image' }, stressSets: {} }))
    const excluded = loadDataset(directory)
    assert.equal(excluded[0].items.length, 1)
    assert.equal(excluded[0].items[0].path, 'example-set/items/item_002')
    assert.deepEqual(excluded.evaluation.excludedImages, [{ path: 'example-set/items/item_001', reason: 'Poor image' }])
    rmSync(join(directory, 'evaluation.json'))
    metadata.imageWidth = 241
    writeFileSync(join(itemDirectory, 'metadata.json'), JSON.stringify(metadata))
    await assert.rejects(() => analyzeDataset(loadDataset(directory)), /dimensions disagree/)
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})