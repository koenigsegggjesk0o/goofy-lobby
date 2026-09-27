import eslint from '@eslint/js';
import tseslint from 'typescript-eslint';
import prettier from 'eslint-config-prettier';

// Catatan: spek menyebut ".eslintrc" — ESLint 10 memakai flat config
// (eslint.config.mjs) sebagai standar; ini padanan fungsionalnya.
export default tseslint.config(
  {
    ignores: [
      'dist',
      'node_modules',
      'coverage',
      'playwright-report',
      'test-results',
      'dev.log',
      'bun.lock',
      // artefak sandbox — bukan kode produk
      'skills',
      '.zscripts',
      'mini-services',
      'download',
      'upload',
    ],
  },
  eslint.configs.recommended,
  ...tseslint.configs.strict,
  // Script Node/Bun lokal (migrations runner, dsb.) — perlu globals Node.
  {
    files: ['scripts/**/*.mjs'],
    languageOptions: {
      globals: {
        console: 'readonly',
        process: 'readonly',
        fetch: 'readonly',
        Buffer: 'readonly',
        URL: 'readonly',
        AbortSignal: 'readonly',
        setTimeout: 'readonly',
        clearTimeout: 'readonly',
        setInterval: 'readonly',
        clearInterval: 'readonly',
      },
    },
  },
  // Probe dev yang berjalan DI BROWSER via page.evaluate — globals DOM.
  {
    files: ['scripts/dev/*.mjs'],
    languageOptions: {
      globals: {
        window: 'readonly',
        RTCPeerConnection: 'readonly',
        Promise: 'readonly',
        setTimeout: 'readonly',
        console: 'readonly',
      },
    },
  },
  prettier,
);
