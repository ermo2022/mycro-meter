import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import ts from 'typescript'

const source = ts.createSourceFile('App.tsx', readFileSync(new URL('../src/App.tsx', import.meta.url), 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
const helper = source.statements.find(statement => ts.isFunctionDeclaration(statement) && statement.name?.text === 'formatBoxDimensionsText')
assert.ok(helper)
const definition = [
  'function formatLength(length) {',
  '  if (length >= 100) return length.toFixed(1)',
  '  if (length >= 10) return length.toFixed(2)',
  '  return length.toFixed(3)',
  '}',
  helper.getText(source).replace(/^export\s+/, ''),
].join('\n')

const { outputText } = ts.transpileModule(definition, {
  compilerOptions: { target: ts.ScriptTarget.ES2022 },
})

function formatBoxDimensionsTextFactory() {
  const module = { exports: {} }
  const fn = new Function('module', `${outputText}; return formatBoxDimensionsText`)(module)
  return fn
}

test('box labels omit angle but keep width and height', () => {
  const formatBoxDimensionsText = formatBoxDimensionsTextFactory()
  assert.equal(formatBoxDimensionsText(120, 80, { pixelsPerUnit: 10, unit: 'mm' }), '12.00 × 8.000 mm')
  assert.equal(formatBoxDimensionsText(120, 80), '120 × 80 px')
})

test('box labels automatically report the longer dimension first', () => {
  const formatBoxDimensionsText = formatBoxDimensionsTextFactory()
  assert.equal(formatBoxDimensionsText(80, 120, { pixelsPerUnit: 10, unit: 'mm' }), '12.00 × 8.000 mm')
  assert.equal(formatBoxDimensionsText(80, 120), '120 × 80 px')
})

test('analysis sections appear only when their prerequisite data is available', () => {
  const conditions = new Map()
  function visit(node) {
    if (ts.isJsxElement(node) && ts.isBinaryExpression(node.parent)) {
      const attributes = node.openingElement.attributes.properties
      const className = attributes.find(attribute => ts.isJsxAttribute(attribute) && attribute.name.getText(source) === 'className')?.initializer?.text
      const label = attributes.find(attribute => ts.isJsxAttribute(attribute) && attribute.name.getText(source) === 'aria-labelledby')?.initializer?.text
      conditions.set(label ?? className, node.parent.left.getText(source))
      const onClick = attributes.find(attribute => ts.isJsxAttribute(attribute) && attribute.name.getText(source) === 'onClick')?.initializer?.expression?.getText(source)
      if (onClick === 'exportActiveImageRecord') conditions.set('current-image-record-export', node.parent.left.getText(source))
    }
    ts.forEachChild(node, visit)
  }
  visit(source)
  const visible = (key, state) => {
    assert.ok(conditions.has(key), key)
    return new Function('imageSize', 'calibration', 'measurements', 'boxMeasurements', 'setSnapshots', 'imageBlob', `return Boolean(${conditions.get(key)})`)(
      state.image ? { x: 100, y: 80 } : null, state.calibrated ? {} : null,
      Array(state.measurements ?? 0), Array(state.boxes ?? 0), Array(state.setImages ?? 0), state.image ? {} : null,
    )
  }
  for (const [state, expected] of [
    [{}, [false, false, false, false, false, false, false, false]],
    [{ image: true }, [true, false, false, false, false, true, false, false]],
    [{ image: true, calibrated: true }, [true, true, true, false, false, true, true, false]],
    [{ image: true, calibrated: true, measurements: 1, boxes: 1 }, [true, true, true, true, true, true, true, false]],
    [{ image: true, measurements: 1, boxes: 1 }, [true, false, true, false, false, true, false, false]],
    [{ setImages: 2 }, [false, false, false, false, true, true, true, false]],
    [{ image: true, setImages: 2 }, [true, false, false, false, true, true, true, false]],
    [{ image: true, calibrated: true, setImages: 2 }, [true, true, true, false, true, true, true, true]],
  ]) {
    assert.deepEqual(['scale-section', 'detection-settings-title', 'results-section', 'overview-title', 'measurement-set-title', 'panel-bottom', 'project-export-actions', 'current-image-record-export'].map(key => visible(key, state)), expected)
  }
})

test('calibration presets keep save visible and use selected or new preset IDs', () => {
  const appText = source.getFullText()
  assert.ok(appText.includes('className="calibration-preset-name-row"'))
  assert.ok(appText.includes('persistCalibrationPreset(selectedCalibrationPresetId || crypto.randomUUID(), calibrationPresetName)'))
  const css = readFileSync(new URL('../src/style.css', import.meta.url), 'utf8')
  assert.ok(css.includes('.calibration-preset-name-row {'))
  assert.ok(!css.includes('grid-template-columns: minmax(180px, 2fr)'))
})

test('scale controls remain open when uncalibrated and collapse after calibration or preset selection', () => {
  const functions = new Map()
  let hidden
  function visit(node) {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && ['saveCalibration', 'applyCalibrationPreset'].includes(node.name.text)) {
      functions.set(node.name.text, node.initializer.getText(source))
    }
    if (ts.isJsxAttribute(node) && node.name.getText(source) === 'hidden' && node.parent.properties.some(attribute =>
      ts.isJsxAttribute(attribute) && attribute.name.getText(source) === 'id' && attribute.initializer?.text === 'image-scale-settings')) {
      hidden = node.initializer.expression.getText(source)
    }
    ts.forEachChild(node, visit)
  }
  visit(source)
  assert.ok(hidden)
  const isHidden = new Function('calibration', 'scaleExpanded', `return ${hidden}`)
  assert.equal(isHidden(null, false), false)
  assert.equal(isHidden({}, false), true)
  assert.equal(isHidden({}, true), false)

  const noop = () => {}
  let collapsed = 0
  let applied
  const dependencies = {
    calibrationDraft: { start: { x: 0, y: 0 }, end: { x: 100, y: 0 } },
    knownLength: '10', calibrationUnit: 'µm', imageSize: { x: 100 },
    savedCalibrationPresets: [{ id: 'camera', name: 'Camera', calibration: { pixelsPerUnit: 8, unit: 'mm' } }],
    distance: (start, end) => Math.hypot(end.x - start.x, end.y - start.y),
    setCalibration: value => { applied = value },
    collapseScale: () => { collapsed++ },
    setSelectedCalibrationPresetId: noop, setCalibrationPresetName: noop, applyDetectionAreaDefaults: noop,
    setCalibrationDraft: noop, setCalibrationLocked: noop, setTool: noop, setStatus: noop,
  }
  const action = name => {
    assert.ok(functions.has(name))
    const { outputText } = ts.transpileModule(`const action = ${functions.get(name)}`, { compilerOptions: { target: ts.ScriptTarget.ES2022 } })
    return new Function(...Object.keys(dependencies), `${outputText}; return action`)(...Object.values(dependencies))
  }
  action('saveCalibration')({ preventDefault: noop })
  assert.deepEqual(applied, { pixelsPerUnit: 10, unit: 'µm' })
  assert.equal(collapsed, 1)
  action('applyCalibrationPreset')('camera')
  assert.deepEqual(applied, dependencies.savedCalibrationPresets[0].calibration)
  assert.equal(collapsed, 2)
  action('applyCalibrationPreset')('missing')
  assert.equal(collapsed, 2)
})

test('auto-detect precedes the detection settings and preview in visual and keyboard order', () => {
  let section
  function visit(node) {
    if (ts.isJsxElement(node) && node.openingElement.attributes.properties.some(attribute =>
      ts.isJsxAttribute(attribute) && attribute.name.getText(source) === 'aria-labelledby' && attribute.initializer?.text === 'detection-settings-title')) section = node
    ts.forEachChild(node, visit)
  }
  visit(source)
  assert.ok(section)
  const children = section.children.filter(ts.isJsxElement)
  assert.match(children[0].openingElement.getText(source), /auto-detect-button/)
  assert.match(children[1].getText(source), /detection-settings-title/)
  assert.match(children[1].getText(source), /detection-preview-open/)
})

test('box editor deletion removes only the saved measurement and is unavailable for drafts or references', () => {
  let deleteAttribute
  function visit(node) {
    if (ts.isJsxAttribute(node) && node.name.getText(source) === 'onDelete') deleteAttribute = node
    ts.forEachChild(node, visit)
  }
  visit(source)
  assert.ok(deleteAttribute)
  const expression = deleteAttribute.initializer.expression.getText(source)
  const { outputText } = ts.transpileModule(`function action(selectingReference, boxEditor, calibration, setMeasurements, setBoxEditor, setStatus) { return (${expression}) }`, {
    compilerOptions: { target: ts.ScriptTarget.ES2022 },
  })
  const createAction = new Function(`${outputText}; return action`)()
  const original = [{ id: 1, name: 'B1' }, { id: 2, name: 'B2' }, { id: 3, name: 'B3' }]
  let measurements = original
  let editor = { measurementId: 2 }
  let statusText
  const remove = createAction(false, editor, {}, update => { measurements = update(measurements) }, value => { editor = value }, value => { statusText = value })
  assert.equal(typeof remove, 'function')
  remove()
  assert.deepEqual(measurements, [original[0], original[2]])
  assert.equal(original.length, 3)
  assert.equal(editor, null)
  assert.equal(statusText, 'Measurement deleted')
  const unused = () => { throw new Error('Unexpected deletion') }
  assert.equal(createAction(false, { measurementId: null }, {}, unused, unused, unused), undefined)
  assert.equal(createAction(true, { measurementId: 2 }, {}, unused, unused, unused), undefined)
  assert.equal(createAction(false, { measurementId: 2 }, null, unused, unused, unused), undefined)
  const editorDeclaration = source.statements.find(statement => ts.isFunctionDeclaration(statement) && statement.name?.text === 'BoxEditorDialog')
  assert.ok(editorDeclaration.getText(source).includes("onClick={onClose}>{t('Cancel')}"))
  assert.ok(editorDeclaration.getText(source).includes("onClick={onAccept}"))
})

test('touch box handles retain usable screen sizes as the canvas changes size', () => {
  const definition = source.statements.find(statement => ts.isFunctionDeclaration(statement) && statement.name?.text === 'boxEditorHandleMetrics')
  assert.ok(definition)
  const { outputText } = ts.transpileModule(definition.getText(source), { compilerOptions: { target: ts.ScriptTarget.ES2022 } })
  const metrics = new Function(`${outputText}; return boxEditorHandleMetrics`)()
  for (const width of [280, 500, 800]) {
    const result = metrics(960, width, true)
    for (const [actual, expected] of [[result.resizeSize, 16], [result.rotateRadius, 10], [result.hitRadius, 22], [result.rotationOffset, 32]]) {
      assert.ok(Math.abs(actual * width / 960 - expected) < 1e-9)
    }
  }
  assert.deepEqual(metrics(960, 800, false), { resizeSize: 14, rotateRadius: 8, hitRadius: 26, rotationOffset: 28, viewportInset: 32, strokeWidth: 1.5 })
})
