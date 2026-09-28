import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { expect, test } from '@playwright/test';

/**
 * Monitoring Sentry live lewat test-harness:
 * init dari VITE_SENTRY_DSN → captureException (eventId) → flush (terkirim)
 * → probe langsung ke endpoint ingest (bukti keras HTTP 200, sama seperti
 * verifikasi F1.2 tapi dari dalam browser).
 *
 * Self-gating: tanpa VITE_SENTRY_DSN asli spec ini DI-SKIP jujur (bukan
 * DSN mock) — selaras gating env-matrix di `bun run verify`, sehingga
 * `playwright test` langsung pun tidak merah hanya karena env opsional
 * belum disetel.
 */
const envVars = new Set<string>();
const envPath = resolve(process.cwd(), '.env');
if (existsSync(envPath)) {
  for (const line of readFileSync(envPath, 'utf8').split('\n')) {
    const m = /^([A-Z0-9_]+)=.+$/.exec(line.trim());
    if (m !== null && m[1] !== undefined) envVars.add(m[1]);
  }
}
const hasSentryDsn = envVars.has('VITE_SENTRY_DSN');
test.skip(
  !hasSentryDsn,
  'VITE_SENTRY_DSN tidak disetel — ingest live Sentry butuh DSN asli (anti-mock)',
);

test('init → capture → flush → ingest live', async ({ page }) => {
  await page.goto('/test-harness/');
  await expect(page.locator('#harness-status')).toContainText('harness siap');

  const init = await page.evaluate(() => window.__harness.initMonitoringLive());
  expect(init.ok).toBe(true);
  expect(init.hasDsn).toBe(true);
  expect(init.initialized).toBe(true);
  expect(init.skipped).toBeNull();

  const captured = await page.evaluate(() =>
    window.__harness.captureTestError('e2e-monitoring-probe'),
  );
  expect(captured.ok).toBe(true);
  expect(captured.eventId).not.toBe('');

  const flushed = await page.evaluate(() => window.__harness.flushMonitoringLive());
  expect(flushed.ok).toBe(true);
  expect(flushed.sent).toBe(true);

  const status = await page.evaluate(() => window.__harness.monitoringStatusLive());
  expect(status.initialized).toBe(true);
  expect(status.enabled).toBe(true);

  const ingest = await page.evaluate(() => window.__harness.verifySentryIngest());
  expect(ingest.ok).toBe(true);
  expect(ingest.status).toBe(200);
  expect(ingest.eventId).not.toBe('');
});
