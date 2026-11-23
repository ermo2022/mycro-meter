import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { collectApis, root, verifyInventory } from '../scripts/opencv-inventory.mjs'

test('checked-in OpenCV matches the source inventory and build recipe', () => {
  verifyInventory()
})

test('inventory follows typed and JavaScript aliases and rejects dynamic access', () => {
  const directory = mkdtempSync(join(tmpdir(), 'mycrometer-opencv-test-'))
  const typescript = join(directory, 'fixture.ts')
  const javascript = join(directory, 'fixture.mjs')
  const detection = join(root, 'src/objectDetection.ts')
  const modulePath = join(root, 'node_modules/@techstark/opencv-js')
  try {
    writeFileSync(typescript, `declare const cv: typeof import(${JSON.stringify(modulePath)});\nconst alias = cv;\nalias.Mat; alias['cvtColor'];\n`)
    writeFileSync(javascript, 'function use(cv) { const other = cv; other.threshold; }\n')
    const apis = collectApis([detection, typescript], [javascript])
    assert.ok(apis.includes('Mat'))
    assert.ok(apis.includes('cvtColor'))
    assert.ok(apis.includes('threshold'))

    writeFileSync(javascript, 'function use(cv, key) { const other = cv; return other[key]; }\n')
    assert.throws(() => collectApis([detection, typescript], [javascript]), /dynamic OpenCV property access/)
    writeFileSync(javascript, '')
    writeFileSync(typescript, `declare const cv: typeof import(${JSON.stringify(modulePath)});\nconst unsafe = cv as any;\n`)
    assert.throws(() => collectApis([detection, typescript], [javascript]), /casting OpenCV to any or unknown/)
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})
