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

function setup(width = 320, height = 240, ImageCapture) {
  const track = { readyState: 'live' }
  class MediaStream {
    getVideoTracks() { return [track] }
  }
  const video = { videoWidth: width, videoHeight: height, srcObject: new MediaStream() }
  const calls = { errors: [], busy: [], captured: [], draws: [] }
  const canvas = {
    getContext: () => ({ drawImage: (...args) => calls.draws.push(args) }),
    toBlob: (callback, type) => { calls.callback = callback; calls.type = type },
  }
  const epoch = { current: 1 }
  const capture = new Function('videoRef', 'ready', 'capturing', 'MAX_IMAGE_RECORD_IMAGE_PIXELS', 'document', 'setError', 'setCapturing', 'captureEpoch', 'onCapture', 'window', 'MediaStream', captureCode)(
    { current: video }, true, false, 40_000_000, { createElement: () => canvas },
    (error) => calls.errors.push(error), (busy) => calls.busy.push(busy), epoch, (blob) => calls.captured.push(blob), { ImageCapture }, MediaStream,
  )
  return { capture, canvas, calls, video, epoch, track }
}

test('supported cameras capture a photo from the active video track', async () => {
  const blob = new Blob(['photo'], { type: 'image/jpeg' })
  let usedTrack
  const fixture = setup(8000, 8000, class {
    constructor(track) { usedTrack = track }
    async takePhoto() { return blob }
  })
  fixture.capture()
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(usedTrack, fixture.track)
  assert.deepEqual(fixture.calls.captured, [blob])
  assert.deepEqual(fixture.calls.busy, [true, false])
  assert.deepEqual(fixture.calls.draws, [])
})

test('photo failures are reported without silently capturing a preview frame', async () => {
  for (const ImageCapture of [
    class {
      constructor() { throw new Error('unsupported track') }
      async takePhoto() {}
    },
    class { async takePhoto() { throw new Error('capture failed') } },
  ]) {
    const { capture, calls } = setup(320, 240, ImageCapture)
    capture()
    await new Promise(resolve => setImmediate(resolve))
    assert.equal(calls.errors.at(-1), 'Could not take a camera photo. Please try again.')
    assert.deepEqual(calls.busy, [true, false])
    assert.deepEqual(calls.captured, [])
    assert.deepEqual(calls.draws, [])
  }
})

test('browsers without takePhoto use the preview frame', () => {
  const { capture, calls, video } = setup(320, 240, class {})
  capture()
  assert.deepEqual(calls.draws, [[video, 0, 0, 320, 240]])
  assert.equal(calls.type, 'image/png')
})

test('pending photos are ignored after camera close or switch', async () => {
  let resolvePhoto
  const { capture, calls, epoch } = setup(320, 240, class {
    takePhoto() { return new Promise(resolve => { resolvePhoto = resolve }) }
  })
  capture()
  epoch.current += 1
  resolvePhoto(new Blob(['photo'], { type: 'image/jpeg' }))
  await new Promise(resolve => setImmediate(resolve))
  assert.deepEqual(calls.captured, [])
  assert.deepEqual(calls.busy, [true])
})

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

test('camera photos use the normal PNG conversion unless already PNG', () => {
  const app = ts.createSourceFile('App.tsx', readFileSync(new URL('../src/App.tsx', import.meta.url), 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
  let callback
  function visitApp(node) {
    if (ts.isJsxSelfClosingElement(node) && node.tagName.getText(app) === 'CameraDialog') {
      callback = node.attributes.properties.find(attribute => ts.isJsxAttribute(attribute) && attribute.name.getText(app) === 'onCapture')?.initializer.expression
    }
    ts.forEachChild(node, visitApp)
  }
  visitApp(app)
  assert.ok(callback)
  const code = ts.transpileModule(`return (${callback.getText(app)})`, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText
  const loads = []
  const onCapture = new Function('setCameraOpen', 'loadImage', 'URL', code)(
    () => {}, (...args) => loads.push(args), { createObjectURL: () => 'blob:camera' },
  )
  const jpeg = new Blob(['photo'], { type: 'image/jpeg' })
  const png = new Blob(['frame'], { type: 'image/png' })
  onCapture(jpeg)
  onCapture(png)
  assert.equal(loads[0][4], undefined)
  assert.equal(loads[1][4], png)
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
