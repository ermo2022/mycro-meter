import { useEffect, useRef, useState, type MouseEvent } from 'react'
import { Trash2 } from 'lucide-react'
import { boxBounds, boxCorners, type OrientedBox } from './boxGeometry'
import type { Point } from './measurementCsv'

export type DetectionReviewItem = OrientedBox & {
  id: string
  recovery?: 'contrast' | 'rim'
  source?: 'direct' | 'watershed'
}

type DetectionReviewDialogProps = {
  image: HTMLImageElement
  imageSize: Point
  detections: DetectionReviewItem[]
  busy: boolean
  editing: boolean
  error?: string
  translate: (key: string, values?: Record<string, string | number>) => string
  formatDimensions: (box: OrientedBox) => string
  onRemove: (id: string) => void
  onEdit: (detection: DetectionReviewItem) => void
  onCancel: () => void
  onAccept: () => void
}

export function DetectionReviewDialog({
  image,
  imageSize,
  detections,
  busy,
  editing,
  error,
  translate: t,
  formatDimensions,
  onRemove,
  onEdit,
  onCancel,
  onAccept,
}: DetectionReviewDialogProps) {
  const dialogRef = useRef<HTMLElement>(null)
  const closeButtonRef = useRef<HTMLButtonElement>(null)
  const onCancelRef = useRef(onCancel)
  const editingRef = useRef(editing)
  const busyRef = useRef(busy)
  const editFocusRef = useRef<HTMLElement | null>(null)
  const candidateSelectRefs = useRef(new Map<string, HTMLButtonElement>())
  const [selectedId, setSelectedId] = useState(detections[0]?.id ?? '')

  onCancelRef.current = onCancel
  editingRef.current = editing
  busyRef.current = busy

  useEffect(() => {
    if (!detections.some((detection) => detection.id === selectedId)) {
      setSelectedId(detections[0]?.id ?? '')
    }
  }, [detections, selectedId])

  useEffect(() => {
    if (!editing) {
      editFocusRef.current?.focus()
      editFocusRef.current = null
    }
  }, [editing])

  useEffect(() => {
    const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null
    const previousOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    closeButtonRef.current?.focus()

    const handleKeyDown = (event: KeyboardEvent) => {
      if (editingRef.current) return
      if (event.key === 'Escape') {
        event.preventDefault()
        if (!busyRef.current) onCancelRef.current()
        return
      }
      if (event.key !== 'Tab') return

      const focusable = [...(dialogRef.current?.querySelectorAll<HTMLElement>(
        'button:not(:disabled), [tabindex]:not([tabindex="-1"])',
      ) ?? [])]
      if (!focusable.length) return
      const first = focusable[0]
      const last = focusable[focusable.length - 1]
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault()
        last.focus()
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault()
        first.focus()
      }
    }

    window.addEventListener('keydown', handleKeyDown)
    return () => {
      window.removeEventListener('keydown', handleKeyDown)
      document.body.style.overflow = previousOverflow
      if (previousFocus?.isConnected) previousFocus.focus()
    }
  }, [])

  const labelFor = (detection: DetectionReviewItem, index: number) => {
    if (detection.id === 'reference-spore') return t('Reference spore')
    const referenceOffset = detections.some((item) => item.id === 'reference-spore') ? 1 : 0
    return t('Spore {number}', { number: index + 1 - referenceOffset })
  }

  const handleEdit = (event: MouseEvent<HTMLButtonElement>, detection: DetectionReviewItem) => {
    editFocusRef.current = event.currentTarget
    onEdit(detection)
  }

  const handleRemove = (id: string, index: number) => {
    const next = detections[index + 1] ?? detections[index - 1]
    if (next) setSelectedId(next.id)
    onRemove(id)
    window.requestAnimationFrame(() => {
      if (next) candidateSelectRefs.current.get(next.id)?.focus()
      else closeButtonRef.current?.focus()
    })
  }

  return (
    <div
      className="detection-review-backdrop"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget && !editing && !busy) onCancel()
      }}
    >
      <section ref={dialogRef} className="detection-review-dialog" role="dialog" aria-modal="true" aria-busy={busy} aria-labelledby="detection-review-title" tabIndex={-1}>
        <header className="detection-review-header">
          <div>
            <h2 id="detection-review-title">{t('Review detected spores')}</h2>
            <p>{t('Review each spore crop. Delete false detections or resize/rotate their boxes before accepting.')}</p>
          </div>
          <button ref={closeButtonRef} className="box-editor-close" type="button" aria-label={t('Cancel review')} disabled={busy} onClick={onCancel}>×</button>
        </header>
        <div className="detection-review-main">
          <section className="detection-review-candidates" aria-label={t('Detected spores')}>
            <h3>{t('Detected spores')} <span>{detections.length}</span></h3>
            {detections.length ? (
              <div className="detection-review-grid">
                {detections.map((detection, index) => (
                  <article
                    key={detection.id}
                    className={`detection-review-card ${detection.id === selectedId ? 'is-selected' : ''}`}
                  >
                    <button
                      className="detection-review-card-select"
                      type="button"
                      ref={(element) => {
                        if (element) candidateSelectRefs.current.set(detection.id, element)
                        else candidateSelectRefs.current.delete(detection.id)
                      }}
                      disabled={busy}
                      aria-pressed={detection.id === selectedId}
                      onClick={() => setSelectedId(detection.id)}
                    >
                      <span className="detection-review-thumbnail-wrap">
                        <DetectionCropThumbnail
                          image={image}
                          imageSize={imageSize}
                          detection={detection}
                          selected={detection.id === selectedId}
                          label={labelFor(detection, index)}
                        />
                        <span className="detection-review-number">
                          {detection.id === 'reference-spore'
                            ? 'R'
                            : index + 1 - (detections.some((item) => item.id === 'reference-spore') ? 1 : 0)}
                        </span>
                      </span>
                      <span className="detection-review-card-detail">
                        <strong>{labelFor(detection, index)}</strong>
                        <small>{formatDimensions(detection)}</small>
                      </span>
                    </button>
                    <div className="detection-review-card-actions">
                      <button className="text-button" type="button" disabled={busy} onClick={(event) => handleEdit(event, detection)}>{t('Edit box')}</button>
                      <button
                        className="detection-review-remove"
                        type="button"
                        disabled={busy}
                        aria-label={t('Remove {name}', { name: labelFor(detection, index) })}
                        title={t('Remove {name}', { name: labelFor(detection, index) })}
                        onClick={() => handleRemove(detection.id, index)}
                      >
                        <Trash2 size={15} aria-hidden="true" />
                        {t('Delete')}
                      </button>
                    </div>
                  </article>
                ))}
              </div>
            ) : (
              <p className="detection-review-empty">{t('No detections remain.')}</p>
            )}
          </section>
        </div>
        {error && <p className="detection-review-error" role="alert">{error}</p>}
        <footer className="detection-review-footer">
          <button className="button box-editor-cancel" type="button" disabled={busy} onClick={onCancel}>{t('Cancel review')}</button>
          <button className="button button-primary" type="button" disabled={busy || !detections.length} onClick={onAccept}>
            {busy && <span className="activity-spinner" aria-hidden="true" />}
            {t(busy ? 'Adding measurements…' : detections.length === 1 ? 'Accept one measurement' : 'Accept {count} measurements', { count: detections.length })}
          </button>
        </footer>
      </section>
    </div>
  )
}

function DetectionCropThumbnail({
  image,
  imageSize,
  detection,
  selected,
  label,
}: {
  image: HTMLImageElement
  imageSize: Point
  detection: DetectionReviewItem
  selected: boolean
  label: string
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const [visible, setVisible] = useState(false)

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    if (!('IntersectionObserver' in window)) {
      setVisible(true)
      return
    }
    const observer = new IntersectionObserver(([entry]) => setVisible(entry.isIntersecting), {
      root: canvas.closest('.detection-review-grid'),
      rootMargin: '80px',
    })
    observer.observe(canvas)
    return () => observer.disconnect()
  }, [])

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    if (!visible) {
      canvas.width = 1
      canvas.height = 1
      return
    }

    const width = 480
    const height = 300
    canvas.width = width
    canvas.height = height
    const context = canvas.getContext('2d')
    if (!context) return

    const bounds = boxBounds(detection)
    const cropWidth = Math.min(imageSize.x, bounds.width + Math.max(8, bounds.width * 0.3))
    const cropHeight = Math.min(imageSize.y, bounds.height + Math.max(8, bounds.height * 0.3))
    const cropX = Math.max(0, Math.min(imageSize.x - cropWidth, detection.centerX - cropWidth / 2))
    const cropY = Math.max(0, Math.min(imageSize.y - cropHeight, detection.centerY - cropHeight / 2))
    const scale = Math.min((width - 16) / cropWidth, (height - 16) / cropHeight)
    const drawWidth = cropWidth * scale
    const drawHeight = cropHeight * scale
    const offsetX = (width - drawWidth) / 2
    const offsetY = (height - drawHeight) / 2

    context.fillStyle = '#17221e'
    context.fillRect(0, 0, width, height)
    context.imageSmoothingEnabled = true
    context.imageSmoothingQuality = 'high'
    context.drawImage(image, cropX, cropY, cropWidth, cropHeight, offsetX, offsetY, drawWidth, drawHeight)
    context.beginPath()
    boxCorners(detection).forEach((point, index) => {
      const x = offsetX + (point.x - cropX) * scale
      const y = offsetY + (point.y - cropY) * scale
      if (index === 0) context.moveTo(x, y)
      else context.lineTo(x, y)
    })
    context.closePath()
    context.lineWidth = selected ? 5 : 3
    context.strokeStyle = detection.id === 'reference-spore'
      ? '#e0b14a'
      : detection.recovery ? '#c883d2' : '#43d6ad'
    context.stroke()
  }, [detection, image, imageSize, selected, visible])

  return <canvas ref={canvasRef} className="detection-review-thumbnail" role="img" aria-label={label} />
}
