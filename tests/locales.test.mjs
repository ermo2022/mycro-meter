import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import test from 'node:test'

const localeDirectory = new URL('../src/locales/', import.meta.url)
const localeFiles = readdirSync(localeDirectory).filter(name => name.endsWith('.json')).sort()

function readLocale(code) {
  return JSON.parse(readFileSync(new URL(`${code}.json`, localeDirectory), 'utf8'))
}

const en = readLocale('en')

function placeholders(value) {
  return [...String(value).matchAll(/\{([^}]+)\}/g)].map(match => match[1]).sort()
}

test('locale files declare metadata and the three required sections', () => {
  assert.ok(localeFiles.length >= 2)
  for (const fileName of localeFiles) {
    const locale = readLocale(fileName.replace(/\.json$/, ''))
    assert.equal(typeof locale.languageName, 'string')
    assert.ok(locale.languageName.trim())
    for (const section of ['messages', 'statuses', 'statusTemplates']) {
      assert.ok(locale[section] && typeof locale[section] === 'object')
    }
  }
})

test('non-English locales preserve English keys and placeholder names', () => {
  for (const section of ['messages', 'statuses', 'statusTemplates']) {
    for (const key of Object.keys(en[section])) {
      for (const fileName of localeFiles.filter(name => name !== 'en.json')) {
        const locale = readLocale(fileName.replace(/\.json$/, ''))
        assert.ok(Object.hasOwn(locale[section], key), `${fileName} ${section} missing key: ${key}`)
        assert.deepEqual(
          placeholders(locale[section][key]),
          placeholders(en[section][key]),
          `${fileName} ${section} placeholder mismatch: ${key}`,
        )
      }
    }
  }
})
