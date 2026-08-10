# TSD Rally V0.4

A deliberately simple, Android-first TSD rally PWA.

## V0.4 additions

- DZ/FZ entries can be inserted into the speed chart.
- A DZ/FZ can be prescribed by either:
  - speed, in which case ideal time is calculated from distance / speed; or
  - total zone time, in which case that exact duration is added to the timing model.
- Fixed-time zones are paced linearly across their distance so the live EARLY/LATE meter remains useful inside the zone and is exact at the exit.
- TCs now create a persistent session log entry before the timing reset.
- Each TC log stores rally odometer distance, clock time, EARLY/LATE status, scratch applied and GPS accuracy.
- END SESSION freezes the run and displays a session summary plus the complete TC log.

## Existing behaviour retained

- V0.3 local-storage keys are retained so an existing phone setup survives the upgrade.
- GPS starts automatically.
- TC can occur anywhere and resets timing using the configured scratch time.
- Manual odometer correction and optional calibration remain available.
- The rally screen remains intentionally bold and minimal.

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

Deploy the repository to Vercel using the Vite preset and `dist` output directory.
