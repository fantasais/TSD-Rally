import { useEffect, useMemo, useState } from 'react'
import type { RallySession, RallySettings, SpeedSector, SftcLog, TcLog } from './types'
import { useGpsOdometer } from './hooks/useGpsOdometer'
import { useWakeLock } from './hooks/useWakeLock'
import {
  deviationSeconds,
  effectiveSpeedKph,
  formatDeviation,
  formatDuration,
  formatElapsed,
  idealElapsedSecondsFromAnchor,
  nextSpeedChange,
  segmentAtDistance,
  segmentKind,
  sortSectors,
  totalRouteKm,
  validateSectors,
  zoneBasis
} from './lib/tsd'
import { loadJson, saveJson } from './lib/storage'
import SpeedChartImporter from './SpeedChartImporter'
import InstallAppButton from './InstallAppButton'
import './styles.css'

type Screen = 'setup' | 'rally' | 'controls'

// Keep V0.3 keys so an existing phone deployment retains its setup after upgrade.
const SETTINGS_KEY = 'tsd:settings:v03'
const SESSION_KEY = 'tsd:session:v03'

function localDateTimeValue(date = new Date(Date.now() + 5 * 60_000)) {
  const pad = (value: number) => String(value).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
}

function timeInputValue(ms = Date.now()) {
  const date = new Date(ms)
  const pad = (value: number) => String(value).padStart(2, '0')
  return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
}

function restartMsFromClock(clockValue: string, tcHitMs: number): number | null {
  const match = /^(\d{1,2}):(\d{2})(?::(\d{2}))?$/.exec(clockValue.trim())
  if (!match) return null

  const hours = Number(match[1])
  const minutes = Number(match[2])
  const seconds = Number(match[3] ?? 0)
  if (hours > 23 || minutes > 59 || seconds > 59) return null

  const tcDate = new Date(tcHitMs)
  const restart = new Date(
    tcDate.getFullYear(),
    tcDate.getMonth(),
    tcDate.getDate(),
    hours,
    minutes,
    seconds,
    0
  )

  // If a rally crosses midnight, a small clock time after a late-night TC belongs to the next day.
  if (restart.getTime() < tcHitMs && tcHitMs - restart.getTime() > 12 * 60 * 60 * 1000) {
    restart.setDate(restart.getDate() + 1)
  }

  return restart.getTime()
}

function editableClockMs(clockValue: string, referenceMs: number): number | null {
  const match = /^(\d{1,2}):(\d{2})(?::(\d{2}))?$/.exec(clockValue.trim())
  if (!match) return null

  const hours = Number(match[1])
  const minutes = Number(match[2])
  const seconds = Number(match[3] ?? 0)
  if (hours > 23 || minutes > 59 || seconds > 59) return null

  const reference = new Date(referenceMs)
  const candidates = [-1, 0, 1].map((dayOffset) => {
    const candidate = new Date(
      reference.getFullYear(),
      reference.getMonth(),
      reference.getDate() + dayOffset,
      hours,
      minutes,
      seconds,
      0
    )
    return candidate.getTime()
  })

  return candidates.reduce((best, candidate) =>
    Math.abs(candidate - referenceMs) < Math.abs(best - referenceMs) ? candidate : best
  )
}

const DEFAULT_SETTINGS: RallySettings = {
  startDateTime: localDateTimeValue(),
  calibrationFactor: 1,
  scratchSeconds: 0,
  sectors: [
    { id: crypto.randomUUID(), fromKm: 0, toKm: 5, speedKph: 30 },
    { id: crypto.randomUUID(), fromKm: 5, toKm: 10, speedKph: 40 },
    { id: crypto.randomUUID(), fromKm: 10, toKm: 15, speedKph: 35 }
  ]
}

const DEFAULT_SESSION: RallySession = {
  status: 'idle',
  startMs: null,
  stopMs: null,
  rawBaselineKm: 0,
  manualOffsetKm: 0,
  timingAnchorDistanceKm: 0,
  timingAnchorIdealElapsedSeconds: 0,
  tcCount: 0,
  tcLogs: [],
  sftcLogs: [],
  pendingRestartTcId: null,
  pendingSftcId: null
}

function App() {
  const [screen, setScreen] = useState<Screen>('setup')
  const [settings, setSettings] = useState<RallySettings>(() => loadJson(SETTINGS_KEY, DEFAULT_SETTINGS))
  const [session, setSession] = useState<RallySession>(() => loadJson(SESSION_KEY, DEFAULT_SESSION))
  const [nowMs, setNowMs] = useState(Date.now())
  const { gps, startGps } = useGpsOdometer()
  const wake = useWakeLock(session.status === 'armed' || session.status === 'running')

  const sortedSectors = useMemo(() => sortSectors(settings.sectors), [settings.sectors])
  const sectorErrors = useMemo(() => validateSectors(sortedSectors), [sortedSectors])

  useEffect(() => saveJson(SETTINGS_KEY, settings), [settings])
  useEffect(() => saveJson(SESSION_KEY, session), [session])

  useEffect(() => {
    startGps()
  }, [startGps])

  useEffect(() => {
    const timer = window.setInterval(() => setNowMs(Date.now()), 100)
    return () => window.clearInterval(timer)
  }, [])

  useEffect(() => {
    if (session.status === 'armed' && session.startMs !== null && nowMs >= session.startMs) {
      setSession((current) => current.status === 'armed'
        ? {
            ...current,
            status: 'running',
            stopMs: null,
            rawBaselineKm: gps.rawDistanceKm,
            manualOffsetKm: 0,
            timingAnchorDistanceKm: 0,
            timingAnchorIdealElapsedSeconds: 0,
            tcCount: 0,
            tcLogs: [],
            sftcLogs: [],
            pendingRestartTcId: null,
            pendingSftcId: null
          }
        : current)
    }
  }, [nowMs, session.status, session.startMs, gps.rawDistanceKm])

  const measuredKm = Math.max(0, gps.rawDistanceKm - session.rawBaselineKm)
  const rallyDistanceKm = Math.max(0, measuredKm * settings.calibrationFactor + session.manualOffsetKm)
  const elapsedEndMs = session.status === 'stopped' ? (session.stopMs ?? nowMs) : nowMs
  const actualElapsedSeconds = session.startMs !== null && (session.status === 'running' || session.status === 'stopped')
    ? Math.max(0, (elapsedEndMs - session.startMs) / 1000)
    : 0
  const idealElapsedSeconds = idealElapsedSecondsFromAnchor(
    rallyDistanceKm,
    sortedSectors,
    session.timingAnchorDistanceKm,
    session.timingAnchorIdealElapsedSeconds
  )
  const deltaSeconds = deviationSeconds(actualElapsedSeconds, idealElapsedSeconds)
  const currentSegment = segmentAtDistance(rallyDistanceKm, sortedSectors)
  const targetSpeed = currentSegment ? effectiveSpeedKph(currentSegment) : 0
  const nextChange = nextSpeedChange(rallyDistanceKm, sortedSectors)
  const routeKm = totalRouteKm(sortedSectors)
  const remainingKm = Math.max(0, routeKm - rallyDistanceKm)
  const tcLogs = session.tcLogs ?? []
  const sftcLogs = session.sftcLogs ?? []

  const newRunSession = (status: RallySession['status'], startMs: number): RallySession => ({
    status,
    startMs,
    stopMs: null,
    rawBaselineKm: gps.rawDistanceKm,
    manualOffsetKm: 0,
    timingAnchorDistanceKm: 0,
    timingAnchorIdealElapsedSeconds: 0,
    tcCount: 0,
    tcLogs: [],
    sftcLogs: [],
    pendingRestartTcId: null,
    pendingSftcId: null
  })

  const arm = () => {
    if (sectorErrors.length) {
      alert(sectorErrors[0])
      setScreen('setup')
      return
    }
    const startMs = new Date(settings.startDateTime).getTime()
    if (!Number.isFinite(startMs)) {
      alert('Set a valid official start date and time.')
      return
    }
    setSession(newRunSession('armed', startMs))
    setScreen('rally')
  }

  const startNow = () => {
    if (sectorErrors.length) {
      alert(sectorErrors[0])
      setScreen('setup')
      return
    }
    const startMs = Date.now()
    setSettings((current) => ({ ...current, startDateTime: localDateTimeValue(new Date(startMs)) }))
    setSession(newRunSession('running', startMs))
    setScreen('rally')
  }

  const resetRun = () => {
    if (!confirm('Reset the current rally session? Speed chart, scratch time and calibration will be kept.')) return
    setSession(DEFAULT_SESSION)
  }

  const endSession = () => {
    if (session.status !== 'running') return
    if (!confirm('End this rally session and freeze the session log?')) return
    setSession((current) => ({ ...current, status: 'stopped', stopMs: Date.now(), pendingRestartTcId: null, pendingSftcId: null }))
  }

  const changeOdo = (deltaKm: number) => {
    setSession((current) => ({ ...current, manualOffsetKm: current.manualOffsetKm + deltaKm }))
  }

  const setOdo = () => {
    const value = window.prompt('Set rally odometer (km)', rallyDistanceKm.toFixed(3))
    if (value === null) return
    const desiredKm = Number(value)
    if (!Number.isFinite(desiredKm) || desiredKm < 0) return
    const rawCorrectedKm = measuredKm * settings.calibrationFactor
    setSession((current) => ({ ...current, manualOffsetKm: desiredKm - rawCorrectedKm }))
  }

  const markTc = () => {
    if (session.status !== 'running' || session.startMs === null) return

    const hitMs = Date.now()
    const hitElapsedSeconds = Math.max(0, (hitMs - session.startMs) / 1000)
    const hitIdealElapsedSeconds = idealElapsedSecondsFromAnchor(
      rallyDistanceKm,
      sortedSectors,
      session.timingAnchorDistanceKm,
      session.timingAnchorIdealElapsedSeconds
    )
    const hitDeviationSeconds = deviationSeconds(hitElapsedSeconds, hitIdealElapsedSeconds)
    const point = gps.lastAcceptedPoint

    const log: TcLog = {
      id: crypto.randomUUID(),
      number: tcLogs.length + 1,
      hitMs,
      odoKm: rallyDistanceKm,
      deviationSeconds: hitDeviationSeconds,
      actualElapsedSeconds: hitElapsedSeconds,
      idealElapsedSeconds: hitIdealElapsedSeconds,
      scratchSeconds: settings.scratchSeconds,
      gpsAccuracyM: gps.accuracyM,
      lat: point?.lat ?? null,
      lon: point?.lon ?? null,
      officialRestartMs: null,
      scratchOverridden: false,
      previousAnchorDistanceKm: session.timingAnchorDistanceKm,
      previousAnchorIdealElapsedSeconds: session.timingAnchorIdealElapsedSeconds
    }

    setSession((current) => ({
      ...current,
      timingAnchorDistanceKm: rallyDistanceKm,
      timingAnchorIdealElapsedSeconds: hitElapsedSeconds + settings.scratchSeconds,
      tcCount: (current.tcLogs?.length ?? current.tcCount) + 1,
      tcLogs: [...(current.tcLogs ?? []), log],
      pendingRestartTcId: log.id
    }))

    if ('vibrate' in navigator) navigator.vibrate?.(60)
  }

  const updateTcCorrection = (tcId: string, correctedOdoKm: number, correctedClockValue: string) => {
    if (session.startMs === null) return

    const tcIndex = tcLogs.findIndex((log) => log.id === tcId)
    if (tcIndex < 0) return

    const tc = tcLogs[tcIndex]
    const correctedHitMs = editableClockMs(correctedClockValue, tc.hitMs)

    if (correctedHitMs === null || !Number.isFinite(correctedOdoKm) || correctedOdoKm < 0) {
      alert('Enter a valid TC odometer and time.')
      return
    }

    const previousAnchorDistanceKm = tc.previousAnchorDistanceKm ?? 0
    const previousAnchorIdealElapsedSeconds = tc.previousAnchorIdealElapsedSeconds ?? 0
    const correctedElapsedSeconds = Math.max(0, (correctedHitMs - session.startMs) / 1000)
    const correctedIdealElapsedSeconds = idealElapsedSecondsFromAnchor(
      correctedOdoKm,
      sortedSectors,
      previousAnchorDistanceKm,
      previousAnchorIdealElapsedSeconds
    )
    const correctedDeviationSeconds = deviationSeconds(correctedElapsedSeconds, correctedIdealElapsedSeconds)
    const isLatestTc = tcIndex === tcLogs.length - 1

    setSession((current) => {
      const nextLogs = (current.tcLogs ?? []).map((log) => log.id === tcId
        ? {
            ...log,
            hitMs: correctedHitMs,
            odoKm: correctedOdoKm,
            actualElapsedSeconds: correctedElapsedSeconds,
            idealElapsedSeconds: correctedIdealElapsedSeconds,
            deviationSeconds: correctedDeviationSeconds
          }
        : log)

      if (!isLatestTc) {
        return { ...current, tcLogs: nextLogs }
      }

      const liveAnchorIdealElapsedSeconds = tc.officialRestartMs
        ? Math.max(0, (tc.officialRestartMs - session.startMs!) / 1000)
        : correctedElapsedSeconds + tc.scratchSeconds

      return {
        ...current,
        tcLogs: nextLogs,
        timingAnchorDistanceKm: correctedOdoKm,
        timingAnchorIdealElapsedSeconds: liveAnchorIdealElapsedSeconds
      }
    })

    if ('vibrate' in navigator) navigator.vibrate?.(40)
  }

  const applyOfficialRestart = (tcId: string, clockValue: string) => {
    if (session.status !== 'running' || session.startMs === null) return

    const tc = tcLogs.find((log) => log.id === tcId)
    if (!tc) return

    const restartMs = restartMsFromClock(clockValue, tc.hitMs)
    if (restartMs === null) {
      alert('Enter a valid official restart time.')
      return
    }
    if (restartMs < tc.hitMs) {
      alert('Official restart time cannot be before the TC arrival time.')
      return
    }

    const anchorElapsedSeconds = Math.max(0, (restartMs - session.startMs) / 1000)

    setSession((current) => ({
      ...current,
      timingAnchorDistanceKm: tc.odoKm,
      timingAnchorIdealElapsedSeconds: anchorElapsedSeconds,
      pendingRestartTcId: null,
      tcLogs: (current.tcLogs ?? []).map((log) => log.id === tcId
        ? { ...log, officialRestartMs: restartMs, scratchOverridden: true }
        : log)
    }))

    if ('vibrate' in navigator) navigator.vibrate?.([70, 40, 70])
  }

  const dismissRestartOption = () => {
    setSession((current) => ({ ...current, pendingRestartTcId: null }))
  }

  const markSftc = () => {
    if (session.status !== 'running' || session.startMs === null) return

    const hitMs = Date.now()
    const hitElapsedSeconds = Math.max(0, (hitMs - session.startMs) / 1000)
    const hitIdealElapsedSeconds = idealElapsedSecondsFromAnchor(
      rallyDistanceKm,
      sortedSectors,
      session.timingAnchorDistanceKm,
      session.timingAnchorIdealElapsedSeconds
    )
    const hitDeviationSeconds = deviationSeconds(hitElapsedSeconds, hitIdealElapsedSeconds)
    const point = gps.lastAcceptedPoint
    const cardTimeMs = Math.floor((session.startMs + hitIdealElapsedSeconds * 1000) / 1000) * 1000

    const log: SftcLog = {
      id: crypto.randomUUID(),
      number: sftcLogs.length + 1,
      hitMs,
      cardTimeMs,
      odoKm: rallyDistanceKm,
      deviationSeconds: hitDeviationSeconds,
      actualElapsedSeconds: hitElapsedSeconds,
      idealElapsedSeconds: hitIdealElapsedSeconds,
      gpsAccuracyM: gps.accuracyM,
      lat: point?.lat ?? null,
      lon: point?.lon ?? null
    }

    setSession((current) => ({
      ...current,
      sftcLogs: [...(current.sftcLogs ?? []), log],
      pendingSftcId: log.id
    }))

    if ('vibrate' in navigator) navigator.vibrate?.([60, 40, 60])
  }

  const dismissSftc = () => {
    setSession((current) => ({ ...current, pendingSftcId: null }))
  }

  return (
    <div className="app-shell">
      <header className="topbar">
        <div>
          <div className="eyebrow">TSD RALLY V0.5</div>
          <div className="brand">RALLY COMPUTER</div>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
          <InstallAppButton />
          <div className={`gps-pill ${gps.accuracyM !== null && gps.accuracyM <= 15 ? 'good' : gps.accuracyM !== null && gps.accuracyM <= 30 ? 'fair' : 'poor'}`}>
            GPS {gps.enabled ? (gps.accuracyM === null ? '…' : `${Math.round(gps.accuracyM)}m`) : 'OFF'}
          </div>
        </div>
      </header>

      <nav className="nav-tabs" aria-label="Main screens">
        <button className={screen === 'setup' ? 'active' : ''} onClick={() => setScreen('setup')}>SETUP</button>
        <button className={screen === 'rally' ? 'active' : ''} onClick={() => setScreen('rally')}>RALLY</button>
        <button className={screen === 'controls' ? 'active' : ''} onClick={() => setScreen('controls')}>CONTROLS</button>
      </nav>

      {screen === 'setup' && (
        <SetupScreen
          settings={settings}
          setSettings={setSettings}
          errors={sectorErrors}
          gpsError={gps.error}
          arm={arm}
          startNow={startNow}
        />
      )}

      {screen === 'rally' && (
        <RallyScreen
          status={session.status}
          startMs={session.startMs}
          stopMs={session.stopMs}
          nowMs={nowMs}
          deltaSeconds={deltaSeconds}
          targetSpeed={targetSpeed}
          currentSegment={currentSegment}
          rallyDistanceKm={rallyDistanceKm}
          remainingKm={remainingKm}
          nextChange={nextChange}
          actualElapsedSeconds={actualElapsedSeconds}
          idealElapsedSeconds={idealElapsedSeconds}
          gpsSpeedKph={gps.speedKph}
          gpsEnabled={gps.enabled}
          gpsError={gps.error}
          wakeHeld={wake.held}
          wakeSupported={wake.supported}
          tcLogs={tcLogs}
          sftcLogs={sftcLogs}
          pendingRestartTcId={session.pendingRestartTcId ?? null}
          pendingSftcId={session.pendingSftcId ?? null}
          arm={arm}
          startNow={startNow}
          endSession={endSession}
          resetRun={resetRun}
          changeOdo={changeOdo}
          setOdo={setOdo}
          markTc={markTc}
          markSftc={markSftc}
          applyOfficialRestart={applyOfficialRestart}
          dismissRestartOption={dismissRestartOption}
          dismissSftc={dismissSftc}
        />
      )}

      {screen === 'controls' && (
        <ControlsScreen
          tcLogs={tcLogs}
          sftcLogs={sftcLogs}
          updateTcCorrection={updateTcCorrection}
        />
      )}

      <footer className="footer-note">Roadbook distance is the master reference. Correct the odometer whenever you have a trusted distance.</footer>
    </div>
  )
}

type SetupProps = {
  settings: RallySettings
  setSettings: React.Dispatch<React.SetStateAction<RallySettings>>
  errors: string[]
  gpsError: string | null
  arm: () => void
  startNow: () => void
}

function SetupScreen({ settings, setSettings, errors, gpsError, arm, startNow }: SetupProps) {
  const [officialKm, setOfficialKm] = useState('5.000')
  const [measuredKm, setMeasuredKm] = useState('5.000')

  const updateSegment = (id: string, patch: Partial<SpeedSector>) => {
    setSettings((current) => ({
      ...current,
      sectors: current.sectors.map((segment) => segment.id === id ? { ...segment, ...patch } : segment)
    }))
  }

  const updateNumber = (id: string, field: 'fromKm' | 'toKm' | 'speedKph', value: string) => {
    updateSegment(id, { [field]: Number(value) })
  }

  const revealNewEntry = (id: string) => {
    // Wait for React to render the new row, then keep the navigator at the latest entry.
    window.requestAnimationFrame(() => {
      window.requestAnimationFrame(() => {
        const entry = document.getElementById(`chart-entry-${id}`)
        entry?.scrollIntoView({ behavior: 'smooth', block: 'center' })
        const input = entry?.querySelector<HTMLInputElement>('[data-new-entry-focus="true"]')
        input?.focus()
        input?.select()
      })
    })
  }

  const addSector = () => {
    const id = crypto.randomUUID()
    setSettings((current) => {
      const sorted = sortSectors(current.sectors)
      const last = sorted[sorted.length - 1]
      const from = last?.toKm ?? 0
      return {
        ...current,
        sectors: [...sorted, { id, fromKm: from, toKm: from + 5, speedKph: 30, kind: 'speed' }]
      }
    })
    revealNewEntry(id)
  }

  const addNextSpeedOnEnter = (event: React.KeyboardEvent<HTMLInputElement>, segmentId: string) => {
    if (event.key !== 'Enter') return
    event.preventDefault()

    const sorted = sortSectors(settings.sectors)
    const index = sorted.findIndex((segment) => segment.id === segmentId)
    if (index !== sorted.length - 1) {
      const next = sorted[index + 1]
      const nextEntry = next ? document.getElementById(`chart-entry-${next.id}`) : null
      nextEntry?.querySelector<HTMLInputElement>('[data-new-entry-focus="true"]')?.focus()
      return
    }

    addSector()
  }

  const addZone = () => {
    const id = crypto.randomUUID()
    setSettings((current) => {
      const sorted = sortSectors(current.sectors)
      const last = sorted[sorted.length - 1]
      const from = last?.toKm ?? 0
      return {
        ...current,
        sectors: [...sorted, {
          id,
          fromKm: from,
          toKm: from + 2,
          speedKph: 20,
          kind: 'zone',
          zoneType: 'FZ',
          zoneBasis: 'speed',
          zoneDurationSeconds: 120
        }]
      }
    })
    revealNewEntry(id)
  }

  const removeSector = (id: string) => {
    setSettings((current) => ({ ...current, sectors: current.sectors.filter((segment) => segment.id !== id) }))
  }

  const setZoneMinutes = (segment: SpeedSector, minutes: number) => {
    const secondsPart = Math.max(0, segment.zoneDurationSeconds ?? 0) % 60
    updateSegment(segment.id, { zoneDurationSeconds: Math.max(0, Math.round(minutes)) * 60 + secondsPart })
  }

  const setZoneSecondsPart = (segment: SpeedSector, secondsPart: number) => {
    const minutes = Math.floor(Math.max(0, segment.zoneDurationSeconds ?? 0) / 60)
    updateSegment(segment.id, { zoneDurationSeconds: minutes * 60 + Math.max(0, Math.min(59, Math.round(secondsPart))) })
  }

  const setScratchMinutes = (minutes: number) => {
    const secondsPart = settings.scratchSeconds % 60
    setSettings((current) => ({ ...current, scratchSeconds: Math.max(0, Math.round(minutes)) * 60 + secondsPart }))
  }

  const setScratchSecondsPart = (secondsPart: number) => {
    const minutes = Math.floor(settings.scratchSeconds / 60)
    setSettings((current) => ({ ...current, scratchSeconds: minutes * 60 + Math.max(0, Math.min(59, Math.round(secondsPart))) }))
  }

  const calculateCalibration = () => {
    const official = Number(officialKm)
    const measured = Number(measuredKm)
    if (!(official > 0) || !(measured > 0)) return
    setSettings((current) => ({ ...current, calibrationFactor: official / measured }))
  }

  return (
    <main className="content setup-screen">
      <section className="panel start-panel">
        <h2>START</h2>
        <label>Official start time
          <input type="datetime-local" step="1" value={settings.startDateTime} onChange={(e) => setSettings((s) => ({ ...s, startDateTime: e.target.value }))} />
        </label>
        <div className="launch-row">
          <button className="primary-button" onClick={arm}>ARM START</button>
          <button className="secondary-button" onClick={startNow}>START NOW</button>
        </div>
      </section>

      <section className="panel speed-chart-panel">
        <div className="section-head">
          <h2>SPEED CHART</h2>
        </div>
        <p className="section-copy">Enter the chart in distance order. Add DZ/FZ only where it appears in the official speed chart.</p>

        <SpeedChartImporter
          onLoad={(sectors) => setSettings((current) => ({ ...current, sectors }))}
        />

        {sortSectors(settings.sectors).map((segment, index) => segmentKind(segment) === 'zone' ? (
          <div className="zone-entry" id={`chart-entry-${segment.id}`} key={segment.id}>
            <div className="zone-entry-head">
              <div className="zone-title-row">
                <strong>DZ/FZ</strong>
              </div>
              <button className="delete-text-button" onClick={() => removeSector(segment.id)}>REMOVE</button>
            </div>

            <div className="zone-distance-grid">
              <label>FROM km<input inputMode="decimal" type="number" step="0.001" value={segment.fromKm} onChange={(e) => updateNumber(segment.id, 'fromKm', e.target.value)} /></label>
              <label>TO km<input data-new-entry-focus="true" inputMode="decimal" type="number" step="0.001" value={segment.toKm} onChange={(e) => updateNumber(segment.id, 'toKm', e.target.value)} /></label>
            </div>

            <div className="zone-basis-toggle">
              <button className={zoneBasis(segment) === 'speed' ? 'active' : ''} onClick={() => updateSegment(segment.id, { zoneBasis: 'speed' })}>SPEED</button>
              <button className={zoneBasis(segment) === 'time' ? 'active' : ''} onClick={() => updateSegment(segment.id, { zoneBasis: 'time' })}>TIME</button>
            </div>

            {zoneBasis(segment) === 'speed' ? (
              <label className="zone-value-field">ZONE SPEED km/h
                <input inputMode="decimal" type="number" step="0.1" value={segment.speedKph} onChange={(e) => updateNumber(segment.id, 'speedKph', e.target.value)} onKeyDown={(e) => addNextSpeedOnEnter(e, segment.id)} />
              </label>
            ) : (
              <div className="zone-time-fields">
                <label>MIN<input type="number" min="0" step="1" value={Math.floor(Math.max(0, segment.zoneDurationSeconds ?? 0) / 60)} onChange={(e) => setZoneMinutes(segment, Number(e.target.value))} /></label>
                <label>SEC<input type="number" min="0" max="59" step="1" value={Math.max(0, segment.zoneDurationSeconds ?? 0) % 60} onChange={(e) => setZoneSecondsPart(segment, Number(e.target.value))} onKeyDown={(e) => addNextSpeedOnEnter(e, segment.id)} /></label>
              </div>
            )}
          </div>
        ) : (
          <div className="speed-entry" id={`chart-entry-${segment.id}`} key={segment.id}>
            <div className="speed-entry-label">SPEED {String(index + 1).padStart(2, '0')}</div>
            <div className="sector-row">
              <label>FROM km<input inputMode="decimal" type="number" step="0.001" value={segment.fromKm} onChange={(e) => updateNumber(segment.id, 'fromKm', e.target.value)} /></label>
              <label>TO km<input data-new-entry-focus="true" inputMode="decimal" type="number" step="0.001" value={segment.toKm} onChange={(e) => updateNumber(segment.id, 'toKm', e.target.value)} /></label>
              <label>AVG km/h<input inputMode="decimal" type="number" step="0.1" value={segment.speedKph} onChange={(e) => updateNumber(segment.id, 'speedKph', e.target.value)} onKeyDown={(e) => addNextSpeedOnEnter(e, segment.id)} /></label>
              <button className="delete-button" aria-label="Delete speed entry" onClick={() => removeSector(segment.id)}>×</button>
            </div>
          </div>
        ))}

        <div className="chart-add-buttons">
          <button className="small-button" onClick={addSector}>+ SPEED</button>
          <button className="small-button zone-add" onClick={addZone}>+ DZ/FZ</button>
        </div>

        {errors.length > 0 && <div className="error-box">{errors.map((error) => <div key={error}>{error}</div>)}</div>}
      </section>

      <section className="panel scratch-panel">
        <h2>TC SCRATCH TIME</h2>
        <div className="scratch-fields">
          <label>MIN
            <input type="number" min="0" step="1" value={Math.floor(settings.scratchSeconds / 60)} onChange={(e) => setScratchMinutes(Number(e.target.value))} />
          </label>
          <label>SEC
            <input type="number" min="0" max="59" step="1" value={settings.scratchSeconds % 60} onChange={(e) => setScratchSecondsPart(Number(e.target.value))} />
          </label>
        </div>
      </section>

      <details className="panel calibration-panel">
        <summary>ODOMETER CALIBRATION <span>OPTIONAL</span></summary>
        <div className="two-col">
          <label>Official km<input type="number" step="0.001" value={officialKm} onChange={(e) => setOfficialKm(e.target.value)} /></label>
          <label>GPS measured km<input type="number" step="0.001" value={measuredKm} onChange={(e) => setMeasuredKm(e.target.value)} /></label>
        </div>
        <button className="secondary-button full-button" onClick={calculateCalibration}>CALCULATE</button>
        <div className="factor-line">FACTOR <strong>{settings.calibrationFactor.toFixed(6)}</strong></div>
      </details>

      {gpsError && <div className="error-box">GPS: {gpsError}. Location starts automatically; allow precise location in the browser/app settings.</div>}
    </main>
  )
}

type RallyScreenProps = {
  status: RallySession['status']
  startMs: number | null
  stopMs: number | null
  nowMs: number
  deltaSeconds: number
  targetSpeed: number
  currentSegment: SpeedSector | null
  rallyDistanceKm: number
  remainingKm: number
  nextChange: ReturnType<typeof nextSpeedChange>
  actualElapsedSeconds: number
  idealElapsedSeconds: number
  gpsSpeedKph: number | null
  gpsEnabled: boolean
  gpsError: string | null
  wakeHeld: boolean
  wakeSupported: boolean
  tcLogs: TcLog[]
  sftcLogs: SftcLog[]
  pendingRestartTcId: string | null
  pendingSftcId: string | null
  arm: () => void
  startNow: () => void
  endSession: () => void
  resetRun: () => void
  changeOdo: (deltaKm: number) => void
  setOdo: () => void
  markTc: () => void
  markSftc: () => void
  applyOfficialRestart: (tcId: string, clockValue: string) => void
  dismissRestartOption: () => void
  dismissSftc: () => void
}

function timingState(seconds: number) {
  if (seconds > 0.8) return 'LATE'
  if (seconds < -0.8) return 'EARLY'
  return 'ON TIME'
}

function clockTime(ms: number | null) {
  if (ms === null) return '—'
  return new Date(ms).toLocaleTimeString([], { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' })
}

function RallyScreen(props: RallyScreenProps) {
  const {
    status, startMs, stopMs, nowMs, deltaSeconds, targetSpeed, currentSegment, rallyDistanceKm, remainingKm, nextChange,
    actualElapsedSeconds, idealElapsedSeconds, gpsSpeedKph, gpsEnabled, gpsError, wakeHeld, wakeSupported, tcLogs, sftcLogs,
    pendingRestartTcId, pendingSftcId, arm, startNow, endSession, resetRun, changeOdo, setOdo, markTc, markSftc,
    applyOfficialRestart, dismissRestartOption, dismissSftc
  } = props

  const activeTcLog = pendingRestartTcId ? (tcLogs.find((log) => log.id === pendingRestartTcId) ?? null) : null
  const activeSftcLog = pendingSftcId ? (sftcLogs.find((log) => log.id === pendingSftcId) ?? null) : null
  const [restartTime, setRestartTime] = useState('')

  useEffect(() => {
    if (activeTcLog) setRestartTime(timeInputValue())
  }, [activeTcLog?.id])

  const waitingSeconds = status === 'armed' && startMs ? Math.max(0, (startMs - nowMs) / 1000) : 0
  const timingClass = deltaSeconds > 0.8 ? 'late' : deltaSeconds < -0.8 ? 'early' : 'on-time'
  const stateLabel = timingState(deltaSeconds)
  const inZone = currentSegment !== null && segmentKind(currentSegment) === 'zone'
  const currentZoneBasis = currentSegment ? zoneBasis(currentSegment) : 'speed'

  if (status === 'idle') {
    return (
      <main className="content rally-empty">
        <div className="empty-card">
          <div className="eyebrow">RALLY COMPUTER READY</div>
          <h1>Set the speed chart, then arm the start.</h1>
          <button className="primary-button" onClick={arm}>ARM START</button>
          <button className="secondary-button" onClick={startNow}>START NOW</button>
        </div>
      </main>
    )
  }

  if (status === 'stopped') {
    return (
      <main className="content session-log-screen">
        <section className="panel session-summary">
          <div className="eyebrow">SESSION COMPLETE</div>
          <h1>SESSION LOG</h1>
          <div className="summary-grid">
            <div><span>DISTANCE</span><strong>{rallyDistanceKm.toFixed(3)}</strong><small>km</small></div>
            <div><span>ELAPSED</span><strong>{formatElapsed(actualElapsedSeconds)}</strong></div>
            <div><span>CONTROLS</span><strong>{tcLogs.length} / {sftcLogs.length}</strong><small>TC / SFTC</small></div>
            <div><span>FINAL</span><strong>{formatDeviation(deltaSeconds)}</strong><small>{stateLabel}</small></div>
          </div>
          <div className="session-times"><span>START {clockTime(startMs)}</span><span>END {clockTime(stopMs)}</span></div>
        </section>

        <section className="panel tc-log-panel">
          <h2>TIME CONTROLS</h2>
          {tcLogs.length === 0 ? (
            <p className="empty-log">No TCs were marked in this session.</p>
          ) : tcLogs.map((log) => (
            <div className="tc-log-row" key={log.id}>
              <div className="tc-log-number">TC {String(log.number).padStart(2, '0')}</div>
              <div><span>ODO</span><strong>{log.odoKm.toFixed(3)} km</strong></div>
              <div><span>TIME</span><strong>{clockTime(log.hitMs)}</strong></div>
              <div><span>STATUS</span><strong>{formatDeviation(log.deviationSeconds)} {timingState(log.deviationSeconds)}</strong></div>
              <div>
                <span>{log.officialRestartMs ? 'RESTART' : 'SCRATCH'}</span>
                <strong>{log.officialRestartMs ? `${clockTime(log.officialRestartMs)} · SCRATCH OVERRIDDEN` : formatDuration(log.scratchSeconds)}</strong>
              </div>
              <div><span>GPS</span><strong>{log.gpsAccuracyM === null ? '—' : `${Math.round(log.gpsAccuracyM)} m`}</strong></div>
            </div>
          ))}
        </section>

        <section className="panel tc-log-panel">
          <h2>SELF TIME CONTROLS</h2>
          {sftcLogs.length === 0 ? (
            <p className="empty-log">No SFTCs were marked in this session.</p>
          ) : sftcLogs.map((log) => (
            <div className="tc-log-row" key={log.id}>
              <div className="tc-log-number">SFTC {String(log.number).padStart(2, '0')}</div>
              <div><span>ODO</span><strong>{log.odoKm.toFixed(3)} km</strong></div>
              <div><span>WRITE</span><strong>{clockTime(log.cardTimeMs)}</strong></div>
              <div><span>ACTUAL</span><strong>{clockTime(log.hitMs)}</strong></div>
              <div><span>STATUS</span><strong>{formatDeviation(log.deviationSeconds)} {timingState(log.deviationSeconds)}</strong></div>
              <div><span>GPS</span><strong>{log.gpsAccuracyM === null ? '—' : `${Math.round(log.gpsAccuracyM)} m`}</strong></div>
            </div>
          ))}
        </section>

        <button className="primary-button full-button" onClick={resetRun}>NEW SESSION</button>
      </main>
    )
  }

  const nextLabel = nextChange
    ? nextChange.nextKind === 'zone'
      ? nextChange.nextZoneBasis === 'time'
        ? `${nextChange.nextZoneType} ${formatDuration(nextChange.nextZoneDurationSeconds ?? 0)}`
        : `${nextChange.nextZoneType} ${nextChange.nextSpeedKph.toFixed(1)}`
      : nextChange.nextSpeedKph.toFixed(1)
    : null

  return (
    <main className="content rally-screen">
      {status === 'armed' ? (
        <section className="armed-card">
          <div className="eyebrow">ARMED</div>
          <div className="countdown">{waitingSeconds.toFixed(1)}</div>
          <div className="countdown-label">SECONDS TO START</div>
          <div className="clock-line">START {clockTime(startMs)}</div>
          <div className="rally-flags"><span>GPS {gpsEnabled ? 'LIVE' : 'OFF'}</span><span>WAKE {wakeHeld ? 'ON' : wakeSupported ? 'WAIT' : 'N/A'}</span></div>
        </section>
      ) : (
        <>
          <section className={`delta-card ${timingClass}`}>
            <div className="delta-number">{formatDeviation(deltaSeconds)}</div>
            <div className="delta-label">SECONDS {stateLabel}</div>
          </section>

          <section className="target-card">
            <div>
              <span>{inZone ? `DZ/FZ ${currentZoneBasis === 'time' ? 'TIME' : 'SPEED'}` : 'TARGET'}</span>
              {inZone && currentZoneBasis === 'time' ? (
                <strong className="time-target">{formatDuration(currentSegment?.zoneDurationSeconds ?? 0)}</strong>
              ) : (
                <><strong>{targetSpeed.toFixed(1)}</strong><small>km/h</small></>
              )}
            </div>
            <div><span>GPS SPEED</span><strong>{gpsSpeedKph === null ? '—' : gpsSpeedKph.toFixed(1)}</strong><small>km/h</small></div>
          </section>

          <section className="trip-card">
            <span>RALLY ODOMETER</span>
            <strong>{rallyDistanceKm.toFixed(3)}</strong>
            <small>km</small>
          </section>

          <section className="next-card">
            <span>NEXT CHART CHANGE</span>
            {nextChange ? (
              <div className="next-main"><strong>{nextChange.distanceKm.toFixed(3)} km</strong><b>→ {nextLabel}</b></div>
            ) : (
              <div className="next-main"><strong>END OF CHART</strong><b>{remainingKm.toFixed(3)} km</b></div>
            )}
          </section>

          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '10px' }}>
            <button className="tc-button" style={{ width: '100%', margin: 0 }} onClick={markTc}>TC</button>
            <button className="tc-button" style={{ width: '100%', margin: 0 }} onClick={markSftc} disabled={Boolean(activeSftcLog)}>SFTC</button>
          </div>

          {activeSftcLog && (
            <section className="panel" style={{ textAlign: 'center' }}>
              <div className="eyebrow">SFTC {String(activeSftcLog.number).padStart(2, '0')} RECORDED</div>
              <h2 style={{ marginBottom: '8px' }}>WRITE</h2>
              <div style={{ fontSize: '3.2rem', lineHeight: 1, fontWeight: 900, letterSpacing: '0.02em', margin: '10px 0 18px' }}>
                {clockTime(activeSftcLog.cardTimeMs)}
              </div>
              <div className="session-times" style={{ justifyContent: 'center', gap: '16px', flexWrap: 'wrap' }}>
                <span>ODO {activeSftcLog.odoKm.toFixed(3)} km</span>
                <span>ACTUAL {clockTime(activeSftcLog.hitMs)}</span>
                <span>{formatDeviation(activeSftcLog.deviationSeconds)} {timingState(activeSftcLog.deviationSeconds)}</span>
              </div>
              <button className="primary-button full-button" style={{ marginTop: '16px' }} onClick={dismissSftc}>OK</button>
            </section>
          )}

          {activeTcLog && (
            <section className="panel">
              <div className="eyebrow">TC {String(activeTcLog.number).padStart(2, '0')} RECORDED</div>
              <h2>NEW START TIME?</h2>
              <p className="section-copy">Normal scratch is active. Use this only if the marshal gives you an official new start time.</p>
              <label>OFFICIAL RESTART TIME
                <input type="time" step="1" value={restartTime} onChange={(e) => setRestartTime(e.target.value)} />
              </label>
              <div className="launch-row">
                <button className="primary-button" onClick={() => applyOfficialRestart(activeTcLog.id, restartTime)}>APPLY NEW START</button>
                <button className="secondary-button" onClick={dismissRestartOption}>DISMISS</button>
              </div>
            </section>
          )}

          <section className="odo-controls">
            <button onClick={() => changeOdo(-0.01)}>−10 m</button>
            <button className="set-odo" onClick={setOdo}>SET ODO</button>
            <button onClick={() => changeOdo(0.01)}>+10 m</button>
          </section>

          <section className="timing-strip">
            <div><span>ACTUAL TIME</span><strong>{clockTime(status === 'stopped' ? stopMs : nowMs)}</strong></div>
            <div><span>IDEAL TIME</span><strong>{startMs === null ? '—' : clockTime(startMs + idealElapsedSeconds * 1000)}</strong></div>
          </section>
        </>
      )}

      {gpsError && <div className="error-box">GPS: {gpsError}</div>}
      <div className="rally-actions">
        {status === 'running' && <button className="stop-button" onClick={endSession}>END SESSION</button>}
        <button className="ghost-button" onClick={resetRun}>RESET RUN</button>
      </div>
    </main>
  )
}

type ControlsScreenProps = {
  tcLogs: TcLog[]
  sftcLogs: SftcLog[]
  updateTcCorrection: (tcId: string, correctedOdoKm: number, correctedClockValue: string) => void
}

function ControlsScreen({ tcLogs, sftcLogs, updateTcCorrection }: ControlsScreenProps) {
  const latestTcId = tcLogs.length ? tcLogs[tcLogs.length - 1].id : null

  return (
    <main className="content controls-screen">
      <section className="panel">
        <div className="eyebrow">CONTROL RECORD</div>
        <h1>TIME CONTROLS</h1>
        <p className="section-copy">The latest TC can be corrected for the delay between crossing the control and pressing TC. Applying a correction re-anchors the live rally timing from that corrected ODO and time.</p>

        {tcLogs.length === 0 ? (
          <p className="empty-log">No TCs recorded yet.</p>
        ) : (
          [...tcLogs].reverse().map((log) => (
            <TcCorrectionCard
              key={log.id}
              log={log}
              isLatest={log.id === latestTcId}
              onApply={updateTcCorrection}
            />
          ))
        )}
      </section>

      {sftcLogs.length > 0 && (
        <section className="panel tc-log-panel">
          <h2>SFTC RECORD</h2>
          {sftcLogs.map((log) => (
            <div className="tc-log-row" key={log.id}>
              <div className="tc-log-number">SFTC {String(log.number).padStart(2, '0')}</div>
              <div><span>ODO</span><strong>{log.odoKm.toFixed(3)} km</strong></div>
              <div><span>WRITE</span><strong>{clockTime(log.cardTimeMs)}</strong></div>
              <div><span>ACTUAL</span><strong>{clockTime(log.hitMs)}</strong></div>
            </div>
          ))}
        </section>
      )}
    </main>
  )
}

type TcCorrectionCardProps = {
  log: TcLog
  isLatest: boolean
  onApply: (tcId: string, correctedOdoKm: number, correctedClockValue: string) => void
}

function TcCorrectionCard({ log, isLatest, onApply }: TcCorrectionCardProps) {
  const [odo, setOdo] = useState(log.odoKm.toFixed(3))
  const [time, setTime] = useState(timeInputValue(log.hitMs))

  useEffect(() => {
    setOdo(log.odoKm.toFixed(3))
    setTime(timeInputValue(log.hitMs))
  }, [log.odoKm, log.hitMs])

  return (
    <div className="tc-correction-card">
      <div className="tc-correction-head">
        <strong>TC {String(log.number).padStart(2, '0')}</strong>
        <span>{isLatest ? 'LIVE ANCHOR' : 'HISTORY'}</span>
      </div>

      <div className="tc-correction-fields">
        <label>TC ODO km
          <input inputMode="decimal" type="number" step="0.001" value={odo} onChange={(e) => setOdo(e.target.value)} />
        </label>
        <label>TC TIME
          <input type="time" step="1" value={time} onChange={(e) => setTime(e.target.value)} />
        </label>
      </div>
      <div className="tc-correction-meta">
        <span>{formatDeviation(log.deviationSeconds)} {timingState(log.deviationSeconds)}</span>
        {log.officialRestartMs && <span>Restart {clockTime(log.officialRestartMs)}</span>}
        {!isLatest && <span>History edit only · live timing is anchored by the latest TC</span>}
      </div>
      <button className="primary-button full-button" onClick={() => onApply(log.id, Number(odo), time)}>APPLY TC CORRECTION</button>
    </div>
  )
}

export default App
