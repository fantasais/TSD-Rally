import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { VitePWA } from 'vite-plugin-pwa'

export default defineConfig({
  plugins: [
    react(),
    VitePWA({
      registerType: 'autoUpdate',
      injectRegister: 'auto',
      // OCR resources are copied into public/ocr before every build. Workbox
      // scans the final dist folder below and precaches them for flight-mode use.
      manifest: {
        id: '/',
        start_url: '/',
        scope: '/',
        name: 'TSD Rally',
        short_name: 'TSD Rally',
        description: 'Offline TSD rally navigator computer',
        theme_color: '#080808',
        background_color: '#080808',
        display: 'standalone',
        orientation: 'portrait',
        prefer_related_applications: false,
        categories: ['sports', 'navigation'],
        icons: [
          { src: '/icon-192.png', sizes: '192x192', type: 'image/png' },
          { src: '/icon-512.png', sizes: '512x512', type: 'image/png' }
        ]
      },
      workbox: {
        navigateFallback: '/index.html',
        globPatterns: ['**/*.{js,mjs,css,html,png,svg,ico,wasm,gz}'],
        // Tesseract core/language files are larger than Workbox's 2 MiB default.
        maximumFileSizeToCacheInBytes: 15 * 1024 * 1024
      }
    })
  ]
})
