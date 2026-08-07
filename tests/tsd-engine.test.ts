import assert from 'node:assert/strict'
import type { SpeedSector } from '../src/types.ts'
import {
  deviationSeconds,
  idealElapsedSecondsAtDistance,
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
assert.ok(Math.abs(deviationSeconds(487, 4.8, sectors) - 7) < 1e-9)

const invalid: SpeedSector[] = [
  { id: 'a', fromKm: 0, toKm: 5, speedKph: 30 },
  { id: 'b', fromKm: 5.1, toKm: 10, speedKph: 40 }
]
assert.ok(validateSectors(invalid).some((message) => message.includes('Gap/overlap')))

console.log('TSD engine self-test: PASS')
