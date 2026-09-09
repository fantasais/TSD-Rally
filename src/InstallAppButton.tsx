import { useEffect, useState } from 'react'

type BeforeInstallPromptEvent = Event & {
  prompt: () => Promise<void>
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed'; platform: string }>
}

export default function InstallAppButton() {
  const [promptEvent, setPromptEvent] = useState<BeforeInstallPromptEvent | null>(null)
  const [standalone, setStandalone] = useState(() => window.matchMedia?.('(display-mode: standalone)').matches ?? false)

  useEffect(() => {
    const media = window.matchMedia('(display-mode: standalone)')
    const onMediaChange = () => setStandalone(media.matches)
    const onBeforeInstall = (event: Event) => {
      event.preventDefault()
      setPromptEvent(event as BeforeInstallPromptEvent)
    }
    const onInstalled = () => {
      setPromptEvent(null)
      setStandalone(true)
    }

    media.addEventListener?.('change', onMediaChange)
    window.addEventListener('beforeinstallprompt', onBeforeInstall)
    window.addEventListener('appinstalled', onInstalled)

    return () => {
      media.removeEventListener?.('change', onMediaChange)
      window.removeEventListener('beforeinstallprompt', onBeforeInstall)
      window.removeEventListener('appinstalled', onInstalled)
    }
  }, [])

  if (standalone) return null

  const install = async () => {
    if (promptEvent) {
      await promptEvent.prompt()
      const choice = await promptEvent.userChoice
      if (choice.outcome === 'accepted') setPromptEvent(null)
      return
    }

    alert('Chrome: tap ⋮ → Add to Home screen → Install app. If Chrome only shows Create shortcut, use the page for about 30 seconds, tap once, reload, and try again.')
  }

  return (
    <button
      onClick={() => void install()}
      style={{
        border: '1px solid #454545',
        background: '#111',
        color: '#fff',
        borderRadius: 999,
        padding: '7px 10px',
        fontSize: 11,
        fontWeight: 800,
        letterSpacing: '.04em'
      }}
    >
      INSTALL
    </button>
  )
}
