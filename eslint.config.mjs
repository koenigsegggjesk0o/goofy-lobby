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
  prettier,
);
