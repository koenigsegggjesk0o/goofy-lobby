/**
 * Probe diagnostik WebRTC antar-dua konteks browser (bukan produk).
 * Menjawab: kandidat ICE apa yang dihasilkan (host IP / mDNS .local /
 * srflx STUN), apakah dua konteks bisa tersambung langsung, dan BERAPA
 * LAMA establishment-nya (offer → connected) — dasar kalibrasi ambang
 * watchdog 8-c (15s) dan metodologi distribusi 8-f.
 *
 * Jalankan:
 *   bun scripts/dev/probe-webrtc.mjs            # 1x
 *   bun scripts/dev/probe-webrtc.mjs --runs 10  # distribusi waktu 10x
 *   bun scripts/dev/probe-webrtc.mjs --no-stun  # tanpa STUN (host-only)
 */
import { chromium } from '@playwright/test';

const STUN = process.argv.includes('--no-stun') ? [] : [{ urls: 'stun:stun.l.google.com:19302' }];

const runsArg = process.argv.find((arg) => arg.startsWith('--runs='));
const runsFlagIndex = process.argv.indexOf('--runs');
const RUNS = Math.max(
  1,
  Number.parseInt(
    runsArg !== undefined
      ? runsArg.slice('--runs='.length)
      : runsFlagIndex !== -1
        ? process.argv[runsFlagIndex + 1]
        : '1',
    10,
  ) || 1,
);

/** Batas poll state koneksi per run (ms). */
const CONNECT_TIMEOUT_MS = 20_000;
const POLL_INTERVAL_MS = 500;

async function makePeer(page) {
  await page.evaluate((iceServers) => {
    const pc = new RTCPeerConnection({ iceServers });
    pc.createDataChannel('probe');
    window.__pc = pc;
    window.__cands = [];
    pc.onicecandidate = (event) => {
      if (event.candidate !== null) window.__cands.push(event.candidate.candidate);
    };
  }, STUN);
}

async function gatherCandidates(page) {
  const done = await page.evaluate(
    () =>
      new Promise((resolve) => {
        const pc = window.__pc;
        if (pc.iceGatheringState === 'complete') return resolve(true);
        const timer = setTimeout(() => resolve(false), 8000);
        pc.onicegatheringstatechange = () => {
          if (pc.iceGatheringState === 'complete') {
            clearTimeout(timer);
            resolve(true);
          }
        };
      }),
  );
  return { done, cands: await page.evaluate(() => window.__cands) };
}

function candidateKind(raw) {
  if (raw.includes(' typ host ')) return 'host';
  if (raw.includes(' typ srflx ')) return 'srflx';
  if (raw.includes(' typ relay ')) return 'relay';
  return 'lain';
}

/**
 * Satu siklus penuh di konteks BARU (isolasi antar-run): dua peer, offer/
 * answer, tukar kandidat (trickle penuh), lalu poll sampai connected.
 * Mengembalikan {connected, ms, kinds} — ms = offer → connected.
 */
async function runOnce(browser, runLabel) {
  const contextA = await browser.newContext();
  const contextB = await browser.newContext();
  const pageA = await contextA.newPage();
  const pageB = await contextB.newPage();
  for (const page of [pageA, pageB]) {
    await page.goto('about:blank');
  }
  try {
    await makePeer(pageA);
    await makePeer(pageB);

    const t0 = Date.now();
    const offer = await pageA.evaluate(async () => {
      const offer = await window.__pc.createOffer();
      await window.__pc.setLocalDescription(offer);
      return window.__pc.localDescription;
    });
    await pageB.evaluate(async (desc) => {
      await window.__pc.setRemoteDescription(desc);
      const answer = await window.__pc.createAnswer();
      await window.__pc.setLocalDescription(answer);
    }, offer);
    const answer = await pageB.evaluate(() => window.__pc.localDescription);
    await pageA.evaluate(async (desc) => {
      await window.__pc.setRemoteDescription(desc);
    }, answer);

    const { done: doneA, cands: candsA } = await gatherCandidates(pageA);
    const { done: doneB, cands: candsB } = await gatherCandidates(pageB);

    // Tukar kandidat. Kegagalan addIceCandidate dikembalikan sebagai teks
    // (console.log di dalam page.evaluate TIDAK terlihat di CLI — bug lama).
    const toInit = (raw) => {
      const parts = raw.split(' ');
      return { candidate: parts.slice(0, 8).join(' '), sdpMid: '0', sdpMLineIndex: 0 };
    };
    const addErrors = [];
    for (const c of candsA) {
      const err = await pageB.evaluate(async (init) => {
        try {
          await window.__pc.addIceCandidate(init);
          return null;
        } catch (error) {
          return String(error);
        }
      }, toInit(c));
      if (err !== null) addErrors.push(`B: ${err}`);
    }
    for (const c of candsB) {
      const err = await pageA.evaluate(async (init) => {
        try {
          await window.__pc.addIceCandidate(init);
          return null;
        } catch (error) {
          return String(error);
        }
      }, toInit(c));
      if (err !== null) addErrors.push(`A: ${err}`);
    }

    const kinds = [...candsA, ...candsB].map(candidateKind);
    for (const c of candsA)
      console.log(`  [${runLabel}] A ${candidateKind(c)}: ${c.replace(/\s+/g, ' ')}`);
    for (const c of candsB)
      console.log(`  [${runLabel}] B ${candidateKind(c)}: ${c.replace(/\s+/g, ' ')}`);
    if (addErrors.length > 0) {
      console.log(`  [${runLabel}] addIceCandidate gagal (${addErrors.length}):`);
      for (const err of addErrors) console.log(`  [${runLabel}]   ${err}`);
    }

    // t1 = selesai tukar kandidat — memisahkan waktu ICE sesungguhnya dari
    // tunggu full-gather (probe non-trickle; mesh asli F1.6 pakai trickle
    // penuh sehingga kandidat host mengalir seketika).
    const t1 = Date.now();
    const gatherTimedOut = !doneA || !doneB;

    let connected = false;
    let ms = -1;
    let msAfterExchange = -1;
    const deadline = Date.now() + CONNECT_TIMEOUT_MS;
    while (Date.now() < deadline) {
      const stateA = await pageA.evaluate(() => window.__pc.connectionState);
      const stateB = await pageB.evaluate(() => window.__pc.connectionState);
      if (stateA === 'connected' && stateB === 'connected') {
        connected = true;
        ms = Date.now() - t0;
        msAfterExchange = Date.now() - t1;
        break;
      }
      await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
    }
    const finalA = await pageA.evaluate(() => window.__pc.connectionState);
    const finalB = await pageB.evaluate(() => window.__pc.connectionState);
    console.log(
      `  [${runLabel}] gathering A=${doneA ? 'ok' : 'timeout'} B=${doneB ? 'ok' : 'timeout'} — final A=${finalA} B=${finalB} ${connected ? 'TERHUBUNG ✅' : 'GAGAL ❌'}`,
    );
    return { connected, ms, msAfterExchange, gatherTimedOut, kinds };
  } finally {
    await contextA.close();
    await contextB.close();
  }
}

function summarize(times) {
  const sorted = [...times].sort((a, b) => a - b);
  const n = sorted.length;
  const median = n % 2 === 1 ? sorted[(n - 1) / 2] : (sorted[n / 2 - 1] + sorted[n / 2]) / 2;
  const mean = sorted.reduce((sum, t) => sum + t, 0) / n;
  return { min: sorted[0], median, mean, max: sorted[n - 1], n };
}

console.log(`iceServers: ${JSON.stringify(STUN)} — runs: ${RUNS}`);
const browser = await chromium.launch();
const results = [];
try {
  for (let i = 1; i <= RUNS; i += 1) {
    results.push(await runOnce(browser, `run ${i}/${RUNS}`));
  }
} finally {
  await browser.close();
}

const connectedRuns = results.filter((r) => r.connected);
const times = connectedRuns.map((r) => r.ms);
const timesAfterExchange = connectedRuns.map((r) => r.msAfterExchange);
const gatherTimeouts = results.filter((r) => r.gatherTimedOut).length;
console.log('\n== ringkasan ==');
console.log(`connected: ${connectedRuns.length}/${results.length}`);
if (times.length > 0) {
  const s = summarize(times);
  const ice = summarize(timesAfterExchange);
  console.log(
    `total offer→connected (termasuk tunggu full-gather non-trickle): n=${s.n} min=${s.min}ms median=${s.median}ms mean=${s.mean.toFixed(0)}ms max=${s.max}ms`,
  );
  console.log(
    `ICE pasca-tukar-kandidat (bandingkan dgn watchdog 8-c): n=${ice.n} min=${ice.min}ms median=${ice.median}ms mean=${ice.mean.toFixed(0)}ms max=${ice.max}ms`,
  );
  if (ice.max > 15_000) {
    console.log('  ⚠ ICE pasca-tukar melebihi ambang watchdog 8-c (15s) — restart akan terpicu.');
  } else {
    console.log('  ✓ seluruh ICE pasca-tukar di bawah ambang watchdog 8-c (15s).');
  }
  if (gatherTimeouts > 0) {
    console.log(
      `  catatan: ${gatherTimeouts}/${results.length} run menunggu full-gather sampai timeout (STUN lambat) — ` +
        `total time terpengaruh; mesh asli F1.6 trickle penuh (kandidat host mengalir seketika).`,
    );
  }
  const allKinds = results.flatMap((r) => r.kinds);
  const counts = allKinds.reduce((acc, kind) => {
    acc[kind] = (acc[kind] ?? 0) + 1;
    return acc;
  }, {});
  console.log(`kandidat: ${JSON.stringify(counts)}`);
} else {
  console.log('tidak ada run yang tersambung — periksa kandidat di atas.');
}
