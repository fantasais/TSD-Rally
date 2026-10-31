import assert from 'node:assert/strict'
import { appendRallyEvent, makeRallyEvent } from '../src/lib/audit.ts'

const first = makeRallyEvent('session-started', 'RALLY STARTED', 0, 1000)
const second = makeRallyEvent('odo-adjusted', 'ODO +10 m', 12.34, 2000)
let events = appendRallyEvent(undefined, first)
events = appendRallyEvent(events, second)

assert.equal(events.length, 2)
assert.equal(events[0].message, 'RALLY STARTED')
assert.equal(events[1].odoKm, 12.34)

// Audit history is deliberately bounded so persistence cannot grow forever.
for (let index = 0; index < 520; index += 1) {
  events = appendRallyEvent(events, makeRallyEvent('odo-adjusted', `STEP ${index}`, index / 1000, 3000 + index))
}
assert.equal(events.length, 500)
assert.equal(events.at(-1)?.message, 'STEP 519')
assert.ok(!events.some((event) => event.message === 'RALLY STARTED'))

console.log('Persistent audit-log self-test: PASS')
