import assert from 'node:assert/strict'
import type { SpeedSector } from '../src/types.ts'
import { validateSectors, validateSectorWarnings } from '../src/lib/tsd.ts'

const normal: SpeedSector[] = [
  { id: 'a', fromKm: 0, toKm: 5, speedKph: 30 },
  { id: 'b', fromKm: 5, toKm: 10, speedKph: 45 }
]
assert.deepEqual(validateSectors(normal), [])
assert.deepEqual(validateSectorWarnings(normal), [])

const highDerivedSpeed: SpeedSector[] = [
  { id: 'fast', fromKm: 0, toKm: 0.2, speedKph: 360, sourceBasis: 'time', sourceDurationSeconds: 2 }
]
assert.deepEqual(validateSectors(highDerivedSpeed), [])
assert.ok(validateSectorWarnings(highDerivedSpeed).some((message) => message.includes('unusually high')))
assert.ok(validateSectorWarnings(highDerivedSpeed).some((message) => message.includes('unusually short')))

// Long organiser-prescribed times remain valid but are surfaced as warnings, not silently changed.
const longTime: SpeedSector[] = [
  { id: 'long', fromKm: 0, toKm: 0.5, speedKph: 1.5, sourceBasis: 'time', sourceDurationSeconds: 20 * 60 }
]
assert.deepEqual(validateSectors(longTime), [])
const longWarnings = validateSectorWarnings(longTime)
assert.ok(longWarnings.some((message) => message.includes('unusually long')))
assert.ok(longWarnings.some((message) => message.includes('unusually low')))

const brokenContinuity: SpeedSector[] = [
  { id: 'a', fromKm: 0, toKm: 5, speedKph: 30 },
  { id: 'b', fromKm: 5.2, toKm: 10, speedKph: 40 }
]
assert.ok(validateSectors(brokenContinuity).some((message) => message.includes('Gap/overlap')))

console.log('Chart validation warning self-test: PASS')
