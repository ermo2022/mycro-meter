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
