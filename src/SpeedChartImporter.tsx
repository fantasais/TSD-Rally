import { useMemo, useRef, useState } from 'react'
import { createWorker, OEM, PSM } from 'tesseract.js'
import { getDocument, GlobalWorkerOptions } from 'pdfjs-dist'
import pdfWorkerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url'
import type { SpeedSector } from './types'

GlobalWorkerOptions.workerSrc = pdfWorkerUrl

type LocalOcrMode = 'speed' | 'time' | 'zone_speed' | 'zone_time'
type ConfidenceLabel = 'high' | 'medium' | 'low'

type LocalOcrRow = {
  fromKm: number
  toKm: number
  mode: LocalOcrMode
  speedKph: number
  durationSeconds: number
  confidence: ConfidenceLabel
  note: string
}

type ProgressCallback = (progress: number, status: string) => void

type FlatWord = {
  text: string
  confidence: number
  x0: number
  y0: number
  x1: number
  y1: number
  cx: number
  cy: number
  height: number
}

type HeaderGeometry = {
  startX: number
  endX: number
  speedX: number
  headerY: number
  typicalHeight: number
  startLeft: number
  boundary1: number
  boundary2: number
  speedRight: number
}

type CellReading<T> = {
  value: T | null
  confidence: number
  text: string
}

type WorkingRow = LocalOcrRow & {
  centerY: number
  top: number
  bottom: number
  fromConfidence: number
  toConfidence: number
  valueConfidence: number
  inserted: boolean
}

type ImageVariant = 'grey' | 'binary'

let activeProgress: ProgressCallback | null = null
let activeWorkerError: ((error: unknown) => void) | null = null
let workerPromise: ReturnType<typeof createWorker> | null = null
let workerProgressBase = 0
let workerProgressSpan = 0.1

function setWorkerProgressPhase(base: number, span: number) {
  workerProgressBase = base
  workerProgressSpan = span
}

function publicAsset(path: string) {
  const base = import.meta.env.BASE_URL.endsWith('/') ? import.meta.env.BASE_URL : `${import.meta.env.BASE_URL}/`
  return `${base}${path.replace(/^\/+/, '')}`
}

function errorText(error: unknown) {
  if (error instanceof Error) return error.message
  if (typeof error === 'string') return error
  return 'Unknown OCR engine error'
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = window.setTimeout(() => reject(new Error(message)), timeoutMs)
    promise.then(
      (value) => {
        window.clearTimeout(timer)
        resolve(value)
      },
      (error) => {
        window.clearTimeout(timer)
        reject(error)
      }
    )
  })
}

function getWorker() {
  if (!workerPromise) {
    activeProgress?.(0.08, 'Loading offline OCR engine')
    workerPromise = createWorker('eng', OEM.LSTM_ONLY, {
      workerPath: publicAsset('ocr/worker.min.js'),
      corePath: publicAsset('ocr/core'),
      langPath: publicAsset('ocr/lang'),
      logger: (message) => {
        const progress = typeof message.progress === 'number' ? message.progress : 0
        activeProgress?.(
          Math.min(0.97, workerProgressBase + progress * workerProgressSpan),
          message.status || 'Preparing OCR'
        )
      },
      errorHandler: (error) => {
        activeWorkerError?.(error)
      }
    })
      .then(async (worker) => {
        await worker.setParameters({
          tessedit_pageseg_mode: PSM.SPARSE_TEXT,
          preserve_interword_spaces: '1',
          user_defined_dpi: '300'
        })
        return worker
      })
      .catch((error) => {
        workerPromise = null
        throw error
      })
  }
  return workerPromise
}

function loadImage(file: File): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file)
    const image = new Image()

    image.onload = () => {
      URL.revokeObjectURL(url)
      resolve(image)
    }
    image.onerror = () => {
      URL.revokeObjectURL(url)
      reject(new Error('Could not read the selected image.'))
    }
    image.src = url
  })
}

/**
 * Engine 2A deliberately gives OCR more pixels than the old reader.
 * The whole photo is normalised once; targeted row/cell retries reuse this canvas.
 */
async function prepareImage(file: File): Promise<HTMLCanvasElement> {
  const image = await loadImage(file)
  const targetWidth = Math.max(1800, Math.min(2200, image.naturalWidth))
  const scale = targetWidth / image.naturalWidth
  const width = Math.max(1, Math.round(image.naturalWidth * scale))
  const height = Math.max(1, Math.round(image.naturalHeight * scale))

  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height
  const ctx = canvas.getContext('2d', { willReadFrequently: true })
  if (!ctx) throw new Error('Image processing is not available on this device.')

  ctx.drawImage(image, 0, 0, width, height)
  const frame = ctx.getImageData(0, 0, width, height)
  const pixels = frame.data
  const histogram = new Uint32Array(256)

  for (let i = 0; i < pixels.length; i += 4) {
    const grey = Math.round(0.299 * pixels[i] + 0.587 * pixels[i + 1] + 0.114 * pixels[i + 2])
    histogram[grey] += 1
  }

  const total = width * height
  const percentile = (fraction: number) => {
    const target = total * fraction
    let running = 0
    for (let value = 0; value < 256; value += 1) {
      running += histogram[value]
      if (running >= target) return value
    }
    return 255
  }

  const low = percentile(0.04)
  const high = Math.max(low + 35, percentile(0.97))
  const range = Math.max(1, high - low)

  for (let i = 0; i < pixels.length; i += 4) {
    const grey = Math.round(0.299 * pixels[i] + 0.587 * pixels[i + 1] + 0.114 * pixels[i + 2])
    const stretched = Math.max(0, Math.min(255, Math.round(((grey - low) * 255) / range)))
    const adjusted = Math.max(0, Math.min(255, Math.round(255 * Math.pow(stretched / 255, 0.9))))
    pixels[i] = adjusted
    pixels[i + 1] = adjusted
    pixels[i + 2] = adjusted
    pixels[i + 3] = 255
  }

  ctx.putImageData(frame, 0, 0)
  return canvas
}

function median(values: number[]) {
  if (!values.length) return 0
  const sorted = [...values].sort((a, b) => a - b)
  const middle = Math.floor(sorted.length / 2)
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2
}

function cleanNumericText(value: string) {
  return value
    .toUpperCase()
    .replace(/[OQ]/g, '0')
    .replace(/,/g, '.')
}

function parseNumber(value: string): number | null {
  const cleaned = cleanNumericText(value)
  const matches = cleaned.match(/\d+(?:\.\d+)?/g)
  if (!matches?.length) return null

  const token = [...matches].sort((a, b) => b.length - a.length)[0]
  const number = Number(token)
  return Number.isFinite(number) ? number : null
}

function normalizeSpeed(number: number) {
  if (number <= 180) return number
  // Decimal points are occasionally dropped from values such as 26.33 / 32.56.
  if (number >= 200 && number <= 9999) {
    const divided = number / 100
    if (divided >= 1 && divided <= 120) return divided
  }
  return number
}

function parseDurationText(value: string): number | null {
  const upper = cleanNumericText(value)

  const colon = /(\d+)\s*:\s*(\d{1,2})/.exec(upper)
  if (colon) {
    const minutes = Number(colon[1])
    const seconds = Number(colon[2])
    if (Number.isFinite(minutes) && seconds >= 0 && seconds <= 59) return minutes * 60 + seconds
  }

  const minutesMatch = /(\d+)\s*(?:MIN|M1N|MINS|MINUTE|MINUTES)/.exec(upper)
  if (!minutesMatch) return null

  const minutes = Number(minutesMatch[1])
  const afterMinutes = upper.slice((minutesMatch.index ?? 0) + minutesMatch[0].length)
  const secondsMatch = /(\d{1,2})\s*(?:SEC|SECS|SECOND|SECONDS)?/.exec(afterMinutes)
  const seconds = secondsMatch ? Number(secondsMatch[1]) : 0

  if (!Number.isFinite(minutes) || !Number.isFinite(seconds) || seconds < 0 || seconds > 59) return null
  return minutes * 60 + seconds
}

function parseSpeedOrTime(value: string) {
  const durationSeconds = parseDurationText(value)
  if (durationSeconds !== null) {
    return {
      mode: 'time' as const,
      speedKph: 0,
      durationSeconds
    }
  }

  const number = parseNumber(value)
  if (number === null) return null

  return {
    mode: 'speed' as const,
    speedKph: normalizeSpeed(number),
    durationSeconds: 0
  }
}

function isTimedMode(mode: LocalOcrMode) {
  return mode === 'time' || mode === 'zone_time'
}

/**
 * Time-heavy charts (such as BEGIN ODO / END ODO / SPEED-TIME) are true segment-time
 * charts. An isolated time row inside an otherwise speed-based chart keeps the existing
 * DZ/FZ fixed-time interpretation.
 */
function classifyTimedChartRows(rows: LocalOcrRow[]) {
  const timeRows = rows.filter((row) => row.mode === 'time').length
  const speedRows = rows.filter((row) => row.mode === 'speed' || row.mode === 'zone_speed').length
  const isTimeChart = timeRows > 0 && timeRows >= speedRows

  return rows.map((row) => row.mode === 'time' && !isTimeChart
    ? { ...row, mode: 'zone_time' as const, note: row.note || 'Fixed-time row in speed chart' }
    : row)
}

function derivedSpeedKph(fromKm: number, toKm: number, durationSeconds: number) {
  const distanceKm = Math.max(0, toKm - fromKm)
  return durationSeconds > 0 ? (distanceKm / durationSeconds) * 3600 : 0
}

function flattenWords(blocks: any[]): FlatWord[] {
  const words: FlatWord[] = []

  for (const block of blocks) {
    for (const paragraph of block.paragraphs ?? []) {
      for (const line of paragraph.lines ?? []) {
        for (const word of line.words ?? []) {
          const text = word.text?.trim()
          if (!text) continue
          const { x0, y0, x1, y1 } = word.bbox
          words.push({
            text,
            confidence: Number.isFinite(word.confidence) ? word.confidence : 0,
            x0,
            y0,
            x1,
            y1,
            cx: (x0 + x1) / 2,
            cy: (y0 + y1) / 2,
            height: Math.max(1, y1 - y0)
          })
        }
      }
    }
  }

  return words
}

function lettersOnly(value: string) {
  return value.toUpperCase().replace(/[^A-Z]/g, '')
}

function wordRole(value: string): 'start' | 'end' | 'speed' | null {
  const word = lettersOnly(value)
  if (!word) return null

  if (
    word.startsWith('STAR') ||
    word === 'STRT' ||
    word === 'FROM' ||
    word === 'FR0M' ||
    word.startsWith('FRO')
  ) return 'start'

  if (word === 'END' || word.startsWith('ENO') || word === 'EN0' || word === 'TO') return 'end'

  if (
    word.startsWith('SPE') ||
    word.startsWith('SPD') ||
    word === 'KM' ||
    word === 'KMH' ||
    word === 'KPH' ||
    word === 'TIME' ||
    word.startsWith('TIM')
  ) return 'speed'

  return null
}

function geometryFromCenters(startX: number, endX: number, speedX: number, headerY: number, typicalHeight: number): HeaderGeometry | null {
  const gap1 = endX - startX
  const gap2 = speedX - endX
  if (!(gap1 > typicalHeight * 1.2) || !(gap2 > typicalHeight * 1.2)) return null

  return {
    startX,
    endX,
    speedX,
    headerY,
    typicalHeight,
    startLeft: Math.max(0, startX - gap1 * 0.53),
    boundary1: (startX + endX) / 2,
    boundary2: (endX + speedX) / 2,
    speedRight: speedX + gap2 * 0.58
  }
}

function findHeaderGeometry(words: FlatWord[]) {
  const candidates = words.filter((word) => /[A-Za-z]/.test(word.text))
  const typicalHeight = Math.max(10, median(words.map((word) => word.height).filter((value) => value > 3)))

  const starts = candidates.filter((word) => wordRole(word.text) === 'start')
  for (const start of starts) {
    const nearby = candidates.filter((word) => Math.abs(word.cy - start.cy) < Math.max(45, start.height * 2.8))
    const ends = nearby.filter((word) => wordRole(word.text) === 'end')
    const speeds = nearby.filter((word) => wordRole(word.text) === 'speed')

    for (const end of ends) {
      for (const speed of speeds) {
        if (start.cx < end.cx && end.cx < speed.cx) {
          const geometry = geometryFromCenters(
            start.cx,
            end.cx,
            speed.cx,
            Math.max(start.cy, end.cy, speed.cy),
            typicalHeight
          )
          if (geometry) return geometry
        }
      }

      // A common OCR failure is losing one short header such as SPEED / KM.
      // Printed rally charts normally use equal-width data columns, so two trusted
      // adjacent headers are enough to recover the third column geometry.
      if (start.cx < end.cx && !speeds.length) {
        const gap = end.cx - start.cx
        const estimatedSpeedX = end.cx + gap
        const geometry = geometryFromCenters(start.cx, end.cx, estimatedSpeedX, Math.max(start.cy, end.cy), typicalHeight)
        if (geometry) return geometry
      }
    }

    if (!ends.length && speeds.length) {
      for (const speed of speeds) {
        if (start.cx < speed.cx) {
          const estimatedEndX = (start.cx + speed.cx) / 2
          const geometry = geometryFromCenters(start.cx, estimatedEndX, speed.cx, Math.max(start.cy, speed.cy), typicalHeight)
          if (geometry) return geometry
        }
      }
    }
  }

  const ends = candidates.filter((word) => wordRole(word.text) === 'end')
  for (const end of ends) {
    const nearby = candidates.filter((word) => Math.abs(word.cy - end.cy) < Math.max(45, end.height * 2.8))
    const speeds = nearby.filter((word) => wordRole(word.text) === 'speed' && word.cx > end.cx)
    if (speeds.length) {
      const speed = speeds[0]
      const gap = speed.cx - end.cx
      const geometry = geometryFromCenters(end.cx - gap, end.cx, speed.cx, Math.max(end.cy, speed.cy), typicalHeight)
      if (geometry) return geometry
    }
  }

  return null
}

function kMeans1D(values: number[], k: number) {
  if (values.length < k) return null
  const sorted = [...values].sort((a, b) => a - b)
  let centers = Array.from({ length: k }, (_, index) => {
    const position = ((index + 0.5) / k) * (sorted.length - 1)
    return sorted[Math.max(0, Math.min(sorted.length - 1, Math.round(position)))]
  })

  let assignments = new Array(values.length).fill(0)
  for (let iteration = 0; iteration < 20; iteration += 1) {
    assignments = values.map((value) => {
      let best = 0
      let bestDistance = Math.abs(value - centers[0])
      for (let i = 1; i < centers.length; i += 1) {
        const distance = Math.abs(value - centers[i])
        if (distance < bestDistance) {
          best = i
          bestDistance = distance
        }
      }
      return best
    })

    const next = centers.map((center, index) => {
      const members = values.filter((_, valueIndex) => assignments[valueIndex] === index)
      return members.length ? members.reduce((sum, value) => sum + value, 0) / members.length : center
    })

    if (next.every((value, index) => Math.abs(value - centers[index]) < 0.25)) {
      centers = next
      break
    }
    centers = next
  }

  const counts = centers.map((_, index) => assignments.filter((assignment) => assignment === index).length)
  const ordered = centers
    .map((center, index) => ({ center, count: counts[index] }))
    .sort((a, b) => a.center - b.center)

  return ordered
}

/**
 * Header OCR is normally the best geometry source. If a header is not recognised
 * (for example FROM / TO / KM), infer the three numeric data columns from the page.
 */
function inferGeometryFromNumericColumns(words: FlatWord[], canvas: HTMLCanvasElement): HeaderGeometry | null {
  const numericWords = words.filter((word) => {
    const value = parseNumber(word.text)
    return value !== null && word.confidence >= 20 && word.cy > canvas.height * 0.08 && word.cy < canvas.height * 0.94
  })
  if (numericWords.length < 12) return null

  const xValues = numericWords.map((word) => word.cx)
  const candidates = [3, 4]
    .map((k) => ({ k, clusters: kMeans1D(xValues, k) }))
    .filter((candidate): candidate is { k: number; clusters: { center: number; count: number }[] } => Boolean(candidate.clusters))

  if (!candidates.length) return null

  let best: { centers: number[]; score: number } | null = null
  for (const candidate of candidates) {
    const clusters = candidate.clusters
    const counts = clusters.map((cluster) => cluster.count)
    const medianCount = Math.max(1, median(counts))
    if (counts.some((count) => count < medianCount * 0.28)) continue

    const data = candidate.k === 4 ? clusters.slice(1) : clusters
    if (data.length !== 3) continue
    const centers = data.map((cluster) => cluster.center)
    const gap1 = centers[1] - centers[0]
    const gap2 = centers[2] - centers[1]
    if (!(gap1 > 30) || !(gap2 > 30)) continue

    const balancePenalty = Math.abs(gap1 - gap2) / Math.max(gap1, gap2)
    const countPenalty = data.reduce((sum, cluster) => sum + Math.abs(cluster.count - median(data.map((item) => item.count))), 0) / Math.max(1, medianCount * 3)
    // Slight preference for 4 clusters when a real serial-number column is present.
    const score = balancePenalty + countPenalty * 0.2 + (candidate.k === 3 ? 0.04 : 0)
    if (!best || score < best.score) best = { centers, score }
  }

  if (!best) return null
  const [startX, endX, speedX] = best.centers
  const typicalHeight = Math.max(10, median(words.map((word) => word.height).filter((value) => value > 3)))

  // Find the first regular run of numeric rows and place the virtual header just above it.
  const likelyDataWords = numericWords.filter((word) => word.cx >= startX - (endX - startX) * 0.65 && word.cx <= speedX + (speedX - endX) * 0.65)
  const rowClusters = clusterRows(likelyDataWords, Math.max(10, typicalHeight * 0.8))
    .filter((row) => row.words.some((word) => parseNumber(word.text) !== null))
  if (rowClusters.length < 3) return null

  const diffs = rowClusters.slice(1).map((row, index) => row.y - rowClusters[index].y).filter((value) => value > typicalHeight * 0.7)
  const spacing = median(diffs.filter((value) => value < typicalHeight * 4.5)) || typicalHeight * 1.8
  let firstIndex = 0
  for (let index = 0; index < rowClusters.length - 2; index += 1) {
    const d1 = rowClusters[index + 1].y - rowClusters[index].y
    const d2 = rowClusters[index + 2].y - rowClusters[index + 1].y
    if (d1 < spacing * 1.8 && d2 < spacing * 1.8) {
      firstIndex = index
      break
    }
  }

  return geometryFromCenters(startX, endX, speedX, rowClusters[firstIndex].y - spacing * 0.8, typicalHeight)
}

type WordRow = { words: FlatWord[]; y: number }

function clusterRows(words: FlatWord[], tolerance: number): WordRow[] {
  const rows: WordRow[] = []
  for (const word of [...words].sort((a, b) => a.cy - b.cy || a.cx - b.cx)) {
    let best: WordRow | null = null
    let bestDistance = Number.POSITIVE_INFINITY

    for (const row of rows) {
      const distance = Math.abs(row.y - word.cy)
      if (distance <= tolerance && distance < bestDistance) {
        best = row
        bestDistance = distance
      }
    }

    if (best) {
      best.words.push(word)
      best.y = best.words.reduce((sum, item) => sum + item.cy, 0) / best.words.length
    } else {
      rows.push({ words: [word], y: word.cy })
    }
  }

  return rows.sort((a, b) => a.y - b.y)
}

function confidenceLabel(value: number): ConfidenceLabel {
  if (value >= 84) return 'high'
  if (value >= 62) return 'medium'
  return 'low'
}

function fieldWords(words: FlatWord[], geometry: HeaderGeometry, centerY: number, halfHeight: number) {
  const inRow = words.filter((word) => Math.abs(word.cy - centerY) <= halfHeight)
  return {
    from: inRow.filter((word) => word.cx >= geometry.startLeft && word.cx < geometry.boundary1),
    to: inRow.filter((word) => word.cx >= geometry.boundary1 && word.cx < geometry.boundary2),
    value: inRow.filter((word) => word.cx >= geometry.boundary2 && word.cx <= geometry.speedRight)
  }
}

function readingFromWords(words: FlatWord[]): CellReading<number> {
  const text = words.map((word) => word.text).join(' ')
  const value = parseNumber(text)
  const confidence = words.length ? words.reduce((sum, word) => sum + word.confidence, 0) / words.length : 0
  return { value, confidence, text }
}

function speedReadingFromWords(words: FlatWord[]) {
  const text = words.map((word) => word.text).join(' ')
  const value = parseSpeedOrTime(text)
  const confidence = words.length ? words.reduce((sum, word) => sum + word.confidence, 0) / words.length : 0
  return { value, confidence, text }
}

function dominantGridSpacing(lines: number[]) {
  if (lines.length < 4) return 0
  const diffs = lines.slice(1).map((line, index) => line - lines[index]).filter((value) => value >= 12 && value <= 180)
  if (!diffs.length) return 0

  let bestSupport: number[] = []
  for (const candidate of diffs) {
    const tolerance = Math.max(4, candidate * 0.14)
    const support = diffs.filter((value) => Math.abs(value - candidate) <= tolerance)
    if (support.length > bestSupport.length) bestSupport = support
  }
  return bestSupport.length >= 3 ? median(bestSupport) : 0
}

function regularGridRun(lines: number[], spacing: number) {
  if (!spacing || lines.length < 4) return [] as number[]
  const tolerance = Math.max(6, spacing * 0.23)
  let best: number[] = []

  for (let start = 0; start < lines.length; start += 1) {
    const run = [lines[start]]
    let current = lines[start]
    while (true) {
      const target = current + spacing
      let next: number | null = null
      let bestDistance = Number.POSITIVE_INFINITY
      for (const line of lines) {
        if (line <= current + spacing * 0.45) continue
        const distance = Math.abs(line - target)
        if (distance <= tolerance && distance < bestDistance) {
          next = line
          bestDistance = distance
        }
      }
      if (next === null) break
      run.push(next)
      current = next
    }
    if (run.length > best.length) best = run
  }

  return best
}

/**
 * Detect the printed horizontal grid directly from pixels. This is the main Engine 2A
 * protection against a row being skipped by OCR: the grid tells us how many physical
 * rows exist before we try to read their text.
 */
function detectGridRowBounds(canvas: HTMLCanvasElement, geometry: HeaderGeometry) {
  const ctx = canvas.getContext('2d', { willReadFrequently: true })
  if (!ctx) return null

  const gap = geometry.endX - geometry.startX
  const probeHalfWidth = Math.max(28, Math.min(95, gap * 0.2))
  const probeX = geometry.startX
  const left = Math.max(0, Math.floor(probeX - probeHalfWidth))
  const right = Math.min(canvas.width, Math.ceil(probeX + probeHalfWidth))
  const top = Math.max(0, Math.floor(geometry.headerY - geometry.typicalHeight * 2.2))
  const bottom = Math.min(canvas.height, Math.floor(canvas.height * 0.96))
  const width = Math.max(1, right - left)
  const height = Math.max(1, bottom - top)
  const frame = ctx.getImageData(left, top, width, height)
  const data = frame.data

  const darkRatios = new Float32Array(height)
  for (let y = 0; y < height; y += 1) {
    let dark = 0
    const rowOffset = y * width * 4
    for (let x = 0; x < width; x += 1) {
      if (data[rowOffset + x * 4] < 118) dark += 1
    }
    darkRatios[y] = dark / width
  }

  const candidates: number[] = []
  for (let y = 0; y < height; y += 1) {
    let localMax = 0
    for (let offset = -2; offset <= 2; offset += 1) {
      const yy = y + offset
      if (yy >= 0 && yy < height) localMax = Math.max(localMax, darkRatios[yy])
    }
    if (localMax >= 0.62) candidates.push(y + top)
  }

  const groups: number[][] = []
  for (const y of candidates) {
    const last = groups[groups.length - 1]
    if (!last || y - last[last.length - 1] > 3) groups.push([y])
    else last.push(y)
  }

  const lines = groups
    .filter((group) => group.length <= Math.max(20, geometry.typicalHeight * 0.7))
    .map((group) => group.reduce((sum, value) => sum + value, 0) / group.length)

  const spacing = dominantGridSpacing(lines)
  const run = regularGridRun(lines, spacing)
  if (run.length < 5) return null

  // The header text sits between two grid lines. The first grid line below it is the
  // top boundary of data row 1; every following line creates another physical row.
  let dataTopIndex = run.findIndex((line) => line > geometry.headerY + geometry.typicalHeight * 0.08)
  if (dataTopIndex < 0) return null
  if (dataTopIndex >= run.length - 2 && dataTopIndex > 0) dataTopIndex -= 1

  const boundaries = run.slice(dataTopIndex)
  if (boundaries.length < 3) return null

  const centers = boundaries.slice(0, -1).map((line, index) => (line + boundaries[index + 1]) / 2)
  return {
    centers,
    boundaries,
    spacing: median(boundaries.slice(1).map((line, index) => line - boundaries[index])) || spacing
  }
}

function estimateRowCenters(words: FlatWord[], geometry: HeaderGeometry, canvas: HTMLCanvasElement) {
  const broadLeft = Math.max(0, geometry.startLeft - (geometry.endX - geometry.startX) * 0.75)
  const broadRight = Math.min(canvas.width, geometry.speedRight + (geometry.speedX - geometry.endX) * 0.18)
  const dataWords = words.filter((word) =>
    word.cy > geometry.headerY + geometry.typicalHeight * 0.35 &&
    word.cy < canvas.height * 0.97 &&
    word.cx >= broadLeft &&
    word.cx <= broadRight
  )

  let clusters = clusterRows(dataWords, Math.max(10, geometry.typicalHeight * 0.82))
    .filter((row) => row.words.some((word) => parseNumber(word.text) !== null))
  if (clusters.length < 2) return { centers: [] as number[], spacing: 0 }

  const rawDiffs = clusters.slice(1)
    .map((row, index) => row.y - clusters[index].y)
    .filter((value) => value > geometry.typicalHeight * 0.7 && value < geometry.typicalHeight * 4.8)
  let spacing = median(rawDiffs) || geometry.typicalHeight * 1.8
  const refined = rawDiffs.filter((value) => value > spacing * 0.55 && value < spacing * 1.5)
  if (refined.length) spacing = median(refined)

  // Find where the regular table run starts. This avoids title/date numbers above the chart.
  let startIndex = 0
  for (let index = 0; index < clusters.length - 2; index += 1) {
    const d1 = clusters[index + 1].y - clusters[index].y
    const d2 = clusters[index + 2].y - clusters[index + 1].y
    if (d1 <= spacing * 1.7 && d2 <= spacing * 1.7) {
      startIndex = index
      break
    }
  }
  clusters = clusters.slice(startIndex)

  const centers: number[] = []
  for (const cluster of clusters) {
    if (!centers.length) {
      centers.push(cluster.y)
      continue
    }

    const previous = centers[centers.length - 1]
    const gap = cluster.y - previous
    if (gap < spacing * 0.42) continue
    if (gap > spacing * 4.8) break

    if (gap > spacing * 1.55) {
      const steps = Math.max(2, Math.round(gap / spacing))
      for (let step = 1; step < steps; step += 1) {
        centers.push(previous + (gap * step) / steps)
      }
    }
    centers.push(cluster.y)
  }

  return { centers, spacing }
}

function cropCanvas(source: HTMLCanvasElement, left: number, top: number, right: number, bottom: number, variant: ImageVariant) {
  const safeLeft = Math.max(0, Math.floor(left))
  const safeTop = Math.max(0, Math.floor(top))
  const safeRight = Math.min(source.width, Math.ceil(right))
  const safeBottom = Math.min(source.height, Math.ceil(bottom))
  const sourceWidth = Math.max(1, safeRight - safeLeft)
  const sourceHeight = Math.max(1, safeBottom - safeTop)
  const scale = Math.max(2.5, Math.min(4, 95 / sourceHeight))
  const padding = 18

  const output = document.createElement('canvas')
  output.width = Math.max(1, Math.round(sourceWidth * scale) + padding * 2)
  output.height = Math.max(1, Math.round(sourceHeight * scale) + padding * 2)
  const ctx = output.getContext('2d', { willReadFrequently: true })
  if (!ctx) throw new Error('Image processing is not available on this device.')

  ctx.fillStyle = '#fff'
  ctx.fillRect(0, 0, output.width, output.height)
  ctx.imageSmoothingEnabled = true
  ctx.imageSmoothingQuality = 'high'
  ctx.drawImage(source, safeLeft, safeTop, sourceWidth, sourceHeight, padding, padding, sourceWidth * scale, sourceHeight * scale)

  if (variant === 'binary') {
    const frame = ctx.getImageData(0, 0, output.width, output.height)
    const data = frame.data
    const histogram = new Uint32Array(256)
    for (let i = 0; i < data.length; i += 4) histogram[data[i]] += 1

    const total = output.width * output.height
    let sum = 0
    for (let value = 0; value < 256; value += 1) sum += value * histogram[value]
    let sumBackground = 0
    let weightBackground = 0
    let bestVariance = -1
    let threshold = 150
    for (let value = 0; value < 256; value += 1) {
      weightBackground += histogram[value]
      if (!weightBackground) continue
      const weightForeground = total - weightBackground
      if (!weightForeground) break
      sumBackground += value * histogram[value]
      const meanBackground = sumBackground / weightBackground
      const meanForeground = (sum - sumBackground) / weightForeground
      const between = weightBackground * weightForeground * (meanBackground - meanForeground) ** 2
      if (between > bestVariance) {
        bestVariance = between
        threshold = value
      }
    }

    for (let i = 0; i < data.length; i += 4) {
      const value = data[i] <= threshold ? 0 : 255
      data[i] = value
      data[i + 1] = value
      data[i + 2] = value
      data[i + 3] = 255
    }
    ctx.putImageData(frame, 0, 0)
  }

  return output
}

async function recognizeText(
  worker: Awaited<ReturnType<typeof createWorker>>,
  image: HTMLCanvasElement,
  psm: PSM,
  whitelist: string
) {
  await worker.setParameters({
    tessedit_pageseg_mode: psm,
    tessedit_char_whitelist: whitelist,
    preserve_interword_spaces: '1',
    user_defined_dpi: '300'
  })
  const result = await worker.recognize(image, undefined, { text: true, blocks: false })
  return {
    text: result.data.text?.trim() ?? '',
    confidence: Number.isFinite(result.data.confidence) ? result.data.confidence : 0
  }
}

async function readNumberCell(
  worker: Awaited<ReturnType<typeof createWorker>>,
  source: HTMLCanvasElement,
  rect: { left: number; top: number; right: number; bottom: number }
): Promise<CellReading<number>> {
  const readings: CellReading<number>[] = []

  for (const variant of ['grey', 'binary'] as const) {
    const crop = cropCanvas(source, rect.left, rect.top, rect.right, rect.bottom, variant)
    const result = await recognizeText(worker, crop, PSM.SINGLE_WORD, '0123456789.,')
    readings.push({ value: parseNumber(result.text), confidence: result.confidence, text: result.text })
    if (readings[0].value !== null && readings[0].confidence >= 90) break
  }

  const valid = readings.filter((reading): reading is CellReading<number> & { value: number } => reading.value !== null)
  if (!valid.length) return { value: null, confidence: 0, text: readings.map((reading) => reading.text).join(' / ') }

  if (valid.length >= 2 && Math.abs(valid[0].value - valid[1].value) < 0.0005) {
    return { value: valid[0].value, confidence: Math.max(valid[0].confidence, valid[1].confidence, 92), text: valid.map((reading) => reading.text).join(' / ') }
  }

  return valid.sort((a, b) => b.confidence - a.confidence)[0]
}

async function readSpeedCell(
  worker: Awaited<ReturnType<typeof createWorker>>,
  source: HTMLCanvasElement,
  rect: { left: number; top: number; right: number; bottom: number }
) {
  const readings: { value: ReturnType<typeof parseSpeedOrTime>; confidence: number; text: string }[] = []
  const whitelist = '0123456789.,:ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz '

  for (const variant of ['grey', 'binary'] as const) {
    const crop = cropCanvas(source, rect.left, rect.top, rect.right, rect.bottom, variant)
    const result = await recognizeText(worker, crop, PSM.SINGLE_LINE, whitelist)
    readings.push({ value: parseSpeedOrTime(result.text), confidence: result.confidence, text: result.text })
    if (readings[0].value && readings[0].confidence >= 90) break
  }

  const valid = readings.filter((reading) => reading.value)
  if (!valid.length) return { value: null, confidence: 0, text: readings.map((reading) => reading.text).join(' / ') }

  if (valid.length >= 2) {
    const first = valid[0].value!
    const second = valid[1].value!
    const same = first.mode === second.mode &&
      Math.abs(first.speedKph - second.speedKph) < 0.001 &&
      first.durationSeconds === second.durationSeconds
    if (same) return { value: first, confidence: Math.max(valid[0].confidence, valid[1].confidence, 92), text: valid.map((reading) => reading.text).join(' / ') }
  }

  return valid.sort((a, b) => b.confidence - a.confidence)[0]
}

function rectForCell(geometry: HeaderGeometry, row: WorkingRow, field: 'from' | 'to' | 'value') {
  const verticalPad = Math.max(2, (row.bottom - row.top) * 0.12)
  const horizontalPad = Math.max(3, (geometry.endX - geometry.startX) * 0.035)
  const top = row.top + verticalPad
  const bottom = row.bottom - verticalPad

  if (field === 'from') return { left: geometry.startLeft + horizontalPad, top, right: geometry.boundary1 - horizontalPad, bottom }
  if (field === 'to') return { left: geometry.boundary1 + horizontalPad, top, right: geometry.boundary2 - horizontalPad, bottom }
  return { left: geometry.boundary2 + horizontalPad, top, right: geometry.speedRight - horizontalPad, bottom }
}

function rowFromWholePageWords(words: FlatWord[], geometry: HeaderGeometry, centerY: number, top: number, bottom: number, inserted: boolean): WorkingRow {
  const halfHeight = Math.max(8, (bottom - top) * 0.46)
  const fields = fieldWords(words, geometry, centerY, halfHeight)
  const from = readingFromWords(fields.from)
  const to = readingFromWords(fields.to)
  const speed = speedReadingFromWords(fields.value)
  const parsedSpeed = speed.value

  const confidences = [from.confidence, to.confidence, speed.confidence].filter((value) => value > 0)
  const averageConfidence = confidences.length ? confidences.reduce((sum, value) => sum + value, 0) / confidences.length : 0

  return {
    fromKm: from.value ?? Number.NaN,
    toKm: to.value ?? Number.NaN,
    mode: parsedSpeed?.mode ?? 'speed',
    speedKph: parsedSpeed?.speedKph ?? 0,
    durationSeconds: parsedSpeed?.durationSeconds ?? 0,
    confidence: inserted ? 'low' : confidenceLabel(averageConfidence),
    note: inserted ? 'Physical row recovered from chart spacing' : '',
    centerY,
    top,
    bottom,
    fromConfidence: from.confidence,
    toConfidence: to.confidence,
    valueConfidence: speed.confidence,
    inserted
  }
}

async function repairWorkingRow(
  worker: Awaited<ReturnType<typeof createWorker>>,
  canvas: HTMLCanvasElement,
  geometry: HeaderGeometry,
  row: WorkingRow,
  force = false
) {
  const needsFrom = force || !Number.isFinite(row.fromKm) || row.fromConfidence < 78
  const needsTo = force || !Number.isFinite(row.toKm) || row.toConfidence < 78
  const needsValue = force || !((isTimedMode(row.mode) && row.durationSeconds > 0) || (!isTimedMode(row.mode) && row.speedKph > 0)) || row.valueConfidence < 78

  if (needsFrom) {
    const reading = await readNumberCell(worker, canvas, rectForCell(geometry, row, 'from'))
    if (reading.value !== null) {
      row.fromKm = reading.value
      row.fromConfidence = reading.confidence
    }
  }
  if (needsTo) {
    const reading = await readNumberCell(worker, canvas, rectForCell(geometry, row, 'to'))
    if (reading.value !== null) {
      row.toKm = reading.value
      row.toConfidence = reading.confidence
    }
  }
  if (needsValue) {
    const reading = await readSpeedCell(worker, canvas, rectForCell(geometry, row, 'value'))
    if (reading.value) {
      row.mode = reading.value.mode
      row.speedKph = reading.value.speedKph
      row.durationSeconds = reading.value.durationSeconds
      row.valueConfidence = reading.confidence
    }
  }

  const validFrom = Number.isFinite(row.fromKm)
  const validTo = Number.isFinite(row.toKm)
  const validValue = isTimedMode(row.mode) ? row.durationSeconds > 0 : row.speedKph > 0
  const minimumConfidence = Math.min(
    validFrom ? row.fromConfidence : 0,
    validTo ? row.toConfidence : 0,
    validValue ? row.valueConfidence : 0
  )
  row.confidence = validFrom && validTo && validValue ? confidenceLabel(minimumConfidence) : 'low'
  if (!validFrom || !validTo || !validValue) row.note = 'One or more cells could not be read reliably'
  else if (row.confidence !== 'high') row.note = row.note || 'Targeted OCR: check highlighted row'
}

async function reconcileContinuity(
  rows: WorkingRow[],
  worker: Awaited<ReturnType<typeof createWorker>>,
  canvas: HTMLCanvasElement,
  geometry: HeaderGeometry,
  onProgress?: ProgressCallback
) {
  for (let index = 0; index < rows.length; index += 1) {
    const row = rows[index]
    if (index === 0 && Number.isFinite(row.fromKm) && Math.abs(row.fromKm) > 0.001 && row.fromConfidence < 86) {
      const reread = await readNumberCell(worker, canvas, rectForCell(geometry, row, 'from'))
      if (reread.value !== null) {
        row.fromKm = reread.value
        row.fromConfidence = reread.confidence
      }
    }

    if (index === 0) continue
    const previous = rows[index - 1]
    if (!Number.isFinite(previous.toKm) || !Number.isFinite(row.fromKm)) continue
    if (Math.abs(previous.toKm - row.fromKm) <= 0.001) continue

    // Mismatch may be a genuine bad source chart. Re-read both printed cells before
    // deciding. Only auto-reconcile when the second pass makes the duplicated value agree.
    onProgress?.(0.9 + (index / Math.max(1, rows.length)) * 0.05, `Cross-checking row ${index + 1}`)
    const previousReading = await readNumberCell(worker, canvas, rectForCell(geometry, previous, 'to'))
    const currentReading = await readNumberCell(worker, canvas, rectForCell(geometry, row, 'from'))

    if (previousReading.value !== null && currentReading.value !== null && Math.abs(previousReading.value - currentReading.value) <= 0.001) {
      previous.toKm = previousReading.value
      previous.toConfidence = Math.max(previous.toConfidence, previousReading.confidence)
      row.fromKm = currentReading.value
      row.fromConfidence = Math.max(row.fromConfidence, currentReading.confidence)
      continue
    }

    if (previousReading.value !== null && Math.abs(previousReading.value - row.fromKm) <= 0.001) {
      previous.toKm = previousReading.value
      previous.toConfidence = Math.max(previous.toConfidence, previousReading.confidence)
      continue
    }
    if (currentReading.value !== null && Math.abs(previous.toKm - currentReading.value) <= 0.001) {
      row.fromKm = currentReading.value
      row.fromConfidence = Math.max(row.fromConfidence, currentReading.confidence)
      continue
    }

    previous.confidence = 'low'
    row.confidence = 'low'
    previous.note = previous.note || 'END ODO does not match next START ODO'
    row.note = row.note || 'START ODO does not match previous END ODO'
  }
}

function rowsFromText(text: string): LocalOcrRow[] {
  const parsed: LocalOcrRow[] = []

  for (const rawLine of text.split(/\r?\n/)) {
    const line = cleanNumericText(rawLine)
    const numericTokens = line.match(/\d+(?:\.\d+)?/g)?.map(Number).filter(Number.isFinite) ?? []
    if (numericTokens.length < 3) continue

    const durationSeconds = parseDurationText(line)
    const minimumWithSerial = durationSeconds !== null ? 5 : 4
    let values = numericTokens
    if (numericTokens.length >= minimumWithSerial && Number.isInteger(numericTokens[0]) && numericTokens[0] >= 0 && numericTokens[0] <= 9999) {
      values = numericTokens.slice(1)
    }
    if (values.length < 3) continue

    const [fromKm, toKm, third] = values
    parsed.push({
      fromKm,
      toKm,
      mode: durationSeconds !== null ? 'time' : 'speed',
      speedKph: durationSeconds !== null ? 0 : normalizeSpeed(third),
      durationSeconds: durationSeconds ?? 0,
      confidence: 'low',
      note: 'Fallback OCR text: verify this row'
    })
  }

  return parsed
}

function dedupeAndAnnotate(rows: LocalOcrRow[]) {
  const unique: LocalOcrRow[] = []
  // Do not discard a row merely because END <= START. The source sheet itself may
  // contain an error and the review screen must expose it rather than hide it.
  for (const row of rows) {
    const duplicate = unique.some((candidate) =>
      Number.isFinite(candidate.fromKm) && Number.isFinite(row.fromKm) &&
      Number.isFinite(candidate.toKm) && Number.isFinite(row.toKm) &&
      Math.abs(candidate.fromKm - row.fromKm) < 0.001 &&
      Math.abs(candidate.toKm - row.toKm) < 0.001
    )
    if (!duplicate) unique.push({ ...row })
  }

  unique.forEach((row, index) => {
    if (!Number.isFinite(row.fromKm) || !Number.isFinite(row.toKm)) {
      row.confidence = 'low'
      row.note = row.note || 'START / END ODO needs check'
      return
    }

    if (row.toKm <= row.fromKm) {
      row.confidence = 'low'
      row.note = row.note || 'END ODO is not greater than START ODO'
    }

    if (index === 0) {
      if (Math.abs(row.fromKm) > 0.001) {
        row.confidence = 'low'
        row.note = row.note || 'First row does not start at 0.000 km'
      }
      return
    }

    const previous = unique[index - 1]
    if (Number.isFinite(previous.toKm) && Math.abs(previous.toKm - row.fromKm) > 0.001) {
      row.confidence = 'low'
      row.note = row.note || `Check continuity: previous END ${previous.toKm.toFixed(3)} → START ${row.fromKm.toFixed(3)}`
    }
  })

  return classifyTimedChartRows(unique)
}


type PdfTextPiece = { text: string; x: number; y: number }

function parseStructuredPdfLine(line: string): LocalOcrRow | null {
  const cleaned = line.replace(/\s+/g, ' ').trim()
  if (!cleaned) return null

  const withSerial = /^(\d{1,3})\s+(\d+(?:\.\d+)?)\s+(\d+(?:\.\d+)?)\s+(.+)$/.exec(cleaned)
  const withoutSerial = /^(\d+(?:\.\d+)?)\s+(\d+(?:\.\d+)?)\s+(.+)$/.exec(cleaned)

  let fromText: string
  let toText: string
  let valueText: string

  if (withSerial) {
    fromText = withSerial[2]
    toText = withSerial[3]
    valueText = withSerial[4]
  } else if (withoutSerial) {
    fromText = withoutSerial[1]
    toText = withoutSerial[2]
    valueText = withoutSerial[3]
  } else {
    return null
  }

  const fromKm = Number(fromText)
  const toKm = Number(toText)
  if (!Number.isFinite(fromKm) || !Number.isFinite(toKm)) return null

  const durationSeconds = parseDurationText(valueText)
  if (durationSeconds !== null) {
    return {
      fromKm,
      toKm,
      mode: 'time',
      speedKph: 0,
      durationSeconds,
      confidence: 'high',
      note: 'PDF text'
    }
  }

  const speed = parseNumber(valueText)
  if (speed === null) return null
  return {
    fromKm,
    toKm,
    mode: 'speed',
    speedKph: normalizeSpeed(speed),
    durationSeconds: 0,
    confidence: 'high',
    note: 'PDF text'
  }
}

function linesFromPdfTextItems(items: any[]) {
  const pieces: PdfTextPiece[] = items
    .filter((item) => typeof item?.str === 'string' && item.str.trim() && Array.isArray(item.transform))
    .map((item) => ({
      text: item.str.trim(),
      x: Number(item.transform[4]) || 0,
      y: Number(item.transform[5]) || 0
    }))

  const groups: { y: number; pieces: PdfTextPiece[] }[] = []
  for (const piece of pieces.sort((a, b) => b.y - a.y || a.x - b.x)) {
    let group = groups.find((candidate) => Math.abs(candidate.y - piece.y) <= 2.5)
    if (!group) {
      group = { y: piece.y, pieces: [] }
      groups.push(group)
    }
    group.pieces.push(piece)
  }

  return groups
    .sort((a, b) => b.y - a.y)
    .map((group) => group.pieces.sort((a, b) => a.x - b.x).map((piece) => piece.text).join(' '))
}

async function canvasToPngFile(canvas: HTMLCanvasElement, name: string) {
  const blob = await new Promise<Blob>((resolve, reject) => {
    canvas.toBlob((value) => value ? resolve(value) : reject(new Error('Could not render PDF page.')), 'image/png')
  })
  return new File([blob], name, { type: 'image/png' })
}

async function recognizeSpeedChartPdf(file: File, onProgress?: ProgressCallback): Promise<LocalOcrRow[]> {
  onProgress?.(0.02, 'PDF selected')
  const data = new Uint8Array(await file.arrayBuffer())
  const pdfDocument = await getDocument({ data }).promise
  const textRows: LocalOcrRow[] = []

  for (let pageNumber = 1; pageNumber <= pdfDocument.numPages; pageNumber += 1) {
    onProgress?.(0.04 + (pageNumber - 1) / Math.max(1, pdfDocument.numPages) * 0.42, `Reading PDF page ${pageNumber}`)
    const page = await pdfDocument.getPage(pageNumber)
    const content = await page.getTextContent()
    const lines = linesFromPdfTextItems(content.items as any[])
    for (const line of lines) {
      const row = parseStructuredPdfLine(line)
      if (row) textRows.push(row)
    }
  }

  if (textRows.length >= 2) {
    onProgress?.(0.96, `Parsed ${textRows.length} PDF rows`)
    const resolved = dedupeAndAnnotate(textRows)
    onProgress?.(1, 'Ready to review')
    return resolved
  }

  // Scanned PDFs may contain no usable text layer. Render each page and reuse
  // the same local OCR engine already used for photographs.
  const ocrRows: LocalOcrRow[] = []
  for (let pageNumber = 1; pageNumber <= pdfDocument.numPages; pageNumber += 1) {
    onProgress?.(0.08 + (pageNumber - 1) / Math.max(1, pdfDocument.numPages) * 0.82, `OCR PDF page ${pageNumber}`)
    const page = await pdfDocument.getPage(pageNumber)
    const viewport = page.getViewport({ scale: 2.4 })
    const canvas = document.createElement('canvas')
    canvas.width = Math.ceil(viewport.width)
    canvas.height = Math.ceil(viewport.height)
    const ctx = canvas.getContext('2d')
    if (!ctx) throw new Error('PDF rendering is not available on this device.')
    await page.render({ canvasContext: ctx, viewport } as any).promise
    const imageFile = await canvasToPngFile(canvas, `${file.name}-page-${pageNumber}.png`)
    try {
      const pageRows = await recognizeSpeedChartPhoto(imageFile, (progress, status) => {
        const pageBase = (pageNumber - 1) / Math.max(1, pdfDocument.numPages)
        const combined = 0.08 + (pageBase + progress / Math.max(1, pdfDocument.numPages)) * 0.82
        onProgress?.(combined, status)
      })
      ocrRows.push(...pageRows)
    } catch {
      // Rally PDFs often include blank continuation pages. A page with no usable
      // rows is not a document failure; keep scanning the remaining pages.
      onProgress?.(0.08 + pageNumber / Math.max(1, pdfDocument.numPages) * 0.82, `Skipped blank/unreadable PDF page ${pageNumber}`)
    }
  }

  const resolved = dedupeAndAnnotate(ocrRows)
  if (!resolved.length) throw new Error('No usable chart rows were found in the PDF.')
  onProgress?.(1, 'Ready to review')
  return resolved
}

async function recognizeSpeedChartPhoto(file: File, onProgress?: ProgressCallback): Promise<LocalOcrRow[]> {
  activeProgress = onProgress ?? null
  activeProgress?.(0.02, 'Photo selected')

  let worker: Awaited<ReturnType<typeof createWorker>> | null = null
  let rejectWorkerError: ((reason?: unknown) => void) | null = null
  const workerError = new Promise<never>((_, reject) => {
    rejectWorkerError = reject
  })

  activeWorkerError = (error) => {
    rejectWorkerError?.(new Error(`Local OCR engine error: ${errorText(error)}`))
  }

  try {
    activeProgress?.(0.04, 'Preparing image')
    const canvas = await prepareImage(file)

    setWorkerProgressPhase(0.08, 0.1)
    worker = await withTimeout(
      Promise.race([getWorker(), workerError]),
      30000,
      'Local OCR engine did not start within 30 seconds. Open the app once while online so the offline OCR assets can finish installing, then try again.'
    )

    await worker.setParameters({
      tessedit_pageseg_mode: PSM.SPARSE_TEXT,
      tessedit_char_whitelist: '',
      preserve_interword_spaces: '1',
      user_defined_dpi: '300'
    })

    setWorkerProgressPhase(0.18, 0.34)
    activeProgress?.(0.18, 'Mapping chart')
    const result = await withTimeout(
      Promise.race([
        worker.recognize(canvas, undefined, { text: true, blocks: true }),
        workerError
      ]),
      90000,
      'Photo recognition took longer than 90 seconds. Try a closer, sharper photo with the table filling most of the frame.'
    )

    const words = result.data.blocks ? flattenWords(result.data.blocks) : []
    let geometry = findHeaderGeometry(words)
    if (!geometry) geometry = inferGeometryFromNumericColumns(words, canvas)

    if (!geometry) {
      const fallback = dedupeAndAnnotate(rowsFromText(result.data.text ?? ''))
      if (fallback.length) {
        activeProgress?.(1, 'Ready to review')
        return fallback
      }
      throw new Error('Could not locate the START/FROM, END/TO and SPEED/KM columns. Retake the photo straight-on with the complete table filling most of the frame.')
    }

    activeProgress?.(0.54, 'Detecting printed table grid')
    const gridRows = detectGridRowBounds(canvas, geometry)
    const wordRows = gridRows ? null : estimateRowCenters(words, geometry, canvas)
    const centers = gridRows?.centers ?? wordRows?.centers ?? []
    const spacing = gridRows?.spacing ?? wordRows?.spacing ?? 0
    if (!centers.length || !(spacing > 0)) {
      const fallback = dedupeAndAnnotate(rowsFromText(result.data.text ?? ''))
      if (fallback.length) {
        activeProgress?.(1, 'Ready to review')
        return fallback
      }
      throw new Error('The table columns were found but the printed row pattern could not be resolved. Retake the photo closer and more square to the page.')
    }

    const rows: WorkingRow[] = centers.map((centerY, index) => {
      const top = gridRows
        ? gridRows.boundaries[index]
        : index === 0 ? centerY - spacing * 0.5 : (centers[index - 1] + centerY) / 2
      const bottom = gridRows
        ? gridRows.boundaries[index + 1]
        : index === centers.length - 1 ? centerY + spacing * 0.5 : (centerY + centers[index + 1]) / 2
      const nearestWordDistance = words
        .filter((word) => word.cx >= geometry!.startLeft && word.cx <= geometry!.speedRight)
        .reduce((best, word) => Math.min(best, Math.abs(word.cy - centerY)), Number.POSITIVE_INFINITY)
      const inserted = nearestWordDistance > spacing * 0.33
      return rowFromWholePageWords(words, geometry!, centerY, top, bottom, inserted)
    })

    activeProgress?.(0.58, `Checking ${rows.length} rows`)
    for (let index = 0; index < rows.length; index += 1) {
      const row = rows[index]
      const validFrom = Number.isFinite(row.fromKm)
      const validTo = Number.isFinite(row.toKm)
      const validValue = isTimedMode(row.mode) ? row.durationSeconds > 0 : row.speedKph > 0
      const weak = Math.min(row.fromConfidence || 0, row.toConfidence || 0, row.valueConfidence || 0) < 78
      if (!validFrom || !validTo || !validValue || weak || row.inserted) {
        setWorkerProgressPhase(0.58 + (index / Math.max(1, rows.length)) * 0.28, 0.008)
        activeProgress?.(0.58 + (index / Math.max(1, rows.length)) * 0.28, `Re-reading row ${index + 1} of ${rows.length}`)
        await repairWorkingRow(worker, canvas, geometry, row, row.inserted)
      } else {
        row.confidence = confidenceLabel(Math.min(row.fromConfidence, row.toConfidence, row.valueConfidence))
      }
    }

    await reconcileContinuity(rows, worker, canvas, geometry, onProgress)

    const resolved = dedupeAndAnnotate(rows.map((row) => ({
      fromKm: row.fromKm,
      toKm: row.toKm,
      mode: row.mode,
      speedKph: row.speedKph,
      durationSeconds: row.durationSeconds,
      confidence: row.confidence,
      note: row.note
    })))

    const usable = resolved.filter((row) => Number.isFinite(row.fromKm) || Number.isFinite(row.toKm) || row.speedKph > 0 || row.durationSeconds > 0)
    if (!usable.length) {
      throw new Error('No usable chart rows were found. Retake the photo closer, with the table filling most of the frame.')
    }

    activeProgress?.(1, 'Ready to review')
    return usable
  } catch (error) {
    workerPromise = null
    if (worker) {
      try {
        await worker.terminate()
      } catch {
        // A fresh worker will be created next time.
      }
    }
    throw error
  } finally {
    activeProgress = null
    activeWorkerError = null
  }
}

type ReviewRow = LocalOcrRow & {
  id: string
  source?: 'ocr' | 'pdf' | 'manual'
}

function sortReviewRows(rows: ReviewRow[]) {
  return [...rows].sort((a, b) => {
    const fromA = Number.isFinite(a.fromKm) ? a.fromKm : Number.POSITIVE_INFINITY
    const fromB = Number.isFinite(b.fromKm) ? b.fromKm : Number.POSITIVE_INFINITY
    if (Math.abs(fromA - fromB) > 0.000001) return fromA - fromB

    const toA = Number.isFinite(a.toKm) ? a.toKm : Number.POSITIVE_INFINITY
    const toB = Number.isFinite(b.toKm) ? b.toKm : Number.POSITIVE_INFINITY
    return toA - toB
  })
}

function rowIsComplete(row: ReviewRow) {
  if (!Number.isFinite(row.fromKm) || !Number.isFinite(row.toKm) || !(row.toKm > row.fromKm)) return false
  if (isTimedMode(row.mode)) return row.durationSeconds > 0
  return row.speedKph > 0
}

type Props = {
  onLoad: (sectors: SpeedSector[]) => void
}

function hardIssues(rows: ReviewRow[]): string[] {
  const issues: string[] = []
  if (!rows.length) return ['No chart entries were found.']

  // Always validate in ODO order. A manually added row may have been created at
  // the bottom of the list but belongs somewhere in the middle of the chart.
  const ordered = sortReviewRows(rows)

  ordered.forEach((row, index) => {
    const n = index + 1
    if (!Number.isFinite(row.fromKm) || !Number.isFinite(row.toKm) || row.toKm <= row.fromKm) {
      issues.push(`Row ${n}: check START / END ODO.`)
    }
    if ((row.mode === 'speed' || row.mode === 'zone_speed') && !(row.speedKph > 0)) {
      issues.push(`Row ${n}: check speed.`)
    }
    if (row.mode === 'time' && !(row.durationSeconds > 0)) {
      issues.push(`Row ${n}: check segment time.`)
    }
    if (row.mode === 'zone_time' && !(row.durationSeconds > 0)) {
      issues.push(`Row ${n}: check zone time.`)
    }
    if (index > 0) {
      const previous = ordered[index - 1]
      if (Math.abs(previous.toKm - row.fromKm) > 0.001) {
        issues.push(`Rows ${index}–${n}: gap/overlap ${previous.toKm.toFixed(3)} → ${row.fromKm.toFixed(3)}.`)
      }
    }
  })

  if (Math.abs(ordered[0].fromKm) > 0.001) issues.push('First entry does not start at 0.000 km.')
  return issues
}

function toSectors(rows: ReviewRow[]): SpeedSector[] {
  return sortReviewRows(rows).map((row) => {
    if (row.mode === 'speed') {
      return {
        id: crypto.randomUUID(),
        fromKm: row.fromKm,
        toKm: row.toKm,
        speedKph: row.speedKph,
        kind: 'speed'
      }
    }

    if (row.mode === 'time') {
      return {
        id: crypto.randomUUID(),
        fromKm: row.fromKm,
        toKm: row.toKm,
        speedKph: derivedSpeedKph(row.fromKm, row.toKm, row.durationSeconds),
        kind: 'speed',
        sourceBasis: 'time',
        sourceDurationSeconds: row.durationSeconds
      }
    }

    if (row.mode === 'zone_time') {
      return {
        id: crypto.randomUUID(),
        fromKm: row.fromKm,
        toKm: row.toKm,
        speedKph: 0,
        kind: 'zone',
        zoneType: 'FZ',
        zoneBasis: 'time',
        zoneDurationSeconds: row.durationSeconds
      }
    }

    return {
      id: crypto.randomUUID(),
      fromKm: row.fromKm,
      toKm: row.toKm,
      speedKph: row.speedKph,
      kind: 'zone',
      zoneType: 'FZ',
      zoneBasis: 'speed'
    }
  })
}

function progressText(status: string, progress: number) {
  if (!status) return `LOCAL OCR ${Math.round(progress * 100)}%`
  return `${status.toUpperCase()} ${Math.round(progress * 100)}%`
}

export default function SpeedChartImporter({ onLoad }: Props) {
  const inputRef = useRef<HTMLInputElement | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [fileName, setFileName] = useState('')
  const [rows, setRows] = useState<ReviewRow[] | null>(null)
  const [progress, setProgress] = useState(0)
  const [status, setStatus] = useState('')

  const issues = useMemo(() => rows ? hardIssues(rows) : [], [rows])
  const needsCheckCount = rows?.filter((row) => row.confidence !== 'high').length ?? 0
  const reviewReady = Boolean(rows && issues.length === 0 && needsCheckCount === 0)

  const scan = async (file: File) => {
    const isPdf = file.type === 'application/pdf' || file.name.toLowerCase().endsWith('.pdf')
    setBusy(true)
    setError(null)
    setRows(null)
    setFileName(file.name)
    setProgress(0)
    setStatus(isPdf ? 'PDF selected' : 'Photo selected')

    try {
      const parsed = isPdf
        ? await recognizeSpeedChartPdf(file, (nextProgress, nextStatus) => {
            setProgress(nextProgress)
            setStatus(nextStatus)
          })
        : await recognizeSpeedChartPhoto(file, (nextProgress, nextStatus) => {
            setProgress(nextProgress)
            setStatus(nextStatus)
          })

      setRows(parsed.map((row) => ({
        ...row,
        id: crypto.randomUUID(),
        source: isPdf ? 'pdf' as const : 'ocr' as const
      })))
    } catch (scanError) {
      const message = scanError instanceof Error ? scanError.message : 'Could not interpret the speed chart.'
      setStatus('Import failed')
      setProgress(0)
      setError(message)
    } finally {
      setBusy(false)
    }
  }

  const update = (id: string, patch: Partial<ReviewRow>) => {
    setRows((current) => current?.map((row) => row.id === id ? { ...row, ...patch } : row) ?? null)
  }

  const settleRow = (id: string) => {
    setRows((current) => {
      if (!current) return null
      const row = current.find((item) => item.id === id)
      if (!row || !rowIsComplete(row)) return current

      // Once a row has usable START/END/value data, place it automatically in
      // the chart according to START ODO. This also makes continuity validation
      // recalculate against its real neighbours immediately.
      return sortReviewRows(current)
    })
  }

  const remove = (id: string) => {
    setRows((current) => current?.filter((row) => row.id !== id) ?? null)
  }

  const addRow = () => {
    setRows((current) => {
      const list = current ?? []
      const from = list[list.length - 1]?.toKm ?? 0
      return [...list, {
        id: crypto.randomUUID(),
        fromKm: from,
        toKm: from,
        mode: 'speed',
        speedKph: 0,
        durationSeconds: 0,
        confidence: 'high',
        note: 'Manual row',
        source: 'manual'
      }]
    })
  }

  return (
    <div className="ocr-importer">
      <input
        ref={inputRef}
        type="file"
        accept="image/*,application/pdf"
        style={{ display: 'none' }}
        onChange={(event) => {
          const file = event.target.files?.[0]
          event.target.value = ''
          if (file) void scan(file)
        }}
      />

      <div className="ocr-import-head">
        <div>
          <strong>LOCAL CHART IMPORT</strong>
          <span>Import a photo, image or PDF. Digital PDFs use their text layer first; scanned pages fall back to local OCR.</span>
        </div>
        <button className="small-button" disabled={busy} onClick={() => inputRef.current?.click()}>
          {busy ? 'READING…' : 'IMPORT CHART'}
        </button>
      </div>

      <div className="ocr-import-note">
        No API key or per-scan charge. Image OCR and PDF parsing run locally and remain available in flight mode after installation.
      </div>

      {fileName && <div className="ocr-file-name">{fileName}</div>}

      {busy && (
        <div className="ocr-progress-wrap">
          <div className="ocr-progress-track">
            <div className="ocr-progress-fill" style={{ width: `${Math.max(3, Math.round(progress * 100))}%` }} />
          </div>
          <div className="ocr-progress-text">{progressText(status, progress)}</div>
        </div>
      )}

      {error && <div className="error-box ocr-error">{error}</div>}

      {rows && (
        <div className="ocr-review">
          <div className={`ocr-review-summary ${reviewReady ? 'ready' : 'attention'}`}>
            <strong>{rows.length} ENTRIES</strong>
            <span className={reviewReady ? 'ready' : 'needs-check'}>
              {issues.length > 0 ? `${issues.length} ISSUE${issues.length === 1 ? '' : 'S'}` : needsCheckCount ? `${needsCheckCount} CHECK${needsCheckCount === 1 ? '' : 'S'}` : 'READY TO LOAD'}
            </span>
          </div>

          <div className="ocr-table-wrap">
            <div className="ocr-table-head" aria-hidden="true">
              <span>#</span>
              <span>FROM</span>
              <span>TO</span>
              <span>SPEED / TIME</span>
              <span>TYPE</span>
              <span />
            </div>

            <div className="ocr-table-body">
              {rows.map((row, index) => {
                const minutes = Math.floor(Math.max(0, row.durationSeconds) / 60)
                const seconds = Math.max(0, row.durationSeconds) % 60
                const needsCheck = row.confidence !== 'high'
                const previous = index > 0 ? rows[index - 1] : null
                const fromIssue = !Number.isFinite(row.fromKm) ||
                  (index === 0 ? Math.abs(row.fromKm) > 0.001 : Boolean(previous && Math.abs(previous.toKm - row.fromKm) > 0.001))
                const toIssue = !Number.isFinite(row.toKm) || !(row.toKm > row.fromKm)
                const valueIssue = isTimedMode(row.mode) ? !(row.durationSeconds > 0) : !(row.speedKph > 0)

                return (
                  <div
                    key={row.id}
                    className={`ocr-review-row ${needsCheck ? 'needs-check' : ''} ${row.mode === 'time' ? 'time-row' : row.mode !== 'speed' ? 'zone-row' : ''}`}
                    title={needsCheck ? (row.note || 'Check against the sheet') : undefined}
                  >
                    <div className="ocr-row-number">
                      <strong>{String(index + 1).padStart(2, '0')}</strong>
                      {needsCheck && <span>CHECK</span>}
                    </div>

                    <input
                      aria-label={`Row ${index + 1} start ODO`}
                      className={fromIssue ? 'ocr-cell-issue' : undefined}
                      inputMode="decimal"
                      type="number"
                      step="0.001"
                      value={row.fromKm}
                      onChange={(e) => update(row.id, { fromKm: Number(e.target.value), confidence: 'high', note: row.source === 'manual' ? 'Manual row' : '' })}
                      onBlur={() => settleRow(row.id)}
                    />

                    <input
                      aria-label={`Row ${index + 1} end ODO`}
                      className={toIssue ? 'ocr-cell-issue' : undefined}
                      inputMode="decimal"
                      type="number"
                      step="0.001"
                      value={row.toKm}
                      onChange={(e) => update(row.id, { toKm: Number(e.target.value), confidence: 'high', note: row.source === 'manual' ? 'Manual row' : '' })}
                      onBlur={() => settleRow(row.id)}
                    />

                    {isTimedMode(row.mode) ? (
                      <div className={`ocr-time-value ${valueIssue ? 'ocr-cell-issue-group' : ''}`} aria-label={`Row ${index + 1} ${row.mode === 'time' ? 'segment time' : 'zone time'}`}>
                        <input
                          aria-label={`Row ${index + 1} minutes`}
                          type="number"
                          min="0"
                          step="1"
                          value={minutes}
                          onChange={(e) => update(row.id, {
                            durationSeconds: Math.max(0, Number(e.target.value)) * 60 + seconds,
                            confidence: 'high',
                            note: row.source === 'manual' ? 'Manual row' : ''
                          })}
                          onBlur={() => settleRow(row.id)}
                        />
                        <span>:</span>
                        <input
                          aria-label={`Row ${index + 1} seconds`}
                          type="number"
                          min="0"
                          max="59"
                          step="1"
                          value={seconds}
                          onChange={(e) => update(row.id, {
                            durationSeconds: minutes * 60 + Math.max(0, Math.min(59, Number(e.target.value))),
                            confidence: 'high',
                            note: row.source === 'manual' ? 'Manual row' : ''
                          })}
                          onBlur={() => settleRow(row.id)}
                        />
                        {row.mode === 'time' && row.durationSeconds > 0 && (
                          <small className="ocr-derived-speed">{derivedSpeedKph(row.fromKm, row.toKm, row.durationSeconds).toFixed(2)} km/h</small>
                        )}
                      </div>
                    ) : (
                      <input
                        aria-label={`Row ${index + 1} ${row.mode === 'speed' ? 'average speed' : 'zone speed'}`}
                        className={valueIssue ? 'ocr-cell-issue' : undefined}
                        inputMode="decimal"
                        type="number"
                        step="0.1"
                        value={row.speedKph}
                        onChange={(e) => update(row.id, { speedKph: Number(e.target.value), confidence: 'high', note: row.source === 'manual' ? 'Manual row' : '' })}
                        onBlur={() => settleRow(row.id)}
                      />
                    )}

                    <select
                      aria-label={`Row ${index + 1} type`}
                      value={row.mode}
                      onChange={(e) => {
                        update(row.id, { mode: e.target.value as LocalOcrMode, confidence: 'high', note: row.source === 'manual' ? 'Manual row' : '' })
                        window.requestAnimationFrame(() => settleRow(row.id))
                      }}
                    >
                      <option value="speed">SPEED</option>
                      <option value="time">TIME</option>
                      <option value="zone_speed">DZ/FZ SPD</option>
                      <option value="zone_time">DZ/FZ TIME</option>
                    </select>

                    <button className="ocr-remove-button" aria-label={`Remove row ${index + 1}`} onClick={() => remove(row.id)}>×</button>
                  </div>
                )
              })}
            </div>
          </div>

          <button className="secondary-button full-button ocr-add-row" onClick={addRow}>+ ROW</button>
          <div className="ocr-import-note ocr-manual-hint">
            Manual rows move automatically into ODO order once START, END and SPEED/TIME are complete. TIME rows keep the prescribed MM:SS and derive the live target speed automatically.
          </div>

          {issues.length > 0 && (
            <div className="error-box ocr-issues">
              {issues.map((issue) => <div key={issue}>{issue}</div>)}
            </div>
          )}

          <div className="launch-row ocr-review-actions">
            <button
              className="primary-button"
              disabled={issues.length > 0}
              onClick={() => {
                onLoad(toSectors(rows))
                setRows(null)
                setFileName('')
              }}
            >
              CONFIRM & LOAD
            </button>
            <button className="secondary-button" onClick={() => { setRows(null); setFileName('') }}>CANCEL</button>
          </div>
        </div>
      )}
    </div>
  )
}
