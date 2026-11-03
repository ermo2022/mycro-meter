import { useEffect, useRef, useState, type ReactNode } from 'react'
import { Download, FolderOpen, Trash2, X } from 'lucide-react'
import { imageProcessingSize, type ImageCrop } from './imageResampler'
import { formatStorageBytes, projectStorageBytes, type StoredImageRecord, type StoredMeasurementSet } from './projectStorage'

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

function Thumbnail({ record }: { record: StoredImageRecord }) {
  const [url, setUrl] = useState('')
  useEffect(() => {
    const next = URL.createObjectURL(record.imageBlob)
    setUrl(next)
    return () => URL.revokeObjectURL(next)
  }, [record.imageBlob])
  return <img className="project-thumbnail" src={url || undefined} alt="" loading="lazy" />
}

export function ProjectLibrary({ imageRecords, sets, activeImageRecordId, activeSetId, onOpen, onOpenSet, onDelete, onDeleteMany, onExport, onExportSet, onClose, t }: {
  imageRecords: StoredImageRecord[]; sets: StoredMeasurementSet[]
  activeImageRecordId: string; activeSetId: string
  onOpen: (record: StoredImageRecord) => void; onOpenSet: (record: StoredMeasurementSet) => void
  onDelete: (id: string, kind: 'image-record' | 'set') => void
  onDeleteMany: (projects: { id: string; kind: 'image-record' | 'set' }[]) => Promise<boolean>
  onExport: (record: StoredImageRecord) => void; onExportSet: (record: StoredMeasurementSet) => void
  onClose: () => void; t: Translate
}) {
  const [tab, setTab] = useState<'imageRecords' | 'sets'>('imageRecords')
  const [selectedImageRecordIds, setSelectedImageRecordIds] = useState<Set<string>>(new Set())
  const [selectedSetIds, setSelectedSetIds] = useState<Set<string>>(new Set())
  const selectAllRef = useRef<HTMLInputElement>(null)
  const visibleProjects = tab === 'imageRecords'
    ? imageRecords.filter((record) => record.id !== activeImageRecordId).map((record) => ({ id: record.id, kind: 'image-record' as const }))
    : sets.filter((record) => record.id !== activeSetId).map((record) => ({ id: record.id, kind: 'set' as const }))
  const selectedVisibleCount = visibleProjects.filter((project) => project.kind === 'image-record'
    ? selectedImageRecordIds.has(project.id)
    : selectedSetIds.has(project.id)).length
  const allVisibleSelected = visibleProjects.length > 0 && selectedVisibleCount === visibleProjects.length
  const selectedProjects = [
    ...imageRecords.filter((record) => selectedImageRecordIds.has(record.id)).map((record) => ({ id: record.id, kind: 'image-record' as const })),
    ...sets.filter((record) => selectedSetIds.has(record.id)).map((record) => ({ id: record.id, kind: 'set' as const })),
  ]
  useEffect(() => {
    if (selectAllRef.current) selectAllRef.current.indeterminate = selectedVisibleCount > 0 && !allVisibleSelected
  }, [selectedVisibleCount, allVisibleSelected])
  const toggleSelection = (id: string, kind: 'image-record' | 'set') => {
    const update = kind === 'image-record' ? setSelectedImageRecordIds : setSelectedSetIds
    update((current) => {
      const next = new Set(current)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }
  const toggleAllVisible = () => {
    const visibleIds = new Set(visibleProjects.map((project) => project.id))
    const update = tab === 'imageRecords' ? setSelectedImageRecordIds : setSelectedSetIds
    update((current) => {
      const next = new Set(current)
      if (allVisibleSelected) visibleIds.forEach((id) => next.delete(id))
      else visibleIds.forEach((id) => next.add(id))
      return next
    })
  }
  const deleteSelected = async () => {
    if (await onDeleteMany(selectedProjects)) {
      setSelectedImageRecordIds(new Set())
      setSelectedSetIds(new Set())
    }
  }
  return <Dialog title={t('Saved projects')} closeLabel={t('Close')} onClose={onClose}>
    <div className="project-tabs" role="tablist" aria-label={t('Saved projects')}>
      <button id="image-records-tab" role="tab" aria-selected={tab === 'imageRecords'} aria-controls="project-list" onClick={() => setTab('imageRecords')}>{t('Image records')} ({imageRecords.length})</button>
      <button id="sets-tab" role="tab" aria-selected={tab === 'sets'} aria-controls="project-list" onClick={() => setTab('sets')}>{t('Measurement sets')} ({sets.length})</button>
    </div>
    <div className="project-bulk-actions">
      <label><input ref={selectAllRef} type="checkbox" checked={allVisibleSelected} disabled={!visibleProjects.length} onChange={toggleAllVisible} />{t('Select all')}</label>
      <span>{t('{count} selected', { count: selectedProjects.length })}</span>
      <button className="button button-small" type="button" disabled={!selectedProjects.length} onClick={() => { void deleteSelected() }}><Trash2 size={15} />{t('Delete selected')}</button>
    </div>
    <div className="project-library-list" id="project-list" role="tabpanel" aria-labelledby={tab === 'imageRecords' ? 'image-records-tab' : 'sets-tab'}>
      {tab === 'imageRecords' ? imageRecords.map((record) => <div className="project-row" key={record.id}>
        <input className="project-select" type="checkbox" aria-label={t('Select {name}', { name: record.metadata.imageName })} title={t(record.id === activeImageRecordId ? 'Open project cannot be deleted. Open another project first.' : 'Select {name}', { name: record.metadata.imageName })} checked={selectedImageRecordIds.has(record.id)} disabled={record.id === activeImageRecordId} onChange={() => toggleSelection(record.id, 'image-record')} />
        <button className="project-open" type="button" onClick={() => onOpen(record)}><Thumbnail record={record} /><span><strong>{record.metadata.imageName}</strong><small>{t('{count} measurements', { count: record.metadata.measurements.length })} / {new Date(record.updatedAt).toLocaleString()}</small>{record.id === activeImageRecordId && <small>{t('Open project')}</small>}<small title={t('Image and data size; browser overhead is not included')}>{t('Estimated storage: {size}', { size: formatStorageBytes(projectStorageBytes(record)) })}</small></span></button>
        <button className="tool-button" type="button" title={t('Export image record')} aria-label={t('Export image record')} onClick={() => onExport(record)}><Download size={17} /></button>
        <button className="tool-button" type="button" title={t(record.id === activeImageRecordId ? 'Open project cannot be deleted. Open another project first.' : 'Delete saved project')} aria-label={t(record.id === activeImageRecordId ? 'Open project cannot be deleted. Open another project first.' : 'Delete saved project')} disabled={record.id === activeImageRecordId} onClick={() => onDelete(record.id, 'image-record')}><Trash2 size={17} /></button>
      </div>) : sets.map((record) => <div className="project-row" key={record.id}>
        <input className="project-select" type="checkbox" aria-label={t('Select {name}', { name: record.name })} title={t(record.id === activeSetId ? 'Open project cannot be deleted. Open another project first.' : 'Select {name}', { name: record.name })} checked={selectedSetIds.has(record.id)} disabled={record.id === activeSetId} onChange={() => toggleSelection(record.id, 'set')} />
        <button className="project-open" type="button" onClick={() => onOpenSet(record)}><FolderOpen size={24} /><span><strong>{record.name}</strong><small>{t('{count} images', { count: record.images.length })} / {new Date(record.updatedAt).toLocaleString()}</small>{record.id === activeSetId && <small>{t('Open project')}</small>}<small title={t('Image and data size; browser overhead is not included')}>{t('Estimated storage: {size}', { size: formatStorageBytes(projectStorageBytes(record)) })}</small></span></button>
        <button className="tool-button" type="button" title={t('Export set')} aria-label={t('Export set')} onClick={() => onExportSet(record)}><Download size={17} /></button>
        <button className="tool-button" type="button" title={t(record.id === activeSetId ? 'Open project cannot be deleted. Open another project first.' : 'Delete saved project')} aria-label={t(record.id === activeSetId ? 'Open project cannot be deleted. Open another project first.' : 'Delete saved project')} disabled={record.id === activeSetId} onClick={() => onDelete(record.id, 'set')}><Trash2 size={17} /></button>
      </div>)}
      {(tab === 'imageRecords' ? !imageRecords.length : !sets.length) && <p className="project-empty">{t('No saved projects')}</p>}
    </div>
  </Dialog>
}

export function ImageProcessingPanel({ image, crop, onCropChange, reduction, onReductionChange, onApply, onClose, t }: {
  image: HTMLImageElement; crop: ImageCrop; onCropChange: (crop: ImageCrop) => void
  reduction: number; onReductionChange: (reduction: number) => void
  onApply: (crop: ImageCrop, reduction: number) => Promise<void>; onClose: () => void; t: Translate
}) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  let output: { width: number; height: number } | null = null
  try { output = imageProcessingSize(image.naturalWidth, image.naturalHeight, crop, reduction) } catch {}
  return <section className="image-processing-panel" aria-label={t('Crop and resample')}>
    <form className="image-processing-form" onSubmit={(event) => {
      event.preventDefault()
      if (!output || busy) return
      setBusy(true)
      void onApply(crop, reduction).catch((failure) => { setError(String(failure)); setBusy(false) })
    }}>
      <div className="crop-fields">{(['x', 'y', 'width', 'height'] as const).map((key) => <label key={key}>{t(key === 'x' ? 'Crop X' : key === 'y' ? 'Crop Y' : key === 'width' ? 'Crop width' : 'Crop height')}<input type="number" min={key === 'x' || key === 'y' ? 0 : 1} step="1" required disabled={busy} value={crop[key]} onChange={(event) => onCropChange({ ...crop, [key]: Number(event.target.value) })} /></label>)}</div>
      <label className="detection-field"><span>{t('Reduction factor')} <strong>{reduction.toFixed(1)}x</strong></span><input aria-label={t('Reduction factor')} type="range" min="1" max="1.5" step="0.1" value={reduction} disabled={busy} onChange={(event) => onReductionChange(Number(event.target.value))} /></label>
      <output>{output ? `${output.width} x ${output.height} px / PNG` : t('Invalid crop')}</output>
      {error && <p role="alert">{error}</p>}
      <div className="project-form-actions"><button className="button button-small" type="button" disabled={busy} onClick={() => { onCropChange({ x: 0, y: 0, width: image.naturalWidth, height: image.naturalHeight }); onReductionChange(1) }}>{t('Reset')}</button><button className="button button-small" type="button" disabled={busy} onClick={onClose}>{t('Cancel crop')}</button><button className="button button-primary" type="submit" disabled={!output || busy}>{t(busy ? 'Processing' : 'Apply crop')}</button></div>
    </form>
  </section>
}