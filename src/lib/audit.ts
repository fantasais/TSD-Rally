import type { RallyEventLog, RallyEventType } from '../types'

const MAX_EVENT_LOGS = 500

export function makeRallyEvent(
  type: RallyEventType,
  message: string,
  odoKm?: number | null,
  atMs = Date.now()
): RallyEventLog {
  return {
    id: crypto.randomUUID(),
    atMs,
    type,
    message,
    odoKm: odoKm ?? null
  }
}

export function appendRallyEvent(events: RallyEventLog[] | undefined, event: RallyEventLog): RallyEventLog[] {
  const next = [...(events ?? []), event]
  return next.length > MAX_EVENT_LOGS ? next.slice(next.length - MAX_EVENT_LOGS) : next
}
