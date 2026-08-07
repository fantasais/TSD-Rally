import { useEffect, useMemo, useRef, useState } from 'react'
import type { RallySession, RallySettings, SpeedSector } from './types'
import { useGpsOdometer } from './hooks/useGpsOdometer'
import { useWakeLock } from './hooks/useWakeLock'
import {
  deviationSeconds,
  formatDeviation,
  formatElapsed,
  idealElapsedSecondsAtDistance,
  nextSpeedChange,
  sortSectors,
  targetSpeedAtDistance,
  totalRouteKm,
  validateSectors
} from './lib/tsd'
import { loadJson, saveJson } from './lib/storage'
import './styles.css'

type Screen = 'setup' | 'rally' | 'simulate'

const SETTINGS_KEY = 'tsd:settings:v01'
const SESSION_KEY = 'tsd:session:v01'

function localDateTimeValue(date = new Date(Date.now() + 5 * 60_000)) {
  const pad = (value: number) => String(value).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
}

const DEFAULT_SETTINGS: RallySettings = {
  rallyName: 'TSD Rally',
  startDateTime: localDateTimeValue(),
  calibrationFactor: 1,
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
  manualOffsetKm: 0
}

function App() {
  const [screen, setScreen] = useState<Screen>('setup')
  const [settings, setSettings] = useState<RallySettings>(() => loadJson(SETTINGS_KEY, DEFAULT_SETTINGS))
  const [session, setSession] = useState<RallySession>(() => loadJson(SESSION_KEY, DEFAULT_SESSION))
  const [nowMs, setNowMs] = useState(Date.now())
  const { gps, startGps, stopGps, resetTracker } = useGpsOdometer()
  const wake = useWakeLock(session.status === 'armed' || session.status === 'running')

  const sortedSectors = useMemo(() => sortSectors(settings.sectors), [settings.sectors])
  const sectorErrors = useMemo(() => validateSectors(sortedSectors), [sortedSectors])

  useEffect(() => saveJson(SETTINGS_KEY, settings), [settings])
  useEffect(() => saveJson(SESSION_KEY, session), [session])

  useEffect(() => {
    const timer = window.setInterval(() => setNowMs(Date.now()), 100)
    return () => window.clearInterval(timer)
  }, [])

  useEffect(() => {
    if (session.status === 'armed' && session.startMs !== null && nowMs >= session.startMs) {
      setSession((current) => current.status === 'armed'
        ? { ...current, status: 'running', stopMs: null, rawBaselineKm: gps.rawDistanceKm, manualOffsetKm: 0 }
        : current)
    }
  }, [nowMs, session.status, session.startMs, gps.rawDistanceKm])

  const measuredKm = Math.max(0, gps.rawDistanceKm - session.rawBaselineKm)
  const rallyDistanceKm = Math.max(0, measuredKm * settings.calibrationFactor + session.manualOffsetKm)
  const elapsedEndMs = session.status === 'stopped' ? (session.stopMs ?? nowMs) : nowMs
  const actualElapsedSeconds = session.startMs && (session.status === 'running' || session.status === 'stopped')
    ? Math.max(0, (elapsedEndMs - session.startMs) / 1000)
    : 0
  const idealElapsedSeconds = idealElapsedSecondsAtDistance(rallyDistanceKm, sortedSectors)
  const deltaSeconds = deviationSeconds(actualElapsedSeconds, rallyDistanceKm, sortedSectors)
  const targetSpeed = targetSpeedAtDistance(rallyDistanceKm, sortedSectors)
  const nextChange = nextSpeedChange(rallyDistanceKm, sortedSectors)
  const routeKm = totalRouteKm(sortedSectors)
  const remainingKm = Math.max(0, routeKm - rallyDistanceKm)

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
    startGps()
    setSession({ status: 'armed', startMs, stopMs: null, rawBaselineKm: gps.rawDistanceKm, manualOffsetKm: 0 })
    setScreen('rally')
  }

  const startNow = () => {
    if (sectorErrors.length) {
      alert(sectorErrors[0])
      setScreen('setup')
      return
    }
    startGps()
    const startMs = Date.now()
    setSettings((current) => ({ ...current, startDateTime: localDateTimeValue(new Date(startMs)) }))
    setSession({ status: 'running', startMs, stopMs: null, rawBaselineKm: gps.rawDistanceKm, manualOffsetKm: 0 })
    setScreen('rally')
  }

  const resetRun = () => {
    if (!confirm('Reset the current rally session? Speed chart and calibration will be kept.')) return
    setSession(DEFAULT_SESSION)
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

  return (
    <div className="app-shell">
      <header className="topbar">
        <div>
          <div className="eyebrow">TSD RALLY V0.1</div>
          <div className="brand">{settings.rallyName || 'TSD Rally'}</div>
        </div>
        <div className={`gps-pill ${gps.accuracyM !== null && gps.accuracyM <= 15 ? 'good' : gps.accuracyM !== null && gps.accuracyM <= 30 ? 'fair' : 'poor'}`}>
          GPS {gps.accuracyM === null ? '—' : `${Math.round(gps.accuracyM)}m`}
        </div>
      </header>

      <nav className="nav-tabs" aria-label="Main screens">
        <button className={screen === 'setup' ? 'active' : ''} onClick={() => setScreen('setup')}>SETUP</button>
        <button className={screen === 'rally' ? 'active' : ''} onClick={() => setScreen('rally')}>RALLY</button>
        <button className={screen === 'simulate' ? 'active' : ''} onClick={() => setScreen('simulate')}>SIM</button>
      </nav>

      {screen === 'setup' && (
        <SetupScreen
          settings={settings}
          setSettings={setSettings}
          errors={sectorErrors}
          gps={gps}
          startGps={startGps}
          stopGps={stopGps}
          resetTracker={resetTracker}
          arm={arm}
          startNow={startNow}
        />
      )}

      {screen === 'rally' && (
        <RallyScreen
          status={session.status}
          startMs={session.startMs}
          nowMs={nowMs}
          deltaSeconds={deltaSeconds}
          targetSpeed={targetSpeed}
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
          startGps={startGps}
          arm={arm}
          startNow={startNow}
          stop={() => setSession((current) => ({ ...current, status: 'stopped', stopMs: Date.now() }))}
          resetRun={resetRun}
          changeOdo={changeOdo}
          setOdo={setOdo}
        />
      )}

      {screen === 'simulate' && <Simulator sectors={sortedSectors} />}

      <footer className="footer-note">Keep the app open in the foreground during the rally. Roadbook distance remains the master reference.</footer>
    </div>
  )
}

type SetupProps = {
  settings: RallySettings
  setSettings: React.Dispatch<React.SetStateAction<RallySettings>>
  errors: string[]
  gps: ReturnType<typeof useGpsOdometer>['gps']
  startGps: () => void
  stopGps: () => void
  resetTracker: () => void
  arm: () => void
  startNow: () => void
}

function SetupScreen({ settings, setSettings, errors, gps, startGps, stopGps, resetTracker, arm, startNow }: SetupProps) {
  const [officialKm, setOfficialKm] = useState('5.000')
  const [measuredKm, setMeasuredKm] = useState('5.000')

  const updateSector = (id: string, field: keyof Pick<SpeedSector, 'fromKm' | 'toKm' | 'speedKph'>, value: string) => {
    const number = Number(value)
    setSettings((current) => ({
      ...current,
      sectors: current.sectors.map((sector) => sector.id === id ? { ...sector, [field]: number } : sector)
    }))
  }

  const addSector = () => {
    setSettings((current) => {
      const sorted = sortSectors(current.sectors)
      const last = sorted[sorted.length - 1]
      const from = last?.toKm ?? 0
      return {
        ...current,
        sectors: [...sorted, { id: crypto.randomUUID(), fromKm: from, toKm: from + 5, speedKph: last?.speedKph ?? 30 }]
      }
    })
  }

  const removeSector = (id: string) => setSettings((current) => ({ ...current, sectors: current.sectors.filter((sector) => sector.id !== id) }))

  const calculateCalibration = () => {
    const official = Number(officialKm)
    const measured = Number(measuredKm)
    if (!(official > 0) || !(measured > 0)) return
    setSettings((current) => ({ ...current, calibrationFactor: official / measured }))
  }

  return (
    <main className="content setup-screen">
      <section className="panel">
        <h2>RALLY</h2>
        <label>Rally name<input value={settings.rallyName} onChange={(e) => setSettings((s) => ({ ...s, rallyName: e.target.value }))} /></label>
        <label>Official start<input type="datetime-local" step="1" value={settings.startDateTime} onChange={(e) => setSettings((s) => ({ ...s, startDateTime: e.target.value }))} /></label>
      </section>

      <section className="panel">
        <div className="section-head"><h2>SPEED CHART</h2><button className="small-button" onClick={addSector}>+ SECTOR</button></div>
        <div className="sector-head"><span>FROM km</span><span>TO km</span><span>AVG</span><span></span></div>
        {sortSectors(settings.sectors).map((sector) => (
          <div className="sector-row" key={sector.id}>
            <input inputMode="decimal" type="number" step="0.001" value={sector.fromKm} onChange={(e) => updateSector(sector.id, 'fromKm', e.target.value)} />
            <input inputMode="decimal" type="number" step="0.001" value={sector.toKm} onChange={(e) => updateSector(sector.id, 'toKm', e.target.value)} />
            <input inputMode="decimal" type="number" step="0.1" value={sector.speedKph} onChange={(e) => updateSector(sector.id, 'speedKph', e.target.value)} />
            <button className="delete-button" aria-label="Delete sector" onClick={() => removeSector(sector.id)}>×</button>
          </div>
        ))}
        {errors.length > 0 && <div className="error-box">{errors.map((error) => <div key={error}>{error}</div>)}</div>}
      </section>

      <section className="panel">
        <h2>ODOMETER CALIBRATION</h2>
        <div className="two-col">
          <label>Official km<input type="number" step="0.001" value={officialKm} onChange={(e) => setOfficialKm(e.target.value)} /></label>
          <label>GPS measured km<input type="number" step="0.001" value={measuredKm} onChange={(e) => setMeasuredKm(e.target.value)} /></label>
        </div>
        <button className="secondary-button" onClick={calculateCalibration}>CALCULATE FACTOR</button>
        <label>Calibration factor<input type="number" step="0.000001" value={settings.calibrationFactor} onChange={(e) => setSettings((s) => ({ ...s, calibrationFactor: Number(e.target.value) || 1 }))} /></label>
      </section>

      <section className="panel">
        <h2>GPS TEST</h2>
        <div className="status-grid">
          <div><span>STATUS</span><strong>{gps.enabled ? 'LIVE' : 'OFF'}</strong></div>
          <div><span>ACCURACY</span><strong>{gps.accuracyM === null ? '—' : `${gps.accuracyM.toFixed(0)} m`}</strong></div>
          <div><span>RAW TRIP</span><strong>{gps.rawDistanceKm.toFixed(3)}</strong></div>
          <div><span>SPEED</span><strong>{gps.speedKph === null ? '—' : gps.speedKph.toFixed(1)}</strong></div>
        </div>
        {gps.error && <div className="error-box">{gps.error}</div>}
        <div className="button-row">
          <button className="secondary-button" onClick={gps.enabled ? stopGps : startGps}>{gps.enabled ? 'STOP GPS' : 'START GPS'}</button>
          <button className="ghost-button" onClick={resetTracker}>RESET RAW TRIP</button>
        </div>
      </section>

      <div className="launch-row">
        <button className="primary-button" onClick={arm}>ARM OFFICIAL START</button>
        <button className="secondary-button" onClick={startNow}>START NOW / TEST</button>
      </div>
    </main>
  )
}

type RallyScreenProps = {
  status: RallySession['status']
  startMs: number | null
  nowMs: number
  deltaSeconds: number
  targetSpeed: number
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
  startGps: () => void
  arm: () => void
  startNow: () => void
  stop: () => void
  resetRun: () => void
  changeOdo: (deltaKm: number) => void
  setOdo: () => void
}

function RallyScreen(props: RallyScreenProps) {
  const {
    status, startMs, nowMs, deltaSeconds, targetSpeed, rallyDistanceKm, remainingKm, nextChange,
    actualElapsedSeconds, idealElapsedSeconds, gpsSpeedKph, gpsEnabled, gpsError, wakeHeld, wakeSupported,
    startGps, arm, startNow, stop, resetRun, changeOdo, setOdo
  } = props

  const waitingSeconds = status === 'armed' && startMs ? Math.max(0, (startMs - nowMs) / 1000) : 0
  const timingClass = deltaSeconds > 0.8 ? 'late' : deltaSeconds < -0.8 ? 'early' : 'on-time'
  const stateLabel = deltaSeconds > 0.8 ? 'LATE' : deltaSeconds < -0.8 ? 'EARLY' : 'ON TIME'

  if (status === 'idle') {
    return (
      <main className="content rally-empty">
        <div className="empty-card">
          <div className="eyebrow">RALLY COMPUTER READY</div>
          <h1>Set the speed chart, then arm the start.</h1>
          <button className="primary-button" onClick={arm}>ARM OFFICIAL START</button>
          <button className="secondary-button" onClick={startNow}>START NOW / TEST</button>
          {!gpsEnabled && <button className="ghost-button" onClick={startGps}>START GPS ONLY</button>}
        </div>
      </main>
    )
  }

  return (
    <main className="content rally-screen">
      {status === 'armed' ? (
        <section className="armed-card">
          <div className="eyebrow">ARMED</div>
          <div className="countdown">{waitingSeconds.toFixed(1)}</div>
          <div className="countdown-label">SECONDS TO START</div>
          <div className="clock-line">START {startMs ? new Date(startMs).toLocaleTimeString([], { hour12: false }) : '—'}</div>
          <div className="rally-flags"><span>GPS {gpsEnabled ? 'LIVE' : 'OFF'}</span><span>WAKE {wakeHeld ? 'ON' : wakeSupported ? 'WAIT' : 'N/A'}</span></div>
        </section>
      ) : (
        <>
          <section className={`delta-card ${timingClass}`}>
            <div className="delta-number">{formatDeviation(deltaSeconds)}</div>
            <div className="delta-label">SECONDS {stateLabel}</div>
          </section>

          <section className="target-card">
            <div><span>TARGET</span><strong>{targetSpeed.toFixed(1)}</strong><small>km/h</small></div>
            <div><span>GPS SPEED</span><strong>{gpsSpeedKph === null ? '—' : gpsSpeedKph.toFixed(1)}</strong><small>km/h</small></div>
          </section>

          <section className="trip-card">
            <span>RALLY ODOMETER</span>
            <strong>{rallyDistanceKm.toFixed(3)}</strong>
            <small>km</small>
          </section>

          <section className="next-card">
            <span>NEXT SPEED CHANGE</span>
            {nextChange ? (
              <div className="next-main"><strong>{nextChange.distanceKm.toFixed(3)} km</strong><b>→ {nextChange.nextSpeedKph.toFixed(1)}</b></div>
            ) : (
              <div className="next-main"><strong>END OF CHART</strong><b>{remainingKm.toFixed(3)} km</b></div>
            )}
          </section>

          <section className="odo-controls">
            <button onClick={() => changeOdo(-0.01)}>−10 m</button>
            <button className="set-odo" onClick={setOdo}>SET ODO</button>
            <button onClick={() => changeOdo(0.01)}>+10 m</button>
          </section>

          <section className="timing-strip">
            <div><span>ACTUAL</span><strong>{formatElapsed(actualElapsedSeconds)}</strong></div>
            <div><span>IDEAL</span><strong>{formatElapsed(idealElapsedSeconds)}</strong></div>
          </section>
        </>
      )}

      {gpsError && <div className="error-box">GPS: {gpsError}</div>}
      <div className="rally-actions">
        {!gpsEnabled && <button className="secondary-button" onClick={startGps}>START GPS</button>}
        {status === 'running' && <button className="stop-button" onClick={stop}>STOP</button>}
        <button className="ghost-button" onClick={resetRun}>RESET RUN</button>
      </div>
    </main>
  )
}

function Simulator({ sectors }: { sectors: SpeedSector[] }) {
  const [running, setRunning] = useState(false)
  const [speedKph, setSpeedKph] = useState(() => sectors[0]?.speedKph ?? 30)
  const [distanceKm, setDistanceKm] = useState(0)
  const [elapsedSeconds, setElapsedSeconds] = useState(0)
  const lastTickRef = useRef<number | null>(null)
  const target = targetSpeedAtDistance(distanceKm, sectors)
  const delta = deviationSeconds(elapsedSeconds, distanceKm, sectors)
  const next = nextSpeedChange(distanceKm, sectors)

  useEffect(() => {
    if (!running) {
      lastTickRef.current = null
      return
    }
    const timer = window.setInterval(() => {
      const now = performance.now()
      const last = lastTickRef.current ?? now
      const dt = Math.min(0.5, (now - last) / 1000)
      lastTickRef.current = now
      setElapsedSeconds((value) => value + dt)
      setDistanceKm((value) => value + (speedKph * dt) / 3600)
    }, 100)
    return () => window.clearInterval(timer)
  }, [running, speedKph])

  const reset = () => {
    setRunning(false)
    setDistanceKm(0)
    setElapsedSeconds(0)
    setSpeedKph(sectors[0]?.speedKph ?? 30)
  }

  const timingClass = delta > 0.8 ? 'late' : delta < -0.8 ? 'early' : 'on-time'
  const stateLabel = delta > 0.8 ? 'LATE' : delta < -0.8 ? 'EARLY' : 'ON TIME'

  return (
    <main className="content simulator-screen">
      <section className={`delta-card ${timingClass}`}>
        <div className="delta-number">{formatDeviation(delta)}</div>
        <div className="delta-label">SECONDS {stateLabel}</div>
      </section>
      <section className="target-card">
        <div><span>TARGET</span><strong>{target.toFixed(1)}</strong><small>km/h</small></div>
        <div><span>SIM SPEED</span><strong>{speedKph.toFixed(1)}</strong><small>km/h</small></div>
      </section>
      <section className="trip-card"><span>SIM ODOMETER</span><strong>{distanceKm.toFixed(3)}</strong><small>km</small></section>
      <section className="next-card"><span>NEXT SPEED CHANGE</span><div className="next-main">{next ? <><strong>{next.distanceKm.toFixed(3)} km</strong><b>→ {next.nextSpeedKph.toFixed(1)}</b></> : <><strong>END</strong><b>—</b></>}</div></section>

      <section className="sim-controls">
        <button onClick={() => setSpeedKph(Math.max(0, target - 5))}>TARGET −5</button>
        <button onClick={() => setSpeedKph(target)}>TARGET</button>
        <button onClick={() => setSpeedKph(target + 5)}>TARGET +5</button>
        <button onClick={() => setSpeedKph(0)}>STOP CAR</button>
      </section>
      <label className="speed-slider">Simulated speed: <strong>{speedKph.toFixed(1)} km/h</strong><input type="range" min="0" max="80" step="0.5" value={speedKph} onChange={(e) => setSpeedKph(Number(e.target.value))} /></label>
      <div className="button-row"><button className="primary-button" onClick={() => setRunning((value) => !value)}>{running ? 'PAUSE SIM' : 'RUN SIM'}</button><button className="ghost-button" onClick={reset}>RESET SIM</button></div>
      <section className="timing-strip"><div><span>ACTUAL</span><strong>{formatElapsed(elapsedSeconds)}</strong></div><div><span>IDEAL</span><strong>{formatElapsed(idealElapsedSecondsAtDistance(distanceKm, sectors))}</strong></div></section>
    </main>
  )
}

export default App
