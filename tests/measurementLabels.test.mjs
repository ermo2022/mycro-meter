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
