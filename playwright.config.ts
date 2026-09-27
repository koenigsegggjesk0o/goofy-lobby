import { defineConfig, devices } from '@playwright/test';

// E2E berjalan lewat test-harness (halaman polos tanpa styling — alat uji,
// bukan UI produk). Browser: Chromium saja untuk Fase 1.
export default defineConfig({
  testDir: './e2e',
  fullyParallel: false,
  timeout: 90_000,
  retries: 0,
  reporter: [['list']],
  use: {
    baseURL: 'http://localhost:3000',
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],
  webServer: {
    command: 'bun run dev',
    url: 'http://localhost:3000',
    reuseExistingServer: true,
    timeout: 120_000,
  },
});
