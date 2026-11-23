import { createHash } from 'node:crypto'
import { readFileSync, readdirSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'

export const root = resolve(fileURLToPath(new URL('..', import.meta.url)))
export const inventoryPath = join(root, 'public/opencv-inventory.json')
export const binaryPath = join(root, 'vendor/opencv.js')

function filesIn(directory, extension) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name)
    return entry.isDirectory() ? filesIn(path, extension) : extension.test(entry.name) ? [path] : []
  })
}

export function collectApis(sourceFiles, scriptFiles) {
  const config = ts.readConfigFile(join(root, 'tsconfig.app.json'), ts.sys.readFile)
  if (config.error) throw new Error(ts.flattenDiagnosticMessageText(config.error.messageText, '\n'))
  const options = ts.parseJsonConfigFileContent(config.config, ts.sys, root).options
  const program = ts.createProgram(sourceFiles, options)
  const checker = program.getTypeChecker()
  const detection = program.getSourceFile(join(root, 'src/objectDetection.ts'))
  const apiAlias = detection?.statements.find((statement) => ts.isTypeAliasDeclaration(statement) && statement.name.text === 'OpenCvApi')
  if (!apiAlias) throw new Error('Cannot find OpenCvApi type in src/objectDetection.ts')
  const apiType = checker.getTypeAtLocation(apiAlias.name)
  const apis = new Set()

  function isTypedCv(expression) {
    const type = checker.getNonNullableType(checker.getTypeAtLocation(expression))
    return !(type.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown | ts.TypeFlags.Never)) &&
      checker.isTypeAssignableTo(type, apiType)
  }

  function visit(file, node, isScript, aliases) {
    const isScriptCv = (expression) => ts.isIdentifier(expression) && aliases.has(expression.text)
    if (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) {
      const receiver = node.expression
      const isCv = isScript
        ? isScriptCv(receiver)
        : isTypedCv(receiver)
      if (isCv) {
        if (ts.isPropertyAccessExpression(node)) apis.add(node.name.text)
        else if (node.argumentExpression && ts.isStringLiteral(node.argumentExpression)) apis.add(node.argumentExpression.text)
        else throw new Error(`${file.fileName}:${file.getLineAndCharacterOfPosition(node.getStart(file)).line + 1}: dynamic OpenCV property access is unsupported`)
      }
    }
    if (ts.isVariableDeclaration(node) && ts.isObjectBindingPattern(node.name) && node.initializer) {
      const isCv = isScript
        ? isScriptCv(node.initializer)
        : isTypedCv(node.initializer)
      if (isCv) throw new Error(`${file.fileName}: OpenCV destructuring is unsupported; use explicit property access`)
    }
    if (!isScript && (ts.isAsExpression(node) || ts.isTypeAssertionExpression(node)) &&
        isTypedCv(node.expression) && (node.type.kind === ts.SyntaxKind.AnyKeyword || node.type.kind === ts.SyntaxKind.UnknownKeyword)) {
      throw new Error(`${file.fileName}: casting OpenCV to any or unknown is unsupported`)
    }
    if (!isScript && ts.isVariableDeclaration(node) && node.initializer && node.type &&
        isTypedCv(node.initializer) && (node.type.kind === ts.SyntaxKind.AnyKeyword || node.type.kind === ts.SyntaxKind.UnknownKeyword)) {
      throw new Error(`${file.fileName}: assigning OpenCV to any or unknown is unsupported`)
    }
    if (!isScript && ts.isCallExpression(node)) {
      const signature = checker.getResolvedSignature(node)
      for (const [index, argument] of node.arguments.entries()) {
        if (!isTypedCv(argument)) continue
        const parameter = signature?.parameters[index]
        const type = parameter && checker.getTypeOfSymbolAtLocation(parameter, node)
        if (!type || type.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown)) {
          throw new Error(`${file.fileName}: passing OpenCV to an untyped parameter is unsupported`)
        }
      }
    }
    ts.forEachChild(node, (child) => visit(file, child, isScript, aliases))
  }

  for (const name of sourceFiles) {
    const file = program.getSourceFile(name)
    if (!file) throw new Error(`Cannot read ${name}`)
    visit(file, file, false, new Set())
  }
  for (const name of scriptFiles) {
    const file = ts.createSourceFile(name, readFileSync(name, 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.JS)
    const aliases = new Set(['cv'])
    let changed
    do {
      changed = false
      function findAliases(node) {
        if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer &&
            ts.isIdentifier(node.initializer) && aliases.has(node.initializer.text) && !aliases.has(node.name.text)) {
          aliases.add(node.name.text)
          changed = true
        }
        ts.forEachChild(node, findAliases)
      }
      findAliases(file)
    } while (changed)
    visit(file, file, true, aliases)
  }
  return [...apis].sort()
}

export function currentApis() {
  return collectApis(filesIn(join(root, 'src'), /\.tsx?$/), [
    ...filesIn(join(root, 'tests'), /\.test\.mjs$/),
    join(root, 'scripts/tuneSpores.mjs'),
  ])
}

export function sha256(data) {
  return createHash('sha256').update(data).digest('hex')
}

export function buildFingerprint() {
  return sha256(['scripts/opencv-inventory.mjs', 'scripts/build-opencv.mjs']
    .map((path) => readFileSync(join(root, path)))
    .reduce((all, content) => Buffer.concat([all, content]), Buffer.alloc(0)))
}

export function verifyInventory() {
  const recorded = JSON.parse(readFileSync(inventoryPath, 'utf8'))
  if (JSON.stringify(recorded.apis) !== JSON.stringify(currentApis()) ||
      recorded.buildFingerprint !== buildFingerprint() ||
      recorded.binarySha256 !== sha256(readFileSync(binaryPath))) {
    throw new Error('Custom OpenCV is stale or modified. Rebuild it with npm run build:opencv; see README.')
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    verifyInventory()
    console.log('Custom OpenCV inventory and binary verified.')
  } catch (error) {
    console.error(`OpenCV verification failed: ${error.message}`)
    process.exitCode = 1
  }
}
