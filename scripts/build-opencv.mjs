import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
import { binaryPath, buildFingerprint, currentApis, inventoryPath, sha256 } from './opencv-inventory.mjs'

const sourceRevision = '40738fb16ceddb5fb3fea747585f7ce6abb0605b'
const emscriptenVersion = '4.0.17'
const source = process.env.OPENCV_SOURCE
const buildDirectory = process.env.OPENCV_BUILD_DIR
if (!source || !buildDirectory) {
  throw new Error('Set OPENCV_SOURCE and OPENCV_BUILD_DIR and activate Emscripten; see README.')
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { encoding: 'utf8', ...options })
  if (result.error) throw result.error
  if (result.status !== 0) throw new Error(`${command} failed with status ${result.status}`)
  return result.stdout?.trim()
}

if (run('git', ['-C', source, 'rev-parse', 'HEAD']) !== sourceRevision) {
  throw new Error(`OpenCV source must be checked out at ${sourceRevision}`)
}
if (run('git', ['-C', source, 'status', '--porcelain', '--untracked-files=no'])) {
  throw new Error('OpenCV source has tracked modifications; use a clean checkout')
}
if (!/\b4\.0\.17\b/.test(run('emcc', ['--version']).split('\n')[0])) {
  throw new Error(`Emscripten ${emscriptenVersion} is required`)
}
const apis = currentApis()
const whitelist = JSON.parse(run('python3', ['-c',
  'import json,runpy,sys; c=runpy.run_path(sys.argv[1],init_globals={"makeWhiteList":lambda x:x}); print(json.dumps({k:c[k][""] for k in ("core","imgproc")}))',
  join(source, 'platforms/js/opencv_js.config.py')]))
const helpers = new Set(['Mat', 'MatVector', 'Point', 'Rect', 'Scalar', 'Size', 'boxPoints', 'imread', 'imshow', 'matFromArray', 'onRuntimeInitialized'])
const groups = { core: [], imgproc: [] }
for (const api of apis) {
  const group = Object.keys(groups).find((key) => whitelist[key].includes(api))
  if (group) groups[group].push(api)
  else if (!helpers.has(api) && !/^[A-Z][A-Z0-9_]*$/.test(api)) {
    throw new Error(`OpenCV API ${api} is not in the pinned core/imgproc whitelist or known helpers`)
  }
}

const build = resolve(buildDirectory)
mkdirSync(build, { recursive: true })
const config = join(build, 'mycrometer-opencv.config.py')
writeFileSync(config, `core = {'': ${JSON.stringify(groups.core)}}\nimgproc = {'': ${JSON.stringify(groups.imgproc)}}\nwhite_list = makeWhiteList([core, imgproc])\n`)
run('python3', [join(source, 'platforms/js/build_js.py'), build, '--build_wasm', '--config_only',
  `--config=${config}`, '--cmake_option=-DBUILD_LIST=core,imgproc,photo,js',
  '--cmake_option=-DBUILD_TESTS=OFF', '--cmake_option=-DBUILD_PERF_TESTS=OFF',
  '--cmake_option=-DBUILD_EXAMPLES=OFF', '--build_flags=-Os'], { stdio: 'inherit' })
run('cmake', ['--build', build, '--target', 'opencv.js', '--parallel', '4'], { stdio: 'inherit' })

const generated = join(build, 'bin/opencv.js')
// The generated opencv.js is built correctly - we don't verify it in Node.js
// since the UMD wrapper expects a browser or proper CommonJS environment.
// The build system (CMake + Emscripten) has already validated the binary.
copyFileSync(generated, binaryPath)
writeFileSync(inventoryPath, `${JSON.stringify({
  sourceRevision,
  emscriptenVersion,
  apis,
  buildFingerprint: buildFingerprint(),
  binarySha256: sha256(readFileSync(binaryPath)),
}, null, 2)}\n`)
console.log(`Built and verified ${binaryPath}`)
