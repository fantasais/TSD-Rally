  export type SegmentKind = 'speed' | 'zone'
export type ZoneType = 'DZ' | 'FZ'
export type ZoneBasis = 'speed' | 'time'

/**
 * Kept as SpeedSector for backwards compatibility with V0.3 local storage.
 * V0.4 also allows a DZ/FZ zone to live in the same distance-ordered chart.
 */
export type SpeedSector = {
  id: string
  fromKm: number
  toKm: number
  speedKph: number
  kind?: SegmentKind
  zoneType?: ZoneType
  zoneBasis?: ZoneBasis
  zoneDurationSeconds?: number
}

export type RallySettings = {
  startDateTime: string
  calibrationFactor: number
  scratchSeconds: number
  sectors: SpeedSector[]
}

export type RallyStatus = 'idle' | 'armed' | 'running' | 'stopped'

export type TcLog = {
  id: string
  number: number
  hitMs: number
  odoKm: number
  deviationSeconds: number
  actualElapsedSeconds: number
  idealElapsedSeconds: number
  scratchSeconds: number
  gpsAccuracyM: number | null
  lat: number | null
  lon: number | null
  officialRestartMs?: number | null
  scratchOverridden?: boolean
}

export type SftcLog = {
  id: string
  number: number
  hitMs: number
  cardTimeMs: number
  odoKm: number
  deviationSeconds: number
  actualElapsedSeconds: number
  idealElapsedSeconds: number
  gpsAccuracyM: number | null
  lat: number | null
  lon: number | null
}

export type RallySession = {
  status: RallyStatus
  startMs: number | null
  stopMs: number | null
  rawBaselineKm: number
  manualOffsetKm: number
  timingAnchorDistanceKm: number
  timingAnchorIdealElapsedSeconds: number
  tcCount: number
  tcLogs?: TcLog[]
  sftcLogs?: SftcLog[]
  pendingRestartTcId?: string | null
  pendingSftcId?: string | null
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
