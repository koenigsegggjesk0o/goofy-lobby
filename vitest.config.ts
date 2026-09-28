import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    // scripts/**/*.test.mts — utang 13-a dibayar (15-c): agregasi stress
    // (summarizeStressRuns) kini dites LANGSUNG; modul .mjs diimpor via
    // cast eksplisit (tanpa file deklarasi duplikatif).
    include: ['src/**/*.test.ts', 'scripts/**/*.test.mts'],
  },
});
