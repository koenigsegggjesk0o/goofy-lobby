import { expect, test } from '@playwright/test';

/**
 * Smoke test audio spasial di browser asli: SpatialAudioEngine membuat
 * AudioContext sungguhan, meregistrasi voice peer dari stream sintetis,
 * menerapkan posisi panner + listener, lalu dispose bersih.
 * (contextState tidak diasumsikan 'running' — autoplay policy bisa
 * menahan resume di lingkungan headless; node tetap terpasang.)
 */

test('audio smoke: engine spasial hidup di AudioContext asli', async ({ page }) => {
  await page.goto('/test-harness/');
  await expect(page.locator('#harness-status')).toContainText('harness siap');

  const result = await page.evaluate(() => window.__harness.audioSmoke());
  expect(result.ok).toBe(true);
  expect(result.peerVoiceIds).toContain('smoke-peer');
  expect(result.peerPosition).toEqual({ x: 3, y: -4 });
  expect(result.muted).toBe(false);
  expect(result.disposed).toBe(true);
});
