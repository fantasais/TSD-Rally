import React, { useState, useEffect } from 'react'

// Placeholder interface definitions matching your app structure
interface RallyScreenProps {
  status: 'idle' | 'armed' | 'active'
  startMs: number | null
  nowMs: number
  deltaSeconds: number
  targetSpeed: number
  currentSegment: any
  rallyDistanceKm: number
  remainingKm: number
  nextChange: { distanceKm: number; nextSpeedKph: number } | null
  gpsSpeedKph: number | null
  gpsEnabled: boolean
  wakeHeld: boolean
  wakeSupported: boolean
  tcLogs: any[]
  sftcLogs: any[]
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
  dismissSftc: () => void
}

// Helpers
function timingState(deltaSeconds: number): string {
  if (deltaSeconds > 0.8) return 'LATE'
  if (deltaSeconds < -0.8) return 'EARLY'
  return 'ON TIME'
}

function segmentKind(segment: any): string {
  return segment?.kind || 'speed'
}

function zoneBasis(segment: any): string {
  return segment?.basis || 'speed'
}

function clockTime(ms: number | null): string {
  if (!ms) return '--:--:--'
  const date = new Date(ms)
  return date.toTimeString().split(' ')[0]
}

function formatDeviation(seconds: number): string {
  const abs = Math.abs(seconds).toFixed(1)
  return seconds >= 0 ? `+${abs}` : `-${abs}`
}

function formatDuration(seconds: number): string {
  const m = Math.floor(seconds / 60)
  const s = Math.floor(seconds % 60)
  return `${m}m ${s}s`
}

function RallyScreen(props: RallyScreenProps) {
  const {
    status, startMs, nowMs, deltaSeconds, targetSpeed, currentSegment, rallyDistanceKm, 
    remainingKm, nextChange, gpsSpeedKph, tcLogs, sftcLogs, pendingSftcId, 
    changeOdo, setOdo, markTc, markSftc
  } = props

  const activeSftcLog = pendingSftcId ? (sftcLogs.find((log) => log.id === pendingSftcId) ?? null) : null
  const waitingSeconds = status === 'armed' && startMs ? Math.max(0, (startMs - nowMs) / 1000) : 0
  const timingClass = deltaSeconds > 0.8 ? 'late' : deltaSeconds < -0.8 ? 'early' : 'on-time'
  const stateLabel = timingState(deltaSeconds)
  const inZone = currentSegment !== null && segmentKind(currentSegment) === 'zone'
  const currentZoneBasis = currentSegment ? zoneBasis(currentSegment) : 'speed'

  // -5s to +5s visual drift indicator
  const driftPercentage = Math.min(100, Math.max(-100, (deltaSeconds / 5) * 100))

  return (
    <main className="content rally-screen">
      {status === 'armed' ? (
        <section className="armed-card" style={{ textAlign: 'center', padding: '32px 16px' }}>
          <div style={{ fontSize: '0.85rem', color: 'var(--amber)', fontWeight: 800 }}>ARMED & READY</div>
          <div style={{ fontSize: '5rem', fontWeight: 900, fontFamily: 'var(--font-mono)' }}>{waitingSeconds.toFixed(1)}</div>
          <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)' }}>SECONDS TO START</div>
          <div style={{ marginTop: '16px', fontSize: '1rem', fontWeight: 700 }}>OFFICIAL START {clockTime(startMs)}</div>
        </section>
      ) : (
        <>
          {/* Enhanced Delta Display with Visual Gauge */}
          <section className={`delta-card ${timingClass}`} style={{ position: 'relative', overflow: 'hidden' }}>
            <div style={{ fontSize: '4.5rem', fontWeight: 900, letterSpacing: '-0.02em', fontFamily: 'var(--font-mono)' }}>
              {formatDeviation(deltaSeconds)}
            </div>
            <div style={{ fontSize: '1.2rem', fontWeight: 800, textTransform: 'uppercase' }}>
              {stateLabel}
            </div>
            
            {/* Peripheral Visual Drift Bar */}
            <div style={{ height: '6px', background: 'rgba(255,255,255,0.15)', marginTop: '12px', borderRadius: '3px', position: 'relative' }}>
              <div 
                style={{
                  position: 'absolute',
                  top: 0,
                  bottom: 0,
                  left: driftPercentage < 0 ? `${50 + driftPercentage / 2}%` : '50%',
                  width: `${Math.abs(driftPercentage) / 2}%`,
                  background: timingClass === 'late' ? 'var(--red)' : timingClass === 'early' ? 'var(--amber)' : 'var(--green)',
                  transition: 'all 0.1s linear'
                }} 
              />
            </div>
          </section>

          {/* Core Target & Telemetry Grid */}
          <section className="target-card">
            <div>
              <span>{inZone ? `DZ/FZ (${currentZoneBasis.toUpperCase()})` : 'TARGET SPEED'}</span>
              {inZone && currentZoneBasis === 'time' ? (
                <strong style={{ color: 'var(--amber)' }}>{formatDuration(currentSegment?.zoneDurationSeconds ?? 0)}</strong>
              ) : (
                <><strong>{targetSpeed.toFixed(1)}</strong> <small>km/h</small></>
              )}
            </div>
            <div>
              <span>GPS SPEED</span>
              <strong>{gpsSpeedKph === null ? '—' : gpsSpeedKph.toFixed(1)}</strong> <small>km/h</small>
            </div>
          </section>

          {/* Odometer Card */}
          <section className="trip-card">
            <span>RALLY ODOMETER</span>
            <strong style={{ fontSize: '3.8rem', lineHeight: '1.0', fontFamily: 'var(--font-mono)' }}>{rallyDistanceKm.toFixed(3)}</strong>
            <small style={{ display: 'block', marginTop: '4px', color: 'var(--text-muted)' }}>km</small>
          </section>

          {/* Next Speed Change Indicator */}
          <section className="next-card">
            <span>NEXT CHANGE AT</span>
            {nextChange ? (
              <div className="next-main">
                <strong>{nextChange.distanceKm.toFixed(3)} km</strong>
                <b style={{ color: 'var(--amber)' }}>→ {nextChange.nextSpeedKph.toFixed(1)} km/h</b>
              </div>
            ) : (
              <div className="next-main"><strong>END OF CHART</strong> <b>{remainingKm.toFixed(3)} km</b></div>
            )}
          </section>

          {/* Cockpit Action Deck */}
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '12px', margin: '4px 0' }}>
            <button 
              style={{ minHeight: '64px', fontSize: '1.2rem', fontWeight: 900, background: '#1e293b', border: '2px solid #334155' }} 
              onClick={markTc}
            >
              RECORD TC
            </button>
            <button 
              style={{ minHeight: '64px', fontSize: '1.2rem', fontWeight: 900, background: '#1e293b', border: '2px solid #334155' }} 
              onClick={markSftc} 
              disabled={Boolean(activeSftcLog)}
            >
              RECORD SFTC
            </button>
          </div>

          {/* Odometer Nudge Deck */}
          <section className="odo-controls" style={{ display: 'grid', gridTemplateColumns: '1fr 1.5fr 1fr', gap: '8px' }}>
            <button style={{ minHeight: '52px', fontSize: '1.1rem', fontWeight: 700 }} onClick={() => changeOdo(-0.01)}>−10 m</button>
            <button style={{ minHeight: '52px', fontSize: '1.1rem', fontWeight: 800, background: '#334155' }} onClick={setOdo}>CALIBRATE ODO</button>
            <button style={{ minHeight: '52px', fontSize: '1.1rem', fontWeight: 700 }} onClick={() => changeOdo(0.01)}>+10 m</button>
          </section>
        </>
      )}
    </main>
  )
}

export default function App() {
  const [activeTab, setActiveTab] = useState<'rally' | 'chart' | 'logs'>('rally')
  const [status, setStatus] = useState<'idle' | 'armed' | 'active'>('active')
  const [nowMs, setNowMs] = useState(Date.now())
  const [rallyDistanceKm, setRallyDistanceKm] = useState(14.250)
  const [deltaSeconds, setDeltaSeconds] = useState(0.8)
  const [showOdoModal, setShowOdoModal] = useState(false)
  const [modalOdoValue, setModalOdoValue] = useState('')

  useEffect(() => {
    const timer = setInterval(() => setNowMs(Date.now()), 100)
    return () => clearInterval(timer)
  }, [])

  const handleOdoSave = () => {
    const parsed = parseFloat(modalOdoValue)
    if (!isNaN(parsed)) {
      setRallyDistanceKm(parsed)
    }
    setShowOdoModal(false)
  }

  return (
    <div className="app-container">
      {/* Top Header */}
      <header className="topbar">
        <div className="brand">TSD COCKPIT</div>
        <div className="topbar-actions">
          <button style={{ background: status === 'active' ? 'var(--red)' : 'var(--green)' }} onClick={() => setStatus(status === 'active' ? 'idle' : 'active')}>
            {status === 'active' ? 'PAUSE' : 'START'}
          </button>
        </div>
      </header>

      {/* Navigation Tabs */}
      <nav className="tab-bar">
        <button className={`tab-button ${activeTab === 'rally' ? 'active' : ''}`} onClick={() => setActiveTab('rally')}>STAGE</button>
        <button className={`tab-button ${activeTab === 'chart' ? 'active' : ''}`} onClick={() => setActiveTab('chart')}>SPEED CHART</button>
        <button className={`tab-button ${activeTab === 'logs' ? 'active' : ''}`} onClick={() => setActiveTab('logs')}>LOGS</button>
      </nav>

      {/* Active Screen Rendering */}
      {activeTab === 'rally' && (
        <RallyScreen
          status={status}
          startMs={null}
          nowMs={nowMs}
          deltaSeconds={deltaSeconds}
          targetSpeed={45.0}
          currentSegment={null}
          rallyDistanceKm={rallyDistanceKm}
          remainingKm={5.750}
          nextChange={{ distanceKm: 20.000, nextSpeedKph: 30.0 }}
          gpsSpeedKph={44.8}
          gpsEnabled={true}
          wakeHeld={true}
          wakeSupported={true}
          tcLogs={[]}
          sftcLogs={[]}
          pendingRestartTcId={null}
          pendingSftcId={null}
          arm={() => setStatus('armed')}
          startNow={() => setStatus('active')}
          endSession={() => setStatus('idle')}
          resetRun={() => setRallyDistanceKm(0)}
          changeOdo={(deltaKm) => setRallyDistanceKm((prev) => Math.max(0, prev + deltaKm))}
          setOdo={() => {
            setModalOdoValue(rallyDistanceKm.toFixed(3))
            setShowOdoModal(true)
          }}
          markTc={() => console.log('TC Marked')}
          markSftc={() => console.log('SFTC Marked')}
          dismissSftc={() => {}}
        />
      )}

      {activeTab === 'chart' && (
        <main className="content" style={{ textAlign: 'center', padding: '40px 0', color: 'var(--text-muted)' }}>
          Speed Chart Configurator Area
        </main>
      )}

      {activeTab === 'logs' && (
        <main className="content" style={{ textAlign: 'center', padding: '40px 0', color: 'var(--text-muted)' }}>
          Time Controls & SFTC History Logs
        </main>
      )}

      {/* Calibrate Odometer Dialog */}
      {showOdoModal && (
        <div className="modal-overlay">
          <div className="modal">
            <h3 style={{ margin: 0, textAlign: 'center' }}>CALIBRATE ODOMETER</h3>
            <input
              type="text"
              inputMode="decimal"
              pattern="[0-9]*"
              value={modalOdoValue}
              onChange={(e) => setModalOdoValue(e.target.value)}
              autoFocus
            />
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '8px', marginTop: '8px' }}>
              <button style={{ padding: '12px' }} onClick={() => setShowOdoModal(false)}>CANCEL</button>
              <button style={{ padding: '12px', background: 'var(--blue)', color: '#000' }} onClick={handleOdoSave}>SAVE</button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
