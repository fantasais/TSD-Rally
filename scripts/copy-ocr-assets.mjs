import { copyFile, mkdir, readdir, rm, stat } from 'node:fs/promises'
import path from 'node:path'

const root = process.cwd()
const outputRoot = path.join(root, 'public', 'ocr')
const workerSource = path.join(root, 'node_modules', 'tesseract.js', 'dist', 'worker.min.js')
const coreSource = path.join(root, 'node_modules', 'tesseract.js-core')
const languagePackage = path.join(root, 'node_modules', '@tesseract.js-data', 'eng')

async function exists(filePath) {
  try {
    await stat(filePath)
    return true
  } catch {
    return false
  }
}

async function findFiles(directory, fileName, matches = []) {
  const entries = await readdir(directory, { withFileTypes: true })
  for (const entry of entries) {
    const fullPath = path.join(directory, entry.name)
    if (entry.isDirectory()) await findFiles(fullPath, fileName, matches)
    else if (entry.name === fileName) matches.push(fullPath)
  }
  return matches
}

if (!(await exists(workerSource))) {
  throw new Error('Tesseract browser worker not found. Run npm install before building.')
}
if (!(await exists(coreSource))) {
  throw new Error('tesseract.js-core package not found. Run npm install before building.')
}
if (!(await exists(languagePackage))) {
  throw new Error('@tesseract.js-data/eng package not found. Run npm install before building.')
}

await rm(outputRoot, { recursive: true, force: true })
await mkdir(path.join(outputRoot, 'core'), { recursive: true })
await mkdir(path.join(outputRoot, 'lang'), { recursive: true })
await copyFile(workerSource, path.join(outputRoot, 'worker.min.js'))

const coreEntries = await readdir(coreSource, { withFileTypes: true })
const coreFiles = coreEntries
  .filter((entry) => entry.isFile() && /^tesseract-core.*\.wasm(?:\.js)?$/.test(entry.name))
  .map((entry) => entry.name)

const requiredCoreFiles = [
  'tesseract-core.wasm.js',
  'tesseract-core-simd.wasm.js',
  'tesseract-core-lstm.wasm.js',
  'tesseract-core-simd-lstm.wasm.js'
]

for (const required of requiredCoreFiles) {
  if (!coreFiles.includes(required)) {
    throw new Error(`Required OCR core asset is missing: ${required}`)
  }
}

for (const fileName of coreFiles) {
  await copyFile(path.join(coreSource, fileName), path.join(outputRoot, 'core', fileName))
}

const languageCandidates = await findFiles(languagePackage, 'eng.traineddata.gz')
if (!languageCandidates.length) {
  throw new Error('English OCR trained data was not found in @tesseract.js-data/eng.')
}

const preferredLanguage =
  languageCandidates.find((candidate) => candidate.includes('4.0.0_best_int')) ??
  languageCandidates.find((candidate) => candidate.includes('4.0.0')) ??
  languageCandidates[0]

await copyFile(preferredLanguage, path.join(outputRoot, 'lang', 'eng.traineddata.gz'))

console.log(`Offline OCR assets prepared: ${coreFiles.length} core files + English trained data.`)
