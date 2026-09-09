import assert from 'node:assert/strict'
import type { SpeedSector } from '../src/types.ts'
import {
  deviationSeconds,
  effectiveSpeedKph,
  idealElapsedSecondsAtDistance,
  idealElapsedSecondsFromAnchor,
  idealTravelSecondsBetween,
  nextSpeedChange,
  targetSpeedAtDistance,
  validateSectors
} from '../src/lib/tsd.ts'

const sectors: SpeedSector[] = [
  { id: 'a', fromKm: 0, toKm: 4.8, speedKph: 36 },
  { id: 'b', fromKm: 4.8, toKm: 12.35, speedKph: 42 },
  { id: 'c', fromKm: 12.35, toKm: 18.6, speedKph: 38 }
]

assert.deepEqual(validateSectors(sectors), [])
assert.equal(idealElapsedSecondsAtDistance(3.6, sectors), 360)
assert.ok(Math.abs(idealElapsedSecondsAtDistance(4.8, sectors) - 480) < 1e-9)
assert.ok(Math.abs(idealElapsedSecondsAtDistance(7.8, sectors) - (480 + (3 / 42) * 3600)) < 1e-9)
assert.equal(targetSpeedAtDistance(4.799, sectors), 36)
assert.equal(targetSpeedAtDistance(4.8, sectors), 42)
assert.equal(targetSpeedAtDistance(13, sectors), 38)
assert.deepEqual(nextSpeedChange(4.5, sectors), {
  distanceKm: 0.2999999999999998,
  nextSpeedKph: 42,
  nextKind: 'speed',
  nextZoneType: null,
  nextZoneBasis: null,
  nextZoneDurationSeconds: null
})
assert.ok(Math.abs(deviationSeconds(487, 480) - 7) < 1e-9)

// A TC may occur anywhere, not at a speed-sector boundary.
const tcDistance = 6.25
const tcActualElapsed = 612
const scratchSeconds = 60
const anchorIdeal = tcActualElapsed + scratchSeconds
assert.equal(idealElapsedSecondsFromAnchor(tcDistance, sectors, tcDistance, anchorIdeal), 672)
assert.equal(deviationSeconds(tcActualElapsed, anchorIdeal), -60)
assert.equal(deviationSeconds(tcActualElapsed + scratchSeconds, anchorIdeal), 0)

const laterDistance = 7.25
const travelAfterTc = idealTravelSecondsBetween(tcDistance, laterDistance, sectors)
const laterIdeal = idealElapsedSecondsFromAnchor(laterDistance, sectors, tcDistance, anchorIdeal)
assert.ok(Math.abs(laterIdeal - (anchorIdeal + travelAfterTc)) < 1e-9)
assert.equal(deviationSeconds(tcActualElapsed, tcActualElapsed), 0)

// DZ/FZ specified by speed: time is derived exactly like a prescribed average.
const withSpeedZone: SpeedSector[] = [
  { id: 'a', fromKm: 0, toKm: 5, speedKph: 30 },
  { id: 'z', fromKm: 5, toKm: 7, speedKph: 20, kind: 'zone', zoneType: 'FZ', zoneBasis: 'speed' },
  { id: 'b', fromKm: 7, toKm: 10, speedKph: 40 }
]
assert.deepEqual(validateSectors(withSpeedZone), [])
assert.ok(Math.abs(idealTravelSecondsBetween(5, 7, withSpeedZone) - 360) < 1e-9)
assert.equal(targetSpeedAtDistance(6, withSpeedZone), 20)

// DZ/FZ specified by fixed time: exact duration applies at exit and is paced linearly inside.
const withTimeZone: SpeedSector[] = [
  { id: 'a', fromKm: 0, toKm: 5, speedKph: 30 },
  { id: 'z', fromKm: 5, toKm: 7, speedKph: 0, kind: 'zone', zoneType: 'DZ', zoneBasis: 'time', zoneDurationSeconds: 300 },
  { id: 'b', fromKm: 7, toKm: 10, speedKph: 40 }
]
assert.deepEqual(validateSectors(withTimeZone), [])
assert.ok(Math.abs(idealTravelSecondsBetween(5, 7, withTimeZone) - 300) < 1e-9)
assert.ok(Math.abs(idealTravelSecondsBetween(5, 6, withTimeZone) - 150) < 1e-9)
assert.ok(Math.abs(effectiveSpeedKph(withTimeZone[1]) - 24) < 1e-9)
const nextIntoTimeZone = nextSpeedChange(4, withTimeZone)
assert.equal(nextIntoTimeZone?.nextKind, 'zone')
assert.equal(nextIntoTimeZone?.nextZoneType, 'DZ')
assert.equal(nextIntoTimeZone?.nextZoneBasis, 'time')
assert.equal(nextIntoTimeZone?.nextZoneDurationSeconds, 300)

const invalid: SpeedSector[] = [
  { id: 'a', fromKm: 0, toKm: 5, speedKph: 30 },
  { id: 'b', fromKm: 5.1, toKm: 10, speedKph: 40 }
]
assert.ok(validateSectors(invalid).some((message) => message.includes('Gap/overlap')))

const invalidTimeZone: SpeedSector[] = [
  { id: 'a', fromKm: 0, toKm: 5, speedKph: 30 },
  { id: 'z', fromKm: 5, toKm: 7, speedKph: 0, kind: 'zone', zoneType: 'FZ', zoneBasis: 'time', zoneDurationSeconds: 0 }
]
assert.ok(validateSectors(invalidTimeZone).some((message) => message.includes('zone time')))


// Native TIME chart: preserve the prescribed segment duration exactly while
// deriving the display target speed from distance / time.
const withNativeTime: SpeedSector[] = [
  { id: 't1', fromKm: 0, toKm: 0.06, speedKph: 43.2, kind: 'speed', sourceBasis: 'time', sourceDurationSeconds: 5 },
  { id: 't2', fromKm: 0.06, toKm: 0.28, speedKph: (0.22 / 28) * 3600, kind: 'speed', sourceBasis: 'time', sourceDurationSeconds: 28 },
  { id: 't3', fromKm: 0.28, toKm: 0.37, speedKph: 40.5, kind: 'speed', sourceBasis: 'time', sourceDurationSeconds: 8 }
]
assert.deepEqual(validateSectors(withNativeTime), [])
assert.ok(Math.abs(idealTravelSecondsBetween(0, 0.06, withNativeTime) - 5) < 1e-9)
assert.ok(Math.abs(idealTravelSecondsBetween(0.06, 0.28, withNativeTime) - 28) < 1e-9)
assert.ok(Math.abs(idealElapsedSecondsAtDistance(0.37, withNativeTime) - 41) < 1e-9)
assert.ok(Math.abs(effectiveSpeedKph(withNativeTime[0]) - 43.2) < 1e-9)
assert.ok(Math.abs(effectiveSpeedKph(withNativeTime[1]) - ((0.22 / 28) * 3600)) < 1e-9)

const invalidNativeTime: SpeedSector[] = [
  { id: 't', fromKm: 0, toKm: 1, speedKph: 0, kind: 'speed', sourceBasis: 'time', sourceDurationSeconds: 0 }
]
assert.ok(validateSectors(invalidNativeTime).some((message) => message.includes('segment time')))

console.log('TSD engine self-test: PASS')
