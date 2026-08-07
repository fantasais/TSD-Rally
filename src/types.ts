export type SpeedSector = {
  id: string
  fromKm: number
  toKm: number
  speedKph: number
}

export type RallySettings = {
  startDateTime: string
  calibrationFactor: number
  scratchSeconds: number
  sectors: SpeedSector[]
}

export type RallyStatus = 'idle' | 'armed' | 'running' | 'stopped'

export type RallySession = {
  status: RallyStatus
  startMs: number | null
  stopMs: number | null
  rawBaselineKm: number
  manualOffsetKm: number
  timingAnchorDistanceKm: number
  timingAnchorIdealElapsedSeconds: number
  tcCount: number
}

export type GpsPoint = {
  lat: number
  lon: number
  accuracyM: number
  speedMps: number | null
  timestampMs: number
}

export type GpsState = {
  enabled: boolean
  rawDistanceKm: number
  lastAcceptedPoint: GpsPoint | null
  accuracyM: number | null
  speedKph: number | null
  lastFixMs: number | null
  acceptedFixes: number
  rejectedFixes: number
  error: string | null
}
