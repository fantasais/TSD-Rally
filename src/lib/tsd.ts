import type { SpeedSector } from '../types'

const EPSILON = 1e-6

export function sortSectors(sectors: SpeedSector[]): SpeedSector[] {
  return [...sectors].sort((a, b) => a.fromKm - b.fromKm)
}

export function validateSectors(sectors: SpeedSector[]): string[] {
  const errors: string[] = []
  const sorted = sortSectors(sectors)

  if (sorted.length === 0) return ['Add at least one speed sector.']

  sorted.forEach((sector, index) => {
    if (!Number.isFinite(sector.fromKm) || !Number.isFinite(sector.toKm) || !Number.isFinite(sector.speedKph)) {
      errors.push(`Sector ${index + 1}: all values must be numbers.`)
      return
    }
    if (sector.fromKm < 0) errors.push(`Sector ${index + 1}: start distance cannot be negative.`)
    if (sector.toKm <= sector.fromKm) errors.push(`Sector ${index + 1}: end distance must be greater than start distance.`)
    if (sector.speedKph <= 0) errors.push(`Sector ${index + 1}: average speed must be greater than zero.`)

    if (index > 0) {
      const previous = sorted[index - 1]
      if (Math.abs(previous.toKm - sector.fromKm) > 0.001) {
        errors.push(`Gap/overlap between sectors ${index} and ${index + 1}: ${previous.toKm.toFixed(3)} km → ${sector.fromKm.toFixed(3)} km.`)
      }
    }
  })

  if (sorted[0] && Math.abs(sorted[0].fromKm) > 0.001) {
    errors.push('First sector should start at 0.000 km for V0.1.')
  }

  return errors
}

export function totalRouteKm(sectors: SpeedSector[]): number {
  const sorted = sortSectors(sectors)
  return sorted.length ? sorted[sorted.length - 1].toKm : 0
}

export function idealElapsedSecondsAtDistance(distanceKm: number, sectors: SpeedSector[]): number {
  const sorted = sortSectors(sectors)
  const distance = Math.max(0, distanceKm)
  let seconds = 0

  for (const sector of sorted) {
    if (distance <= sector.fromKm + EPSILON) break
    const segmentEnd = Math.min(distance, sector.toKm)
    const segmentKm = Math.max(0, segmentEnd - sector.fromKm)
    seconds += (segmentKm / sector.speedKph) * 3600
    if (distance <= sector.toKm + EPSILON) break
  }

  return seconds
}

export function sectorIndexAtDistance(distanceKm: number, sectors: SpeedSector[]): number {
  const sorted = sortSectors(sectors)
  if (!sorted.length) return -1
  const distance = Math.max(0, distanceKm)

  const index = sorted.findIndex((sector, i) => {
    const isLast = i === sorted.length - 1
    return distance >= sector.fromKm - EPSILON && (distance < sector.toKm - EPSILON || (isLast && distance <= sector.toKm + EPSILON))
  })

  if (index >= 0) return index
  if (distance > sorted[sorted.length - 1].toKm) return sorted.length - 1
  return 0
}

export function targetSpeedAtDistance(distanceKm: number, sectors: SpeedSector[]): number {
  const sorted = sortSectors(sectors)
  const index = sectorIndexAtDistance(distanceKm, sorted)
  return index >= 0 ? sorted[index].speedKph : 0
}

export function nextSpeedChange(distanceKm: number, sectors: SpeedSector[]): { distanceKm: number; nextSpeedKph: number } | null {
  const sorted = sortSectors(sectors)
  const index = sectorIndexAtDistance(distanceKm, sorted)
  if (index < 0 || index >= sorted.length - 1) return null
  return {
    distanceKm: Math.max(0, sorted[index].toKm - distanceKm),
    nextSpeedKph: sorted[index + 1].speedKph
  }
}

export function deviationSeconds(actualElapsedSeconds: number, distanceKm: number, sectors: SpeedSector[]): number {
  return actualElapsedSeconds - idealElapsedSecondsAtDistance(distanceKm, sectors)
}

export function formatElapsed(totalSeconds: number): string {
  const safe = Math.max(0, totalSeconds)
  const hours = Math.floor(safe / 3600)
  const minutes = Math.floor((safe % 3600) / 60)
  const seconds = Math.floor(safe % 60)
  const tenths = Math.floor((safe - Math.floor(safe)) * 10)
  return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}.${tenths}`
}

export function formatDeviation(seconds: number): string {
  const sign = seconds > 0 ? '+' : seconds < 0 ? '−' : '±'
  return `${sign}${Math.abs(seconds).toFixed(1)}`
}
