import { fileURLToPath, URL } from 'node:url';
import { defineConfig } from 'vite';

// Fase 1: dev server untuk test-harness — TIDAK ADA UI produk (lihat spek:
// BATASAN RUANG LINGKUP). Entry build test-harness (F1.6) HANYA disertakan
// bila BUILD_HARNESS=1 (remediasi audit 25-a): build produksi murni
// `vite build` hanya mengeluarkan index.html utama; build QA
// `BUILD_HARNESS=1 vite build` (script package.json "build:harness") ikut
// mengeluarkan dist/test-harness/index.html. optimizeDeps TETAP memuat
// harness — dev server membutuhkannya.
const includeHarness = process.env.BUILD_HARNESS === '1';

export default defineConfig({
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  build: {
    rollupOptions: {
      input: {
        main: fileURLToPath(new URL('./index.html', import.meta.url)),
        ...(includeHarness
          ? { harness: fileURLToPath(new URL('./test-harness/index.html', import.meta.url)) }
          : {}),
      },
    },
  },
  // Batasi dependency-scan & watch hanya ke entry produk — folder artefak
  // sandbox (skills/, .zscripts/, dst.) diabaikan.
  optimizeDeps: {
    entries: ['index.html', 'test-harness/**/*.html'],
  },
  server: {
    // Header keamanan DEV (remediasi 25-a): dev server meniru header yang
    // nanti dipasang host-level di produksi. CSP SENGAJA tidak dipasang di
    // dev — mematikan HMR (eval/source map Vite butuh relaksasi).
    headers: {
      'X-Content-Type-Options': 'nosniff',
      'X-Frame-Options': 'DENY',
      'Referrer-Policy': 'no-referrer',
      'Permissions-Policy': 'microphone=(self), camera=(), geolocation=()',
    },
    watch: {
      ignored: ['**/skills/**', '**/.zscripts/**', '**/mini-services/**'],
    },
  },
});
