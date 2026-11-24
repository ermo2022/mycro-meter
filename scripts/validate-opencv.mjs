#!/usr/bin/env node

import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'
import crypto from 'crypto'
import { spawnSync } from 'child_process'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const projectRoot = path.dirname(__dirname)
const binaryPath = path.join(projectRoot, 'vendor', 'opencv.js')
const inventoryPath = path.join(projectRoot, 'public', 'opencv-inventory.json')

const minSizeBytes = 3_000_000
const expectedApiCount = 60

function computeFileHash(filePath) {
  const content = fs.readFileSync(filePath)
  return crypto.createHash('sha256').update(content).digest('hex')
}

function runCommand(command, args, description) {
  console.log(`\n🔨 ${description}...`)
  const result = spawnSync(command, args, {
    cwd: projectRoot,
    stdio: 'inherit',
    shell: true,
  })

  if (result.status !== 0) {
    console.error(`\n❌ ${description} failed with exit code ${result.status}`)
    process.exit(1)
  }

  console.log(`✅ ${description} passed`)
}

function main() {
  console.log('\n📋 Validating OpenCV.js build...\n')

  // Check binary file exists and has reasonable size
  if (!fs.existsSync(binaryPath)) {
    console.error(`❌ Binary not found: ${binaryPath}`)
    process.exit(1)
  }

  const stats = fs.statSync(binaryPath)
  const sizeBytes = stats.size
  const sizeMB = (sizeBytes / 1_000_000).toFixed(1)

  console.log(`📦 Binary size: ${sizeMB} MB (${sizeBytes.toLocaleString()} bytes)`)

  if (sizeBytes < minSizeBytes) {
    console.error(`❌ Binary is suspiciously small (< ${(minSizeBytes / 1_000_000).toFixed(0)} MB). Build may be incomplete.`)
    process.exit(1)
  }

  // Check inventory exists and is valid JSON
  if (!fs.existsSync(inventoryPath)) {
    console.error(`❌ Inventory not found: ${inventoryPath}`)
    process.exit(1)
  }

  let inventory
  try {
    inventory = JSON.parse(fs.readFileSync(inventoryPath, 'utf-8'))
  } catch (error) {
    console.error(`❌ Inventory is not valid JSON: ${error.message}`)
    process.exit(1)
  }

  // Validate inventory structure
  if (!inventory.apis || !Array.isArray(inventory.apis)) {
    console.error('❌ Inventory missing "apis" array')
    process.exit(1)
  }

  if (!inventory.buildFingerprint || typeof inventory.buildFingerprint !== 'string') {
    console.error('❌ Inventory missing "buildFingerprint"')
    process.exit(1)
  }

  if (!inventory.binarySha256 || typeof inventory.binarySha256 !== 'string') {
    console.error('❌ Inventory missing "binarySha256"')
    process.exit(1)
  }

  if (!inventory.sourceRevision || typeof inventory.sourceRevision !== 'string') {
    console.error('❌ Inventory missing "sourceRevision"')
    process.exit(1)
  }

  if (!inventory.emscriptenVersion || typeof inventory.emscriptenVersion !== 'string') {
    console.error('❌ Inventory missing "emscriptenVersion"')
    process.exit(1)
  }

  // Check API count
  const apiCount = inventory.apis.length
  console.log(`🔧 Registered APIs: ${apiCount}`)

  if (apiCount < expectedApiCount) {
    console.warn(`⚠️  API count is lower than expected (${expectedApiCount}). Some dependencies may be missing.`)
  }

  // Verify binary hash matches inventory
  const computedHash = computeFileHash(binaryPath)
  console.log(`🔐 Binary SHA256: ${computedHash}`)
  console.log(`📋 Inventory SHA256: ${inventory.binarySha256}`)

  if (computedHash !== inventory.binarySha256) {
    console.error('❌ Binary hash does not match inventory. Inventory may be stale or binary was modified.')
    process.exit(1)
  }

  // Log versions
  console.log(`\n📌 Build Info:`)
  console.log(`   Source Revision: ${inventory.sourceRevision}`)
  console.log(`   Emscripten Version: ${inventory.emscriptenVersion}`)
  console.log(`   Build Fingerprint: ${inventory.buildFingerprint}`)

  // Check for critical APIs that the app depends on
  const criticalApis = [
    'Canny',
    'GaussianBlur',
    'Mat',
    'MatVector',
    'contourArea',
    'minEnclosingCircle',
    'minAreaRect',
    'findContours',
    'cvtColor',
    'imread',
    'imshow',
    'COLOR_RGBA2GRAY',
  ]

  const missingApis = criticalApis.filter(api => !inventory.apis.includes(api))

  if (missingApis.length > 0) {
    console.error(`\n❌ Missing critical APIs: ${missingApis.join(', ')}`)
    console.error('The build is incomplete and will cause runtime errors.')
    process.exit(1)
  }

  console.log(`\n✅ All ${criticalApis.length} critical APIs present`)

  // Integration tests
  console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━')
  console.log('📊 Running integration tests...')
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━')

  runCommand('npm', ['test'], 'Unit tests')
  runCommand('npm', ['run', 'build'], 'Production build')

  console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━')
  console.log('✅ All validations passed! OpenCV.js is ready.\n')
  console.log('Next steps:')
  console.log('  1. npm run preview')
  console.log('  2. Open http://localhost:4173')
  console.log('  3. Load a test image and verify detection works')
  console.log('  4. git commit changes')
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n')
}

main()

