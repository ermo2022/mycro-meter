import { existsSync, readFileSync, readdirSync, mkdirSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { parseArgs } from 'node:util'
import { PNG } from 'pngjs'
import ts from 'typescript'

const require = createRequire(import.meta.url)
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const modules = new Map()

function sourceModule(name) {
  if (modules.has(name)) return modules.get(name)
  const module = { exports: {} }
  modules.set(name, module.exports)
  const source = readFileSync(join(root, 'src', `${name}.ts`), 'utf8')
  const { outputText } = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  })
  new Function('require', 'module', 'exports', outputText)((dependency) => {
    if (dependency === './objectDetection') return { loadOpenCv: () => { throw new Error('Offline analysis must not use the browser loader') } }
    if (dependency.startsWith('./')) return sourceModule(dependency.slice(2))
    throw new Error(`Unexpected source dependency: ${dependency}`)
  }, module, module.exports)
  return module.exports
}

const geometry = sourceModule('boxGeometry')
const referenceFeatures = sourceModule('referenceFeatures')
const matching = sourceModule('sporeMatching')

export function loadDataset(input) {
  const sets = []
  const profilePath = join(input, 'evaluation.json')
  const profile = existsSync(profilePath) ? JSON.parse(readFileSync(profilePath, 'utf8')) : { version: 1, excludedImages: {}, stressSets: {} }
  if (profile.version !== 1 || !profile.excludedImages || !profile.stressSets
    || !Object.values(profile.excludedImages).every(reason => typeof reason === 'string' && reason.length > 0)
    || !Object.values(profile.stressSets).every(reason => typeof reason === 'string' && reason.length > 0)) throw new Error('Invalid evaluation profile')
  const excludedImages = []
  const folders = readdirSync(input, { withFileTypes: true }).filter(entry => entry.isDirectory()).map(entry => entry.name).sort()
  for (const folder of folders) {
    const directory = join(input, folder)
    const manifest = JSON.parse(readFileSync(join(directory, 'project_manifest.json'), 'utf8'))
    if (manifest.format !== 'mycrometer' || manifest.version !== 1 || manifest.kind !== 'set' || !Array.isArray(manifest.items)) {
      throw new Error(`Unsupported set manifest: ${folder}`)
    }
    const items = manifest.items.map(item => {
      const itemDirectory = resolve(directory, item.path)
      if (relative(directory, itemDirectory).startsWith('..') || itemDirectory === resolve(directory)) throw new Error(`Invalid item path: ${item.path}`)
      const itemPath = relative(input, itemDirectory).split('\\').join('/')
      if (profile.excludedImages[itemPath]) {
        excludedImages.push({ path: itemPath, reason: profile.excludedImages[itemPath] })
        return null
      }
      const metadata = JSON.parse(readFileSync(join(itemDirectory, 'metadata.json'), 'utf8'))
      if (!Number.isInteger(metadata.imageWidth) || !Number.isInteger(metadata.imageHeight) || metadata.imageWidth <= 0 || metadata.imageHeight <= 0) throw new Error(`Invalid image dimensions: ${itemDirectory}`)
      const boxes = metadata.measurements.filter(measurement => measurement.kind === 'box').map(measurement => {
        const box = geometry.longAxisFirst(measurement.rect)
        if (![box.centerX, box.centerY, box.width, box.height, box.angle].every(Number.isFinite) || box.width <= 0 || box.height <= 0
          || box.centerX < 0 || box.centerX >= metadata.imageWidth || box.centerY < 0 || box.centerY >= metadata.imageHeight) throw new Error(`Invalid box ${measurement.id}: ${itemDirectory}`)
        return { id: measurement.id, box }
      })
      return { path: relative(input, itemDirectory), imageName: metadata.imageName, imagePath: join(itemDirectory, 'image.png'), width: metadata.imageWidth, height: metadata.imageHeight, boxes }
    }).filter(item => item !== null)
    if (items.length) sets.push({ name: manifest.name, path: folder, items, evaluationGroup: profile.stressSets[folder] ? 'stress' : 'standard', evaluationNote: profile.stressSets[folder] ?? null })
  }
  if (!sets.length) throw new Error('No exported measurement sets found')
  const unknownImages = Object.keys(profile.excludedImages).filter(path => !excludedImages.some(item => item.path === path))
  const unknownSets = Object.keys(profile.stressSets).filter(path => !sets.some(set => set.path === path))
  if (unknownImages.length || unknownSets.length) throw new Error(`Evaluation profile names missing images or sets: ${[...unknownImages, ...unknownSets].join(', ')}`)
  sets.evaluation = { profile: existsSync(profilePath) ? 'evaluation.json' : null, excludedImages }
  return sets
}

export function quantile(values, probability) {
  if (!values.length) return null
  const sorted = [...values].sort((first, second) => first - second)
  const position = (sorted.length - 1) * probability
  const lower = Math.floor(position)
  return sorted[lower] + (sorted[Math.ceil(position)] - sorted[lower]) * (position - lower)
}

function mean(values) {
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null
}

export function boxIou(cv, first, second) {
  const polygon = box => cv.matFromArray(4, 1, cv.CV_32FC2, geometry.boxCorners(box).flatMap(point => [point.x, point.y]))
  const firstPolygon = polygon(first)
  const secondPolygon = polygon(second)
  const intersection = new cv.Mat()
  try {
    const area = cv.intersectConvexConvex(firstPolygon, secondPolygon, intersection, true)
    return Math.max(0, area) / (first.width * first.height + second.width * second.height - Math.max(0, area))
  } finally {
    firstPolygon.delete()
    secondPolygon.delete()
    intersection.delete()
  }
}

export function associateBoxes(cv, detections, labels, minimumIou = 0.5) {
  const edges = detections.map(detection => labels.map((label, index) => ({ index, iou: boxIou(cv, detection, label) }))
    .filter(edge => edge.iou >= minimumIou).sort((first, second) => second.iou - first.iou))
  const owners = new Map()
  function assign(detectionIndex, visited) {
    for (const edge of edges[detectionIndex]) {
      if (visited.has(edge.index)) continue
      visited.add(edge.index)
      if (!owners.has(edge.index) || assign(owners.get(edge.index), visited)) {
        owners.set(edge.index, detectionIndex)
        return true
      }
    }
    return false
  }
  detections.forEach((_, index) => assign(index, new Set()))
  return [...owners].map(([labelIndex, detectionIndex]) => ({ labelIndex, detectionIndex, iou: boxIou(cv, detections[detectionIndex], labels[labelIndex]) }))
}

function pairSummary(pairs) {
  const usable = pairs.filter(pair => pair.areaRatio !== null)
  return {
    pairs: pairs.length,
    validExtractedAreaPairs: usable.length,
    qToleranceP95: quantile(pairs.map(pair => pair.qDeviation), 0.95),
    histogramDistanceP95: quantile(pairs.map(pair => pair.distance), 0.95),
    extractedAreaRatioP025: quantile(usable.map(pair => pair.areaRatio), 0.025),
    extractedAreaRatioP975: quantile(usable.map(pair => pair.areaRatio), 0.975),
    currentQAndHistogramCoverage: mean(pairs.map(pair => Number(pair.qDeviation <= matching.DIRECT_LIMITS.qTolerance && pair.distance < matching.DIRECT_LIMITS.maxDistance))),
    currentExtractedAreaCoverage: mean(usable.map(pair => Number(pair.areaRatio >= matching.DIRECT_LIMITS.minArea && pair.areaRatio <= matching.DIRECT_LIMITS.maxArea))),
  }
}

function coverage(pairs, limits) {
  return mean(pairs.map(pair => Number(pair.qDeviation <= limits.qTolerance && pair.distance < limits.maxDistance)))
}

export const STAGE_NAMES = ['generated', 'framePassed', 'areaPassed', 'geometry', 'segmentAreaPassed', 'evaluated', 'histogramPassed', 'accepted']

function stageMeans(entries) {
  return Object.fromEntries([...STAGE_NAMES, 'qOnlyPassed'].map(stage => [stage, mean(entries.map(entry => entry?.[stage]).filter(value => value !== undefined && value !== null))]))
}

function failureSummary(images) {
  const targets = images.flatMap(image => image.trials.flatMap(trial => trial.stages?.targets ?? []))
  const reasons = [...new Set(targets.filter(target => target.failure).map(target => target.failure.reason))]
  return reasons.map(reason => {
    const failures = targets.filter(target => target.failure?.reason === reason).map(target => target.failure)
    const values = key => failures.map(failure => failure[key]).filter(value => value !== undefined)
    const area = values('candidateAreaRatio')
    const ious = values('candidateIou')
    return {
      reason, comparisons: failures.length,
      candidateAreaRatioMin: area.length ? Math.min(...area) : null,
      candidateAreaRatioMax: area.length ? Math.max(...area) : null,
      medianCandidateBoxAreaToLabel: quantile(values('candidateBoxAreaToLabel'), 0.5),
      maximumCandidateIou: ious.length ? Math.max(...ious) : null,
      wellLocalizedCandidates: failures.filter(failure => failure.candidateIou >= 0.5).length,
      watershedReturnedNoSegments: failures.filter(failure => failure.watershedReturnedNoSegments).length,
    }
  })
}

function stageObserver(cv, targets, scale) {
  const presence = Object.fromEntries(['generated', 'framePassed', 'areaPassed'].map(stage => [stage, new Set()]))
  const pools = Object.fromEntries(['geometry', 'segmentAreaPassed', 'evaluated', 'histogramPassed', 'qOnlyPassed'].map(stage => [stage, []]))
  const targetTraces = targets.map(target => ({ id: target.id, events: [] }))
  const observe = (event, contour) => {
    const bounds = cv.boundingRect(contour)
    const corners = geometry.boxCorners(event.box)
    const minX = Math.min(...corners.map(point => point.x))
    const maxX = Math.max(...corners.map(point => point.x))
    const minY = Math.min(...corners.map(point => point.y))
    const maxY = Math.max(...corners.map(point => point.y))
    let relevant = false
    targets.forEach((target, index) => {
      const labelCorners = geometry.boxCorners(target.box)
      if (Math.max(...labelCorners.map(point => point.x)) < minX || Math.min(...labelCorners.map(point => point.x)) > maxX
        || Math.max(...labelCorners.map(point => point.y)) < minY || Math.min(...labelCorners.map(point => point.y)) > maxY) return
      const pointX = target.box.centerX * scale - 0.5
      const pointY = target.box.centerY * scale - 0.5
      const centerInside = pointX >= bounds.x && pointX <= bounds.x + bounds.width && pointY >= bounds.y && pointY <= bounds.y + bounds.height
        && cv.pointPolygonTest(contour, new cv.Point(pointX, pointY), false) >= 0
      const iou = boxIou(cv, event.box, target.box)
      if (!centerInside && iou < 0.05) return
      relevant = true
      targetTraces[index].events.push({ ...event, centerInside, iou })
      if (presence[event.stage] && (centerInside || iou >= 0.5)) presence[event.stage].add(index)
    })
    if (!relevant) return
    if (pools[event.stage]) pools[event.stage].push(event.box)
    if (event.stage === 'evaluated') {
      if (event.histogramPassed) pools.histogramPassed.push(event.box)
      if (event.qPassed) pools.qOnlyPassed.push(event.box)
    }
  }
  const finish = matches => {
    const counts = Object.fromEntries(Object.entries(presence).map(([stage, indexes]) => [stage, indexes.size]))
    for (const [stage, boxes] of Object.entries(pools)) counts[stage] = associateBoxes(cv, boxes, targets.map(target => target.box)).length
    const assignments = associateBoxes(cv, matches, targets.map(target => target.box))
    counts.accepted = assignments.length
    const recovered = new Set(assignments.map(assignment => assignment.labelIndex))
    targetTraces.forEach((trace, index) => {
      trace.recovered = recovered.has(index)
      trace.bestGeometryIou = Math.max(0, ...trace.events.filter(event => event.stage === 'geometry').map(event => event.iou))
      trace.firstMissingStage = STAGE_NAMES.find(stage => stage === 'accepted' ? !trace.recovered
        : !trace.events.some(event => event.stage === (stage === 'histogramPassed' ? 'evaluated' : stage)
          && (presence[stage] ? event.centerInside || event.iou >= 0.5 : event.iou >= 0.5)
          && (stage !== 'histogramPassed' || event.histogramPassed))) ?? null
      const covering = trace.events.filter(event => event.centerInside || event.iou >= 0.5)
      const rejected = covering.filter(event => event.stage === 'rejected').sort((first, second) => second.iou - first.iou)
      const failed = trace.firstMissingStage
      const event = failed === 'framePassed' ? rejected.find(event => event.reason === 'frame')
        : failed === 'areaPassed' ? rejected.find(event => event.reason.startsWith('area'))
          : failed === 'segmentAreaPassed' ? rejected.find(event => event.reason === 'segmentArea' && event.iou >= 0.5)
            : failed === 'geometry' ? rejected.find(event => event.reason === 'watershedNoSegments') : undefined
      const label = targets[index].box
      trace.failure = failed === null ? null : {
        stage: failed,
        reason: event?.reason ?? (failed === 'geometry' ? (trace.bestGeometryIou === 0 ? 'noSeparateBoxes' : 'boxIouBelowHalf')
          : failed === 'histogramPassed' ? 'histogramGate'
            : failed === 'accepted' ? (trace.events.some(event => event.stage === 'evaluated' && event.iou >= 0.5 && event.histogramPassed && event.qPassed) ? 'oneToOneAssignment' : 'qGate') : failed),
        candidateAreaRatio: event?.areaRatio,
        candidateIou: event?.iou,
        candidateBoxAreaToLabel: event ? event.box.width * event.box.height / (label.width * label.height) : undefined,
        watershedReturnedNoSegments: covering.some(event => event.reason === 'watershedNoSegments'),
      }
    })
    return {
      counts, recall: Object.fromEntries(Object.entries(counts).map(([stage, count]) => [stage, targets.length ? count / targets.length : null])),
      targets: targetTraces,
    }
  }
  return { observe, finish }
}

export async function analyzeDataset(sets, { baseline = true, stages = false, preprocessing = {}, progress = () => {} } = {}) {
  const cv = await require('@techstark/opencv-js')
  const images = []
  for (const set of sets) {
    for (const item of set.items) {
      progress(`${set.name}: ${item.imageName} (${item.boxes.length} positives)`)
      const png = item.png ?? PNG.sync.read(readFileSync(item.imagePath))
      if (item.imagePath && (png.width !== item.width || png.height !== item.height)) throw new Error(`Image dimensions disagree with metadata: ${item.path}`)
      const source = cv.matFromArray(png.height, png.width, cv.CV_8UC4, png.data)
      const gray = new cv.Mat()
      const processing = new cv.Mat()
      const scale = Math.min(1, matching.MAX_PROCESSING_SIDE / Math.max(png.width, png.height))
      try {
        cv.cvtColor(source, gray, cv.COLOR_RGBA2GRAY)
        if (scale < 1) cv.resize(source, processing, new cv.Size(Math.round(png.width * scale), Math.round(png.height * scale)), 0, 0, cv.INTER_LINEAR)
        const positives = item.boxes.map(({ id, box }) => {
          const patch = referenceFeatures.extractPatch(cv, gray, box)
          try {
            const features = referenceFeatures.analyzeReferencePatch(cv, patch)
            return { id, box, features: { ...features, width: box.width, height: box.height, q: box.width / box.height } }
          } finally {
            patch.delete()
          }
        })
        const pairs = []
        const trials = []
        for (const reference of positives) {
          const targets = positives.filter(target => target !== reference && !matching.overlapsReference(target.box, reference.box, 1))
          for (const target of targets) {
            pairs.push({
              referenceId: reference.id, targetId: target.id,
              qDeviation: Math.abs(target.features.q - reference.features.q) / reference.features.q,
              distance: matching.bhattacharyyaDistance(reference.features.histogram, target.features.histogram),
              areaRatio: reference.features.area > 0 && target.features.area > 0 ? target.features.area / reference.features.area : null,
              boxAreaRatio: target.box.width * target.box.height / (reference.box.width * reference.box.height),
            })
          }
          if (!baseline) continue
          if (reference.features.area <= 0) {
            trials.push({ referenceId: reference.id, eligible: targets.length, recovered: 0, recall: targets.length ? 0 : null, error: 'Reference contour extraction returned zero area',
              stages: stages ? { recall: Object.fromEntries([...STAGE_NAMES, 'qOnlyPassed'].map(stage => [stage, targets.length ? 0 : null])), targets: targets.map(target => ({ id: target.id, firstMissingStage: 'referenceExtraction', recovered: false })) } : undefined })
            continue
          }
          const trace = stages ? stageObserver(cv, targets, scale) : undefined
          const result = matching.matchSporePixels(cv, scale < 1 ? processing : source, reference.features, reference.box, scale, trace?.observe, preprocessing)
          const assignments = associateBoxes(cv, result.matches, targets.map(target => target.box))
          trials.push({
            referenceId: reference.id, eligible: targets.length, recovered: assignments.length,
            recall: targets.length ? assignments.length / targets.length : null,
            candidates: result.candidates, detections: result.matches.length,
            unreviewedDetections: result.matches.length - assignments.length,
            recoveredIds: assignments.map(assignment => targets[assignment.labelIndex].id),
            meanIou: mean(assignments.map(assignment => assignment.iou)),
            matches: result.matches,
            stages: trace?.finish(result.matches),
          })
        }
        images.push({
          set: set.path, path: item.path, imageName: item.imageName, width: png.width, height: png.height,
          positives, pairs, trials, featureSummary: pairSummary(pairs),
          baselineRecall: mean(trials.map(trial => trial.recall).filter(value => value !== null)),
          stageRecall: stages ? stageMeans(trials.map(trial => trial.stages?.recall)) : undefined,
        })
      } finally {
        source.delete()
        gray.delete()
        processing.delete()
      }
    }
  }
  const setSummaries = sets.map(set => {
    const members = images.filter(image => image.set === set.path)
    return {
      set: set.path, name: set.name, images: members.length, positives: members.reduce((total, image) => total + image.positives.length, 0),
      evaluationGroup: set.evaluationGroup ?? 'standard', evaluationNote: set.evaluationNote ?? null,
      featureSummary: pairSummary(members.flatMap(image => image.pairs)),
      baselineRecall: mean(members.map(image => image.baselineRecall).filter(value => value !== null)),
      stageRecall: stages ? stageMeans(members.map(image => image.stageRecall)) : undefined,
      failures: stages ? failureSummary(members) : undefined,
    }
  })
  const heldOut = sets.map(set => {
    const training = images.filter(image => image.set !== set.path)
    const pairs = training.flatMap(image => image.pairs)
    const limits = {
      qTolerance: quantile(pairs.map(pair => pair.qDeviation), 0.95),
      maxDistance: quantile(pairs.map(pair => pair.distance), 0.95),
    }
    const members = images.filter(image => image.set === set.path && image.pairs.length)
    return {
      set: set.path, trainingSets: sets.length - 1, positiveOnlyLimits: limits,
      heldOutImageMeanFeatureCoverage: limits.qTolerance === null ? null : mean(members.map(image => coverage(image.pairs, limits))),
      currentImageMeanFeatureCoverage: mean(members.map(image => coverage(image.pairs, matching.DIRECT_LIMITS))),
    }
  })
  return {
    version: 1,
    methodology: {
      annotations: 'Verified single-spore rotated boxes; other image regions are unlabeled, not negative.',
      features: 'Shared extractPatch/analyzeReferencePatch at source resolution. Extracted areas are Otsu estimates, not ground-truth masks.',
      pairs: 'Ordered reference/target pairs within each image; overlapping reference boxes excluded to mirror matcher behavior.',
      baseline: 'Current full-image matcher, every positive used as reference; maximum-cardinality one-to-one rotated IoU >= 0.5.',
      stages: 'Optional trace: generated/frame/area measure containment of label centers OR IoU >= 0.5 (merged blobs may contain multiple labels); geometry onward uses one-to-one IoU >= 0.5. Histogram then Q is the cumulative gate order; Q-only is a separate counterfactual. This is candidate-generation diagnostics, not ground-truth segmentation. Each target retains relevant events and first missing stage.',
      weighting: 'Baseline recall averaged over references, then images, then sets. Pair quantiles are exploratory and correlated, not confidence intervals.',
      resizing: 'Images >3000 pixels use OpenCV linear downsampling; browser canvas interpolation may differ. Reference patch interpolation can also differ slightly from browser Canvas.',
      limitations: 'Positive-only limits are diagnostic, not validated detector settings. Cannot estimate precision, false-positive rate, or optimal watershed/threshold settings without reviewed candidates or masks.',
    },
    currentLimits: { direct: matching.DIRECT_LIMITS, watershed: matching.WATERSHED_LIMITS },
    evaluation: sets.evaluation ?? { profile: null, excludedImages: [] },
    preprocessing,
    summary: {
      sets: sets.length, images: images.length, positives: images.reduce((total, image) => total + image.positives.length, 0),
      baselineRecall: mean(setSummaries.map(set => set.baselineRecall).filter(value => value !== null)),
      standardSetRecall: mean(setSummaries.filter(set => set.evaluationGroup !== 'stress').map(set => set.baselineRecall).filter(value => value !== null)),
      featureSummary: pairSummary(images.flatMap(image => image.pairs)),
      stageRecall: stages ? stageMeans(setSummaries.map(set => set.stageRecall)) : undefined,
    },
    sets: setSummaries, heldOut, images,
  }
}

function evaluationMarkdown(report) {
  if (!report.evaluation?.profile && !report.sets.some(set => set.evaluationGroup === 'stress')) return []
  return [
    '## Evaluation Scope', '',
    `Dataset profile: ${report.evaluation?.profile ?? 'Provided programmatically'}. Overall scores retain stress cases; standard-set scores exclude stress cases without hiding their results.`, '',
    ...report.evaluation.excludedImages.map(item => `- Excluded ${item.path}: ${item.reason}`),
    ...report.sets.filter(set => set.evaluationGroup === 'stress').map(set => `- Stress case ${set.name}: ${set.evaluationNote}`), '',
  ]
}

export function reportMarkdown(report) {
  const percent = value => value === null ? 'N/A' : `${(100 * value).toFixed(1)}%`
  const summary = report.summary
  return [
    '# Spore Tuning Diagnostics', '',
    `${summary.positives} verified spores; ${summary.images} images; ${summary.sets} sets.`, '',
    `Evaluated candidate preprocessing: ${report.preprocessing?.mask ?? 'combined'}; illumination correction ${report.preprocessing?.correctIllumination ? 'enabled' : 'disabled'}. Browser Auto-detect uses illumination-corrected adaptive preprocessing; the original combined pipeline remains the offline baseline.`, '',
    `Evaluated detector marked-positive recall (set-balanced, IoU >= 0.5): **${percent(summary.baselineRecall)}**.`, '',
    ...(report.sets.some(set => set.evaluationGroup === 'stress') ? [`Standard-set recall (stress cases excluded): **${percent(summary.standardSetRecall)}**.`, ''] : []),
    ...evaluationMarkdown(report),
    '| Set | Group | Images | Spores | Baseline Recall |', '| --- | --- | ---: | ---: | ---: |',
    ...report.sets.map(set => `| ${set.name} | ${set.evaluationGroup} | ${set.images} | ${set.positives} | ${percent(set.baselineRecall)} |`), '',
    ...(summary.stageRecall ? [
      '## Stage-by-Stage Survival', '',
      '| Stage | Set-Balanced Survival | Loss From Previous Stage |', '| --- | ---: | ---: |',
      ...STAGE_NAMES.map((stage, index) => {
        const previous = index ? summary.stageRecall[STAGE_NAMES[index - 1]] : 1
        const value = summary.stageRecall[stage]
        return `| ${stage} | ${percent(value)} | ${previous === null || value === null ? 'N/A' : `${((previous - value) * 100).toFixed(1)} pp`} |`
      }), '',
      'Generated/frame/area stages allow merged blobs containing several marked centers; geometry onward requires separate boxes with IoU >= 0.5. The geometry drop combines failure to split blobs and inaccurate box geometry, not just a numerical threshold.', '',
      `From evaluated boxes: histogram-only survival ${percent(summary.stageRecall.histogramPassed)}; Q-only survival ${percent(summary.stageRecall.qOnlyPassed)}; both gates ${percent(summary.stageRecall.accepted)}. These counterfactuals bypass only the final gates, not earlier filters.`, '',
      '| Set | Generated | After Frame | After Area | Geometry | Segment Area | Ref Exclusion | Histogram | Both Gates |', '| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |',
      ...report.sets.map(set => `| ${set.name} | ${STAGE_NAMES.map(stage => percent(set.stageRecall[stage])).join(' | ')} |`), '',
      '### First-Failure Details', '',
      'Counts are reference/target comparisons, not unique spores; a spore is tested with multiple references. Area ratios use the selected reference contour. For frame/area failures, details use the highest-IoU blocking contour covering that target. These details describe malformed or rejected candidates, not guaranteed recoveries from bypassing a filter.', '',
      '| Set | First Failure | Comparisons | Candidate Area Ratio Min-Max | Median Box Area / Label | Max IoU | Boxes With IoU >= 0.5 |', '| --- | --- | ---: | ---: | ---: | ---: | ---: |',
      ...report.sets.flatMap(set => set.failures.map(failure => `| ${set.name} | ${failure.reason} | ${failure.comparisons} | ${failure.candidateAreaRatioMin === null ? 'N/A' : `${failure.candidateAreaRatioMin.toFixed(2)}-${failure.candidateAreaRatioMax.toFixed(2)}`} | ${failure.medianCandidateBoxAreaToLabel?.toFixed(1) ?? 'N/A'} | ${failure.maximumCandidateIou?.toFixed(3) ?? 'N/A'} | ${failure.wellLocalizedCandidates} |`)), '',
      'The last column counts good-box candidates blocked at that stage, not additional final detections: later gates have not been bypassed. Watershed-no-segment candidates can be single spores larger than the selected reference rather than genuine multi-spore clusters.', '',
    ] : []),
    '## Positive Feature Diagnostics', '',
    `Current Q + histogram gates accept ${percent(summary.featureSummary.currentQAndHistogramCoverage)} of ordered labeled-patch pairs (not full-detector recall).`,
    `Exploratory 95th-percentile Q deviation: ${summary.featureSummary.qToleranceP95?.toFixed(4) ?? 'N/A'}; histogram distance: ${summary.featureSummary.histogramDistanceP95?.toFixed(4) ?? 'N/A'}.`,
    `Current direct-area band contains ${percent(summary.featureSummary.currentExtractedAreaCoverage)} of positive extracted-area ratios. These are estimated contours, not segmentation labels.`, '',
    '| Held-Out Set | Current Feature Coverage | Training-P95 Feature Coverage |', '| --- | ---: | ---: |',
    ...report.heldOut.map(set => `| ${set.set} | ${percent(set.currentImageMeanFeatureCoverage)} | ${percent(set.heldOutImageMeanFeatureCoverage)} |`), '',
    '## Interpretation', '',
    'Do not install the positive-only percentiles as defaults: relaxing gates can also admit debris. Full-detector recovery additionally depends on candidate generation, area grouping, and watershed. Unmatched detections require review and are not false positives.', '',
    'Larger sets are useful when they add independent images, species, illumination, magnifications, touching spores, and difficult examples. Keep whole sets/specimens out of tuning; do not randomly split boxes from the same image. Review detector proposals as true/false positives, or exhaustively annotate designated regions, before optimizing precision/recall. Include missed spores, not just easy examples.', '',
    'The JSON includes positive boxes and extracted features, all ordered pair metrics, all baseline detections, and recovered IDs for later tuning and review. No images or annotations are modified. Calibration is not needed because features use source pixels.', '',
    ...Object.entries(report.methodology).map(([name, description]) => `- ${name}: ${description}`), '',
  ].join('\n')
}

export const PREPROCESSING_VARIANTS = [
  { name: 'baseline', options: {} },
  { name: 'edges', options: { mask: 'edges' } },
  { name: 'adaptive', options: { mask: 'adaptive' } },
  { name: 'corrected-combined', options: { correctIllumination: true } },
  { name: 'corrected-edges', options: { mask: 'edges', correctIllumination: true } },
  { name: 'corrected-adaptive', options: { mask: 'adaptive', correctIllumination: true } },
]

export async function comparePreprocessing(sets, { stages = false, progress = () => {} } = {}) {
  const cv = await require('@techstark/opencv-js')
  const variants = []
  let baseline
  for (const variant of PREPROCESSING_VARIANTS) {
    const report = await analyzeDataset(sets, { stages, preprocessing: variant.options, progress: message => progress(`${variant.name}: ${message}`) })
    baseline ??= report
    const changes = report.images.map((image, imageIndex) => {
      const original = baseline.images[imageIndex]
      const additions = []
      const trials = image.trials.map((trial, trialIndex) => {
        const previous = original.trials[trialIndex]
        const gained = (trial.recoveredIds ?? []).filter(id => !(previous.recoveredIds ?? []).includes(id))
        const lost = (previous.recoveredIds ?? []).filter(id => !(trial.recoveredIds ?? []).includes(id))
        const added = (trial.matches ?? []).filter(match => !(previous.matches ?? []).some(old => boxIou(cv, match, old) >= 0.5))
        const targets = image.positives.filter(positive => positive.id !== trial.referenceId && !matching.overlapsReference(positive.box, image.positives.find(positive => positive.id === trial.referenceId).box, 1))
        const known = new Map(associateBoxes(cv, added, targets.map(target => target.box)).map(assignment => [assignment.detectionIndex, targets[assignment.labelIndex].id]))
        added.forEach((match, index) => {
          const existing = additions.find(addition => boxIou(cv, addition.box, match) >= 0.5)
          if (existing) {
            existing.referenceIds.push(trial.referenceId)
            if (known.has(index)) existing.knownLabelId = known.get(index)
          } else additions.push({ id: additions.length + 1, box: match, knownLabelId: known.get(index) ?? null, referenceIds: [trial.referenceId] })
        })
        return { referenceId: trial.referenceId, gained, lost, additionalDetections: added.length, additionalUnreviewed: added.length - known.size }
      })
      return { path: image.path, set: image.set, imageName: image.imageName, trials, additions }
    })
    const balanced = value => mean(sets.map(set => mean(changes.filter(image => image.set === set.path).map(image => mean(image.trials.map(value))))))
    variants.push({
      name: variant.name, options: variant.options, report, changes,
      summary: {
        recall: report.summary.baselineRecall,
        standardSetRecall: report.summary.standardSetRecall,
        geometryRecall: report.summary.stageRecall?.geometry ?? null,
        meanDetectionsPerReference: mean(report.sets.map(set => mean(report.images.filter(image => image.set === set.set).map(image => mean(image.trials.map(trial => trial.detections ?? 0)))))),
        additionalUnreviewedPerReference: balanced(trial => trial.additionalUnreviewed),
        gainedTargetComparisons: changes.reduce((sum, image) => sum + image.trials.reduce((total, trial) => total + trial.gained.length, 0), 0),
        lostTargetComparisons: changes.reduce((sum, image) => sum + image.trials.reduce((total, trial) => total + trial.lost.length, 0), 0),
        uniqueAdditionalUnreviewed: changes.reduce((sum, image) => sum + image.additions.filter(addition => addition.knownLabelId === null).length, 0),
      },
    })
  }
  return variants
}

export function comparisonMarkdown(variants) {
  const percent = value => value === null ? 'N/A' : `${(value * 100).toFixed(1)}%`
  return [
    '# Candidate Preprocessing Comparison', '',
    'All variants use unchanged reference features, contour-area bands, histogram limits, and Q limits. Illumination correction affects candidate masks/watershed only; acceptance histograms still use original pixels.', '',
    'Browser Auto-detect now uses corrected-adaptive. Baseline here retains the original combined-mask pipeline for historical comparison; it is not the current browser default.', '',
    ...evaluationMarkdown(variants[0].report),
    '| Variant | Overall Recall | Standard-Set Recall | Geometry Recall | Detections / Reference | Extra Unreviewed / Reference | Gained / Lost Comparisons |', '| --- | ---: | ---: | ---: | ---: | ---: | ---: |',
    ...variants.map(variant => `| ${variant.name} | ${percent(variant.summary.recall)} | ${percent(variant.summary.standardSetRecall)} | ${percent(variant.summary.geometryRecall)} | ${variant.summary.meanDetectionsPerReference?.toFixed(2) ?? 'N/A'} | ${variant.summary.additionalUnreviewedPerReference?.toFixed(2) ?? 'N/A'} | ${variant.summary.gainedTargetComparisons} / ${variant.summary.lostTargetComparisons} |`), '',
    'Recall and per-reference detection counts are averaged over references, images, then sets. Gained/lost comparisons are raw repeated trials, not independent spores. Geometry uses one-to-one rotated IoU >= 0.5, not center containment.', '',
    '| Set | ' + variants.map(variant => variant.name).join(' | ') + ' |', '| --- | ' + variants.map(() => '---:').join(' | ') + ' |',
    ...variants[0].report.sets.map((set, index) => `| ${set.name}${set.evaluationGroup === 'stress' ? ' (stress)' : ''} | ${variants.map(variant => percent(variant.report.sets[index].baselineRecall)).join(' | ')} |`), '',
    '## False-Positive Review', '',
    'Extra unreviewed detections are not false positives: images are not exhaustively annotated. Baseline itself also has unreviewed detections. Extra detections are boxes with no baseline box at IoU >= 0.5, so changed geometry can count as additional. Proposals overlapping verified labels are identified separately. Review the PNG sheets and JSON additions before promoting any variant; higher positive recall alone does not establish acceptable precision.', '',
    'Review sheets contain unique additional proposals across references (deduplicated at IoU >= 0.5), including both known-label overlaps and unmarked proposals. Sheet identifiers map to the per-image additions in comparison.json. Different references can produce different geometry for the same location; deduplication is approximate.', '',
    'Background correction estimates a broad Gaussian illumination field at one reference-length sigma using downsampled pixels, subtracts it in floating point, and adds 128 before converting to grayscale. It does not change original images or calibrations. These are fixed diagnostic variants, not optimized or certified defaults.', '',
  ].join('\n')
}

async function writeReviewSheets(sets, variants, output) {
  const cv = await require('@techstark/opencv-js')
  const items = new Map(sets.flatMap(set => set.items).map(item => [item.path, item]))
  for (const variant of variants) {
    for (const image of variant.changes.filter(image => image.additions.length)) {
      const item = items.get(image.path)
      const png = item.png ?? PNG.sync.read(readFileSync(item.imagePath))
      const source = cv.matFromArray(png.height, png.width, cv.CV_8UC4, png.data)
      const directory = join(output, variant.name, image.path)
      mkdirSync(directory, { recursive: true })
      image.reviewSheets = []
      try {
        for (let page = 0; page * 24 < image.additions.length; page += 1) {
          const additions = image.additions.slice(page * 24, (page + 1) * 24)
          const sheet = new cv.Mat(Math.ceil(additions.length / 6) * 280, 1536, cv.CV_8UC4, new cv.Scalar(245, 245, 245, 255))
          try {
            additions.forEach((addition, index) => {
              const corners = geometry.boxCorners(addition.box)
              const margin = Math.max(12, addition.box.width * 0.4)
              const left = Math.max(0, Math.floor(Math.min(...corners.map(point => point.x)) - margin))
              const top = Math.max(0, Math.floor(Math.min(...corners.map(point => point.y)) - margin))
              const right = Math.min(png.width, Math.ceil(Math.max(...corners.map(point => point.x)) + margin))
              const bottom = Math.min(png.height, Math.ceil(Math.max(...corners.map(point => point.y)) + margin))
              const width = right - left
              const height = bottom - top
              const scale = Math.min(1, 248 / Math.max(width, height))
              const patch = source.roi(new cv.Rect(left, top, width, height))
              const resized = new cv.Mat()
              let view
              try {
                cv.resize(patch, resized, new cv.Size(Math.max(1, Math.round(width * scale)), Math.max(1, Math.round(height * scale))), 0, 0, cv.INTER_AREA)
                const originX = (index % 6) * 256 + Math.floor((256 - resized.cols) / 2)
                const originY = Math.floor(index / 6) * 280 + 24 + Math.floor((256 - resized.rows) / 2)
                view = sheet.roi(new cv.Rect(originX, originY, resized.cols, resized.rows))
                resized.copyTo(view)
                const color = addition.knownLabelId === null ? new cv.Scalar(210, 25, 65, 255) : new cv.Scalar(0, 130, 130, 255)
                corners.forEach((point, cornerIndex) => {
                  const next = corners[(cornerIndex + 1) % 4]
                  cv.line(sheet, new cv.Point(Math.round(originX + (point.x - left) * scale), Math.round(originY + (point.y - top) * scale)), new cv.Point(Math.round(originX + (next.x - left) * scale), Math.round(originY + (next.y - top) * scale)), color, 2)
                })
                cv.putText(sheet, `#${addition.id} ${addition.knownLabelId === null ? 'Unmarked' : 'Known box'}`, new cv.Point((index % 6) * 256 + 6, Math.floor(index / 6) * 280 + 18), cv.FONT_HERSHEY_SIMPLEX, 0.45, new cv.Scalar(30, 30, 30, 255), 1)
              } finally {
                view?.delete()
                patch.delete()
                resized.delete()
              }
            })
            const path = join(directory, `review-${page + 1}.png`)
            writeFileSync(path, PNG.sync.write({ width: sheet.cols, height: sheet.rows, data: Buffer.from(sheet.data) }))
            image.reviewSheets.push(relative(output, path))
          } finally {
            sheet.delete()
          }
        }
      } finally {
        source.delete()
      }
    }
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const { values } = parseArgs({ options: { input: { type: 'string', default: 'measurements' }, output: { type: 'string', default: 'tuning-results' }, 'features-only': { type: 'boolean', default: false }, stages: { type: 'boolean', default: false }, 'compare-preprocessing': { type: 'boolean', default: false } } })
  const input = resolve(values.input)
  const output = resolve(values.output)
  if (output === input || !relative(input, output).startsWith('..')) throw new Error('Output must be outside the input dataset')
  if (values.stages && values['features-only']) throw new Error('--stages requires the full baseline; omit --features-only')
  if (values['compare-preprocessing']) {
    if (values['features-only']) throw new Error('--compare-preprocessing requires the full baseline')
    const sets = loadDataset(input)
    const variants = await comparePreprocessing(sets, { stages: values.stages, progress: message => console.error(message) })
    const directory = join(output, 'preprocessing')
    mkdirSync(directory, { recursive: true })
    for (const variant of variants) {
      const destination = join(directory, variant.name)
      mkdirSync(destination, { recursive: true })
      writeFileSync(join(destination, 'report.json'), `${JSON.stringify(variant.report, null, 2)}\n`)
      writeFileSync(join(destination, 'report.md'), reportMarkdown(variant.report))
    }
    await writeReviewSheets(sets, variants, directory)
    writeFileSync(join(directory, 'comparison.json'), `${JSON.stringify(variants.map(({ report: _report, ...variant }) => variant), null, 2)}\n`)
    writeFileSync(join(directory, 'comparison.md'), comparisonMarkdown(variants))
    console.log(comparisonMarkdown(variants))
    console.log(`Reports and review sheets: ${directory}`)
  } else {
    const report = await analyzeDataset(loadDataset(input), { baseline: !values['features-only'], stages: values.stages, progress: message => console.error(message) })
    mkdirSync(output, { recursive: true })
    writeFileSync(join(output, 'report.json'), `${JSON.stringify(report, null, 2)}\n`)
    writeFileSync(join(output, 'report.md'), reportMarkdown(report))
    console.log(reportMarkdown(report).split('## Interpretation')[0])
    console.log(`Reports: ${output}`)
  }
}