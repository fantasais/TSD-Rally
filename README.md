# TSD Rally Computer V0.3

A deliberately simple GPS-assisted TSD/regularity rally computer built as a React + TypeScript PWA.

## V0.3 rally logic

- GPS starts automatically when the app opens (browser permission is still required).
- The setup uses a plain FROM / TO / AVG speed chart.
- TC locations are **not** pre-programmed. They can appear anywhere on the route.
- Setup has one optional TC scratch-time value (minutes + seconds).
- During a run, pressing **TC** creates a fresh timing anchor at the current odometer and actual time.
- Any accumulated early/late deviation before that TC is scratched/reset.
- If scratch time is configured, the new ideal clock is shifted forward by that amount. Immediately after pressing TC the display therefore shows the configured amount EARLY and counts back toward zero while stationary.
- With zero scratch time, pressing TC resets the deviation to approximately 0.0 seconds immediately.
- Speed changes continue to follow their absolute roadbook distances after a TC.

## Core features

- Official start time / arm start
- Start-now testing mode
- Live GPS odometer
- Calibration factor
- Manual −10 m / SET ODO / +10 m correction
- Live early/late timing delta
- Automatic speed changes by roadbook distance
- TC reset + scratch handling
- Offline-capable PWA
- Screen wake lock request while armed/running
- Local persistence

## Development

```bash
npm install
npm run test
npm run build
npm run dev
```

## Deployment

Vercel settings:
- Framework preset: Vite
- Build command: `npm run build`
- Output directory: `dist`

Core rally operation is designed not to depend on a network connection once the PWA is cached.
