import assert from 'node:assert/strict'
import { processGpsPoint } from '../src/lib/gps.ts'
import type { GpsPoint, GpsState } from '../src/types.ts'

const baseState: GpsState = {
  enabled: true,
  rawDistanceKm: 0,
  lastAcceptedPoint: null,
  lastObservedPoint: null,
  accuracyM: null,
  speedKph: null,
  lastFixMs: null,
  acceptedFixes: 0,
  rejectedFixes: 0,
  isStationary: false,
  stationaryCandidateSinceMs: null,
  stationaryReleaseFixes: 0,
  error: null
}

const baseMs = 1_800_000_000_000
const metersToLat = (meters: number) => meters / 111_320
const point = (metersNorth: number, seconds: number, speedMps: number | null, accuracyM = 4): GpsPoint => ({
  lat: 28 + metersToLat(metersNorth),
  lon: 77,
  accuracyM,
  speedMps,
  timestampMs: baseMs + seconds * 1000
})

let state = processGpsPoint(baseState, point(0, 0, 0))
assert.equal(state.acceptedFixes, 1)
assert.equal(state.isStationary, false)

// Small near-zero movement starts the stationary candidate but cannot add drift.
state = processGpsPoint(state, point(0.8, 1, 0))
assert.equal(state.rawDistanceKm, 0)
assert.equal(state.isStationary, false)

// Sustained stopped state for >=3 seconds explicitly locks the odometer.
state = processGpsPoint(state, point(1.2, 4, 0))
assert.equal(state.isStationary, true)
assert.equal(state.rawDistanceKm, 0)

// A several-metre GPS wander while still reporting zero speed must not accumulate.
state = processGpsPoint(state, point(4.5, 5, 0))
assert.equal(state.isStationary, true)
assert.equal(state.rawDistanceKm, 0)

// Credible movement releases the lock and resumes from the stationary anchor.
state = processGpsPoint(state, point(10, 6, 2.5))
assert.equal(state.isStationary, false)
assert.ok(state.rawDistanceKm > 0.008 && state.rawDistanceKm < 0.012)


// Duplicate/out-of-order timestamps must never change distance.
const beforeDuplicate = state.rawDistanceKm
state = processGpsPoint(state, point(12, 6, 3))
assert.equal(state.rawDistanceKm, beforeDuplicate)

// An accurate but physically impossible GPS teleport is rejected by the speed gate.
const beforeTeleport = state.rawDistanceKm
state = processGpsPoint(state, point(500, 7, 10, 4))
assert.equal(state.rawDistanceKm, beforeTeleport)

// A wildly inaccurate fix is still rejected by the existing hard gate.
const beforeBadFix = state.rawDistanceKm
state = processGpsPoint(state, point(100, 7, 20, 80))
assert.equal(state.rawDistanceKm, beforeBadFix)

console.log('GPS stationary-lock self-test: PASS')
