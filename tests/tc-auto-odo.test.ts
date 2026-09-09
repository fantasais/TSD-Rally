import assert from 'node:assert/strict'
import { estimateRawDistanceAt } from '../src/lib/gps.ts'
import type { GpsOdoSample } from '../src/types.ts'

const baseMs = new Date('2026-08-18T10:00:00.000Z').getTime()
const samples: GpsOdoSample[] = [0, 1, 2, 3, 4, 5].map((second) => ({
  timestampMs: baseMs + second * 1000,
  rawDistanceKm: 100 + second * 0.010,
  accuracyM: 4,
  lat: 28 + second * 0.00001,
  lon: 77 + second * 0.00001
}))

const exact = estimateRawDistanceAt(samples, baseMs + 2_000)
assert.ok(exact)
assert.equal(exact.method, 'exact')
assert.equal(exact.rawDistanceKm, 100.02)

const interpolated = estimateRawDistanceAt(samples, baseMs + 2_500)
assert.ok(interpolated)
assert.equal(interpolated.method, 'interpolated')
assert.ok(Math.abs(interpolated.rawDistanceKm - 100.025) < 1e-9)

// TC button was pressed at 4 s with a displayed ODO of 20.040 km.
// Marshal time says the actual crossing was at 2 s. GPS history therefore
// rewinds the TC ODO by 20 m while keeping the original capture untouched.
const capturedTcOdoKm = 20.040
const capturedRawDistanceKm = 100.040
const officialRawDistanceKm = exact.rawDistanceKm
const calibrationFactor = 1
const autoTcOdoKm = capturedTcOdoKm + (officialRawDistanceKm - capturedRawDistanceKm) * calibrationFactor
assert.ok(Math.abs(autoTcOdoKm - 20.020) < 1e-9)

const tooFarOutsideHistory = estimateRawDistanceAt(samples, baseMs - 10_000)
assert.equal(tooFarOutsideHistory, null)

console.log('TC official-time → GPS auto-ODO self-test: PASS')
