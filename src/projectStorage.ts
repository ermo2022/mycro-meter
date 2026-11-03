import localforage from 'localforage'
import { imageRecordCsv, measurementSetCsv, units, validateImageMeasurementData, type ImageMeasurementData, type MeasurementSetImage, type Unit } from './measurementCsv'

export type StoredImageRecord = {
  id: string
  updatedAt: number
  imageBlob: Blob
  metadata: ImageMeasurementData
  csv: string
}
export type StoredMeasurementSet = {
  id: string
  name: string
  unit: Unit
  updatedAt: number
  imageRecordIdsList: string[]
  images: StoredImageRecord[]
}

const imageRecords = localforage.createInstance({ name: 'mycrometer', storeName: 'image_records_store', driver: localforage.INDEXEDDB })
const sets = localforage.createInstance({ name: 'mycrometer', storeName: 'sets_store', driver: localforage.INDEXEDDB })
const MAX_PROJECT_BYTES = 128 * 1024 * 1024
const MAX_PNG_BYTES = 128 * 1024 * 1024
let writes: Promise<unknown> = Promise.resolve()

function enqueue<T>(operation: () => Promise<T>): Promise<T> {
  const result = writes.then(operation)
  writes = result.catch(() => undefined)
  return result
}

export function createImageRecord(id: string, imageBlob: Blob, metadata: ImageMeasurementData): StoredImageRecord {
  return {
    id, imageBlob, metadata, updatedAt: Date.now(),
    csv: imageRecordCsv(metadata.measurements, metadata.calibration, metadata.imageName, { x: metadata.imageWidth, y: metadata.imageHeight }),
  }
}

export function saveImageRecord(record: StoredImageRecord) {
  return enqueue(async () => {
    const valid = await normalizeStoredImageRecord(record)
    if (!valid.metadata.calibration) return null
    return imageRecords.setItem(valid.id, valid)
  })
}

export function projectStorageBytes(record: StoredImageRecord | StoredMeasurementSet): number {
  const dataBytes = new Blob([JSON.stringify(record, (_key, value: unknown) => value instanceof Blob ? undefined : value)]).size
  const imageBytes = 'imageBlob' in record
    ? record.imageBlob.size
    : record.images.reduce((total, image) => total + image.imageBlob.size, 0)
  return dataBytes + imageBytes
}

export function formatStorageBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} KiB`
  if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(1)} MiB`
  return `${(bytes / 1024 ** 3).toFixed(1)} GiB`
}

export function saveSet(record: StoredMeasurementSet) {
  return enqueue(async () => sets.setItem(record.id, await normalizeStoredSet(record)))
}

export async function listProjects() {
  await writes
  const storedImageRecords: unknown[] = []
  const storedSets: unknown[] = []
  await imageRecords.iterate<unknown, void>((record) => { storedImageRecords.push(record) })
  await sets.iterate<unknown, void>((record) => { storedSets.push(record) })
  const imageRecordList: StoredImageRecord[] = []
  const setRecords: StoredMeasurementSet[] = []
  for (const record of storedImageRecords) imageRecordList.push(await normalizeStoredImageRecord(record))
  for (const record of storedSets) setRecords.push(await normalizeStoredSet(record))
  return {
    imageRecords: imageRecordList.sort((first, second) => second.updatedAt - first.updatedAt),
    sets: setRecords.sort((first, second) => second.updatedAt - first.updatedAt),
  }
}

export function deleteProject(id: string, kind: 'image-record' | 'set') {
  return enqueue(() => (kind === 'image-record' ? imageRecords : sets).removeItem(id))
}

export function deleteProjects(projects: { id: string; kind: 'image-record' | 'set' }[]) {
  return enqueue(async () => {
    for (const project of projects) {
      await (project.kind === 'image-record' ? imageRecords : sets).removeItem(project.id)
    }
  })
}

export function validateMetadata(value: unknown): asserts value is ImageMeasurementData {
  validateImageMeasurementData(value)
}

export async function validatePng(blob: Blob, metadata: ImageMeasurementData) {
  if (blob.size > MAX_PNG_BYTES || blob.size < 33) throw new Error('Invalid PNG size')
  const header = new DataView(await blob.slice(0, 33).arrayBuffer())
  if (header.getUint32(0) !== 0x89504e47 || header.getUint32(4) !== 0x0d0a1a0a ||
    header.getUint32(8) !== 13 || header.getUint32(12) !== 0x49484452 ||
    header.getUint32(16) !== metadata.imageWidth || header.getUint32(20) !== metadata.imageHeight) {
    throw new Error('PNG dimensions do not match image metadata')
  }
}

async function normalizeStoredImageRecord(value: unknown): Promise<StoredImageRecord> {
  if (!value || typeof value !== 'object') throw new Error('Invalid stored image record')
  const record = value as StoredImageRecord
  if (typeof record.id !== 'string' || record.id.length === 0 || record.id.length > 256 ||
    !Number.isFinite(record.updatedAt) || record.updatedAt <= 0 || !(record.imageBlob instanceof Blob)) {
    throw new Error('Invalid stored image record')
  }
  validateMetadata(record.metadata)
  await validatePng(record.imageBlob, record.metadata)
  return {
    id: record.id,
    updatedAt: record.updatedAt,
    imageBlob: record.imageBlob,
    metadata: record.metadata,
    csv: imageRecordCsv(record.metadata.measurements, record.metadata.calibration, record.metadata.imageName, {
      x: record.metadata.imageWidth,
      y: record.metadata.imageHeight,
    }),
  }
}

async function normalizeStoredSet(value: unknown): Promise<StoredMeasurementSet> {
  if (!value || typeof value !== 'object') throw new Error('Invalid stored set')
  const record = value as StoredMeasurementSet
  if (typeof record.id !== 'string' || record.id.length === 0 || record.id.length > 256 ||
    typeof record.name !== 'string' || record.name.length > 1024 || !units.includes(record.unit) ||
    !Number.isFinite(record.updatedAt) || record.updatedAt <= 0 ||
    !Array.isArray(record.imageRecordIdsList) || !Array.isArray(record.images) ||
    record.images.length === 0 || record.images.length > 100 || record.imageRecordIdsList.length !== record.images.length) {
    throw new Error('Invalid stored set')
  }
  const images: StoredImageRecord[] = []
  let totalImageBytes = 0
  for (const [index, value] of record.images.entries()) {
    const image = await normalizeStoredImageRecord(value)
    if (record.imageRecordIdsList[index] !== image.id || !image.metadata.calibration) throw new Error('Invalid stored measurement-set image')
    totalImageBytes += image.imageBlob.size
    if (totalImageBytes > MAX_PROJECT_BYTES) throw new Error('Stored set exceeds the size limit')
    images.push(image)
  }
  return { ...record, images }
}

export async function exportProjectBundle(records: StoredImageRecord[], set?: StoredMeasurementSet): Promise<Blob> {
  if (!records.length || records.length > 100) throw new Error('A project must contain 1 to 100 images')
  if (records.reduce((total, record) => total + record.imageBlob.size, 0) > MAX_PROJECT_BYTES) throw new Error('Project exceeds the 128 MiB limit')
  const { default: JSZip } = await import('jszip')
  const zip = new JSZip()
  const items = records.map((record, index) => ({ path: `items/item_${String(index + 1).padStart(3, '0')}`, id: record.id }))
  zip.file('project_manifest.json', JSON.stringify({
    format: 'mycrometer', version: 1, kind: set ? 'set' : 'image',
    name: set?.name ?? records[0].metadata.imageName,
    unit: set?.unit ?? null, items,
  }, null, 2))
  for (const [index, record] of records.entries()) {
    validateMetadata(record.metadata)
    await validatePng(record.imageBlob, record.metadata)
    const path = items[index].path
    zip.file(`${path}/metadata.json`, JSON.stringify(record.metadata, null, 2))
    zip.file(`${path}/measurements.csv`, record.csv)
    zip.file(`${path}/image.png`, await record.imageBlob.arrayBuffer())
  }
  if (set) {
    zip.file('measurements.csv', measurementSetCsv(records.map((record) => ({ ...record.metadata, id: record.id })) as MeasurementSetImage[], set.unit))
  }
  const blob = await zip.generateAsync({ type: 'blob', compression: 'STORE' })
  if (blob.size > MAX_PROJECT_BYTES) throw new Error('Project exceeds the 128 MiB limit')
  return blob
}

export async function importProjectBundle(file: Blob): Promise<{ imageRecords: StoredImageRecord[]; set?: StoredMeasurementSet }> {
  if (file.size > MAX_PROJECT_BYTES) throw new Error('Project exceeds the 128 MiB limit')
  const { default: JSZip } = await import('jszip')
  const zip = await JSZip.loadAsync(file)
  let total = 0
  for (const entry of Object.values(zip.files)) {
    const size = (entry as unknown as { _data?: { uncompressedSize?: number } })._data?.uncompressedSize ?? 0
    total += size
    if (size > MAX_PNG_BYTES || total > MAX_PROJECT_BYTES) throw new Error('Expanded project exceeds the size limit')
  }
  const readJson = async (path: string) => {
    const entry = zip.file(path)
    if (!entry || (entry as unknown as { _data: { uncompressedSize: number } })._data.uncompressedSize > 10 * 1024 * 1024) {
      throw new Error(`Missing or oversized metadata: ${path}`)
    }
    return JSON.parse(await entry.async('string'))
  }
  const manifest = await readJson('project_manifest.json')
  if (!manifest || manifest.format !== 'mycrometer' || manifest.version !== 1 ||
    !['image', 'set'].includes(manifest.kind) || typeof manifest.name !== 'string' ||
    !Array.isArray(manifest.items) || !manifest.items.length || manifest.items.length > 100 ||
    (manifest.kind === 'image' && manifest.items.length !== 1) ||
    (manifest.kind === 'set' && !units.includes(manifest.unit))) throw new Error('Invalid or unsupported Mycrometer project')
  const records: StoredImageRecord[] = []
  const paths = new Set<string>()
  for (const item of manifest.items) {
    if (!item || typeof item.path !== 'string' || !/^items\/item_\d{3}$/.test(item.path) || paths.has(item.path)) throw new Error('Invalid project item path')
    paths.add(item.path)
    const metadata: unknown = await readJson(`${item.path}/metadata.json`)
    validateMetadata(metadata)
    if (manifest.kind === 'set' && !metadata.calibration) throw new Error('Set images require calibration')
    const entry = zip.file(`${item.path}/image.png`)
    if (!entry) throw new Error('Project image is missing')
    const imageBlob = new Blob([await entry.async('arraybuffer')], { type: 'image/png' })
    await validatePng(imageBlob, metadata)
    records.push(createImageRecord(crypto.randomUUID(), imageBlob, metadata))
  }
  const set: StoredMeasurementSet | undefined = manifest.kind === 'set' ? {
    id: crypto.randomUUID(), name: manifest.name, unit: manifest.unit, updatedAt: Date.now(),
    imageRecordIdsList: records.map((record) => record.id), images: records,
  } : undefined
  return { imageRecords: records, set }
}