import { useCallback, useEffect, useRef, useState } from 'react'
import type { GpsOdoEstimate, GpsOdoSample, GpsState } from '../types'
import { estimateRawDistanceAt, pointFromPosition, processGpsPoint } from '../lib/gps'
import { loadJson, saveJson } from '../lib/storage'

const STORAGE_KEY = 'tsd:gps:v01'
const HISTORY_KEY = 'tsd:gps-history:v01'
const HISTORY_WINDOW_MS = 15 * 60 * 1000
const HISTORY_PERSIST_EVERY_ACCEPTED_FIXES = 5

const EMPTY_GPS: GpsState = {
  enabled: false,
  rawDistanceKm: 0,
  lastAcceptedPoint: null,
  accuracyM: null,
  speedKph: null,
  lastFixMs: null,
  acceptedFixes: 0,
  rejectedFixes: 0,
  error: null
}

function loadHistory(): GpsOdoSample[] {
  const saved = loadJson<GpsOdoSample[]>(HISTORY_KEY, [])
  if (!Array.isArray(saved)) return []
  const cutoff = Date.now() - HISTORY_WINDOW_MS
  return saved
    .filter((sample) =>
      Number.isFinite(sample?.timestampMs) &&
      Number.isFinite(sample?.rawDistanceKm) &&
      Number.isFinite(sample?.accuracyM) &&
      Number.isFinite(sample?.lat) &&
      Number.isFinite(sample?.lon) &&
      sample.timestampMs >= cutoff
    )
    .sort((a, b) => a.timestampMs - b.timestampMs)
}

export function useGpsOdometer() {
  const initialGps = (() => {
    const saved = loadJson<GpsState>(STORAGE_KEY, EMPTY_GPS)
    return { ...saved, enabled: false, error: null }
  })()
  const [gps, setGps] = useState<GpsState>(initialGps)
  const gpsRef = useRef<GpsState>(initialGps)
  const watchIdRef = useRef<number | null>(null)
  const historyRef = useRef<GpsOdoSample[]>(loadHistory())
  const acceptedSincePersistRef = useRef(0)

  const commitGps = useCallback((next: GpsState) => {
    gpsRef.current = next
    setGps(next)
  }, [])

  useEffect(() => {
    saveJson(STORAGE_KEY, { ...gps, enabled: false })
  }, [gps])

  const persistHistory = useCallback(() => {
    saveJson(HISTORY_KEY, historyRef.current)
    acceptedSincePersistRef.current = 0
  }, [])

  const appendAcceptedSample = useCallback((next: GpsState) => {
    const point = next.lastAcceptedPoint
    if (!point) return
    const sample: GpsOdoSample = {
      timestampMs: point.timestampMs,
      rawDistanceKm: next.rawDistanceKm,
      accuracyM: point.accuracyM,
      lat: point.lat,
      lon: point.lon
    }
    const cutoff = sample.timestampMs - HISTORY_WINDOW_MS
    const withoutDuplicate = historyRef.current.filter((item) => item.timestampMs >= cutoff && item.timestampMs !== sample.timestampMs)
    historyRef.current = [...withoutDuplicate, sample].sort((a, b) => a.timestampMs - b.timestampMs)
    acceptedSincePersistRef.current += 1
    if (acceptedSincePersistRef.current >= HISTORY_PERSIST_EVERY_ACCEPTED_FIXES) persistHistory()
  }, [persistHistory])

  const startGps = useCallback(() => {
    if (!('geolocation' in navigator)) {
      commitGps({ ...gpsRef.current, error: 'Geolocation is not available on this device.' })
      return
    }
    if (watchIdRef.current !== null) return

    commitGps({ ...gpsRef.current, enabled: true, error: null })
    watchIdRef.current = navigator.geolocation.watchPosition(
      (position) => {
        const point = pointFromPosition(position)
        const current = gpsRef.current
        const next = processGpsPoint({ ...current, enabled: true }, point)
        const acceptedThisFix =
          next.lastAcceptedPoint?.timestampMs === point.timestampMs &&
          current.lastAcceptedPoint?.timestampMs !== point.timestampMs
        if (acceptedThisFix) appendAcceptedSample(next)
        commitGps(next)
      },
      (error) => {
        commitGps({ ...gpsRef.current, enabled: false, error: error.message })
      },
      { enableHighAccuracy: true, timeout: 10_000, maximumAge: 0 }
    )
  }, [appendAcceptedSample, commitGps])

  const stopGps = useCallback(() => {
    if (watchIdRef.current !== null) {
      navigator.geolocation.clearWatch(watchIdRef.current)
      watchIdRef.current = null
    }
    persistHistory()
    commitGps({ ...gpsRef.current, enabled: false })
  }, [commitGps, persistHistory])

  const resetTracker = useCallback(() => {
    historyRef.current = []
    saveJson(HISTORY_KEY, [])
    commitGps({ ...EMPTY_GPS, enabled: gpsRef.current.enabled })
  }, [commitGps])

  const estimateRawDistanceAtMs = useCallback((timestampMs: number): GpsOdoEstimate | null =>
    estimateRawDistanceAt(historyRef.current, timestampMs), [])

  useEffect(() => () => {
    if (watchIdRef.current !== null) navigator.geolocation.clearWatch(watchIdRef.current)
    persistHistory()
  }, [persistHistory])

  return { gps, startGps, stopGps, resetTracker, estimateRawDistanceAtMs }
}
