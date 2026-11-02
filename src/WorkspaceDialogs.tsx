import { useEffect, useRef, useState, type ReactNode } from 'react'
import { Download, FolderOpen, Move, Trash2, X } from 'lucide-react'
import { adjustImageCrop, imageProcessingSize, type CropHandle, type ImageCrop } from './imageResampler'
import { formatStorageBytes, projectStorageBytes, type StoredSession, type StoredSet } from './projectStorage'

type Translate = (key: string, values?: Record<string, string | number>) => string

function Dialog({ title, closeLabel, onClose, children }: { title: string; closeLabel: string; onClose: () => void; children: ReactNode }) {
  const ref = useRef<HTMLDialogElement>(null)
  useEffect(() => {
    const dialog = ref.current!
    dialog.showModal()
    return () => dialog.close()
  }, [])
  return <dialog ref={ref} className="workspace-dialog" aria-label={title} onCancel={(event) => { event.preventDefault(); onClose() }}>
    <header className="workspace-dialog-header"><h2>{title}</h2><button className="tool-button" type="button" title={closeLabel} aria-label={closeLabel} onClick={onClose}><X size={18} /></button></header>
    {children}
  </dialog>
}

function Thumbnail({ record }: { record: StoredSession }) {
  const [url, setUrl] = useState('')
  useEffect(() => {
    const next = URL.createObjectURL(record.imageBlob)
    setUrl(next)
    return () => URL.revokeObjectURL(next)
  }, [record.imageBlob])
  return <img className="project-thumbnail" src={url || undefined} alt="" loading="lazy" />
}

export function ProjectLibrary({ sessions, sets, activeSessionId, activeSetId, onOpen, onOpenSet, onDelete, onExport, onExportSet, onClose, t }: {
  sessions: StoredSession[]; sets: StoredSet[]
  activeSessionId: string; activeSetId: string
  onOpen: (record: StoredSession) => void; onOpenSet: (record: StoredSet) => void
  onDelete: (id: string, kind: 'session' | 'set') => void
  onExport: (record: StoredSession) => void; onExportSet: (record: StoredSet) => void
  onClose: () => void; t: Translate
}) {
  const [tab, setTab] = useState<'sessions' | 'sets'>('sessions')
  return <Dialog title={t('Saved projects')} closeLabel={t('Close')} onClose={onClose}>
    <div className="project-tabs" role="tablist" aria-label={t('Saved projects')}>
      <button id="sessions-tab" role="tab" aria-selected={tab === 'sessions'} aria-controls="project-list" onClick={() => setTab('sessions')}>{t('Sessions')} ({sessions.length})</button>
      <button id="sets-tab" role="tab" aria-selected={tab === 'sets'} aria-controls="project-list" onClick={() => setTab('sets')}>{t('Sets')} ({sets.length})</button>
    </div>
    <div className="project-library-list" id="project-list" role="tabpanel" aria-labelledby={tab === 'sessions' ? 'sessions-tab' : 'sets-tab'}>
      {tab === 'sessions' ? sessions.map((record) => <div className="project-row" key={record.id}>
        <button className="project-open" type="button" onClick={() => onOpen(record)}><Thumbnail record={record} /><span><strong>{record.metadata.imageName}</strong><small>{t('{count} measurements', { count: record.metadata.measurements.length })} / {new Date(record.updatedAt).toLocaleString()}</small>{record.id === activeSessionId && <small>{t('Open project')}</small>}<small title={t('Image and data size; browser overhead is not included')}>{t('Estimated storage: {size}', { size: formatStorageBytes(projectStorageBytes(record)) })}</small></span></button>
        <button className="tool-button" type="button" title={t('Export session')} aria-label={t('Export session')} onClick={() => onExport(record)}><Download size={17} /></button>
        <button className="tool-button" type="button" title={t(record.id === activeSessionId ? 'Open project cannot be deleted. Open another project first.' : 'Delete saved project')} aria-label={t(record.id === activeSessionId ? 'Open project cannot be deleted. Open another project first.' : 'Delete saved project')} disabled={record.id === activeSessionId} onClick={() => onDelete(record.id, 'session')}><Trash2 size={17} /></button>
      </div>) : sets.map((record) => <div className="project-row" key={record.id}>
        <button className="project-open" type="button" onClick={() => onOpenSet(record)}><FolderOpen size={24} /><span><strong>{record.name}</strong><small>{t('{count} images', { count: record.images.length })} / {new Date(record.updatedAt).toLocaleString()}</small>{record.id === activeSetId && <small>{t('Open project')}</small>}<small title={t('Image and data size; browser overhead is not included')}>{t('Estimated storage: {size}', { size: formatStorageBytes(projectStorageBytes(record)) })}</small></span></button>
        <button className="tool-button" type="button" title={t('Export set')} aria-label={t('Export set')} onClick={() => onExportSet(record)}><Download size={17} /></button>
        <button className="tool-button" type="button" title={t(record.id === activeSetId ? 'Open project cannot be deleted. Open another project first.' : 'Delete saved project')} aria-label={t(record.id === activeSetId ? 'Open project cannot be deleted. Open another project first.' : 'Delete saved project')} disabled={record.id === activeSetId} onClick={() => onDelete(record.id, 'set')}><Trash2 size={17} /></button>
      </div>)}
      {(tab === 'sessions' ? !sessions.length : !sets.length) && <p className="project-empty">{t('No saved projects')}</p>}
    </div>
  </Dialog>
}

export function ImageProcessingDialog({ image, onApply, onClose, t }: {
  image: HTMLImageElement; onApply: (crop: ImageCrop, reduction: number) => Promise<void>; onClose: () => void; t: Translate
}) {
  const [crop, setCrop] = useState<ImageCrop>({ x: 0, y: 0, width: image.naturalWidth, height: image.naturalHeight })
  const [reduction, setReduction] = useState(1)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const drag = useRef<{ pointerId: number; x: number; y: number; crop: ImageCrop; handle: CropHandle | null } | null>(null)
  const handleLabels: Record<CropHandle, string> = {
    n: 'Resize crop top edge', ne: 'Resize crop top right corner', e: 'Resize crop right edge',
    se: 'Resize crop bottom right corner', s: 'Resize crop bottom edge', sw: 'Resize crop bottom left corner',
    w: 'Resize crop left edge', nw: 'Resize crop top left corner', move: 'Move crop',
  }
  let output: { width: number; height: number } | null = null
  try { output = imageProcessingSize(image.naturalWidth, image.naturalHeight, crop, reduction) } catch {}
  return <Dialog title={t('Crop and resample')} closeLabel={t('Close')} onClose={() => { if (!busy) onClose() }}>
    <form className="image-processing-form" onSubmit={(event) => {
      event.preventDefault()
      if (!output || busy) return
      setBusy(true)
      void onApply(crop, reduction).catch((failure) => { setError(String(failure)); setBusy(false) })
    }}>
      <div className="crop-preview" style={{ width: `min(100%, ${45 * image.naturalWidth / image.naturalHeight}dvh)` }} onPointerDown={(event) => {
        if (busy || drag.current || event.button !== 0) return
        const bounds = event.currentTarget.getBoundingClientRect()
        let handle = (event.target as HTMLElement).closest<HTMLElement>('[data-crop-handle]')?.dataset.cropHandle as CropHandle | undefined
        if (handle === 'move' && crop.width === image.naturalWidth && crop.height === image.naturalHeight) handle = undefined
        drag.current = { pointerId: event.pointerId, x: Math.max(0, Math.min(image.naturalWidth - 1, Math.round((event.clientX - bounds.left) / bounds.width * image.naturalWidth))), y: Math.max(0, Math.min(image.naturalHeight - 1, Math.round((event.clientY - bounds.top) / bounds.height * image.naturalHeight))), crop: { ...crop }, handle: output ? handle ?? null : null }
        event.currentTarget.setPointerCapture(event.pointerId)
      }} onPointerMove={(event) => {
        const start = drag.current
        if (!start || start.pointerId !== event.pointerId || busy) return
        const bounds = event.currentTarget.getBoundingClientRect()
        const endX = Math.max(0, Math.min(image.naturalWidth, Math.round((event.clientX - bounds.left) / bounds.width * image.naturalWidth)))
        const endY = Math.max(0, Math.min(image.naturalHeight, Math.round((event.clientY - bounds.top) / bounds.height * image.naturalHeight)))
        if (start.handle) setCrop(adjustImageCrop(start.crop, start.handle, endX - start.x, endY - start.y, image.naturalWidth, image.naturalHeight))
        else setCrop({ x: Math.min(start.x, endX), y: Math.min(start.y, endY), width: Math.max(1, Math.abs(endX - start.x)), height: Math.max(1, Math.abs(endY - start.y)) })
      }} onPointerUp={(event) => { if (drag.current?.pointerId === event.pointerId) drag.current = null }} onPointerCancel={() => { drag.current = null }} onLostPointerCapture={() => { drag.current = null }}>
        <img src={image.src} alt={t('Crop preview')} draggable={false} />
        <div className="crop-outline" style={{ left: `${crop.x / image.naturalWidth * 100}%`, top: `${crop.y / image.naturalHeight * 100}%`, width: `${crop.width / image.naturalWidth * 100}%`, height: `${crop.height / image.naturalHeight * 100}%` }}>
          {(Object.keys(handleLabels) as CropHandle[]).map((handle) => <button key={handle} className={handle === 'move' ? 'crop-move' : `crop-handle crop-handle-${handle}`} type="button" data-crop-handle={handle} aria-label={t(handleLabels[handle])} title={t(handleLabels[handle])} disabled={busy || !output} onKeyDown={(event) => {
            const directions: Record<string, [number, number]> = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] }
            const direction = directions[event.key]
            if (!direction || !output) return
            event.preventDefault()
            const step = event.shiftKey ? 10 : 1
            setCrop(adjustImageCrop(crop, handle, direction[0] * step, direction[1] * step, image.naturalWidth, image.naturalHeight))
          }}>{handle === 'move' && <Move size={20} aria-hidden="true" />}</button>)}
        </div>
      </div>
      <div className="crop-fields">{(['x', 'y', 'width', 'height'] as const).map((key) => <label key={key}>{t(key === 'x' ? 'Crop X' : key === 'y' ? 'Crop Y' : key === 'width' ? 'Crop width' : 'Crop height')}<input type="number" min={key === 'x' || key === 'y' ? 0 : 1} step="1" required disabled={busy} value={crop[key]} onChange={(event) => setCrop({ ...crop, [key]: Number(event.target.value) })} /></label>)}</div>
      <label className="detection-field"><span>{t('Reduction factor')} <strong>{reduction.toFixed(1)}x</strong></span><input aria-label={t('Reduction factor')} type="range" min="1" max="1.5" step="0.1" value={reduction} disabled={busy} onChange={(event) => setReduction(Number(event.target.value))} /></label>
      <output>{output ? `${output.width} x ${output.height} px / PNG` : t('Invalid crop')}</output>
      {error && <p role="alert">{error}</p>}
      <div className="project-form-actions"><button className="button button-small" type="button" disabled={busy} onClick={() => { setCrop({ x: 0, y: 0, width: image.naturalWidth, height: image.naturalHeight }); setReduction(1) }}>{t('Reset')}</button><button className="button button-primary" type="submit" disabled={!output || busy}>{t(busy ? 'Processing' : 'Apply crop')}</button></div>
    </form>
  </Dialog>
}