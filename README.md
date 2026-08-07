# TSD Rally V0.2

A deliberately basic, offline-first TSD rally computer for a navigator using a physical roadbook and organiser-supplied speed chart.

## V0.2 changes

- Removed rally name.
- Removed the simulator tab from the user interface.
- GPS now starts automatically when the app opens. The first use can still trigger the browser's location permission prompt.
- Speed-chart setup is simplified: each sector starts automatically where the previous sector ends, so only `TO km` and `AVG km/h` need to be entered.
- A sector can be marked as a **TC at its end distance**.
- Each TC can have optional **scratch time** entered in minutes and seconds.
- Scratch time is incorporated directly into the ideal schedule. At the TC, the timing delta effectively becomes the available scratch and counts back toward zero while the car waits.
- Odometer calibration remains available but is collapsed under an optional section.
- Rally screen remains essentially unchanged.

## Operating principle for TC scratch

If a TC at 5.000 km has 60 seconds of scratch, the ideal schedule gains 60 seconds at 5.000 km. If you reach the TC exactly on time, the display becomes about `-60.0 EARLY`; while you wait, that counts back toward zero. If you arrive 10 seconds late, you have roughly 50 seconds of usable scratch before the schedule returns to zero.

This matches the intended V0.2 interpretation of scratch as free adjustment time at the TC. Verify this against the specific event's roadbook/supplementary regulations before competition use.

## Core scope

- Official start date/time and armed automatic start
- Live high-accuracy browser GPS watch
- Cumulative GPS odometer with basic noise/jump rejection
- Optional odometer calibration factor
- Manual `-10 m`, `+10 m`, and `SET ODO` correction
- Live ideal-vs-actual timing deviation in seconds
- Automatic target-speed changes by rally distance
- TC scratch-time handling
- Offline PWA cache
- Screen Wake Lock request while armed/running
- Local persistence

## Vercel

Use the same deployment settings as V0.1:

- Framework preset: `Vite`
- Build command: `npm run build`
- Output directory: `dist`

After deployment, open the HTTPS URL on the rally phone, allow precise location, and install/add the PWA to the home screen.

## Before event use

- Confirm GPS/electronic rally computers are permitted in your class.
- Test on the actual rally phone.
- Run a known-distance calibration route.
- Run a mock TSD route including at least one TC with scratch time.
- Keep the roadbook as the master distance reference.
- Carry a backup timing method. This remains new software.
