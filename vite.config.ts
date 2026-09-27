import { fileURLToPath, URL } from 'node:url';
import { defineConfig } from 'vite';

// Fase 1: dev server untuk test-harness — TIDAK ADA UI produk (lihat spek:
// BATASAN RUANG LINGKUP). Entry build test-harness (F1.6) disertakan supaya
// `vite build` ikut mengeluarkan dist/test-harness/index.html.
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
        harness: fileURLToPath(new URL('./test-harness/index.html', import.meta.url)),
      },
    },
  },
  // Batasi dependency-scan & watch hanya ke entry produk — folder artefak
  // sandbox (skills/, .zscripts/, dst.) diabaikan.
  optimizeDeps: {
    entries: ['index.html', 'test-harness/**/*.html'],
  },
  server: {
    watch: {
      ignored: ['**/skills/**', '**/.zscripts/**', '**/mini-services/**'],
    },
  },
});
