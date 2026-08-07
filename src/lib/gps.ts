import type { GpsPoint, GpsState } from '../types'

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
