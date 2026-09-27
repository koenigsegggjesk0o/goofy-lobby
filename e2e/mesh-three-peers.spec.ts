import { expect, test, type Browser, type Page } from '@playwright/test';
import { qaUser, type QaUser } from './helpers/qa-env';

/**
 * Mesh WebRTC end-to-end dengan TIGA konteks browser terpisah (alpha, bravo,
 * charlie — storage terisolasi): full-mesh berarti TIAP sisi harus melihat
 * 2 peer dan kedua koneksi P2P 'connected'; posisi alpha harus mengalir ke
 * DUA sisi sekaligus lewat DataChannelSync; leave bersih di tiga sisi.
 *
 * PREP 8-e (ditulis siklus 8-i): dieksekusi penuh hanya setelah TEST_USER_*
 * alpha+bravo+charlie lengkap di .env — sampai itu, spec gagal cepat dengan
 * pesan qaUser() (konvensi fail-fast yang sama dengan spec auth-dependent
 * lain; bukan bug). Kapasitas room 8 → 3 peer jauh di bawah batas.
 */

const alpha = qaUser('alpha');
const bravo = qaUser('bravo');
const charlie = qaUser('charlie');

test.setTimeout(300_000); // 3 koneksi P2P dinegosiasikan — kasih ruang lebih dari 2-peer

async function signInOn(page: Page, user: QaUser): Promise<void> {
  await page.goto('/test-harness/');
  await expect(page.locator('#harness-status')).toContainText('harness siap');
  const result = await page.evaluate(
    async ({ email, password }) => window.__harness.signIn(email, password),
    { email: user.email, password: user.password },
  );
  expect(result.ok).toBe(true);
}

async function connectedCount(page: Page): Promise<number> {
  return page.evaluate(
    () =>
      window.__harness.meshState().peers.filter((peer) => peer.connectionState === 'connected')
        .length,
  );
}

test('mesh tiga konteks: full-mesh 2 peer/sisi, posisi broadcast dua sisi, leave', async ({
  browser,
}: {
  browser: Browser;
}) => {
  const roomCode = `e2e${Math.random().toString(36).slice(2, 8)}`; // [a-z0-9]{4,12}

  const contextAlpha = await browser.newContext();
  const contextBravo = await browser.newContext();
  const contextCharlie = await browser.newContext();
  const pageAlpha = await contextAlpha.newPage();
  const pageBravo = await contextBravo.newPage();
  const pageCharlie = await contextCharlie.newPage();

  try {
    await signInOn(pageAlpha, alpha);
    await signInOn(pageBravo, bravo);
    await signInOn(pageCharlie, charlie);

    // alpha menyematkan stream mock → track audio harus diterima bravo & charlie
    const joinAlpha = await pageAlpha.evaluate(
      (code) => window.__harness.joinMesh(code, { attachMockStream: true }),
      roomCode,
    );
    expect(joinAlpha.ok).toBe(true);
    const joinBravo = await pageBravo.evaluate((code) => window.__harness.joinMesh(code), roomCode);
    expect(joinBravo.ok).toBe(true);
    const joinCharlie = await pageCharlie.evaluate(
      (code) => window.__harness.joinMesh(code),
      roomCode,
    );
    expect(joinCharlie.ok).toBe(true);

    const sessionIds = new Set([joinAlpha.sessionId, joinBravo.sessionId, joinCharlie.sessionId]);
    expect(sessionIds.size).toBe(3);

    // presence: full-mesh — tiap sisi melihat TEPAT 2 peer
    for (const page of [pageAlpha, pageBravo, pageCharlie]) {
      await expect
        .poll(() => page.evaluate(() => window.__harness.meshState().peers.length), {
          timeout: 30_000,
        })
        .toBe(2);
    }

    // koneksi P2P 'connected' untuk KEDUA peer di tiap sisi (3 pasangan total:
    // alpha-bravo, alpha-charlie, bravo-charlie)
    for (const page of [pageAlpha, pageBravo, pageCharlie]) {
      await expect.poll(() => connectedCount(page), { timeout: 60_000 }).toBe(2);
    }

    // track audio dari stream mock alpha sampai ke bravo DAN charlie
    for (const page of [pageBravo, pageCharlie]) {
      await expect
        .poll(
          async () =>
            (await page.evaluate(() => window.__harness.meshLog())).some(
              (entry) => entry.event === 'remote-stream',
            ),
          { timeout: 30_000 },
        )
        .toBe(true);
    }

    // posisi alpha mengalir ke DUA sisi — dicari per displayName karena urutan
    // array peers tidak dijamin
    const moved = await pageAlpha.evaluate(() => window.__harness.setLocalPosition(-13, 55));
    expect(moved.ok).toBe(true);
    for (const page of [pageBravo, pageCharlie]) {
      await expect
        .poll(
          async () =>
            await page.evaluate(() => {
              const peer = window.__harness
                .meshState()
                .peers.find((candidate) => candidate.displayName === 'QA Alpha');
              return peer?.lastPosition?.x ?? null;
            }),
          { timeout: 30_000 },
        )
        .toBe(-13);
    }

    // metadata presence benar: bravo melihat alpha+charlie, charlie melihat alpha+bravo
    const namesOnBravo = await pageBravo.evaluate(() =>
      window.__harness
        .meshState()
        .peers.map((peer) => peer.displayName)
        .sort(),
    );
    expect(namesOnBravo).toEqual(['QA Alpha', 'QA Charlie']);
    const namesOnCharlie = await pageCharlie.evaluate(() =>
      window.__harness
        .meshState()
        .peers.map((peer) => peer.displayName)
        .sort(),
    );
    expect(namesOnCharlie).toEqual(['QA Alpha', 'QA Bravo']);

    // leave bersih di ketiga sisi
    for (const page of [pageAlpha, pageBravo, pageCharlie]) {
      const left = await page.evaluate(() => window.__harness.leaveMesh());
      expect(left.ok).toBe(true);
      expect(await page.evaluate(() => window.__harness.meshState().joined)).toBe(false);
    }
  } finally {
    // dump mesh log untuk diagnosis bila gagal (murah bila lolos)
    for (const [label, meshPage] of [
      ['alpha', pageAlpha],
      ['bravo', pageBravo],
      ['charlie', pageCharlie],
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
    await contextCharlie.close();
  }
});
