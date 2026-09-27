import { expect, test } from '@playwright/test';
import { qaUser } from './helpers/qa-env';

/**
 * Matriks RLS ringan (tabel profiles, policy 0002) lewat test-harness:
 *  - anon tidak melihat baris apa pun;
 *  - authenticated boleh membaca semua baris (select_authenticated);
 *  - tulis hanya baris sendiri — patch lintas user menyentuh 0 baris;
 *  - readback membuktikan data lintas user TIDAK berubah.
 */

const alpha = qaUser('alpha');
const bravo = qaUser('bravo');

test('anon tidak melihat profil apa pun (RLS select authenticated)', async ({ page }) => {
  await page.goto('/test-harness/');
  await expect(page.locator('#harness-status')).toContainText('harness siap');

  const session = await page.evaluate(() => window.__harness.getSession());
  expect(session.signedIn).toBe(false);

  const probe = await page.evaluate(() => window.__harness.probeListProfiles());
  expect(probe.ok).toBe(true);
  expect(probe.count).toBe(0);
});

test('profil sendiri terbaca dan bisa di-update lalu dipulihkan', async ({ page }) => {
  await page.goto('/test-harness/');
  await expect(page.locator('#harness-status')).toContainText('harness siap');

  const signIn = await page.evaluate(
    async ({ email, password }) => window.__harness.signIn(email, password),
    { email: alpha.email, password: alpha.password },
  );
  expect(signIn.ok).toBe(true);

  const initial = await page.evaluate(() => window.__harness.getProfile());
  expect(initial.ok).toBe(true);
  expect(initial.profile?.id).toBe(alpha.id);
  expect(initial.profile?.displayName).toBe('QA Alpha');

  const updated = await page.evaluate(() =>
    window.__harness.updateProfile({ displayName: 'QA Alpha E2E', avatarColor: '#ff0055' }),
  );
  expect(updated.ok).toBe(true);
  expect(updated.profile?.displayName).toBe('QA Alpha E2E');
  expect(updated.profile?.avatarColor).toBe('#ff0055');

  const restored = await page.evaluate(() =>
    window.__harness.updateProfile({ displayName: 'QA Alpha', avatarColor: '#22c55e' }),
  );
  expect(restored.ok).toBe(true);
  expect(restored.profile?.displayName).toBe('QA Alpha');
});

test('authenticated melihat profil user lain (policy select_authenticated)', async ({ page }) => {
  await page.goto('/test-harness/');
  await expect(page.locator('#harness-status')).toContainText('harness siap');

  const signIn = await page.evaluate(
    async ({ email, password }) => window.__harness.signIn(email, password),
    { email: alpha.email, password: alpha.password },
  );
  expect(signIn.ok).toBe(true);

  const probe = await page.evaluate((id) => window.__harness.probeReadProfile(id), bravo.id);
  expect(probe.ok).toBe(true);
  expect(probe.displayName).toBe('QA Bravo');
});

test('tulis profil user lain diblokir RLS (0 baris tersentuh)', async ({ page }) => {
  await page.goto('/test-harness/');
  await expect(page.locator('#harness-status')).toContainText('harness siap');

  const signIn = await page.evaluate(
    async ({ email, password }) => window.__harness.signIn(email, password),
    { email: alpha.email, password: alpha.password },
  );
  expect(signIn.ok).toBe(true);

  const write = await page.evaluate(
    (id) => window.__harness.probeWriteProfile(id, 'HACKED'),
    bravo.id,
  );
  expect(write.ok).toBe(true);
  expect(write.changed).toBe(false);

  const readback = await page.evaluate((id) => window.__harness.probeReadProfile(id), bravo.id);
  expect(readback.ok).toBe(true);
  expect(readback.displayName).toBe('QA Bravo');
});
