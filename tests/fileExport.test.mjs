import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import ts from 'typescript'

const source = ts.createSourceFile('App.tsx', readFileSync(new URL('../src/App.tsx', import.meta.url), 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
const helper = source.statements.find(statement => ts.isFunctionDeclaration(statement) && statement.name?.text === 'downloadCsv')
assert.ok(helper)
const { outputText } = ts.transpileModule(helper.getText(source), {
  compilerOptions: { target: ts.ScriptTarget.ES2022 },
})

function exportFixture(showSaveFilePicker) {
  const downloads = []
  const revokedUrls = []
  let downloadBlob
  const browser = { showSaveFilePicker }
  const document = {
    createElement: () => ({ click() { downloads.push(this.download) } }),
  }
  const urls = {
    createObjectURL: blob => { downloadBlob = blob; return 'blob:csv' },
    revokeObjectURL: url => revokedUrls.push(url),
  }
  const downloadCsv = new Function('window', 'document', 'URL', `${outputText}; return downloadCsv`)(browser, document, urls)
  return { downloadCsv, downloads, revokedUrls, get downloadBlob() { return downloadBlob } }
}

test('CSV export opens Save As and writes unchanged content before closing', async () => {
  const events = []
  let savedBlob
  const fixture = exportFixture(async options => {
    assert.equal(options.id, 'mycrometer-csv')
    assert.equal(options.suggestedName, 'sample-session.csv')
    assert.deepEqual(options.types, [{ description: 'CSV', accept: { 'text/csv': ['.csv'] } }])
    return {
      createWritable: async () => ({
        write: async blob => { savedBlob = blob; events.push('write') },
        close: async () => { events.push('close') },
      }),
    }
  })
  const csv = 'length,width\r\n12,4\r\n'
  await fixture.downloadCsv(csv, 'sample-session.csv')
  assert.equal(await savedBlob.text(), csv)
  assert.equal(savedBlob.type, 'text/csv')
  assert.deepEqual(events, ['write', 'close'])
  assert.deepEqual(fixture.downloads, [])
})

test('canceling Save As does not trigger a fallback download', async () => {
  const fixture = exportFixture(async () => { throw new DOMException('Canceled', 'AbortError') })
  await fixture.downloadCsv('test', 'sample.csv')
  assert.deepEqual(fixture.downloads, [])
})

test('picker and file failures reach the caller without downloading a duplicate', async () => {
  for (const stage of ['picker', 'createWritable', 'write', 'close']) {
    const failure = new Error(`Failed at ${stage}`)
    const fixture = exportFixture(async () => {
      if (stage === 'picker') throw failure
      return {
        createWritable: async () => {
          if (stage === 'createWritable') throw failure
          return {
            write: async () => { if (stage === 'write') throw failure },
            close: async () => { if (stage === 'close') throw failure },
          }
        },
      }
    })
    await assert.rejects(fixture.downloadCsv('test', 'sample.csv'), failure)
    assert.deepEqual(fixture.downloads, [])
  }
})

test('browsers without Save As retain CSV downloads and filenames', async () => {
  const fixture = exportFixture()
  await fixture.downloadCsv('length,width\n12,4', 'mycrometer-set.csv')
  assert.deepEqual(fixture.downloads, ['mycrometer-set.csv'])
  assert.equal(await fixture.downloadBlob.text(), 'length,width\n12,4')
  assert.equal(fixture.downloadBlob.type, 'text/csv')
  assert.deepEqual(fixture.revokedUrls, ['blob:csv'])
})

test('ZIP export retains every word of set names and sanitizes filesystem characters', async () => {
  let declaration
  function visit(node) {
    if (ts.isVariableDeclaration(node) && node.name.getText(source) === 'exportProject') declaration = node
    ts.forEachChild(node, visit)
  }
  visit(source)
  assert.ok(declaration?.initializer)
  const { outputText } = ts.transpileModule(`const exportProject = ${declaration.initializer.getText(source)}`, {
    compilerOptions: { target: ts.ScriptTarget.ES2022 },
  })
  const downloads = []
  const document = {
    body: { appendChild() {} },
    createElement: () => ({ click() { downloads.push(this.download) }, remove() {} }),
  }
  const exportProject = new Function('exportProjectBundle', 'document', 'URL', 'window', 'setStatus', `${outputText}; return exportProject`)(
    async () => new Blob(['zip']), document,
    { createObjectURL: () => 'blob:zip', revokeObjectURL() {} },
    { setTimeout: callback => callback() },
    message => assert.fail(message),
  )
  const records = [{ metadata: { imageName: 'Slide 1. Field notes.tiff' } }]
  for (const [name, expected] of [
    ['Sample one field two', 'Sample_one_field_two-set.zip'],
    ['Sample 1. Field notes', 'Sample_1_Field_notes-set.zip'],
    ['  Sample   one\tfield two  ', 'Sample_one_field_two-set.zip'],
    ['Sample/one:field?two', 'Sample_one_field_two-set.zip'],
    ['   ', 'mycrometer-set.zip'],
  ]) {
    await exportProject(records, { name })
    assert.equal(downloads.at(-1), expected)
  }
  await exportProject(records)
  assert.equal(downloads.at(-1), 'Slide_1_Field_notes-session.zip')
})