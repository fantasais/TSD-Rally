import { useEffect, useRef, useState } from 'react'

export function useWakeLock(active: boolean) {
  const sentinelRef = useRef<WakeLockSentinel | null>(null)
  const [held, setHeld] = useState(false)
  const [supported] = useState(() => 'wakeLock' in navigator)

  useEffect(() => {
    if (!supported) return

    const acquire = async () => {
      if (!active || document.visibilityState !== 'visible' || sentinelRef.current) return
      try {
        const sentinel = await navigator.wakeLock.request('screen')
        sentinelRef.current = sentinel
        setHeld(true)
        sentinel.addEventListener('release', () => {
          sentinelRef.current = null
          setHeld(false)
        })
      } catch {
        setHeld(false)
      }
    }

    const release = async () => {
      if (sentinelRef.current) {
        await sentinelRef.current.release().catch(() => undefined)
        sentinelRef.current = null
      }
      setHeld(false)
    }

    const onVisibility = () => {
      if (document.visibilityState === 'visible') void acquire()
    }

    if (active) void acquire()
    else void release()

    document.addEventListener('visibilitychange', onVisibility)
    return () => {
      document.removeEventListener('visibilitychange', onVisibility)
      void release()
    }
  }, [active, supported])

  return { supported, held }
}
