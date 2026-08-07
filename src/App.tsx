import { useEffect, useMemo, useState } from 'react'
import type { RallySession, RallySettings, SpeedSector } from './types'
import { useGpsOdometer } from './hooks/useGpsOdometer'
import { useWakeLock } from './hooks/useWakeLock'
import {
  chainSectors,
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

type Screen = 'setup' | 'rally'

const SETTINGS_KEY = 'tsd:settings:v02'
const SESSION_KEY = 'tsd:session:v02'

function localDateTimeValue(date = new Date(Date.now() + 5 * 60_000)) {
  const pad = (value: number) => String(value).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
}

const DEFAULT_SETTINGS: RallySettings = {
  startDateTime: localDateTimeValue(),
  calibrationFactor: 1,
  sectors: [
    { id: crypto.randomUUID(), fromKm: 0, toKm: 5, speedKph: 30, tcAtEnd: false, scratchSeconds: 0 },
    { id: crypto.randomUUID(), fromKm: 5, toKm: 10, speedKph: 40, tcAtEnd: false, scratchSeconds: 0 },
    { id: crypto.randomUUID(), fromKm: 10, toKm: 15, speedKph: 35, tcAtEnd: false, scratchSeconds: 0 }
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
    setSession({ status: 'armed', startMs, stopMs: null, rawBaselineKm: gps.rawDistanceKm, manualOffsetKm: 0 })
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
          <div className="eyebrow">TSD RALLY V0.2</div>
          <div className="brand">RALLY COMPUTER</div>
        </div>
        <div className={`gps-pill ${gps.accuracyM !== null && gps.accuracyM <= 15 ? 'good' : gps.accuracyM !== null && gps.accuracyM <= 30 ? 'fair' : 'poor'}`}>
          GPS {gps.enabled ? (gps.accuracyM === null ? '…' : `${Math.round(gps.accuracyM)}m`) : 'OFF'}
        </div>
      </header>

      <nav className="nav-tabs" aria-label="Main screens">
        <button className={screen === 'setup' ? 'active' : ''} onClick={() => setScreen('setup')}>SETUP</button>
        <button className={screen === 'rally' ? 'active' : ''} onClick={() => setScreen('rally')}>RALLY</button>
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
          arm={arm}
          startNow={startNow}
          stop={() => setSession((current) => ({ ...current, status: 'stopped', stopMs: Date.now() }))}
          resetRun={resetRun}
          changeOdo={changeOdo}
          setOdo={setOdo}
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

  const changeSectors = (mutate: (sectors: SpeedSector[]) => SpeedSector[]) => {
    setSettings((current) => ({ ...current, sectors: chainSectors(mutate(current.sectors)) }))
  }

  const updateSector = (id: string, changes: Partial<SpeedSector>) => {
    changeSectors((sectors) => sectors.map((sector) => sector.id === id ? { ...sector, ...changes } : sector))
  }

  const addSector = () => {
    changeSectors((sectors) => {
      const last = sectors[sectors.length - 1]
      const from = last?.toKm ?? 0
      return [...sectors, {
        id: crypto.randomUUID(),
        fromKm: from,
        toKm: from + 5,
        speedKph: last?.speedKph ?? 30,
        tcAtEnd: false,
        scratchSeconds: 0
      }]
    })
  }

  const removeSector = (id: string) => {
    changeSectors((sectors) => sectors.filter((sector) => sector.id !== id))
  }

  const setScratchMinutes = (sector: SpeedSector, minutes: number) => {
    const seconds = Math.max(0, Math.round(minutes)) * 60 + (sector.scratchSeconds % 60)
    updateSector(sector.id, { scratchSeconds: seconds })
  }

  const setScratchSeconds = (sector: SpeedSector, secondsPart: number) => {
    const minutes = Math.floor(sector.scratchSeconds / 60)
    const seconds = minutes * 60 + Math.max(0, Math.min(59, Math.round(secondsPart)))
    updateSector(sector.id, { scratchSeconds: seconds })
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
          <div>
            <h2>SPEED CHART</h2>
            <p className="section-copy">Enter only the end distance and average speed. Each next sector starts automatically from the previous one.</p>
          </div>
          <button className="small-button" onClick={addSector}>+ SECTOR</button>
        </div>

        <div className="sector-list">
          {settings.sectors.map((sector, index) => (
            <div className="sector-card" key={sector.id}>
              <div className="sector-title-row">
                <strong>SECTOR {String(index + 1).padStart(2, '0')}</strong>
                {settings.sectors.length > 1 && <button className="remove-link" onClick={() => removeSector(sector.id)}>REMOVE</button>}
              </div>

              <div className="sector-range">{sector.fromKm.toFixed(3)} km →</div>

              <div className="sector-main-fields">
                <label>TO km
                  <input inputMode="decimal" type="number" step="0.001" value={sector.toKm} onChange={(e) => updateSector(sector.id, { toKm: Number(e.target.value) })} />
                </label>
                <label>AVG km/h
                  <input inputMode="decimal" type="number" step="0.1" value={sector.speedKph} onChange={(e) => updateSector(sector.id, { speedKph: Number(e.target.value) })} />
                </label>
              </div>

              <label className="tc-toggle">
                <input
                  type="checkbox"
                  checked={sector.tcAtEnd}
                  onChange={(e) => updateSector(sector.id, { tcAtEnd: e.target.checked, scratchSeconds: e.target.checked ? sector.scratchSeconds : 0 })}
                />
                <span>TC at {sector.toKm.toFixed(3)} km</span>
              </label>

              {sector.tcAtEnd && (
                <div className="scratch-row">
                  <span>SCRATCH TIME</span>
                  <label><input type="number" min="0" step="1" value={Math.floor(sector.scratchSeconds / 60)} onChange={(e) => setScratchMinutes(sector, Number(e.target.value))} /><small>min</small></label>
                  <label><input type="number" min="0" max="59" step="1" value={sector.scratchSeconds % 60} onChange={(e) => setScratchSeconds(sector, Number(e.target.value))} /><small>sec</small></label>
                </div>
              )}
            </div>
          ))}
        </div>

        <button className="secondary-button full-button" onClick={addSector}>+ ADD SECTOR</button>
        {errors.length > 0 && <div className="error-box">{errors.map((error) => <div key={error}>{error}</div>)}</div>}
      </section>

      <details className="panel calibration-panel">
        <summary>ODOMETER CALIBRATION <span>OPTIONAL</span></summary>
        <p className="section-copy">Use this only if the organiser gives you a known calibration distance.</p>
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
    arm, startNow, stop, resetRun, changeOdo, setOdo
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
          <button className="primary-button" onClick={arm}>ARM START</button>
          <button className="secondary-button" onClick={startNow}>START NOW</button>
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
        {status === 'running' && <button className="stop-button" onClick={stop}>STOP</button>}
        <button className="ghost-button" onClick={resetRun}>RESET RUN</button>
      </div>
    </main>
  )
}

export default App
