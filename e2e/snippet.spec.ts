import { expect, test } from '@playwright/test';
import { qaUser } from './helpers/qa-env';

/**
 * Siklus hidup snippet suara LIVE (bucket voice-snippets, migrasi 0003/0004/0006):
 * rekam dari stream sintetis lewat MediaRecorder asli browser → upload ke
 * folder sendiri (RLS owner-only) → profil menunjuk path baru → signed URL
 * bisa di-fetch → cleanup menyisakan bucket bersih.
 * Plus probe negatif: upload ke folder user lain ditolak RLS.
 */

const alpha = qaUser('alpha');
const bravo = qaUser('bravo');

test.beforeEach(async ({ page }) => {
  await page.goto('/test-harness/');
  await expect(page.locator('#harness-status')).toContainText('harness siap');
  const signIn = await page.evaluate(
    async ({ email, password }) => window.__harness.signIn(email, password),
    { email: alpha.email, password: alpha.password },
  );
  expect(signIn.ok).toBe(true);

  // deterministis: bersihkan penunjuk + sisa objek dari run sebelumnya
  await page.evaluate(() => window.__harness.clearSnippet());
  const cleanup = await page.evaluate(() => window.__harness.cleanupSnippets());
  expect(cleanup.ok).toBe(true);
  expect(cleanup.remaining).toHaveLength(0);
});

test('rekam mock → upload → profil menunjuk path → signed url ter-fetch → bersih', async ({
  page,
}) => {
  const recording = await page.evaluate(() => window.__harness.recordMockSnippet(1200));
  expect(recording.ok).toBe(true);
  expect(recording.bytes).toBeGreaterThan(0);
  expect(recording.mimeType).toContain('audio/webm');
  expect(recording.autoStopped).toBeNull();

  const upload = await page.evaluate(() => window.__harness.uploadLastRecording());
  expect(upload.ok).toBe(true);
  expect(upload.path).toContain(`${alpha.id}/`);
  expect(upload.path).toMatch(/\.webm$/);

  const profile = await page.evaluate(() => window.__harness.getProfile());
  expect(profile.ok).toBe(true);
  expect(profile.profile?.voiceSnippetPath).toBe(upload.path);

  const playback = await page.evaluate(() => window.__harness.createPlaybackUrl());
  expect(playback.ok).toBe(true);
  expect(playback.signedUrl).toContain('/storage/v1/object/sign/voice-snippets/');
  expect(playback.expiresInS).toBeGreaterThan(0);

  const fetched = await page.evaluate(() => window.__harness.fetchSnippet());
  expect(fetched.ok).toBe(true);
  expect(fetched.status).toBe(200);
  expect(fetched.contentType).toContain('audio/webm');
  expect(fetched.bytes).toBe(recording.bytes);

  const names = await page.evaluate(() => window.__harness.listSnippets());
  expect(names.ok).toBe(true);
  const snippetName = upload.path?.split('/')[1] ?? '';
  expect(snippetName).not.toBe('');
  expect(names.names).toContain(snippetName);

  const cleared = await page.evaluate(() => window.__harness.clearSnippet());
  expect(cleared.ok).toBe(true);
  expect(cleared.clearedPath).toBe(upload.path);

  const afterClear = await page.evaluate(() => window.__harness.getProfile());
  expect(afterClear.profile?.voiceSnippetPath).toBeNull();

  const cleanup = await page.evaluate(() => window.__harness.cleanupSnippets());
  expect(cleanup.remaining).toHaveLength(0);
});

test('upload ke folder user lain ditolak RLS storage', async ({ page }) => {
  const probe = await page.evaluate((id) => window.__harness.probeUploadToFolder(id), bravo.id);
  expect(probe.ok).toBe(true);
  expect(probe.blocked).toBe(true);
});
