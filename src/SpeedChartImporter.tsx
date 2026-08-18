import { useMemo, useRef, useState } from 'react'
import { createWorker, OEM, PSM } from 'tesseract.js'
import type { SpeedSector } from './types'

type LocalOcrMode = 'speed' | 'zone_speed' | 'zone_time'

type LocalOcrRow = {
  fromKm: number
  toKm: number
  mode: LocalOcrMode
  speedKph: number
  durationSeconds: number
  confidence: 'high' | 'medium' | 'low'
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

let activeProgress: ProgressCallback | null = null
let workerPromise: ReturnType<typeof createWorker> | null = null

function getWorker() {
  if (!workerPromise) {
    workerPromise = createWorker('eng', OEM.LSTM_ONLY, {
      logger: (message) => {
        const progress = typeof message.progress === 'number' ? message.progress : 0
        activeProgress?.(progress, message.status || 'Preparing OCR')
      }
    }).then(async (worker) => {
      await worker.setParameters({
        tessedit_pageseg_mode: PSM.SPARSE_TEXT,
        preserve_interword_spaces: '1',
        user_defined_dpi: '300'
      })
      return worker
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
 * Prepare a phone photograph for OCR without sending it anywhere.
 * The image is upscaled when needed, converted to greyscale and contrast-stretched.
 * Keeping greyscale rather than hard thresholding is friendlier to uneven phone lighting.
 */
async function prepareImage(file: File): Promise<HTMLCanvasElement> {
  const image = await loadImage(file)
  const targetWidth = Math.max(1400, Math.min(1900, image.naturalWidth))
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

  // Ignore extreme shadows/highlights and stretch the useful paper/text range.
  const low = percentile(0.04)
  const high = Math.max(low + 35, percentile(0.96))
  const range = Math.max(1, high - low)

  for (let i = 0; i < pixels.length; i += 4) {
    const grey = Math.round(0.299 * pixels[i] + 0.587 * pixels[i + 1] + 0.114 * pixels[i + 2])
    const stretched = Math.max(0, Math.min(255, Math.round(((grey - low) * 255) / range)))
    // Slightly brighten paper while keeping printed strokes dark.
    const adjusted = Math.max(0, Math.min(255, Math.round(255 * Math.pow(stretched / 255, 0.92))))
    pixels[i] = adjusted
    pixels[i + 1] = adjusted
    pixels[i + 2] = adjusted
    pixels[i + 3] = 255
  }

  ctx.putImageData(frame, 0, 0)
  return canvas
}

function lettersOnly(value: string) {
  return value.toUpperCase().replace(/[^A-Z]/g, '')
}

function wordLooksLike(value: string, target: 'START' | 'END' | 'SPEED') {
  const word = lettersOnly(value)
  if (!word) return false
  if (target === 'START') return word.startsWith('STAR') || word === 'STRT'
  if (target === 'END') return word === 'END' || word.startsWith('ENO') || word === 'EN0'
  return word.startsWith('SPE') || word.startsWith('SPD')
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

  // A cell should contain one value. If grid noise creates extras, the longest numeric token
  // is usually the printed ODO/speed rather than a stray mark.
  const token = [...matches].sort((a, b) => b.length - a.length)[0]
  const number = Number(token)
  return Number.isFinite(number) ? number : null
}

function parseSpeedOrTime(value: string) {
  const upper = cleanNumericText(value)
  const number = parseNumber(upper)
  if (number === null) return null

  const isTime = /MIN|M1N|MINS|MINUTE/.test(upper)
  if (isTime) {
    return {
      mode: 'zone_time' as const,
      speedKph: 0,
      durationSeconds: Math.max(0, Math.round(number * 60))
    }
  }

  return {
    mode: 'speed' as const,
    speedKph: number,
    durationSeconds: 0
  }
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

function findHeader(words: FlatWord[]) {
  const candidates = words.filter((word) => /[A-Za-z]/.test(word.text))

  for (const start of candidates.filter((word) => wordLooksLike(word.text, 'START'))) {
    const nearby = candidates.filter((word) => Math.abs(word.cy - start.cy) < Math.max(35, start.height * 2.2))
    const end = nearby.find((word) => wordLooksLike(word.text, 'END'))
    const speed = nearby.find((word) => wordLooksLike(word.text, 'SPEED'))
    if (end && speed && start.cx < end.cx && end.cx < speed.cx) {
      return { startX: start.cx, endX: end.cx, speedX: speed.cx, y: Math.max(start.cy, end.cy, speed.cy) }
    }
  }

  const start = candidates.find((word) => wordLooksLike(word.text, 'START'))
  const end = candidates.find((word) => wordLooksLike(word.text, 'END'))
  const speed = candidates.find((word) => wordLooksLike(word.text, 'SPEED'))
  if (start && end && speed && start.cx < end.cx && end.cx < speed.cx) {
    return { startX: start.cx, endX: end.cx, speedX: speed.cx, y: Math.max(start.cy, end.cy, speed.cy) }
  }

  return null
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

function confidenceLabel(value: number): LocalOcrRow['confidence'] {
  if (value >= 82) return 'high'
  if (value >= 58) return 'medium'
  return 'low'
}

function rowsFromColumns(words: FlatWord[]): LocalOcrRow[] {
  const header = findHeader(words)
  if (!header) return []

  const typicalHeight = Math.max(10, median(words.map((word) => word.height).filter((value) => value > 3)))
  const startGap = header.endX - header.startX
  const endGap = header.speedX - header.endX
  // Numeric values in these printed tables are usually right-aligned inside each cell,
  // so the useful column boundaries sit to the right of the header-word centres.
  const startMinX = header.startX - startGap * 0.25
  const speedMaxX = header.speedX + endGap * 0.55
  const boundary1 = header.startX + startGap * 0.68
  const boundary2 = header.endX + endGap * 0.68

  const dataWords = words.filter((word) =>
    word.cy > header.y + typicalHeight * 0.25 &&
    word.cx >= startMinX &&
    word.cx <= speedMaxX
  )

  const clusters = clusterRows(dataWords, Math.max(12, typicalHeight * 1.15))
  const parsed: LocalOcrRow[] = []

  for (const cluster of clusters) {
    const startWords = cluster.words.filter((word) => word.cx < boundary1)
    const endWords = cluster.words.filter((word) => word.cx >= boundary1 && word.cx < boundary2)
    const speedWords = cluster.words.filter((word) => word.cx >= boundary2)

    const fromKm = parseNumber(startWords.map((word) => word.text).join(' '))
    const toKm = parseNumber(endWords.map((word) => word.text).join(' '))
    const speedOrTime = parseSpeedOrTime(speedWords.map((word) => word.text).join(' '))

    if (fromKm === null || toKm === null || !speedOrTime || !(toKm > fromKm)) continue

    const used = [...startWords, ...endWords, ...speedWords]
    const averageConfidence = used.length
      ? used.reduce((sum, word) => sum + word.confidence, 0) / used.length
      : 0

    parsed.push({
      fromKm,
      toKm,
      ...speedOrTime,
      confidence: confidenceLabel(averageConfidence),
      note: averageConfidence < 82 ? 'OCR confidence: check against the sheet' : ''
    })
  }

  return parsed
}

function rowsFromText(text: string): LocalOcrRow[] {
  const parsed: LocalOcrRow[] = []

  for (const rawLine of text.split(/\r?\n/)) {
    const line = cleanNumericText(rawLine)
    const numericTokens = line.match(/\d+(?:\.\d+)?/g)?.map(Number).filter(Number.isFinite) ?? []
    if (numericTokens.length < 3) continue

    let values = numericTokens
    // Typical printed line is SNO + START + END + SPEED/TIME. Drop SNO when present.
    if (numericTokens.length >= 4 && Number.isInteger(numericTokens[0]) && numericTokens[0] >= 0 && numericTokens[0] <= 99) {
      values = numericTokens.slice(1)
    }
    if (values.length < 3) continue

    const [fromKm, toKm, third] = values
    if (!(toKm > fromKm) || !(third > 0)) continue

    const isTime = /MIN|M1N|MINS|MINUTE/.test(line)
    parsed.push({
      fromKm,
      toKm,
      mode: isTime ? 'zone_time' : 'speed',
      speedKph: isTime ? 0 : third,
      durationSeconds: isTime ? Math.round(third * 60) : 0,
      confidence: 'low',
      note: 'Recovered from OCR text: verify this row'
    })
  }

  return parsed
}

function dedupeAndAnnotate(rows: LocalOcrRow[]) {
  const unique: LocalOcrRow[] = []
  const sorted = [...rows].sort((a, b) => a.fromKm - b.fromKm || a.toKm - b.toKm)

  for (const row of sorted) {
    const duplicate = unique.some((candidate) =>
      Math.abs(candidate.fromKm - row.fromKm) < 0.001 &&
      Math.abs(candidate.toKm - row.toKm) < 0.001
    )
    if (!duplicate) unique.push({ ...row })
  }

  unique.forEach((row, index) => {
    if (index === 0) {
      if (Math.abs(row.fromKm) > 0.001) {
        row.confidence = 'low'
        row.note = row.note || 'First row does not start at 0.000 km'
      }
      return
    }

    const previous = unique[index - 1]
    const gap = Math.abs(previous.toKm - row.fromKm)
    if (gap > 0.001) {
      row.confidence = 'low'
      row.note = `Check continuity: previous END ${previous.toKm.toFixed(3)} → START ${row.fromKm.toFixed(3)}`
    }
  })

  return unique
}

async function recognizeSpeedChartPhoto(file: File, onProgress?: ProgressCallback): Promise<LocalOcrRow[]> {
  activeProgress = onProgress ?? null
  activeProgress?.(0.02, 'Preparing image')

  try {
    const canvas = await prepareImage(file)
    activeProgress?.(0.08, 'Loading local OCR')
    const worker = await getWorker()

    const result = await worker.recognize(
      canvas,
      { rotateAuto: true },
      { text: true, blocks: true }
    )

    activeProgress?.(0.96, 'Reading chart rows')
    const words = result.data.blocks ? flattenWords(result.data.blocks) : []
    const structured = rowsFromColumns(words)
    const fallback = structured.length >= 2 ? [] : rowsFromText(result.data.text ?? '')
    const rows = dedupeAndAnnotate(structured.length >= 2 ? structured : fallback)

    if (!rows.length) {
      throw new Error('No usable chart rows were found. Retake the photo closer, with the table filling most of the frame.')
    }

    activeProgress?.(1, 'Ready to review')
    return rows
  } finally {
    activeProgress = null
  }
}


type ReviewRow = LocalOcrRow & { id: string }

type Props = {
  onLoad: (sectors: SpeedSector[]) => void
}

function hardIssues(rows: ReviewRow[]): string[] {
  const issues: string[] = []
  if (!rows.length) return ['No chart entries were found.']

  rows.forEach((row, index) => {
    const n = index + 1
    if (!Number.isFinite(row.fromKm) || !Number.isFinite(row.toKm) || row.toKm <= row.fromKm) {
      issues.push(`Row ${n}: check START / END ODO.`)
    }
    if ((row.mode === 'speed' || row.mode === 'zone_speed') && !(row.speedKph > 0)) {
      issues.push(`Row ${n}: check speed.`)
    }
    if (row.mode === 'zone_time' && !(row.durationSeconds > 0)) {
      issues.push(`Row ${n}: check zone time.`)
    }
    if (index > 0) {
      const previous = rows[index - 1]
      if (Math.abs(previous.toKm - row.fromKm) > 0.001) {
        issues.push(`Rows ${index}–${n}: gap/overlap ${previous.toKm.toFixed(3)} → ${row.fromKm.toFixed(3)}.`)
      }
    }
  })

  if (Math.abs(rows[0].fromKm) > 0.001) issues.push('First entry does not start at 0.000 km.')
  return issues
}

function toSectors(rows: ReviewRow[]): SpeedSector[] {
  return rows.map((row) => {
    if (row.mode === 'speed') {
      return {
        id: crypto.randomUUID(),
        fromKm: row.fromKm,
        toKm: row.toKm,
        speedKph: row.speedKph,
        kind: 'speed'
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

  const scan = async (file: File) => {
    setBusy(true)
    setError(null)
    setRows(null)
    setFileName(file.name)
    setProgress(0)
    setStatus('Preparing image')

    try {
      const parsed = await recognizeSpeedChartPhoto(file, (nextProgress, nextStatus) => {
        setProgress(nextProgress)
        setStatus(nextStatus)
      })

      setRows(parsed.map((row) => ({ ...row, id: crypto.randomUUID() })))
    } catch (scanError) {
      setError(scanError instanceof Error ? scanError.message : 'Could not interpret the speed chart.')
    } finally {
      setBusy(false)
    }
  }

  const update = (id: string, patch: Partial<ReviewRow>) => {
    setRows((current) => current?.map((row) => row.id === id ? { ...row, ...patch } : row) ?? null)
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
        note: 'Manual row'
      }]
    })
  }

  return (
    <div className="ocr-importer">
      <input
        ref={inputRef}
        type="file"
        accept="image/jpeg,image/png,image/webp"
        style={{ display: 'none' }}
        onChange={(event) => {
          const file = event.target.files?.[0]
          event.target.value = ''
          if (file) void scan(file)
        }}
      />

      <div className="ocr-import-head">
        <div>
          <strong>LOCAL PHOTO IMPORT</strong>
          <span>Fill the photo with the table. OCR runs on this phone; always review before loading.</span>
        </div>
        <button className="small-button" disabled={busy} onClick={() => inputRef.current?.click()}>
          {busy ? 'READING…' : 'UPLOAD PHOTO'}
        </button>
      </div>

      <div className="ocr-import-note">
        No API key or per-scan charge. The first OCR use may need data once to initialise the local engine.
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
          <div className="ocr-review-summary">
            <strong>{rows.length} ENTRIES FOUND</strong>
            <span className={needsCheckCount ? 'needs-check' : ''}>
              {needsCheckCount ? `${needsCheckCount} NEED CHECK` : 'REVIEW BEFORE LOADING'}
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

                return (
                  <div
                    key={row.id}
                    className={`ocr-review-row ${needsCheck ? 'needs-check' : ''} ${row.mode !== 'speed' ? 'zone-row' : ''}`}
                    title={needsCheck ? (row.note || 'Check against the sheet') : undefined}
                  >
                    <div className="ocr-row-number">
                      <strong>{String(index + 1).padStart(2, '0')}</strong>
                      {needsCheck && <span>CHECK</span>}
                    </div>

                    <input
                      aria-label={`Row ${index + 1} start ODO`}
                      inputMode="decimal"
                      type="number"
                      step="0.001"
                      value={row.fromKm}
                      onChange={(e) => update(row.id, { fromKm: Number(e.target.value), confidence: 'high' })}
                    />

                    <input
                      aria-label={`Row ${index + 1} end ODO`}
                      inputMode="decimal"
                      type="number"
                      step="0.001"
                      value={row.toKm}
                      onChange={(e) => update(row.id, { toKm: Number(e.target.value), confidence: 'high' })}
                    />

                    {row.mode === 'zone_time' ? (
                      <div className="ocr-time-value" aria-label={`Row ${index + 1} zone time`}>
                        <input
                          aria-label={`Row ${index + 1} minutes`}
                          type="number"
                          min="0"
                          step="1"
                          value={minutes}
                          onChange={(e) => update(row.id, {
                            durationSeconds: Math.max(0, Number(e.target.value)) * 60 + seconds,
                            confidence: 'high'
                          })}
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
                            confidence: 'high'
                          })}
                        />
                      </div>
                    ) : (
                      <input
                        aria-label={`Row ${index + 1} ${row.mode === 'speed' ? 'average speed' : 'zone speed'}`}
                        inputMode="decimal"
                        type="number"
                        step="0.1"
                        value={row.speedKph}
                        onChange={(e) => update(row.id, { speedKph: Number(e.target.value), confidence: 'high' })}
                      />
                    )}

                    <select
                      aria-label={`Row ${index + 1} type`}
                      value={row.mode}
                      onChange={(e) => update(row.id, { mode: e.target.value as LocalOcrMode, confidence: 'high' })}
                    >
                      <option value="speed">SPEED</option>
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
