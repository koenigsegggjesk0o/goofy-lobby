import { expect, test } from '@playwright/test';

/**
 * Monitoring Sentry live lewat test-harness:
 * init dari VITE_SENTRY_DSN → captureException (eventId) → flush (terkirim)
 * → probe langsung ke endpoint ingest (bukti keras HTTP 200, sama seperti
 * verifikasi F1.2 tapi dari dalam browser).
 */

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
