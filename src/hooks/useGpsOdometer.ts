import { useCallback, useEffect, useRef, useState } from 'react'
import type { GpsState } from '../types'
import { pointFromPosition, processGpsPoint } from '../lib/gps'
import { loadJson, saveJson } from '../lib/storage'

const STORAGE_KEY = 'tsd:gps:v01'

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

export function useGpsOdometer() {
  const [gps, setGps] = useState<GpsState>(() => {
    const saved = loadJson<GpsState>(STORAGE_KEY, EMPTY_GPS)
    return { ...saved, enabled: false, error: null }
  })
  const watchIdRef = useRef<number | null>(null)

  useEffect(() => {
    saveJson(STORAGE_KEY, { ...gps, enabled: false })
  }, [gps])

  const startGps = useCallback(() => {
    if (!('geolocation' in navigator)) {
      setGps((current) => ({ ...current, error: 'Geolocation is not available on this device.' }))
      return
    }
    if (watchIdRef.current !== null) return

    setGps((current) => ({ ...current, enabled: true, error: null }))
    watchIdRef.current = navigator.geolocation.watchPosition(
      (position) => {
        const point = pointFromPosition(position)
        setGps((current) => processGpsPoint({ ...current, enabled: true }, point))
      },
      (error) => {
        setGps((current) => ({ ...current, enabled: false, error: error.message }))
      },
      { enableHighAccuracy: true, timeout: 10_000, maximumAge: 0 }
    )
  }, [])

  const stopGps = useCallback(() => {
    if (watchIdRef.current !== null) {
      navigator.geolocation.clearWatch(watchIdRef.current)
      watchIdRef.current = null
    }
    setGps((current) => ({ ...current, enabled: false }))
  }, [])

  const resetTracker = useCallback(() => {
    setGps((current) => ({ ...EMPTY_GPS, enabled: current.enabled }))
  }, [])

  useEffect(() => () => {
    if (watchIdRef.current !== null) navigator.geolocation.clearWatch(watchIdRef.current)
  }, [])

  return { gps, startGps, stopGps, resetTracker }
}
