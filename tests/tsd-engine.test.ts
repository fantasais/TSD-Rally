import assert from 'node:assert/strict'
import type { SpeedSector } from '../src/types.ts'
import {
  deviationSeconds,
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
assert.deepEqual(nextSpeedChange(4.5, sectors), { distanceKm: 0.2999999999999998, nextSpeedKph: 42 })
assert.ok(Math.abs(deviationSeconds(487, 480) - 7) < 1e-9)

// A TC may occur anywhere, not at a speed-sector boundary.
const tcDistance = 6.25
const tcActualElapsed = 612
const scratchSeconds = 60
const anchorIdeal = tcActualElapsed + scratchSeconds
assert.equal(idealElapsedSecondsFromAnchor(tcDistance, sectors, tcDistance, anchorIdeal), 672)
assert.equal(deviationSeconds(tcActualElapsed, anchorIdeal), -60)

// After waiting exactly the scratch time at the TC, timing returns to zero.
assert.equal(deviationSeconds(tcActualElapsed + scratchSeconds, anchorIdeal), 0)

// Once moving again, only prescribed chart travel time after the TC is added.
const laterDistance = 7.25
const travelAfterTc = idealTravelSecondsBetween(tcDistance, laterDistance, sectors)
const laterIdeal = idealElapsedSecondsFromAnchor(laterDistance, sectors, tcDistance, anchorIdeal)
assert.ok(Math.abs(laterIdeal - (anchorIdeal + travelAfterTc)) < 1e-9)

// With zero scratch, pressing TC immediately resets accumulated early/late to zero.
assert.equal(deviationSeconds(tcActualElapsed, tcActualElapsed), 0)

const invalid: SpeedSector[] = [
  { id: 'a', fromKm: 0, toKm: 5, speedKph: 30 },
  { id: 'b', fromKm: 5.1, toKm: 10, speedKph: 40 }
]
assert.ok(validateSectors(invalid).some((message) => message.includes('Gap/overlap')))

console.log('TSD engine self-test: PASS')
