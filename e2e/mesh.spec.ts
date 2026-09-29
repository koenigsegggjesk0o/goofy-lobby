import { expect, test, type Browser, type Page } from '@playwright/test';
import { qaUser, type QaUser } from './helpers/qa-env';

/**
 * Mesh WebRTC end-to-end dengan DUA konteks browser terpisah (storage
 * terisolasi — tiap konteks signin sebagai QA user berbeda):
 * presence saling menemukan → signaling offer/answer/ice via Realtime
 * broadcast → koneksi P2P 'connected' → track audio diterima (stream mock
 * disematkan alpha) → posisi mengalir lewat DataChannel → leave bersih.
 */

const alpha = qaUser('alpha');
const bravo = qaUser('bravo');

test.setTimeout(240_000); // negosiasi ICE di jaringan lambat — kasih ruang

async function signInOn(page: Page, user: QaUser): Promise<void> {
  await page.goto('/test-harness/');
  await expect(page.locator('#harness-status')).toContainText('harness siap');
  const result = await page.evaluate(
    async ({ email, password }) => window.__harness.signIn(email, password),
    { email: user.email, password: user.password },
  );
  expect(result.ok).toBe(true);
}

test('mesh dua konteks: presence, koneksi P2P, stream, posisi, leave', async ({
  browser,
}: {
  browser: Browser;
}) => {
  // P0-1: room diterbitkan SERVER — alpha host (createRoom), kode dibagikan
  // ke bravo lewat hasil joinMesh (bukan dikarang client lagi).
  const contextAlpha = await browser.newContext();
  const contextBravo = await browser.newContext();
  const pageAlpha = await contextAlpha.newPage();
  const pageBravo = await contextBravo.newPage();

  try {
    await signInOn(pageAlpha, alpha);
    await signInOn(pageBravo, bravo);

    // alpha menyematkan stream mock → bravo harus menerima track audio
    const joinAlpha = await pageAlpha.evaluate(() =>
      window.__harness.joinMesh('', { createRoom: true, attachMockStream: true }),
    );
    expect(joinAlpha.ok).toBe(true);
    const roomCode = joinAlpha.roomCode;
    if (typeof roomCode !== 'string') {
      throw new Error(`createRoom tidak menghasilkan kode: ${JSON.stringify(joinAlpha)}`);
    }

    const joinBravo = await pageBravo.evaluate((code) => window.__harness.joinMesh(code), roomCode);
    expect(joinBravo.ok).toBe(true);
    expect(joinAlpha.sessionId).not.toBe(joinBravo.sessionId);

    // presence: masing-masing melihat satu peer
    await expect
      .poll(() => pageAlpha.evaluate(() => window.__harness.meshState().peers.length), {
        timeout: 30_000,
      })
      .toBe(1);
    await expect
      .poll(() => pageBravo.evaluate(() => window.__harness.meshState().peers.length), {
        timeout: 30_000,
      })
      .toBe(1);

    // koneksi P2P benar-benar tersambung di kedua sisi
    await expect
      .poll(
        () => pageAlpha.evaluate(() => window.__harness.meshState().peers[0]?.connectionState),
        { timeout: 60_000 },
      )
      .toBe('connected');
    await expect
      .poll(
        () => pageBravo.evaluate(() => window.__harness.meshState().peers[0]?.connectionState),
        { timeout: 60_000 },
      )
      .toBe('connected');

    // Task 11-b: pasangan kandidat TERPILIH terbaca di jalur mesh nyata
    // (host/srflx/prflx/relay — bukti jalur aktual, bukan kandidat terkumpul).
    for (const page of [pageAlpha, pageBravo]) {
      await expect
        .poll(
          () =>
            page.evaluate(() => {
              const pair = window.__harness.meshState().peers[0]?.selectedPair ?? null;
              return pair !== null && ['host', 'srflx', 'prflx', 'relay'].includes(pair.localType);
            }),
          { timeout: 30_000 },
        )
        .toBe(true);
    }

    // track audio dari stream mock alpha sampai ke bravo
    await expect
      .poll(
        async () =>
          (await pageBravo.evaluate(() => window.__harness.meshLog())).some(
            (entry) => entry.event === 'remote-stream',
          ),
        { timeout: 30_000 },
      )
      .toBe(true);

    // posisi alpha mengalir ke bravo lewat DataChannelSync
    const moved = await pageAlpha.evaluate(() => window.__harness.setLocalPosition(42, -7));
    expect(moved.ok).toBe(true);
    await expect
      .poll(
        async () =>
          (
            await pageBravo.evaluate(
              () => window.__harness.meshState().peers[0]?.lastPosition ?? null,
            )
          )?.x,
        { timeout: 30_000 },
      )
      .toBe(42);

    // metadata presence benar: bravo melihat nama alpha
    const peerName = await pageBravo.evaluate(
      () => window.__harness.meshState().peers[0]?.displayName,
    );
    expect(peerName).toBe('QA Alpha');

    // leave bersih di kedua sisi
    const leaveAlpha = await pageAlpha.evaluate(() => window.__harness.leaveMesh());
    expect(leaveAlpha.ok).toBe(true);
    const leaveBravo = await pageBravo.evaluate(() => window.__harness.leaveMesh());
    expect(leaveBravo.ok).toBe(true);

    expect(await pageAlpha.evaluate(() => window.__harness.meshState().joined)).toBe(false);
    expect(await pageBravo.evaluate(() => window.__harness.meshState().joined)).toBe(false);
  } finally {
    // dump mesh log untuk diagnosis bila gagal (murah bila lolos)
    for (const [label, meshPage] of [
      ['alpha', pageAlpha],
      ['bravo', pageBravo],
    ] as const) {
      try {
        const state = await meshPage.evaluate(() => window.__harness.meshState());
        const log = await meshPage.evaluate(() => window.__harness.meshLog());
        console.log(`\n===== meshLog ${label} (joined=${state.joined}) =====`);
        for (const entry of log.slice(-30)) {
          console.log(`  ${entry.at} ${entry.event} ${JSON.stringify(entry.detail)}`);
        }
      } catch {
        // halaman sudah tertutup — abaikan
      }
    }
    await contextAlpha.close();
    await contextBravo.close();
  }
});
