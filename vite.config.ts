import { fileURLToPath, URL } from 'node:url';
import { defineConfig } from 'vite';

// Fase 1: dev server untuk test-harness — TIDAK ADA UI produk (lihat spek:
// BATASAN RUANG LINGKUP). Entry build test-harness ditambahkan saat F1.6.
export default defineConfig({
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
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
