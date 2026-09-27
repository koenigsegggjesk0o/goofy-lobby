import { expect, test } from '@playwright/test';

/**
 * Status TURN lewat envStatus (Task 8-d) — spec TANPA auth dan TANPA env
 * Supabase: window.__harness dipasang selalu (bahkan saat halaman berstatus
 * "harness TIDAK siap" karena env klien belum lengkap), jadi kontrak
 * envStatus.turn tetap terverifikasi di lingkungan apa pun.
 *
 * Env e2e lokal memang tidak menyetel VITE_TURN_* → status wajib 'disabled'
 * (fallback STUN-only). Kasus 'enabled'/'invalid' tercakup unit test
 * turn-config.test.ts (25 test injeksi source); kasus live 'enabled'
 * menyusul begitu kredensial TURN Metered diisi (Fase 2 penuh).
 */

test('envStatus.turn: disabled tanpa VITE_TURN_* (fallback STUN-only)', async ({ page }) => {
  await page.goto('/test-harness/');
  await page.waitForFunction(() => window.__harness !== undefined, undefined, {
    timeout: 15_000,
  });

  const status = await page.evaluate(() => window.__harness.envStatus());
  expect(status.turn.status).toBe('disabled');
  expect(status.turn.reasons).toEqual([]);
});

test('envStatus: kontrak field stabil lintas keadaan env', async ({ page }) => {
  await page.goto('/test-harness/');
  await page.waitForFunction(() => window.__harness !== undefined, undefined, {
    timeout: 15_000,
  });

  const status = await page.evaluate(() => window.__harness.envStatus());
  // Keadaan ready boleh beda (env lengkap vs belum), tetapi bentuk hasil tidak.
  expect(typeof status.ready).toBe('boolean');
  expect(Array.isArray(status.missing)).toBe(true);
  expect(typeof status.hasTurnstileKey).toBe('boolean');
  expect(typeof status.hasSentryDsn).toBe('boolean');
  expect(['disabled', 'enabled', 'invalid']).toContain(status.turn.status);
  expect(Array.isArray(status.turn.reasons)).toBe(true);
});
