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