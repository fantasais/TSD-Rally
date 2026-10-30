export type SegmentKind = 'speed' | 'zone'
export type ZoneType = 'DZ' | 'FZ'
export type ZoneBasis = 'speed' | 'time'
export type SegmentSourceBasis = 'speed' | 'time'

export type SpeedSector = {
  id: string
  fromKm: number
  toKm: number
  speedKph: number
  kind?: SegmentKind
  zoneType?: ZoneType
  zoneBasis?: ZoneBasis
  zoneDurationSeconds?: number
  // Original chart representation. TIME sectors retain their prescribed segment time
  // while speedKph stores the equivalent average used by the live rally display.
  sourceBasis?: SegmentSourceBasis
  sourceDurationSeconds?: number
}

export type RallySettings = {
  startDateTime: string
  calibrationFactor: number
  scratchSeconds: number
  sectors: SpeedSector[]
}

export type RallyStatus = 'idle' | 'armed' | 'running' | 'stopped'

export type TcCorrectionMethod = 'exact' | 'interpolated' | 'nearest'
export type TcOdoCorrectionSource = 'gps-auto' | 'manual'

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
  previousAnchorDistanceKm?: number
  previousAnchorIdealElapsedSeconds?: number
  // Original button-press capture is kept permanently in hitMs / odoKm / deviationSeconds.
  // Official marshal-time correction is stored separately so no recorded data is overwritten.
  capturedRawDistanceKm?: number
  calibrationFactorAtHit?: number
  officialHitMs?: number | null
  officialOdoKm?: number | null
  officialRawDistanceKm?: number | null
  officialActualElapsedSeconds?: number | null
  officialIdealElapsedSeconds?: number | null
  officialDeviationSeconds?: number | null
  correctionMethod?: TcCorrectionMethod | null
  correctionGpsAccuracyM?: number | null
  correctionLat?: number | null
  correctionLon?: number | null
  odoCorrectionSource?: TcOdoCorrectionSource | null
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

export type GpsOdoSample = {
  timestampMs: number
  rawDistanceKm: number
  accuracyM: number
  lat: number
  lon: number
}

export type GpsOdoEstimate = GpsOdoSample & {
  method: TcCorrectionMethod
  sourceBeforeMs: number
  sourceAfterMs: number
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
