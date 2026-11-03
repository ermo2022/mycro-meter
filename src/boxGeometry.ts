export type GeometryPoint = { x: number; y: number }
export type OrientedBox = { centerX: number; centerY: number; width: number; height: number; angle: number }
type LegacyBox = OrientedBox & { x?: number; y?: number }
export type BoxHandle = 'n' | 'ne' | 'e' | 'se' | 's' | 'sw' | 'w' | 'nw' | 'rotate'
export type BoxHandlePoint = { handle: BoxHandle; x: number; y: number }

export function normalizeOrientedBox(box: OrientedBox): OrientedBox {
  const legacy = box as LegacyBox
  const centerX = Number.isFinite(legacy.centerX) ? legacy.centerX : (legacy.x ?? 0) + legacy.width / 2
  const centerY = Number.isFinite(legacy.centerY) ? legacy.centerY : (legacy.y ?? 0) + legacy.height / 2
  return {
    centerX,
    centerY,
    width: legacy.width,
    height: legacy.height,
    angle: Number.isFinite(legacy.angle) ? legacy.angle : 0,
  }
}

export function normalizeBoxAngle(angle: number) {
  return ((angle + 90) % 180 + 180) % 180 - 90
}

export function longAxisFirst(box: OrientedBox): OrientedBox {
  const normalized = normalizeOrientedBox(box)
  if (normalized.width >= normalized.height) return normalized
  return {
    ...normalized,
    width: normalized.height,
    height: normalized.width,
    angle: normalizeBoxAngle(normalized.angle + 90),
  }
}

export function boxCorners(box: OrientedBox): GeometryPoint[] {
  const normalized = normalizeOrientedBox(box)
  const halfWidth = normalized.width / 2
  const halfHeight = normalized.height / 2
  const radians = normalized.angle * Math.PI / 180
  const cosine = Math.cos(radians)
  const sine = Math.sin(radians)
  const localCorners = [
    { x: -halfWidth, y: -halfHeight },
    { x: halfWidth, y: -halfHeight },
    { x: halfWidth, y: halfHeight },
    { x: -halfWidth, y: halfHeight },
  ]
  return localCorners.map((point) => ({
    x: normalized.centerX + point.x * cosine - point.y * sine,
    y: normalized.centerY + point.x * sine + point.y * cosine,
  }))
}

export function boxBounds(box: OrientedBox) {
  const corners = boxCorners(box)
  const xs = corners.map((point) => point.x)
  const ys = corners.map((point) => point.y)
  const x = Math.min(...xs)
  const y = Math.min(...ys)
  return { x, y, width: Math.max(...xs) - x, height: Math.max(...ys) - y }
}

export function boxContainsPoint(box: OrientedBox, point: GeometryPoint) {
  const normalized = normalizeOrientedBox(box)
  const radians = -normalized.angle * Math.PI / 180
  const dx = point.x - normalized.centerX
  const dy = point.y - normalized.centerY
  const localX = dx * Math.cos(radians) - dy * Math.sin(radians)
  const localY = dx * Math.sin(radians) + dy * Math.cos(radians)
  return Math.abs(localX) <= normalized.width / 2 && Math.abs(localY) <= normalized.height / 2
}

export function boxHandles(box: OrientedBox, rotationOffset: number): BoxHandlePoint[] {
  const normalized = normalizeOrientedBox(box)
  const halfWidth = normalized.width / 2
  const halfHeight = normalized.height / 2
  const radians = normalized.angle * Math.PI / 180
  const cosine = Math.cos(radians)
  const sine = Math.sin(radians)
  const handles: Array<{ handle: BoxHandle; x: number; y: number }> = [
    { handle: 'nw', x: -halfWidth, y: -halfHeight },
    { handle: 'n', x: 0, y: -halfHeight },
    { handle: 'ne', x: halfWidth, y: -halfHeight },
    { handle: 'e', x: halfWidth, y: 0 },
    { handle: 'se', x: halfWidth, y: halfHeight },
    { handle: 's', x: 0, y: halfHeight },
    { handle: 'sw', x: -halfWidth, y: halfHeight },
    { handle: 'w', x: -halfWidth, y: 0 },
    { handle: 'rotate', x: 0, y: -halfHeight - rotationOffset },
  ]
  return handles.map(({ handle, x, y }) => ({
    handle,
    x: normalized.centerX + x * cosine - y * sine,
    y: normalized.centerY + x * sine + y * cosine,
  }))
}

export function resizeOrientedBox(box: OrientedBox, handle: Exclude<BoxHandle, 'rotate'>, point: GeometryPoint): OrientedBox {
  const normalized = normalizeOrientedBox(box)
  const radians = normalized.angle * Math.PI / 180
  const cosine = Math.cos(radians)
  const sine = Math.sin(radians)
  const dx = point.x - normalized.centerX
  const dy = point.y - normalized.centerY
  const localX = dx * cosine + dy * sine
  const localY = -dx * sine + dy * cosine
  const minimumSide = 2
  let left = -normalized.width / 2
  let right = normalized.width / 2
  let top = -normalized.height / 2
  let bottom = normalized.height / 2

  if (handle.includes('w')) left = Math.min(localX, right - minimumSide)
  if (handle.includes('e')) right = Math.max(localX, left + minimumSide)
  if (handle.includes('n')) top = Math.min(localY, bottom - minimumSide)
  if (handle.includes('s')) bottom = Math.max(localY, top + minimumSide)

  const localCenterX = (left + right) / 2
  const localCenterY = (top + bottom) / 2
  return {
    centerX: normalized.centerX + localCenterX * cosine - localCenterY * sine,
    centerY: normalized.centerY + localCenterX * sine + localCenterY * cosine,
    width: right - left,
    height: bottom - top,
    angle: normalized.angle,
  }
}

export function rotateOrientedBox(box: OrientedBox, start: GeometryPoint, current: GeometryPoint): OrientedBox {
  const normalized = normalizeOrientedBox(box)
  const startAngle = Math.atan2(start.y - normalized.centerY, start.x - normalized.centerX)
  const currentAngle = Math.atan2(current.y - normalized.centerY, current.x - normalized.centerX)
  const angle = normalized.angle + (currentAngle - startAngle) * 180 / Math.PI
  return { ...normalized, angle: ((angle + 180) % 360 + 360) % 360 - 180 }
}

export function constrainBoxToImage(box: OrientedBox, imageSize: GeometryPoint): OrientedBox {
  const normalized = normalizeOrientedBox(box)
  const bounds = boxBounds(normalized)
  const shiftX = bounds.width > imageSize.x
    ? imageSize.x / 2 - normalized.centerX
    : bounds.x < 0 ? -bounds.x : bounds.x + bounds.width > imageSize.x ? imageSize.x - bounds.x - bounds.width : 0
  const shiftY = bounds.height > imageSize.y
    ? imageSize.y / 2 - normalized.centerY
    : bounds.y < 0 ? -bounds.y : bounds.y + bounds.height > imageSize.y ? imageSize.y - bounds.y - bounds.height : 0
  return { ...normalized, centerX: normalized.centerX + shiftX, centerY: normalized.centerY + shiftY }
}