import assert from 'node:assert/strict'
import { deviationSeconds, idealElapsedSecondsFromAnchor } from '../src/lib/tsd.ts'
import type { SpeedSector } from '../src/types.ts'

const sectors: SpeedSector[] = [
  { id: 's1', fromKm: 0, toKm: 20, speedKph: 60, kind: 'speed' }
]

// Rally starts 10:00:00. Corrected TC is 10.000 km at 10:10:00 with 60 sec scratch.
const correctedTcElapsed = 600
const scratchSeconds = 60
const anchorIdeal = correctedTcElapsed + scratchSeconds

// At 11.000 km, one more minute at 60 km/h is required. Ideal clock is therefore 10:12:00.
const idealAt11 = idealElapsedSecondsFromAnchor(11, sectors, 10, anchorIdeal)
assert.equal(idealAt11, 720)
assert.equal(deviationSeconds(720, idealAt11), 0)
assert.equal(deviationSeconds(723, idealAt11), 3)

console.log('TC correction anchor self-test: PASS')
