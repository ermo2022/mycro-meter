import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import test from 'node:test'
import 'fake-indexeddb/auto'
import ts from 'typescript'

globalThis.self = globalThis
const require = createRequire(import.meta.url)
const modules = new Map()
function load(name) {
  if (!name.startsWith('./')) return require(name)
  if (modules.has(name)) return modules.get(name)
  const source = readFileSync(new URL(`../src/${name.slice(2)}.ts`, import.meta.url), 'utf8')
  const { outputText } = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
  })
  const module = { exports: {} }
  new Function('require', 'module', 'exports', outputText)(load, module, module.exports)
  modules.set(name, module.exports)
  return module.exports
}
const storage = load('./projectStorage')
const { imageRecordCsv, measurementSetBoxes, measurementSetCsv, parseImageRecordCsv, rawMeasurementsCsv } = load('./measurementCsv')
const { boxCorners, longAxisFirst } = load('./boxGeometry')
const { adjustImageCrop, imageProcessingSize, resampleMicroscopeImage } = load('./imageResampler')
const JSZip = require('jszip')
const metadata = {
  imageName: 'slide.tiff', imageWidth: 100, imageHeight: 80,
  calibration: { pixelsPerUnit: 4, unit: 'mm' },
  measurements: [{ id: 1, kind: 'box', name: 'B1', objectId: 'manual-1', rect: { centerX: 50, centerY: 40, width: 20, height: 10, angle: 35 } }],
}
const header = new Uint8Array(33)
const view = new DataView(header.buffer)
for (const [offset, value] of [[0, 0x89504e47], [4, 0x0d0a1a0a], [8, 13], [12, 0x49484452], [16, 100], [20, 80]]) view.setUint32(offset, value)
const image = new Blob([header], { type: 'image/png' })

test('box dimensions automatically use the long axis in summaries and CSV without moving the box', () => {
  for (const [width, height] of [[10, 20], [20, 10], [10, 10], [0.25, 0.5]]) {
    const measurement = { ...metadata.measurements[0], rect: { ...metadata.measurements[0].rect, width, height } }
    const normalized = longAxisFirst(measurement.rect)
    for (const corner of boxCorners(measurement.rect)) {
      assert.ok(boxCorners(normalized).some(candidate => Math.hypot(candidate.x - corner.x, candidate.y - corner.y) < 1e-8))
    }
    const length = Math.max(width, height)
    const breadth = Math.min(width, height)
    const entry = { ...metadata, id: 'axes-test', measurements: [measurement] }
    assert.deepEqual(measurementSetBoxes([entry], 'mm'), [{ length: length / 4, width: breadth / 4, q: length / breadth }])
    const fields = `"${length / 4}","${breadth / 4}","${(length / breadth).toFixed(4)}","mm","${length}","${breadth}","${normalized.angle}"`
    assert.ok(rawMeasurementsCsv([measurement], metadata.calibration).includes(fields))
    assert.ok(measurementSetCsv([entry], 'mm').includes(fields))
    const restored = parseImageRecordCsv(imageRecordCsv([measurement], metadata.calibration, metadata.imageName, { x: 100, y: 80 }))
    assert.deepEqual(restored.measurements[0].rect, normalized)
    assert.equal(measurement.rect.width, width)
    assert.equal(measurement.rect.height, height)
  }
})

test('crop bounds and lossless size policy enforce a maximum 1.5x reduction', () => {
  assert.deepEqual(imageProcessingSize(6000, 4000, { x: 100, y: 200, width: 3000, height: 1800 }, 1.5), { width: 2000, height: 1200 })
  assert.deepEqual(imageProcessingSize(100, 80, { x: 0, y: 0, width: 100, height: 80 }, 1), { width: 100, height: 80 })
  for (const reduction of [0, 2, NaN]) assert.throws(() => imageProcessingSize(100, 80, { x: 0, y: 0, width: 100, height: 80 }, reduction))
  assert.throws(() => imageProcessingSize(100, 80, { x: 90, y: 0, width: 20, height: 80 }, 1))
})

test('resampling uses PNG, high-quality interpolation, and uniform scaling', async () => {
  const originalDocument = globalThis.document
  const context = { drawImage: (...args) => { context.args = args } }
  let mime
  const canvas = { getContext: () => context, toBlob: (callback, type) => { mime = type; callback(image) } }
  globalThis.document = { createElement: () => canvas }
  try {
    const source = { naturalWidth: 100, naturalHeight: 80 }
    await resampleMicroscopeImage(source, { x: 10, y: 20, width: 49, height: 31 }, 1.5)
    assert.equal(context.imageSmoothingEnabled, true)
    assert.equal(context.imageSmoothingQuality, 'high')
    assert.equal(mime, 'image/png')
    assert.equal(canvas.width, 33)
    assert.equal(canvas.height, 21)
    assert.ok(Math.abs(context.args[7] / 49 - context.args[8] / 31) < 1e-12)
  } finally { globalThis.document = originalDocument }
})

test('crop edges and corners resize in source pixels without crossing or leaving the image', () => {
  const crop = { x: 20, y: 30, width: 100, height: 80 }
  assert.deepEqual(adjustImageCrop(crop, 'w', 10, 0, 200, 150), { x: 30, y: 30, width: 90, height: 80 })
  assert.deepEqual(adjustImageCrop(crop, 'n', 0, 10, 200, 150), { x: 20, y: 40, width: 100, height: 70 })
  assert.deepEqual(adjustImageCrop(crop, 'se', 20, 10, 200, 150), { x: 20, y: 30, width: 120, height: 90 })
  assert.deepEqual(adjustImageCrop(crop, 'nw', -100, -100, 200, 150), { x: 0, y: 0, width: 120, height: 110 })
  for (const handle of ['n', 'ne', 'e', 'se', 's', 'sw', 'w', 'nw']) {
    for (const delta of [-1000, 1000]) {
      const result = adjustImageCrop(crop, handle, delta, delta, 200, 150)
      assert.ok(result.width >= 1 && result.height >= 1)
      assert.ok(result.x >= 0 && result.y >= 0 && result.x + result.width <= 200 && result.y + result.height <= 150)
      imageProcessingSize(200, 150, result, 1)
    }
  }
})

test('moving a crop preserves its dimensions and clamps it to image bounds', () => {
  const crop = { x: 20, y: 30, width: 100, height: 80 }
  assert.deepEqual(adjustImageCrop(crop, 'move', 12.4, -10.8, 200, 150), { x: 32, y: 19, width: 100, height: 80 })
  assert.deepEqual(adjustImageCrop(crop, 'move', 1000, 1000, 200, 150), { x: 100, y: 70, width: 100, height: 80 })
  assert.deepEqual(adjustImageCrop(crop, 'move', -1000, -1000, 200, 150), { x: 0, y: 0, width: 100, height: 80 })
})

test('IndexedDB stores only calibrated image records and preserves blobs, snapshots and explicit deletion', async () => {
  const uncalibrated = storage.createImageRecord('uncalibrated-test', image, { ...metadata, calibration: null, measurements: [] })
  assert.equal(await storage.saveImageRecord(uncalibrated), null)
  assert.ok(!(await storage.listProjects()).imageRecords.some(entry => entry.id === uncalibrated.id))
  const record = storage.createImageRecord('storage-test', image, metadata)
  await storage.saveImageRecord(record)
  const snapshot = structuredClone(record)
  const set = { id: 'set-test', name: 'Slides', unit: 'mm', updatedAt: Date.now(), imageRecordIdsList: [record.id], images: [snapshot] }
  await storage.saveSet(set)
  await storage.saveImageRecord(storage.createImageRecord(record.id, image, { ...metadata, measurements: [] }))
  await storage.saveImageRecord(storage.createImageRecord(record.id, image, { ...metadata, calibration: null, measurements: [] }))
  const projects = await storage.listProjects()
  assert.equal(projects.imageRecords.find(entry => entry.id === record.id).metadata.measurements.length, 0)
  assert.deepEqual(projects.imageRecords.find(entry => entry.id === record.id).metadata.calibration, metadata.calibration)
  assert.equal(projects.sets.find(entry => entry.id === set.id).images[0].metadata.measurements.length, 1)
  assert.deepEqual(new Uint8Array(await projects.imageRecords[0].imageBlob.arrayBuffer()), header)
  await storage.deleteProject(record.id, 'image-record')
  await storage.deleteProject(set.id, 'set')
  assert.deepEqual(await storage.listProjects(), { imageRecords: [], sets: [] })
})

test('IndexedDB deletes selected image records and sets together', async () => {
  const first = storage.createImageRecord('bulk-delete-first', image, metadata)
  const remaining = storage.createImageRecord('bulk-delete-remaining', image, metadata)
  await storage.saveImageRecord(first)
  await storage.saveImageRecord(remaining)
  await storage.saveSet({
    id: 'bulk-delete-set', name: 'Slides', unit: 'mm', updatedAt: Date.now(),
    imageRecordIdsList: [first.id], images: [first],
  })

  await storage.deleteProjects([
    { id: first.id, kind: 'image-record' },
    { id: 'bulk-delete-set', kind: 'set' },
  ])

  const projects = await storage.listProjects()
  assert.deepEqual(projects.imageRecords.map((record) => record.id), [remaining.id])
  assert.deepEqual(projects.sets, [])
  await storage.deleteProject(remaining.id, 'image-record')
})

test('IndexedDB reads reject malformed records and regenerate saved CSV from metadata', async () => {
  const store = require('localforage').createInstance({ name: 'mycrometer', storeName: 'image_records_store', driver: require('localforage').INDEXEDDB })
  const valid = storage.createImageRecord('tampered-csv-test', image, metadata)
  await store.setItem(valid.id, { ...valid, csv: '=1+1' })
  try {
    const projects = await storage.listProjects()
    assert.equal(projects.imageRecords[0].csv, valid.csv)

    const invalidMetadata = {
      ...metadata,
      measurements: [{ ...metadata.measurements[0], rect: { ...metadata.measurements[0].rect, centerX: 101 } }],
    }
    const invalid = storage.createImageRecord('invalid-indexeddb-test', image, invalidMetadata)
    await assert.rejects(storage.saveImageRecord(invalid), /Invalid box geometry/)
    await store.setItem(invalid.id, invalid)
    await assert.rejects(storage.listProjects(), /Invalid box geometry/)
  } finally {
    await store.removeItem(valid.id)
    await store.removeItem('invalid-indexeddb-test')
  }
})

test('entry storage estimates include PNG blobs, UTF-8 metadata, CSV and set snapshots', () => {
  const record = storage.createImageRecord('size-test', image, { ...metadata, imageName: 'microscope-µm.png' })
  const { imageBlob, ...data } = record
  assert.equal(storage.projectStorageBytes(record), imageBlob.size + new TextEncoder().encode(JSON.stringify(data)).length)
  const set = { id: 'size-set', name: 'Slides', unit: 'mm', updatedAt: 1, imageRecordIdsList: [record.id, record.id], images: [record, record] }
  const serializedSet = { ...set, images: [data, data] }
  assert.equal(storage.projectStorageBytes(set), 2 * imageBlob.size + new TextEncoder().encode(JSON.stringify(serializedSet)).length)
  assert.equal(storage.formatStorageBytes(0), '0 B')
  assert.equal(storage.formatStorageBytes(1024), '1.0 KiB')
  assert.equal(storage.formatStorageBytes(1024 ** 2), '1.0 MiB')
  assert.equal(storage.formatStorageBytes(1024 ** 3), '1.0 GiB')
})

test('image record and set ZIP round-trips retain geometry, calibration, PNG and readable CSV', async () => {
  const record = storage.createImageRecord('zip-test', image, metadata)
  for (const isSet of [false, true]) {
    const set = isSet ? { name: 'Collection', unit: 'mm' } : undefined
    const blob = await storage.exportProjectBundle([record], set)
    const zip = await JSZip.loadAsync(await blob.arrayBuffer())
    const manifest = JSON.parse(await zip.file('project_manifest.json').async('string'))
    assert.equal(manifest.kind, isSet ? 'set' : 'image')
    assert.equal(zip.files['items/item_001/image.png']._data.compressedSize, zip.files['items/item_001/image.png']._data.uncompressedSize)
    assert.ok(zip.file('items/item_001/measurements.csv'))
    if (isSet) assert.ok(zip.file('measurements.csv'))
    const result = await storage.importProjectBundle(blob)
    assert.deepEqual(result.imageRecords[0].metadata, metadata)
    assert.notEqual(result.imageRecords[0].id, record.id)
    assert.deepEqual(new Uint8Array(await result.imageRecords[0].imageBlob.arrayBuffer()), header)
    assert.equal(result.set?.name, isSet ? 'Collection' : undefined)
  }
})

test('offline app-shell lookups tolerate Origin variants on static assets', async () => {
  const handlers = new Map()
  const origin = 'https://mycrometer.example'
  const self = { location: { origin }, addEventListener: (name, callback) => handlers.set(name, callback) }
  let options
  const cachedResponse = new Response('body { display: grid }', { headers: { Vary: 'Origin' } })
  const caches = { open: async () => ({ match: async (_request, matchOptions) => { options = matchOptions; return cachedResponse } }) }
  const fetch = async () => { throw new Error('Offline') }
  new Function('self', 'caches', 'fetch', readFileSync(new URL('../public/sw.js', import.meta.url), 'utf8'))(self, caches, fetch)
  let result
  handlers.get('fetch')({ request: new Request(`${origin}/assets/index.css`), respondWith: (response) => { result = response } })
  assert.equal(await (await result).text(), 'body { display: grid }')
  assert.deepEqual(options, { ignoreVary: true })
})

test('empty uncalibrated image records round-trip without requiring a CSV measurement row', async () => {
  const empty = { ...metadata, calibration: null, measurements: [] }
  const result = await storage.importProjectBundle(await storage.exportProjectBundle([storage.createImageRecord('empty', image, empty)]))
  assert.deepEqual(result.imageRecords[0].metadata, empty)
})

test('image record CSV import rejects out-of-bounds coordinates and oversized boxes', () => {
  const boxCsv = imageRecordCsv(metadata.measurements, metadata.calibration, metadata.imageName, { x: metadata.imageWidth, y: metadata.imageHeight })
  assert.throws(() => parseImageRecordCsv(boxCsv.replace('"50","40"', '"101","40"')))
  const oversized = { ...metadata.measurements[0], rect: { ...metadata.measurements[0].rect, width: 200 } }
  assert.throws(() => parseImageRecordCsv(imageRecordCsv([oversized], metadata.calibration, metadata.imageName, { x: metadata.imageWidth, y: metadata.imageHeight })))
  const distance = { id: 2, kind: 'distance', start: { x: -1, y: 20 }, end: { x: 60, y: 20 }, pixels: 61, name: 'D1' }
  assert.throws(() => parseImageRecordCsv(imageRecordCsv([distance], metadata.calibration, metadata.imageName, { x: metadata.imageWidth, y: metadata.imageHeight })))
})

test('invalid manifests, duplicate paths, mismatched images and invalid geometry are rejected', async () => {
  const valid = await storage.exportProjectBundle([storage.createImageRecord('invalid', image, metadata)])
  for (const change of ['version', 'path', 'duplicates', 'dimensions', 'geometry', 'missing']) {
    const zip = await JSZip.loadAsync(await valid.arrayBuffer())
    const manifest = JSON.parse(await zip.file('project_manifest.json').async('string'))
    if (change === 'version') manifest.version = 100
    if (change === 'path') manifest.items[0].path = '../outside'
    if (change === 'duplicates') { manifest.kind = 'set'; manifest.unit = 'mm'; manifest.items.push(manifest.items[0]) }
    if (change === 'dimensions') zip.file('items/item_001/metadata.json', JSON.stringify({ ...metadata, imageWidth: 101 }))
    if (change === 'geometry') zip.file('items/item_001/metadata.json', JSON.stringify({ ...metadata, measurements: [{ ...metadata.measurements[0], rect: { ...metadata.measurements[0].rect, width: -1 } }] }))
    if (change === 'missing') zip.remove('items/item_001/image.png')
    zip.file('project_manifest.json', JSON.stringify(manifest))
    await assert.rejects(storage.importProjectBundle(await zip.generateAsync({ type: 'blob' })), undefined, change)
  }
})