# TSD Rally V0.1

A deliberately simple, offline-first TSD rally computer for a navigator using a physical roadbook plus organiser-supplied speed chart.

## V0.1 scope

- Speed-chart entry by distance sector
- Official start date/time and automatic armed start
- Live high-accuracy browser GPS watch
- Cumulative GPS odometer with basic noise/jump rejection
- Calibration factor from official vs measured calibration distance
- Manual `-10 m`, `+10 m`, and `SET ODO` correction
- Live ideal-vs-actual timing deviation in seconds
- Automatic target-speed changes by rally odometer distance
- Next speed-change distance
- Offline PWA cache
- Screen Wake Lock request while armed/running
- Local persistence of settings/session/GPS raw trip
- Simulation mode for desk testing

## Critical operating principle

The organiser's roadbook distance is the master reference. GPS is only the measuring instrument. Calibrate before the rally and correct the app odometer whenever a trustworthy roadbook distance reference is available.

## Local development

```bash
npm install
npm run test
npm run dev
```

## Production build

```bash
npm run build
```

## Vercel

1. Push this folder to a GitHub repository.
2. Import the repository into Vercel.
3. Framework preset: Vite. No `vercel.json` is required for V0.1 because the app uses a single page without client-side URL routes.
4. Build command: `npm run build`.
5. Output directory: `dist`.
6. Deploy.
7. Open the HTTPS URL on the rally phone and allow precise location.
8. Add/install the PWA to the home screen.

## Before using it in an event

- Confirm electronic/GPS rally computers are permitted by your event/class regulations.
- Keep the app in the foreground during competitive sections.
- Disable battery optimisation for the browser/PWA if Android allows it.
- Test GPS permission, wake lock and offline reload on the actual phone.
- Run a calibration route and a mock TSD route before rally day.
- Carry the organiser's roadbook and a backup timing method. V0.1 is new software, not a homologated rally computer.

## GPS filter currently used

The first build rejects fixes with >50 m reported accuracy, impossible jumps above 180 km/h, tiny movements below an accuracy-aware noise gate, and small position movements when the device reports near-zero speed. This must be tuned from real road-test data rather than theory.
