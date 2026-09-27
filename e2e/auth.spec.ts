import { expect, test } from '@playwright/test';
import { qaUser } from './helpers/qa-env';

/**
 * E2E auth lewat test-harness.
 *
 * DoD #4 (jalur penolakan): signup TANPA captcha token wajib ditolak
 * 400 captcha_failed — captcha Turnstile aktif di konfigurasi Auth.
 * Happy-path signin memakai QA users buatan admin (email sudah terkonfirmasi,
 * tanpa menyentuh rate limit email 2/jam).
 */

const alpha = qaUser('alpha');

test('halaman harness termuat dengan env lengkap', async ({ page }) => {
  await page.goto('/test-harness/');
  await expect(page.locator('#harness-status')).toContainText('harness siap', { timeout: 15_000 });
});

test('signup tanpa captcha token ditolak captcha_failed (DoD #4)', async ({ page }) => {
  await page.goto('/test-harness/');
  await expect(page.locator('#harness-status')).toContainText('harness siap');

  const email = `nocap-${Date.now()}@goofy.example.com`;
  const result = await page.evaluate(
    async (email) => window.__harness.signUp(email, 'Passw0rd!e2e'),
    email,
  );

  expect(result.ok).toBe(false);
  expect(result.code).toBe('captcha_failed');
});

test('signin QA alpha happy path (captcha dummy test key)', async ({ page }) => {
  await page.goto('/test-harness/');
  await expect(page.locator('#harness-status')).toContainText('harness siap');

  const result = await page.evaluate(
    async ({ email, password }) => window.__harness.signIn(email, password),
    { email: alpha.email, password: alpha.password },
  );

  expect(result.ok).toBe(true);
  expect(result.userId).toBe(alpha.id);

  const session = await page.evaluate(() => window.__harness.getSession());
  expect(session.signedIn).toBe(true);
  expect(session.userId).toBe(alpha.id);
  expect(session.email).toBe(alpha.email);
});

test('signin dengan password salah ditolak invalid_credentials', async ({ page }) => {
  await page.goto('/test-harness/');
  await expect(page.locator('#harness-status')).toContainText('harness siap');

  const result = await page.evaluate(
    async ({ email }) => window.__harness.signIn(email, 'PasswordYangSalah123!'),
    { email: alpha.email },
  );

  expect(result.ok).toBe(false);
  expect(result.code).toBe('invalid_credentials');
});

test('signout mengakhiri sesi', async ({ page }) => {
  await page.goto('/test-harness/');
  await expect(page.locator('#harness-status')).toContainText('harness siap');

  const signIn = await page.evaluate(
    async ({ email, password }) => window.__harness.signIn(email, password),
    { email: alpha.email, password: alpha.password },
  );
  expect(signIn.ok).toBe(true);

  const signOut = await page.evaluate(() => window.__harness.signOut());
  expect(signOut.ok).toBe(true);

  const session = await page.evaluate(() => window.__harness.getSession());
  expect(session.signedIn).toBe(false);
  expect(session.userId).toBeNull();
});
