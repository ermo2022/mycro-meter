import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import ts from 'typescript'

const source = ts.createSourceFile('WorkspaceDialogs.tsx', readFileSync(new URL('../src/WorkspaceDialogs.tsx', import.meta.url), 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
let captureDeclaration
function visit(node) {
  if (ts.isVariableDeclaration(node) && node.name.getText(source) === 'capture') captureDeclaration = node.getText(source)
  ts.forEachChild(node, visit)
}
visit(source)
assert.ok(captureDeclaration)
const captureCode = ts.transpileModule(`const ${captureDeclaration}; return capture`, {
  compilerOptions: { target: ts.ScriptTarget.ES2022 },
}).outputText

function setup(width = 320, height = 240) {
  const video = { videoWidth: width, videoHeight: height }
  const calls = { errors: [], busy: [], captured: [], draws: [] }
  const canvas = {
    getContext: () => ({ drawImage: (...args) => calls.draws.push(args) }),
    toBlob: (callback, type) => { calls.callback = callback; calls.type = type },
  }
  const epoch = { current: 1 }
  const capture = new Function('videoRef', 'ready', 'capturing', 'MAX_IMAGE_RECORD_IMAGE_PIXELS', 'document', 'setError', 'setCapturing', 'captureEpoch', 'onCapture', captureCode)(
    { current: video }, true, false, 40_000_000, { createElement: () => canvas },
    (error) => calls.errors.push(error), (busy) => calls.busy.push(busy), epoch, (blob) => calls.captured.push(blob),
  )
  return { capture, canvas, calls, video, epoch }
}

test('snapshot uses the full video frame and passes the PNG to the image flow', () => {
  const { capture, canvas, calls, video } = setup()
  capture()
  assert.deepEqual([canvas.width, canvas.height], [320, 240])
  assert.deepEqual(calls.draws, [[video, 0, 0, 320, 240]])
  assert.equal(calls.type, 'image/png')
  const blob = new Blob(['image'], { type: 'image/png' })
  calls.callback(blob)
  assert.deepEqual(calls.busy, [true, false])
  assert.deepEqual(calls.captured, [blob])
})

test('snapshot reports encoding failure without replacing the image', () => {
  const { capture, calls } = setup()
  capture()
  calls.callback(null)
  assert.deepEqual(calls.busy, [true, false])
  assert.deepEqual(calls.errors, ['Could not capture the camera frame.'])
  assert.deepEqual(calls.captured, [])
})

test('snapshot rejects oversized frames and ignores results after camera closes', () => {
  const oversized = setup(8000, 8000)
  oversized.capture()
  assert.equal(oversized.calls.errors[0], 'Camera frame dimensions are invalid or exceed 40 megapixels.')
  assert.equal(oversized.calls.draws.length, 0)

  const pending = setup()
  pending.capture()
  pending.epoch.current += 1
  pending.calls.callback(new Blob(['image']))
  assert.deepEqual(pending.calls.captured, [])
})

test('live view is a guarded capture control alongside the snapshot button', () => {
  const buttons = []
  function findButtons(node) {
    if (ts.isJsxOpeningElement(node) && node.tagName.getText(source) === 'button') {
      const attributes = node.attributes.properties.filter(ts.isJsxAttribute)
      const get = (name) => attributes.find(attribute => attribute.name.getText(source) === name)?.initializer
      if (get('onClick')?.expression?.getText(source) === 'capture') buttons.push({
        className: get('className')?.text,
        disabled: get('disabled')?.expression?.getText(source),
      })
    }
    ts.forEachChild(node, findButtons)
  }
  findButtons(source)
  assert.deepEqual(buttons, [
    { className: 'camera-preview-button', disabled: '!ready || capturing' },
    { className: 'button button-primary', disabled: '!ready || capturing' },
  ])
})
