import assert from 'node:assert/strict'
import type { SpeedSector } from '../src/types.ts'
import {
  chainSectors,
  deviationSeconds,
  idealElapsedSecondsAtDistance,
  nextSpeedChange,
  targetSpeedAtDistance,
  validateSectors
} from '../src/lib/tsd.ts'

const sectors: SpeedSector[] = [
  { id: 'a', fromKm: 0, toKm: 4.8, speedKph: 36, tcAtEnd: false, scratchSeconds: 0 },
  { id: 'b', fromKm: 4.8, toKm: 12.35, speedKph: 42, tcAtEnd: false, scratchSeconds: 0 },
  { id: 'c', fromKm: 12.35, toKm: 18.6, speedKph: 38, tcAtEnd: false, scratchSeconds: 0 }
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

const withTc: SpeedSector[] = [
  { id: 'a', fromKm: 0, toKm: 5, speedKph: 30, tcAtEnd: true, scratchSeconds: 60 },
  { id: 'b', fromKm: 5, toKm: 10, speedKph: 40, tcAtEnd: false, scratchSeconds: 0 }
]

assert.ok(Math.abs(idealElapsedSecondsAtDistance(4.999, withTc) - ((4.999 / 30) * 3600)) < 1e-9)
assert.ok(Math.abs(idealElapsedSecondsAtDistance(5, withTc) - 660) < 1e-9)
assert.ok(Math.abs(deviationSeconds(600, 5, withTc) + 60) < 1e-9)
assert.ok(Math.abs(deviationSeconds(660, 5, withTc)) < 1e-9)
assert.ok(Math.abs(idealElapsedSecondsAtDistance(6, withTc) - 750) < 1e-9)

const chained = chainSectors([
  { id: 'a', fromKm: 0, toKm: 3, speedKph: 30, tcAtEnd: false, scratchSeconds: 0 },
  { id: 'b', fromKm: 999, toKm: 7, speedKph: 40, tcAtEnd: false, scratchSeconds: 0 }
])
assert.equal(chained[1].fromKm, 3)

console.log('TSD engine self-test: PASS')
