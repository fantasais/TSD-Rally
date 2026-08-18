import type { SpeedSector } from '../types'

const EPSILON = 1e-6

export function sortSectors(sectors: SpeedSector[]): SpeedSector[] {
  return [...sectors].sort((a, b) => a.fromKm - b.fromKm)
}

export function segmentKind(segment: SpeedSector): 'speed' | 'zone' {
  return segment.kind === 'zone' ? 'zone' : 'speed'
}

export function zoneBasis(segment: SpeedSector): 'speed' | 'time' {
  return segment.zoneBasis === 'time' ? 'time' : 'speed'
}

export function segmentDurationSeconds(segment: SpeedSector): number {
  const distanceKm = Math.max(0, segment.toKm - segment.fromKm)
  if (distanceKm <= EPSILON) return 0

  if (segmentKind(segment) === 'zone' && zoneBasis(segment) === 'time') {
    return Math.max(0, segment.zoneDurationSeconds ?? 0)
  }

  return segment.speedKph > 0 ? (distanceKm / segment.speedKph) * 3600 : 0
}

/** Effective average speed used only to pace a fixed-time DZ/FZ across its distance. */
export function effectiveSpeedKph(segment: SpeedSector): number {
  const distanceKm = Math.max(0, segment.toKm - segment.fromKm)
  if (distanceKm <= EPSILON) return 0
  const duration = segmentDurationSeconds(segment)
  return duration > 0 ? (distanceKm / duration) * 3600 : 0
}

export function validateSectors(sectors: SpeedSector[]): string[] {
  const errors: string[] = []
  const sorted = sortSectors(sectors)

  if (sorted.length === 0) return ['Add at least one speed-chart entry.']

  sorted.forEach((segment, index) => {
    const kind = segmentKind(segment)
    const label = kind === 'zone' ? `${segment.zoneType ?? 'DZ/FZ'} zone` : 'speed sector'

    if (!Number.isFinite(segment.fromKm) || !Number.isFinite(segment.toKm)) {
      errors.push(`Entry ${index + 1}: distances must be numbers.`)
      return
    }
    if (segment.fromKm < 0) errors.push(`Entry ${index + 1}: start distance cannot be negative.`)
    if (segment.toKm <= segment.fromKm) errors.push(`Entry ${index + 1}: end distance must be greater than start distance.`)

    if (kind === 'speed' || zoneBasis(segment) === 'speed') {
      if (!Number.isFinite(segment.speedKph) || segment.speedKph <= 0) {
        errors.push(`Entry ${index + 1} (${label}): speed must be greater than zero.`)
      }
    } else {
      const duration = segment.zoneDurationSeconds ?? 0
      if (!Number.isFinite(duration) || duration <= 0) {
        errors.push(`Entry ${index + 1} (${label}): zone time must be greater than zero.`)
      }
    }

    if (index > 0) {
      const previous = sorted[index - 1]
      if (Math.abs(previous.toKm - segment.fromKm) > 0.001) {
        errors.push(`Gap/overlap between entries ${index} and ${index + 1}: ${previous.toKm.toFixed(3)} km → ${segment.fromKm.toFixed(3)} km.`)
      }
    }
  })

  if (sorted[0] && Math.abs(sorted[0].fromKm) > 0.001) {
    errors.push('First speed-chart entry should start at 0.000 km.')
  }

  return errors
}

export function totalRouteKm(sectors: SpeedSector[]): number {
  const sorted = sortSectors(sectors)
  return sorted.length ? sorted[sorted.length - 1].toKm : 0
}

/**
 * Base ideal elapsed time from rally distance 0 to the supplied distance.
 * For a fixed-time DZ/FZ, its prescribed total time is distributed linearly
 * across the zone distance. This makes the live EARLY/LATE meter useful inside
 * the zone while guaranteeing the exact prescribed time at the zone exit.
 */
export function idealElapsedSecondsAtDistance(distanceKm: number, sectors: SpeedSector[]): number {
  const sorted = sortSectors(sectors)
  const distance = Math.max(0, distanceKm)
  let seconds = 0

  for (const segment of sorted) {
    if (distance <= segment.fromKm + EPSILON) break

    const segmentEnd = Math.min(distance, segment.toKm)
    const coveredKm = Math.max(0, segmentEnd - segment.fromKm)
    const fullKm = Math.max(EPSILON, segment.toKm - segment.fromKm)

    if (segmentKind(segment) === 'zone' && zoneBasis(segment) === 'time') {
      const fullDuration = Math.max(0, segment.zoneDurationSeconds ?? 0)
      seconds += fullDuration * (coveredKm / fullKm)
    } else if (segment.speedKph > 0) {
      seconds += (coveredKm / segment.speedKph) * 3600
    }

    if (distance <= segment.toKm + EPSILON) break
  }

  return seconds
}

export function idealTravelSecondsBetween(fromKm: number, toKm: number, sectors: SpeedSector[]): number {
  return idealElapsedSecondsAtDistance(toKm, sectors) - idealElapsedSecondsAtDistance(fromKm, sectors)
}

export function idealElapsedSecondsFromAnchor(
  distanceKm: number,
  sectors: SpeedSector[],
  anchorDistanceKm: number,
  anchorIdealElapsedSeconds: number
): number {
  return anchorIdealElapsedSeconds + idealTravelSecondsBetween(anchorDistanceKm, distanceKm, sectors)
}

export function sectorIndexAtDistance(distanceKm: number, sectors: SpeedSector[]): number {
  const sorted = sortSectors(sectors)
  if (!sorted.length) return -1
  const distance = Math.max(0, distanceKm)

  const index = sorted.findIndex((segment, i) => {
    const isLast = i === sorted.length - 1
    return distance >= segment.fromKm - EPSILON && (distance < segment.toKm - EPSILON || (isLast && distance <= segment.toKm + EPSILON))
  })

  if (index >= 0) return index
  if (distance > sorted[sorted.length - 1].toKm) return sorted.length - 1
  return 0
}

export function segmentAtDistance(distanceKm: number, sectors: SpeedSector[]): SpeedSector | null {
  const sorted = sortSectors(sectors)
  const index = sectorIndexAtDistance(distanceKm, sorted)
  return index >= 0 ? sorted[index] : null
}

export function targetSpeedAtDistance(distanceKm: number, sectors: SpeedSector[]): number {
  const segment = segmentAtDistance(distanceKm, sectors)
  return segment ? effectiveSpeedKph(segment) : 0
}

export type NextChartChange = {
  distanceKm: number
  nextSpeedKph: number
  nextKind: 'speed' | 'zone'
  nextZoneType: 'DZ' | 'FZ' | null
  nextZoneBasis: 'speed' | 'time' | null
  nextZoneDurationSeconds: number | null
}

export function nextSpeedChange(distanceKm: number, sectors: SpeedSector[]): NextChartChange | null {
  const sorted = sortSectors(sectors)
  const index = sectorIndexAtDistance(distanceKm, sorted)
  if (index < 0 || index >= sorted.length - 1) return null
  const next = sorted[index + 1]
  const kind = segmentKind(next)
  return {
    distanceKm: Math.max(0, sorted[index].toKm - distanceKm),
    nextSpeedKph: effectiveSpeedKph(next),
    nextKind: kind,
    nextZoneType: kind === 'zone' ? (next.zoneType ?? 'FZ') : null,
    nextZoneBasis: kind === 'zone' ? zoneBasis(next) : null,
    nextZoneDurationSeconds: kind === 'zone' && zoneBasis(next) === 'time' ? Math.max(0, next.zoneDurationSeconds ?? 0) : null
  }
}

export function deviationSeconds(actualElapsedSeconds: number, idealElapsedSeconds: number): number {
  return actualElapsedSeconds - idealElapsedSeconds
}

export function formatElapsed(totalSeconds: number): string {
  const safe = Math.max(0, totalSeconds)
  const hours = Math.floor(safe / 3600)
  const minutes = Math.floor((safe % 3600) / 60)
  const seconds = Math.floor(safe % 60)
  const tenths = Math.floor((safe - Math.floor(safe)) * 10)
  return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}.${tenths}`
}

export function formatDuration(totalSeconds: number): string {
  const safe = Math.max(0, Math.round(totalSeconds))
  const minutes = Math.floor(safe / 60)
  const seconds = safe % 60
  return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`
}

export function formatDeviation(seconds: number): string {
  const sign = seconds > 0 ? '+' : seconds < 0 ? '−' : '±'
  return `${sign}${Math.abs(seconds).toFixed(1)}`
}
