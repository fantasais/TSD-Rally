# TSD Rally V0.5 — Local OCR build

Android-first TSD rally PWA with GPS timing, TC/SFTC logging and local photo speed-chart import.

## V0.5 photo import

- Select a speed-chart photograph from the phone.
- OCR runs in the browser on the phone using Tesseract.js / WebAssembly.
- No OpenAI API key, Vercel Function or per-scan API billing is required.
- The importer reads START ODO / END ODO / SPEED and recognises rows containing `MINUTE(S)` as time-defined DZ/FZ entries.
- Every interpreted row remains editable before `CONFIRM & LOAD`.
- Deterministic continuity checks flag gaps, overlaps, invalid speeds and invalid durations.
- Manual chart entry remains available at all times.

### First-use note

The OCR engine/language assets may need to download once on first use. Tesseract.js caches trained language data in the browser, and the PWA also caches its jsDelivr OCR runtime requests. For the safest rally workflow, open the app and run one test photo before heading to an area with weak data coverage.

## Local development

```bash
npm install
npm run test
npm run dev
```

## Production

Deploy to Vercel using the Vite preset and `dist` output directory. No environment variables are required for OCR.

## V0.5 field-feedback refinements

- Rally timing strip shows 24-hour ACTUAL TIME and IDEAL TIME instead of elapsed rally clocks.
- New CONTROLS tab records TC stamps and allows ODO/time correction. The latest TC correction re-anchors live timing; older corrections update history only.
- Press Enter on the final speed/time value in Setup to create the next SPEED row automatically and focus its TO km field.
- Local speed-chart OCR remains browser-side with Tesseract.js; no API key is required.
