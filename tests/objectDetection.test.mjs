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