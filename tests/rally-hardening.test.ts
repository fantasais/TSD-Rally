import assert from 'node:assert/strict'
import type { RallySession, SpeedSector } from '../src/types.ts'
import {
  deviationSeconds,
  idealElapsedSecondsAtDistance,
  idealElapsedSecondsFromAnchor,
  idealTravelSecondsBetween,
  validateSectors
} from '../src/lib/tsd.ts'

// Mixed real-world chart: SPEED -> native TIME -> fixed-time DZ/FZ -> SPEED.
const mixed: SpeedSector[] = [
  { id: 's1', fromKm: 0, toKm: 10, speedKph: 50 },
  { id: 't1', fromKm: 10, toKm: 10.5, speedKph: 30, sourceBasis: 'time', sourceDurationSeconds: 60 },
  { id: 'z1', fromKm: 10.5, toKm: 11, speedKph: 0, kind: 'zone', zoneType: 'FZ', zoneBasis: 'time', zoneDurationSeconds: 120 },
  { id: 's2', fromKm: 11, toKm: 20, speedKph: 45 }
]
assert.deepEqual(validateSectors(mixed), [])
assert.equal(idealElapsedSecondsAtDistance(10, mixed), 720)
assert.equal(idealTravelSecondsBetween(10, 10.5, mixed), 60)
assert.equal(idealTravelSecondsBetween(10.5, 11, mixed), 120)

// TC correction can re-anchor anywhere in the mixed chart without altering prior chart maths.
const tcDistanceKm = 10.25
const correctedTcElapsedSeconds = 760
const scratchSeconds = 45
const anchorIdealSeconds = correctedTcElapsedSeconds + scratchSeconds
const nextDistanceKm = 10.75
const idealAfterTc = idealElapsedSecondsFromAnchor(nextDistanceKm, mixed, tcDistanceKm, anchorIdealSeconds)
const expectedTravel = idealTravelSecondsBetween(tcDistanceKm, nextDistanceKm, mixed)
assert.ok(Math.abs(idealAfterTc - (anchorIdealSeconds + expectedTravel)) < 1e-9)
assert.equal(deviationSeconds(idealAfterTc, idealAfterTc), 0)

// A persisted session survives a JSON round trip with anchors and audit events intact.
const session: RallySession = {
  status: 'running',
  startMs: new Date('2026-10-29T23:59:30+05:30').getTime(),
  stopMs: null,
  rawBaselineKm: 100,
  manualOffsetKm: 0.03,
  timingAnchorDistanceKm: tcDistanceKm,
  timingAnchorIdealElapsedSeconds: anchorIdealSeconds,
  tcCount: 1,
  tcLogs: [],
  sftcLogs: [],
  pendingRestartTcId: null,
  pendingSftcId: null,
  eventLogs: [{ id: 'e1', atMs: 123, type: 'tc-corrected', message: 'TC 01 CORRECTED', odoKm: tcDistanceKm }]
}
const restored = JSON.parse(JSON.stringify(session)) as RallySession
assert.equal(restored.timingAnchorDistanceKm, tcDistanceKm)
assert.equal(restored.eventLogs?.[0].type, 'tc-corrected')
assert.equal(restored.manualOffsetKm, 0.03)

console.log('Mixed-chart / persistence hardening self-test: PASS')
