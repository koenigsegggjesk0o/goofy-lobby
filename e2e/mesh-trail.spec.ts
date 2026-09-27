import { expect, test } from '@playwright/test';

/**
 * Jejak breadcrumb mesh via trailLog() (Task 10-a) — spec TANPA auth dan
 * TANPA env apapun: ring lokal trail-log terpasang di modul monitoring
 * (bukan SDK Sentry), jadi breadcrumb tetap teramati meski DSN kosong.
 *
 * Ini menutup celah kejujuran Task 8-g: "breadcrumb ke SDK Sentry tidak
 * bisa diverifikasi live tanpa DSN" — kini jalur APP-SIDE terverifikasi
 * di lingkungan apa pun; jalur dashboard tetap butuh VITE_SENTRY_DSN.
 *
 * Pola turn-config.spec.ts: window.__harness dipasang selalu walau env
 * belum lengkap; joinMesh tanpa signin gagal di env/auth check —
 * 'mesh join attempt' TETAP tercatat (breadcrumb attempt didorong
 * SEBELUM auth, by design Task 8-g).
 */

const waitForHarness = (page: import('@playwright/test').Page) =>
  page.waitForFunction(() => window.__harness !== undefined, undefined, {
    timeout: 15_000,
  });

test('trailLog: terpasang dan kosong di halaman segar', async ({ page }) => {
  await page.goto('/test-harness/');
  await waitForHarness(page);

  const log = await page.evaluate(() => window.__harness.trailLog());
  // Kontrak: selalu array (lingkungan apa pun); halaman segar belum ada
  // aktivitas mesh → kosong.
  expect(Array.isArray(log)).toBe(true);
  expect(log).toEqual([]);
});

test('joinMesh gagal (env/belum signin) → "mesh join attempt" tetap tercatat', async ({ page }) => {
  await page.goto('/test-harness/');
  await waitForHarness(page);

  const join = await page.evaluate(() => window.__harness.joinMesh('qa-trail-1'));
  // Lingkungan e2e lokal tanpa env klien: join ditolak cepat (fail-fast).
  // Bila env lengkap tapi tanpa signin: ditolak auth — keduanya ok:false.
  expect(join.ok).toBe(false);

  const trail = await page.evaluate(() => window.__harness.trailLog());
  const attempt = trail.find((e) => e.message === 'mesh join attempt');
  expect(attempt).toBeDefined();
  expect(attempt?.category).toBe('mesh');
  expect(attempt?.level).toBe('info');
  // turnStatus apa pun valid (disabled tanpa env TURN; enabled/invalid
  // bila kredensial TURN terisi) — kontrak field, bukan nilai env spesifik.
  expect(['disabled', 'enabled', 'invalid']).toContain(attempt?.data?.turnStatus);
  expect(attempt?.data?.roomCode).toBe('qa-trail-1');
  expect(new Date(attempt?.at ?? 'bukan-iso').toString()).not.toBe('Invalid Date');
});

test('ring berbatas: 60 join attempt → 50 entri terakhir, terlama terbuang', async ({ page }) => {
  await page.goto('/test-harness/');
  await waitForHarness(page);

  const roomCodes = await page.evaluate(async () => {
    for (let i = 0; i < 60; i++) {
      await window.__harness.joinMesh(`qa-ring-${i}`);
    }
    return window.__harness.trailLog().map((e) => e.data?.roomCode);
  });
  // 60 attempt → ring FIFO menyimpan 50 terakhir (#10..#59).
  expect(roomCodes).toHaveLength(50);
  expect(roomCodes[0]).toBe('qa-ring-10');
  expect(roomCodes[49]).toBe('qa-ring-59');
});
