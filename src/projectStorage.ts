import localforage from 'localforage'
import { measurementSetCsv, sessionCsv, units, validateMeasurementSession, type MeasurementSession, type MeasurementSetImage, type Unit } from './measurementCsv'

export type StoredSession = {
  id: string
  updatedAt: number
  imageBlob: Blob
  metadata: MeasurementSession
  csv: string
}
export type StoredSet = {
  id: string
  name: string
  unit: Unit
  updatedAt: number
  sessionIdsList: string[]
  images: StoredSession[]
}

const sessions = localforage.createInstance({ name: 'mycrometer', storeName: 'sessions_store', driver: localforage.INDEXEDDB })
const sets = localforage.createInstance({ name: 'mycrometer', storeName: 'sets_store', driver: localforage.INDEXEDDB })
const MAX_PROJECT_BYTES = 128 * 1024 * 1024
const MAX_PNG_BYTES = 128 * 1024 * 1024
let writes: Promise<unknown> = Promise.resolve()

function enqueue<T>(operation: () => Promise<T>): Promise<T> {
  const result = writes.then(operation)
  writes = result.catch(() => undefined)
  return result
}

export function createSession(id: string, imageBlob: Blob, metadata: MeasurementSession): StoredSession {
  return {
    id, imageBlob, metadata, updatedAt: Date.now(),
    csv: sessionCsv(metadata.measurements, metadata.calibration, metadata.imageName, { x: metadata.imageWidth, y: metadata.imageHeight }),
  }
}

export function saveSession(record: StoredSession) {
  return enqueue(async () => {
    const valid = await normalizeStoredSession(record)
    if (!valid.metadata.calibration) return null
    return sessions.setItem(valid.id, valid)
  })
}

export function projectStorageBytes(record: StoredSession | StoredSet): number {
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

export function saveSet(record: StoredSet) {
  return enqueue(async () => sets.setItem(record.id, await normalizeStoredSet(record)))
}

export async function listProjects() {
  await writes
  const storedSessions: unknown[] = []
  const storedSets: unknown[] = []
  await sessions.iterate<unknown, void>((record) => { storedSessions.push(record) })
  await sets.iterate<unknown, void>((record) => { storedSets.push(record) })
  const sessionRecords: StoredSession[] = []
  const setRecords: StoredSet[] = []
  for (const record of storedSessions) sessionRecords.push(await normalizeStoredSession(record))
  for (const record of storedSets) setRecords.push(await normalizeStoredSet(record))
  return {
    sessions: sessionRecords.sort((first, second) => second.updatedAt - first.updatedAt),
    sets: setRecords.sort((first, second) => second.updatedAt - first.updatedAt),
  }
}

export function deleteProject(id: string, kind: 'session' | 'set') {
  return enqueue(() => (kind === 'session' ? sessions : sets).removeItem(id))
}

export function validateMetadata(value: unknown): asserts value is MeasurementSession {
  validateMeasurementSession(value)
}

export async function validatePng(blob: Blob, metadata: MeasurementSession) {
  if (blob.size > MAX_PNG_BYTES || blob.size < 33) throw new Error('Invalid PNG size')
  const header = new DataView(await blob.slice(0, 33).arrayBuffer())
  if (header.getUint32(0) !== 0x89504e47 || header.getUint32(4) !== 0x0d0a1a0a ||
    header.getUint32(8) !== 13 || header.getUint32(12) !== 0x49484452 ||
    header.getUint32(16) !== metadata.imageWidth || header.getUint32(20) !== metadata.imageHeight) {
    throw new Error('PNG dimensions do not match session metadata')
  }
}

async function normalizeStoredSession(value: unknown): Promise<StoredSession> {
  if (!value || typeof value !== 'object') throw new Error('Invalid stored session')
  const record = value as StoredSession
  if (typeof record.id !== 'string' || record.id.length === 0 || record.id.length > 256 ||
    !Number.isFinite(record.updatedAt) || record.updatedAt <= 0 || !(record.imageBlob instanceof Blob)) {
    throw new Error('Invalid stored session')
  }
  validateMetadata(record.metadata)
  await validatePng(record.imageBlob, record.metadata)
  return {
    id: record.id,
    updatedAt: record.updatedAt,
    imageBlob: record.imageBlob,
    metadata: record.metadata,
    csv: sessionCsv(record.metadata.measurements, record.metadata.calibration, record.metadata.imageName, {
      x: record.metadata.imageWidth,
      y: record.metadata.imageHeight,
    }),
  }
}

async function normalizeStoredSet(value: unknown): Promise<StoredSet> {
  if (!value || typeof value !== 'object') throw new Error('Invalid stored set')
  const record = value as StoredSet
  if (typeof record.id !== 'string' || record.id.length === 0 || record.id.length > 256 ||
    typeof record.name !== 'string' || record.name.length > 1024 || !units.includes(record.unit) ||
    !Number.isFinite(record.updatedAt) || record.updatedAt <= 0 ||
    !Array.isArray(record.sessionIdsList) || !Array.isArray(record.images) ||
    record.images.length === 0 || record.images.length > 100 || record.sessionIdsList.length !== record.images.length) {
    throw new Error('Invalid stored set')
  }
  const images: StoredSession[] = []
  let totalImageBytes = 0
  for (const [index, value] of record.images.entries()) {
    const image = await normalizeStoredSession(value)
    if (record.sessionIdsList[index] !== image.id || !image.metadata.calibration) throw new Error('Invalid stored set image')
    totalImageBytes += image.imageBlob.size
    if (totalImageBytes > MAX_PROJECT_BYTES) throw new Error('Stored set exceeds the size limit')
    images.push(image)
  }
  return { ...record, images }
}

export async function exportProjectBundle(records: StoredSession[], set?: StoredSet): Promise<Blob> {
  if (!records.length || records.length > 100) throw new Error('A project must contain 1 to 100 images')
  if (records.reduce((total, record) => total + record.imageBlob.size, 0) > MAX_PROJECT_BYTES) throw new Error('Project exceeds the 128 MiB limit')
  const { default: JSZip } = await import('jszip')
  const zip = new JSZip()
  const items = records.map((record, index) => ({ path: `items/item_${String(index + 1).padStart(3, '0')}`, id: record.id }))
  zip.file('project_manifest.json', JSON.stringify({
    format: 'mycrometer', version: 1, kind: set ? 'set' : 'session',
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

export async function importProjectBundle(file: Blob): Promise<{ sessions: StoredSession[]; set?: StoredSet }> {
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
    !['session', 'set'].includes(manifest.kind) || typeof manifest.name !== 'string' ||
    !Array.isArray(manifest.items) || !manifest.items.length || manifest.items.length > 100 ||
    (manifest.kind === 'session' && manifest.items.length !== 1) ||
    (manifest.kind === 'set' && !units.includes(manifest.unit))) throw new Error('Invalid or unsupported Mycrometer project')
  const records: StoredSession[] = []
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
    records.push(createSession(crypto.randomUUID(), imageBlob, metadata))
  }
  const set: StoredSet | undefined = manifest.kind === 'set' ? {
    id: crypto.randomUUID(), name: manifest.name, unit: manifest.unit, updatedAt: Date.now(),
    sessionIdsList: records.map((record) => record.id), images: records,
  } : undefined
  return { sessions: records, set }
}