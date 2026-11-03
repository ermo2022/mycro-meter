import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import test from 'node:test'
import ts from 'typescript'

const require = createRequire(import.meta.url)
const cv = await require('@techstark/opencv-js')

function compile(source, imports = require) {
  const module = { exports: {} }
  const { outputText } = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  })
  new Function('require', 'module', 'exports', outputText)(imports, module, module.exports)
  return module.exports
}

const appSource = ts.createSourceFile('App.tsx', readFileSync(new URL('../src/App.tsx', import.meta.url), 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
const detectionDeclarations = new Map()
function collectDetectionDeclarations(node) {
  if (ts.isVariableDeclaration(node)) detectionDeclarations.set(node.name.getText(appSource), node.getText(appSource))
  ts.forEachChild(node, collectDetectionDeclarations)
}
collectDetectionDeclarations(appSource)
const detectionHelpers = ['formatDetectionDimension', 'detectionAreaDefaults'].map(name => {
  const helper = appSource.statements.find(statement => ts.isFunctionDeclaration(statement) && statement.name?.text === name)
  assert.ok(helper)
  return helper.getText(appSource)
})
const detectionValues = ['detectionPixelsPerUnit', 'minimumWidthValue', 'minimumHeightValue', 'maximumWidthValue', 'maximumHeightValue', 'minimumObjectArea', 'maximumObjectArea', 'detectionLimitsValid']
const detectionSettings = compile([
  `const ${detectionDeclarations.get('micrometresPerUnit')};`,
  ...detectionHelpers,
  'export function settings(calibration, dimensions, imageWidth = 1000) {',
  '  const defaults = detectionAreaDefaults(calibration, imageWidth);',
  '  const { unit: detectionUnit, minimumWidth, minimumHeight, maximumWidth, maximumHeight } = dimensions ?? defaults;',
  ...detectionValues.map(name => `  const ${detectionDeclarations.get(name)};`),
  '  return { defaults, minimumObjectArea, maximumObjectArea, detectionLimitsValid };',
  '}',
  'export function changeUnit(dimensions, nextUnit) {',
  '  const { unit: detectionUnit, minimumWidth, minimumHeight, maximumWidth, maximumHeight } = dimensions;',
  '  const result = { ...dimensions };',
  '  const setMinimumWidth = value => { result.minimumWidth = value };',
  '  const setMinimumHeight = value => { result.minimumHeight = value };',
  '  const setMaximumWidth = value => { result.maximumWidth = value };',
  '  const setMaximumHeight = value => { result.maximumHeight = value };',
  '  const setDetectionUnit = value => { result.unit = value };',
  `  const ${detectionDeclarations.get('changeDetectionUnit')};`,
  '  changeDetectionUnit(nextUnit);',
  '  return result;',
  '}',
].join('\n'))

test('detection defaults round physical dimensions up while retaining the pixel-area floor', () => {
  for (const calibration of [
    { pixelsPerUnit: 7.62, unit: 'mm' },
    { pixelsPerUnit: 0.00762, unit: 'µm' },
    { pixelsPerUnit: 0.00000762, unit: 'nm' },
    { pixelsPerUnit: 7.62, unit: 'µm' },
    { pixelsPerUnit: 7620, unit: 'mm' },
    { pixelsPerUnit: 1000, unit: 'µm' },
  ]) {
    const defaults = detectionSettings.settings(calibration)
    assert.equal(defaults.detectionLimitsValid, true)
    const unitSizes = { mm: 1000, 'µm': 1, nm: 0.001 }
    const pixelsPerUnit = calibration.pixelsPerUnit * unitSizes[defaults.defaults.unit] / unitSizes[calibration.unit]
    assert.equal(Number(defaults.defaults.minimumWidth), Math.ceil(Math.sqrt(50) / pixelsPerUnit))
    assert.equal(Number(defaults.defaults.maximumWidth), Math.ceil(100 / pixelsPerUnit))
    assert.ok(defaults.minimumObjectArea >= 50)
    assert.ok(defaults.maximumObjectArea >= 10000)
    const smallImage = detectionSettings.settings(calibration, undefined, 20)
    assert.equal(smallImage.detectionLimitsValid, true)
    assert.ok(smallImage.maximumObjectArea >= 200)
    for (const dimensions of [defaults.defaults, smallImage.defaults]) {
      for (const name of ['minimumWidth', 'minimumHeight', 'maximumWidth', 'maximumHeight']) {
        assert.ok(Number.isInteger(Number(dimensions[name])) && Number(dimensions[name]) > 0)
      }
    }
  }
})

test('changing detection units rounds dimensions up and preserves empty inputs', () => {
  const dimensions = { unit: 'µm', minimumWidth: '7', minimumHeight: '8', maximumWidth: '100', maximumHeight: '' }
  assert.deepEqual(detectionSettings.changeUnit(dimensions, 'mm'), { unit: 'mm', minimumWidth: '1', minimumHeight: '1', maximumWidth: '1', maximumHeight: '' })
  assert.deepEqual(detectionSettings.changeUnit(dimensions, 'nm'), { unit: 'nm', minimumWidth: '7000', minimumHeight: '8000', maximumWidth: '100000', maximumHeight: '' })
})

test('all detection dimension inputs round upward on blur without replacing empty fields', () => {
  const inputs = []
  function collectInputs(node) {
    if (ts.isJsxSelfClosingElement(node) && node.tagName.getText(appSource) === 'input') {
      const attributes = node.attributes.properties
      const value = attributes.find(attribute => ts.isJsxAttribute(attribute) && attribute.name.getText(appSource) === 'value')
      const name = value?.initializer?.expression?.getText(appSource)
      if (['minimumWidth', 'minimumHeight', 'maximumWidth', 'maximumHeight'].includes(name)) inputs.push({ name, attributes })
    }
    ts.forEachChild(node, collectInputs)
  }
  collectInputs(appSource)
  assert.equal(inputs.length, 4)
  for (const { name, attributes } of inputs) {
    const blur = attributes.find(attribute => ts.isJsxAttribute(attribute) && attribute.name.getText(appSource) === 'onBlur')
    const setter = `set${name[0].toUpperCase()}${name.slice(1)}`
    const helper = detectionHelpers[0]
    const { outputText } = ts.transpileModule(`${helper}\nconst onBlur = ${blur.initializer.expression.getText(appSource)}`, { compilerOptions: { target: ts.ScriptTarget.ES2022 } })
    for (const [value, expected] of [['7.01', '8'], ['7', '7'], ['0.5', '1'], ['', undefined]]) {
      let rounded
      new Function(name, setter, `${outputText}; onBlur()`)(value, result => { rounded = result })
      assert.equal(rounded, expected)
    }
  }
})

test('detection enforces a 50 px² floor across units and rejects an unusable maximum', () => {
  const unitSizes = { mm: 1000, 'µm': 1, nm: 0.001 }
  for (const calibration of [
    { pixelsPerUnit: 7.62, unit: 'mm' },
    { pixelsPerUnit: 0.00762, unit: 'µm' },
    { pixelsPerUnit: 0.00000762, unit: 'nm' },
  ]) {
    for (const unit of ['mm', 'µm', 'nm']) {
      const pixelsPerUnit = calibration.pixelsPerUnit * unitSizes[unit] / unitSizes[calibration.unit]
      const dimensions = { unit, minimumWidth: String(10 / pixelsPerUnit), minimumHeight: String(10 / pixelsPerUnit), maximumWidth: String(100 / pixelsPerUnit), maximumHeight: String(100 / pixelsPerUnit) }
      assert.equal(detectionSettings.settings(calibration, dimensions).detectionLimitsValid, true)
      assert.ok(Math.abs(detectionSettings.settings(calibration, dimensions).minimumObjectArea - 100) < 1e-10)
      const tinyMinimum = { ...dimensions, minimumWidth: String(1 / pixelsPerUnit), minimumHeight: String(1 / pixelsPerUnit) }
      assert.equal(detectionSettings.settings(calibration, tinyMinimum).minimumObjectArea, 50)
      assert.equal(detectionSettings.settings(calibration, tinyMinimum).detectionLimitsValid, true)
      const tinyMaximum = { ...tinyMinimum, maximumWidth: String(5 / pixelsPerUnit), maximumHeight: String(5 / pixelsPerUnit) }
      assert.equal(detectionSettings.settings(calibration, tinyMaximum).detectionLimitsValid, false)
      const equalLimits = { ...dimensions, maximumWidth: dimensions.minimumWidth, maximumHeight: dimensions.minimumHeight }
      assert.equal(detectionSettings.settings(calibration, equalLimits).detectionLimitsValid, true)
      assert.equal(detectionSettings.settings(calibration, { ...dimensions, minimumWidth: '0' }).detectionLimitsValid, false)
      assert.equal(detectionSettings.settings(calibration, { ...dimensions, minimumWidth: '' }).detectionLimitsValid, false)
      assert.equal(detectionSettings.settings(calibration, { ...equalLimits, maximumWidth: String(1 / pixelsPerUnit) }).detectionLimitsValid, false)
    }
  }
})

const geometry = compile(readFileSync(new URL('../src/boxGeometry.ts', import.meta.url), 'utf8'))
const source = readFileSync(new URL('../src/objectDetection.ts', import.meta.url), 'utf8')
const { contourBox } = compile(`${source}\nexport { contourBox }`, (name) => {
  if (name === './boxGeometry') return geometry
  if (name.endsWith('?url')) return ''
  throw new Error(`Unexpected dependency: ${name}`)
})

function contourFromPoints(points, degrees) {
  const radians = degrees * Math.PI / 180
  const rotated = points.flatMap(([pointX, pointY]) => [
    Math.round(210 + pointX * Math.cos(radians) - pointY * Math.sin(radians)),
    Math.round(330 + pointX * Math.sin(radians) + pointY * Math.cos(radians)),
  ])
  return cv.matFromArray(points.length, 1, cv.CV_32SC2, rotated)
}

function ellipsePoints(radiusX, radiusY) {
  return Array.from({ length: 120 }, (_, index) => {
    const radians = index * 2 * Math.PI / 120
    return [radiusX * Math.cos(radians), radiusY * Math.sin(radians)]
  })
}

function assertEncloses(box, contour) {
  const radians = box.angle * Math.PI / 180
  for (let index = 0; index < contour.data32S.length; index += 2) {
    const offsetX = contour.data32S[index] - box.centerX
    const offsetY = contour.data32S[index + 1] - box.centerY
    assert.ok(Math.abs(offsetX * Math.cos(radians) + offsetY * Math.sin(radians)) <= box.width / 2 + 1e-8)
    assert.ok(Math.abs(-offsetX * Math.sin(radians) + offsetY * Math.cos(radians)) <= box.height / 2 + 1e-8)
  }
}

test('elongated silhouettes retain axes, dimensions, and enclosure across rotations', () => {
  for (const degrees of [-89, -65, -30, 0, 17, 45, 80, 90, 135]) {
    const contour = contourFromPoints(ellipsePoints(100, 35), degrees)
    try {
      const box = contourBox(cv, contour)
      assert.ok(Math.abs(geometry.normalizeBoxAngle(box.angle - degrees)) < 0.5)
      assert.ok(Math.abs(box.width - 200) < 1.5)
      assert.ok(Math.abs(box.height - 70) < 1.5)
      assert.ok(Math.abs(box.centerX - 210) < 0.01)
      assert.ok(Math.abs(box.centerY - 330) < 0.01)
      assertEncloses(box, contour)
    } finally {
      contour.delete()
    }
  }
})

test('symmetric pointed shapes follow their major axis rather than an outline edge', () => {
  const contour = contourFromPoints([[100, 0], [0, 35], [-100, 0], [0, -35]], 0)
  try {
    const box = contourBox(cv, contour)
    assert.equal(box.angle, 0)
    assert.equal(box.width, 200)
    assert.equal(box.height, 70)
    assert.ok(Math.abs(geometry.normalizeBoxAngle(cv.minAreaRect(contour).angle)) > 10)
    assertEncloses(box, contour)
  } finally {
    contour.delete()
  }
})

test('round and nearly round silhouettes retain the minimum-area fallback', () => {
  for (const radiusY of [50, 49]) {
    const contour = contourFromPoints(ellipsePoints(50, radiusY), 27)
    let fallbackCalls = 0
    try {
      const box = contourBox({
        ...cv,
        minAreaRect: (...args) => {
          fallbackCalls += 1
          return cv.minAreaRect(...args)
        },
      }, contour)
      assert.equal(fallbackCalls, 1)
      assert.ok(Number.isFinite(box.angle))
      assert.ok(box.width >= box.height)
      assertEncloses({ ...box, width: box.width + 0.001, height: box.height + 0.001 }, contour)
    } finally {
      contour.delete()
    }
  }
})

if (process.env.BENCHMARK_DETECTION === '1') {
  const contour = contourFromPoints(ellipsePoints(100, 35), 23)
  try {
    const baseline = () => cv.boxPoints(cv.minAreaRect(contour))
    for (let index = 0; index < 2000; index += 1) {
      baseline()
      contourBox(cv, contour)
    }
    const iterations = 20000
    for (const [label, operation] of [['minimum-area rectangle', baseline], ['principal-axis box', () => contourBox(cv, contour)]]) {
      const start = performance.now()
      for (let index = 0; index < iterations; index += 1) operation()
      console.log(`${label}: ${((performance.now() - start) / iterations).toFixed(4)} ms/contour`)
    }
    console.log('Geometry only, 120-vertex contour; not a phone or full detection benchmark.')
  } finally {
    contour.delete()
  }
}