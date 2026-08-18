import type { GpsOdoEstimate, GpsOdoSample, GpsPoint, GpsState } from '../types'

const EARTH_RADIUS_M = 6_371_000
const MAX_ACCURACY_M = 50
const MAX_REASONABLE_SPEED_KPH = 180

export function haversineMeters(a: GpsPoint, b: GpsPoint): number {
  const toRad = (deg: number) => (deg * Math.PI) / 180
  const dLat = toRad(b.lat - a.lat)
  const dLon = toRad(b.lon - a.lon)
  const lat1 = toRad(a.lat)
  const lat2 = toRad(b.lat)

  const h = Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2
  return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(h)))
}

export function pointFromPosition(position: GeolocationPosition): GpsPoint {
  return {
    lat: position.coords.latitude,
    lon: position.coords.longitude,
    accuracyM: position.coords.accuracy,
    speedMps: Number.isFinite(position.coords.speed) ? position.coords.speed : null,
    timestampMs: position.timestamp
  }
}

export function processGpsPoint(state: GpsState, point: GpsPoint): GpsState {
  const base: GpsState = {
    ...state,
    accuracyM: point.accuracyM,
    speedKph: point.speedMps === null ? state.speedKph : point.speedMps * 3.6,
    lastFixMs: point.timestampMs,
    error: null
  }

  if (point.accuracyM > MAX_ACCURACY_M) {
    return { ...base, rejectedFixes: state.rejectedFixes + 1 }
  }

  if (!state.lastAcceptedPoint) {
    return { ...base, lastAcceptedPoint: point, acceptedFixes: state.acceptedFixes + 1 }
  }

  const previous = state.lastAcceptedPoint
  const dtSeconds = (point.timestampMs - previous.timestampMs) / 1000
  if (dtSeconds <= 0) return { ...base, rejectedFixes: state.rejectedFixes + 1 }

  const segmentM = haversineMeters(previous, point)
  const impliedSpeedKph = (segmentM / dtSeconds) * 3.6
  const noiseGateM = Math.max(1.5, Math.min(previous.accuracyM, point.accuracyM) * 0.15)

  if (impliedSpeedKph > MAX_REASONABLE_SPEED_KPH) {
    return { ...base, rejectedFixes: state.rejectedFixes + 1 }
  }

  const deviceSaysStopped = point.speedMps !== null && point.speedMps < 0.5
  if (segmentM < noiseGateM || (deviceSaysStopped && segmentM < 5)) {
    return { ...base, rejectedFixes: state.rejectedFixes + 1 }
  }

  return {
    ...base,
    rawDistanceKm: state.rawDistanceKm + segmentM / 1000,
    lastAcceptedPoint: point,
    speedKph: point.speedMps === null ? impliedSpeedKph : point.speedMps * 3.6,
    acceptedFixes: state.acceptedFixes + 1
  }
}

/**
 * Reconstruct the cumulative raw GPS odometer at an arbitrary timestamp.
 * We prefer interpolation between accepted fixes. A nearby single fix is used
 * only as a conservative fallback when the target sits just outside history.
 */
export function estimateRawDistanceAt(
  samples: GpsOdoSample[],
  targetMs: number,
  maxInterpolationGapMs = 6_000,
  maxNearestAgeMs = 2_500
): GpsOdoEstimate | null {
  if (!Number.isFinite(targetMs) || samples.length === 0) return null

  const ordered = [...samples].sort((a, b) => a.timestampMs - b.timestampMs)

  let before: GpsOdoSample | null = null
  let after: GpsOdoSample | null = null

  for (const sample of ordered) {
    if (sample.timestampMs === targetMs) {
      return {
        ...sample,
        method: 'exact',
        sourceBeforeMs: sample.timestampMs,
        sourceAfterMs: sample.timestampMs
      }
    }
    if (sample.timestampMs < targetMs) before = sample
    if (sample.timestampMs > targetMs) {
      after = sample
      break
    }
  }

  if (before && after) {
    const gapMs = after.timestampMs - before.timestampMs
    if (gapMs > 0 && gapMs <= maxInterpolationGapMs) {
      const ratio = (targetMs - before.timestampMs) / gapMs
      return {
        timestampMs: targetMs,
        rawDistanceKm: before.rawDistanceKm + (after.rawDistanceKm - before.rawDistanceKm) * ratio,
        accuracyM: Math.max(before.accuracyM, after.accuracyM),
        lat: before.lat + (after.lat - before.lat) * ratio,
        lon: before.lon + (after.lon - before.lon) * ratio,
        method: 'interpolated',
        sourceBeforeMs: before.timestampMs,
        sourceAfterMs: after.timestampMs
      }
    }
  }

  const candidates = [before, after].filter((sample): sample is GpsOdoSample => sample !== null)
  if (!candidates.length) return null
  const nearest = candidates.reduce((best, sample) =>
    Math.abs(sample.timestampMs - targetMs) < Math.abs(best.timestampMs - targetMs) ? sample : best
  )
  if (Math.abs(nearest.timestampMs - targetMs) > maxNearestAgeMs) return null

  return {
    ...nearest,
    timestampMs: targetMs,
    method: 'nearest',
    sourceBeforeMs: nearest.timestampMs,
    sourceAfterMs: nearest.timestampMs
  }
}
