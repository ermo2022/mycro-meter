import { normalizeOrientedBox, type OrientedBox } from './boxGeometry'

export type Point = { x: number; y: number }
export type Measurement =
  | { id: number; kind: 'distance'; start: Point; end: Point; pixels: number; name: string }
  | { id: number; kind: 'box'; objectId: string; rect: OrientedBox; name: string }

export const units = ['µm', 'mm', 'nm'] as const
export const MAX_SESSION_CSV_BYTES = 10 * 1024 * 1024
export const MAX_SESSION_MEASUREMENTS = 10_000
export const MAX_SESSION_IMAGE_PIXELS = 40_000_000
export type Unit = (typeof units)[number]
export type Calibration = { pixelsPerUnit: number; unit: Unit }

export type MeasurementSession = {
  imageName: string
  imageWidth: number
  imageHeight: number
  calibration: Calibration | null
  measurements: Measurement[]
}

export type MeasurementSetImage = MeasurementSession & { id: string; calibration: Calibration }

const micrometresPerUnit: Record<Unit, number> = { 'µm': 1, mm: 1000, nm: 0.001 }

function calibrationInUnit(calibration: Calibration, unit: Unit): Calibration {
  return {
    pixelsPerUnit: calibration.pixelsPerUnit * micrometresPerUnit[unit] / micrometresPerUnit[calibration.unit],
    unit,
  }
}

export function measurementSetBoxes(images: MeasurementSetImage[], unit: Unit) {
  return images.flatMap((image) => {
    const calibration = calibrationInUnit(image.calibration, unit)
    return image.measurements.flatMap((measurement) => {
      if (measurement.kind !== 'box') return []
      const box = normalizeOrientedBox(measurement.rect)
      return [{ length: box.width / calibration.pixelsPerUnit, width: box.height / calibration.pixelsPerUnit, q: box.width / Math.max(1, box.height) }]
    })
  })
}

const rawHeader = ['Name', 'Type', 'Length', 'Width', 'Q', 'Unit', 'Length_px', 'Width_px', 'Angle_deg']
const sessionHeader = [...rawHeader, 'Image', 'Image_width_px', 'Image_height_px', 'Pixels_per_unit', 'Center_x_px', 'Center_y_px', 'Start_x_px', 'Start_y_px', 'End_x_px', 'End_y_px']

function rawFields(item: Measurement, calibration: Calibration | null): string[] {
  const pixelsPerUnit = calibration?.pixelsPerUnit ?? 1
  const unit = calibration?.unit ?? 'px'
  if (item.kind === 'distance') {
    return [item.name, 'Distance', String(item.pixels / pixelsPerUnit), '', '', unit, String(item.pixels), '', '']
  }
  const { width, height, angle } = normalizeOrientedBox(item.rect)
  const q = width / Math.max(1, height)
  return [item.name, 'Box', String(width / pixelsPerUnit), String(height / pixelsPerUnit), q.toFixed(4), unit, String(width), String(height), String(angle)]
}

// Prefix text that spreadsheets would evaluate as a formula.
function csvField(value: string) {
  const safe = /^[=+\-@\t\r]/.test(value) && !Number.isFinite(Number(value)) ? `'${value}` : value
  return `"${safe.replaceAll('"', '""')}"`
}

function unescapeText(value: string) {
  return /^'[=+\-@\t\r]/.test(value) ? value.slice(1) : value
}

function toCsv(rows: string[][]) {
  return rows.map((row) => row.map(csvField).join(',')).join('\n')
}

export function rawMeasurementsCsv(measurements: Measurement[], calibration: Calibration | null) {
  return toCsv([rawHeader, ...measurements.map((item) => rawFields(item, calibration))])
}

export function measurementSetCsv(images: MeasurementSetImage[], unit: Unit) {
  return toCsv([
    ['Image_ID', 'Image', ...rawHeader],
    ...images.flatMap((image) => image.measurements.map((measurement) => [
      image.id,
      image.imageName,
      ...rawFields(measurement, calibrationInUnit(image.calibration, unit)),
    ])),
  ])
}

export function sessionCsv(measurements: Measurement[], calibration: Calibration | null, imageName: string, imageSize: Point) {
  return toCsv([
    sessionHeader,
    ...measurements.map((item) => {
      const box = item.kind === 'box' ? normalizeOrientedBox(item.rect) : null
      const geometry = item.kind === 'box'
        ? [box!.centerX, box!.centerY, '', '', '', '']
        : ['', '', item.start.x, item.start.y, item.end.x, item.end.y]
      return [
        ...rawFields(item, calibration),
        imageName,
        String(imageSize.x),
        String(imageSize.y),
        calibration ? String(calibration.pixelsPerUnit) : '',
        ...geometry.map(String),
      ]
    }),
  ])
}

function parseCsv(text: string): string[][] {
  if (text.length > MAX_SESSION_CSV_BYTES) throw new Error('Session CSV exceeds the 10 MiB limit')
  const rows: string[][] = []
  let row: string[] = []
  let field = ''
  let quoted = false
  for (let index = 0; index < text.length; index++) {
    const char = text[index]
    if (quoted) {
      if (char !== '"') field += char
      else if (text[index + 1] === '"') {
        field += '"'
        index++
      } else quoted = false
    } else if (char === '"') {
      quoted = true
    } else if (char === ',') {
      row.push(field)
      field = ''
    } else if (char === '\n' || char === '\r') {
      if (char === '\r' && text[index + 1] === '\n') index++
      row.push(field)
      rows.push(row)
      if (rows.length > MAX_SESSION_MEASUREMENTS + 1) throw new Error('Session CSV exceeds the 10,000 measurement limit')
      row = []
      field = ''
    } else {
      field += char
    }
  }
  if (field || row.length) {
    row.push(field)
    rows.push(row)
  }
  if (rows.length > MAX_SESSION_MEASUREMENTS + 1) throw new Error('Session CSV exceeds the 10,000 measurement limit')
  return rows
}

export function parseSessionCsv(text: string): MeasurementSession {
  const rows = parseCsv(text.replace(/^\uFEFF/, '')).filter((row) => row.some((field) => field.trim() !== ''))
  const [header, ...records] = rows
  if (!header) throw new Error('That CSV is empty')
  const columns = new Map(header.map((name, index) => [name.trim(), index]))
  if (sessionHeader.some((name) => !columns.has(name))) {
    throw new Error('That CSV has no saved image geometry · import a session export')
  }
  if (!records.length) throw new Error('That CSV contains no measurements')

  const reader = (record: string[], rowNumber: number) => {
    const text = (name: string) => (record[columns.get(name)!] ?? '').trim()
    const number = (name: string) => {
      const value = Number(text(name))
      if (text(name) === '' || !Number.isFinite(value)) throw new Error(`Invalid ${name} in CSV row ${rowNumber}`)
      return value
    }
    return { text, number }
  }

  const first = reader(records[0], 2)
  const imageWidth = first.number('Image_width_px')
  const imageHeight = first.number('Image_height_px')
  if (!Number.isInteger(imageWidth) || !Number.isInteger(imageHeight) || imageWidth <= 0 || imageHeight <= 0 || imageWidth * imageHeight > MAX_SESSION_IMAGE_PIXELS) {
    throw new Error('Session image dimensions are invalid or exceed 40 megapixels')
  }
  const unit = first.text('Unit')
  let calibration: Calibration | null = null
  if (unit !== 'px') {
    if (!(units as readonly string[]).includes(unit)) throw new Error(`Unsupported unit "${unit}" in CSV`)
    const pixelsPerUnit = first.number('Pixels_per_unit')
    if (pixelsPerUnit <= 0) throw new Error('Invalid calibration in CSV')
    calibration = { pixelsPerUnit, unit: unit as Unit }
  }

  const baseId = Date.now()
  const measurements = records.map((record, index): Measurement => {
    const { text, number } = reader(record, index + 2)
    const name = unescapeText(text('Name')) || `M${index + 1}`
    const id = baseId + index
    if (text('Type') === 'Distance') {
      const start = { x: number('Start_x_px'), y: number('Start_y_px') }
      const end = { x: number('End_x_px'), y: number('End_y_px') }
      return { id, kind: 'distance', start, end, pixels: Math.hypot(end.x - start.x, end.y - start.y), name }
    }
    if (text('Type') !== 'Box') throw new Error(`Unknown measurement type in CSV row ${index + 2}`)
    const width = number('Length_px')
    const height = number('Width_px')
    if (width <= 0 || height <= 0) throw new Error(`Invalid box size in CSV row ${index + 2}`)
    return {
      id,
      kind: 'box',
      objectId: `imported-${index + 1}`,
      rect: { centerX: number('Center_x_px'), centerY: number('Center_y_px'), width, height, angle: number('Angle_deg') },
      name,
    }
  })

  return { imageName: unescapeText(first.text('Image')), imageWidth, imageHeight, calibration, measurements }
}
