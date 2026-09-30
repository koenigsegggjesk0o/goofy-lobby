/**
 * Probe diagnostik WebRTC antar-dua konteks browser (bukan produk).
 * Menjawab: kandidat ICE apa yang dihasilkan (host IP / mDNS .local /
 * srflx STUN / relay TURN), apakah dua konteks bisa tersambung langsung,
 * BERAPA LAMA establishment-nya (offer → connected), dan PASANGAN KANDIDAT
 * mana yang SUNGGUH dipakai (selected pair — bukti aktual, bukan sekadar
 * terkumpul) — dasar kalibrasi ambang watchdog 8-c (15s) dan metodologi
 * distribusi 8-f.
 *
 * DISTRIBUSI PERSENTIL (Task 13-a): --runs N ≥ 2 merangkum
 * min/p50/p75/p90/p95/p99/max + mean + stdev sampel lewat modul bersama
 * src/lib/stats.ts (interpolasi type 7 — SATU sumber kebenaran dengan
 * e2e-stress; teruji unit di src/lib/stats.test.ts).
 *
 * MODE VERIFIKASI TURN (Fase 2, Task 11-a):
 *   bun scripts/dev/probe-webrtc.mjs --turn
 * Membaca VITE_TURN_URL/USERNAME/CREDENTIAL dari environment (bun memuat
 * .env otomatis), memvalidasi lewat parseTurnEnv (SATU sumber kebenaran
 * dengan jalur mesh — diimpor dari src/webrtc/turn-config.ts), lalu
 * menjalankan probe relay-forced (iceTransportPolicy 'relay' di KEDUA
 * peer): koneksi HANYA mungkin bila TURN sungguhan merelay. Terhubung =
 * TURN terbukti end-to-end. Nilai kredensial TIDAK PERNAH dicetak.
 *
 * MODE SIMULASI FIREWALL BLOKIR-UDP (P0-2 DoD):
 *   bun scripts/dev/probe-webrtc.mjs --turn --turn-tcp
 * Menambah syarat: SEMUA URL TURN wajib non-UDP ke arah server (skema
 * turns: ATAU query transport=tcp) DAN pasangan kandidat terpilih tiap
 * run terbukti relay dengan relayProtocol tcp/tls (kaki klien→TURN).
 * Itulah jalur yang tetap hidup saat firewall memblokir UDP — kernel-level
 * blokir tidak mungkin di sandbox (tanpa root/iptables), jadi pembatasan
 * dipaksakan di lapisan ICE: URL transport=tcp membuat kandidat relay
 * SATU-SATU kandidat yang bisa terbentuk, persis kondisi jaringan
 * UDP-blocked. Bukti getStats ini ekuivalen dengan yang ditampilkan
 * chrome://webrtc-internals (sumber data yang sama — RTCStatsReport).
 *
 * Jalankan:
 *   bun scripts/dev/probe-webrtc.mjs            # 1x
 *   bun scripts/dev/probe-webrtc.mjs --runs 10  # distribusi waktu 10x
 *   bun scripts/dev/probe-webrtc.mjs --no-stun  # tanpa STUN (host-only)
 *   bun scripts/dev/probe-webrtc.mjs --turn     # verifikasi relay TURN
 *   bun scripts/dev/probe-webrtc.mjs --turn --turn-tcp  # DoD P0-2 (blokir-UDP)
 *
 * Exit code: 0 = sukses sesuai mode (mode --turn: SEMUA run tersambung
 * lewat relay; --turn-tcp: tambahan semua kaki relay tcp/tls; mode normal:
 * minimal satu run tersambung). 1 = env TURN kosong/invalid saat --turn
 * atau sambungan gagal sesuai ketentuan mode. 2 = konfigurasi --turn-tcp
 * memuat URL UDP (harus turns:/transport=tcp).
 */
import { chromium } from '@playwright/test';
import { pathToFileURL } from 'node:url';
// SATU sumber kebenaran validasi TURN — modul yang sama dipakai mesh asli
// (8-d); bun men-transpile TS saat import, tanpa duplikasi logika.
import { parseTurnEnv, resolveIceServers } from '../../src/webrtc/turn-config.ts';
import { isSelectedPairRelayOverTcpOrTls, pickSelectedPair } from '../../src/webrtc/relay-stats.ts';
import { summarizeNumbers } from '../../src/lib/stats.ts';

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

async function makePeer(page, iceServers, iceTransportPolicy) {
  await page.evaluate(
    ({ iceServers, iceTransportPolicy }) => {
      const pc = new RTCPeerConnection({ iceServers, iceTransportPolicy });
      pc.createDataChannel('probe');
      window.__pc = pc;
      window.__cands = [];
      pc.onicecandidate = (event) => {
        if (event.candidate !== null) window.__cands.push(event.candidate.candidate);
      };
    },
    { iceServers, iceTransportPolicy },
  );
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

/** Kumpulkan entri getStats() mentah (pengumpulan generik — parsing murni dilakukan di sisi Node oleh relay-stats.ts). */
async function collectStats(page) {
  return page.evaluate(async () => {
    const report = await window.__pc.getStats();
    return [...report].map(([, stats]) => ({ ...stats }));
  });
}

function describePair(pair) {
  if (pair === null) return '— (belum ada pasangan terpilih)';
  const flags = [
    `state=${pair.state ?? '?'}`,
    `nominated=${pair.nominated ?? '?'}`,
    pair.selected !== null ? `selected=${pair.selected}` : null,
    pair.localProtocol !== null ? `proto=${pair.localProtocol}` : null,
    pair.localRelayProtocol !== null ? `relayProto=${pair.localRelayProtocol}` : null,
  ]
    .filter((f) => f !== null)
    .join(' ');
  return `A=${pair.localType} B=${pair.remoteType} (${flags})`;
}

/**
 * Satu siklus penuh di konteks BARU (isolasi antar-run): dua peer, offer/
 * answer, tukar kandidat (trickle penuh), lalu poll sampai connected.
 * Mengembalikan {connected, ms, kinds, pairA, pairB} — ms = offer → connected;
 * pairA/pairB = pasangan kandidat terpilih (bukti jalur aktual).
 */
async function runOnce(browser, runLabel, config) {
  const contextA = await browser.newContext();
  const contextB = await browser.newContext();
  const pageA = await contextA.newPage();
  const pageB = await contextB.newPage();
  for (const page of [pageA, pageB]) {
    await page.goto('about:blank');
  }
  try {
    await makePeer(pageA, config.iceServers, config.iceTransportPolicy);
    await makePeer(pageB, config.iceServers, config.iceTransportPolicy);

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
    // Pasangan kandidat terpilih — dikumpulkan APA PUN hasil akhirnya
    // (kegagalan pun diagnostik: pasangan tidak pernah selected).
    const [statsA, statsB] = [await collectStats(pageA), await collectStats(pageB)];
    const pairA = pickSelectedPair(statsA);
    const pairB = pickSelectedPair(statsB);
    console.log(`  [${runLabel}] pasangan terpilih: ${describePair(pairA)}`);
    return { connected, ms, msAfterExchange, gatherTimedOut, kinds, pairA, pairB };
  } finally {
    await contextA.close();
    await contextB.close();
  }
}

/** Format ms dibulatkan (interpolasi persentil menghasilkan pecahan). */
function formatMs(value) {
  return `${Math.round(value)}ms`;
}

/**
 * Redaksi userinfo URL TURN pada OUTPUT (remediasi 25-a / 23-c LOW-2):
 * `scheme://user:pass@host` → `scheme://***:***@host`. Nilai asli tetap
 * dipakai untuk koneksi (RTCPeerConnection) — hanya cetakan yang disikat.
 * Duplikasi kecil dengan test-harness/harness.ts disengaja (script CLI vs
 * bundle harness tidak berbagi modul).
 */
function redactTurnUrl(value) {
  return value.replace(/\/\/[^/@:\s]+:[^/@:\s]+@/g, '//***:***@');
}

/** Cetak distribusi dua baris: persentil dulu, lalu tendensi sentral + sebaran. */
function printDistribution(label, s) {
  console.log(`${label}: n=${s.n}`);
  console.log(
    `  min=${formatMs(s.min)} p50=${formatMs(s.p50)} p75=${formatMs(s.p75)} p90=${formatMs(s.p90)} p95=${formatMs(s.p95)} p99=${formatMs(s.p99)} max=${formatMs(s.max)}`,
  );
  console.log(`  mean=${formatMs(s.mean)} stdev=${formatMs(s.stdev)}`);
}

/** Eksekusi runner HANYA bila dijalankan langsung sebagai CLI — import modul (mis. verifikasi agregasi) bebas efek samping. */
const isMain = import.meta.url === pathToFileURL(process.argv[1] ?? '').href;

if (isMain) {
  await main();
}

async function main() {
  const TURN_MODE = process.argv.includes('--turn');
  const TURN_TCP = process.argv.includes('--turn-tcp');
  let iceServers = STUN;
  let iceTransportPolicy = 'all';

  if (TURN_MODE || TURN_TCP) {
    if (TURN_TCP && !TURN_MODE) {
      // --turn-tcp tanpa --turn hampir pasti salah ketik — jangan tebak
      // niat pemanggil; jelaskan dan keluar dengan kode konfigurasi.
      console.log('❌ --turn-tcp hanya bermakna bersama --turn.');
      console.log('   Gunakan: bun scripts/dev/probe-webrtc.mjs --turn --turn-tcp');
      process.exit(2);
    }
    // Sumber env: process.env (bun memuat .env otomatis). Hanya tiga var
    // TURN yang dibaca; nilai TIDAK PERNAH dicetak — hanya status/alasan.
    const source = {
      VITE_TURN_URL: process.env.VITE_TURN_URL,
      VITE_TURN_USERNAME: process.env.VITE_TURN_USERNAME,
      VITE_TURN_CREDENTIAL: process.env.VITE_TURN_CREDENTIAL,
    };
    const turn = parseTurnEnv(source);
    if (turn.status === 'disabled') {
      console.log(
        'TURN: disabled — env VITE_TURN_URL/USERNAME/CREDENTIAL kosong, tidak ada yang bisa diverifikasi.\n' +
          'Isi ketiganya di .env (lihat .env.example — grup TURN Fase 2), lalu jalankan ulang.',
      );
      process.exit(1);
    }
    if (turn.status === 'invalid') {
      console.log('TURN: invalid — konfigurasi tidak sah, verifikasi dibatalkan:');
      // Alasan memuat URL mentah yang bisa berisi user:pass@ tertanam —
      // di-redaksi di output (remediasi 25-a).
      for (const reason of turn.reasons) console.log(`  - ${redactTurnUrl(reason)}`);
      process.exit(1);
    }
    if (TURN_TCP) {
      // Simulasi firewall blokir-UDP (P0-2 DoD): SEMUA URL TURN wajib
      // non-UDP ke arah server — skema turns: (TLS) atau query
      // transport=tcp. URL turn: tanpa query = UDP default → tolak keras,
      // jangan biarkan verifikasi "lolos" lewat kaki UDP.
      const urls = (process.env.VITE_TURN_URL ?? '')
        .split(',')
        .map((part) => part.trim())
        .filter((part) => part !== '');
      const udpUrls = urls.filter(
        (url) => !url.startsWith('turns:') && !/[?&]transport=tcp([&#]|$)/.test(url),
      );
      if (udpUrls.length > 0) {
        console.log(
          '❌ --turn-tcp: ada URL TURN yang kakinya UDP ke server — simulasi blokir-UDP jadi tidak sah:',
        );
        for (const url of udpUrls) {
          // URL mentah bisa berisi user:pass@ — cetak versi ter-redaksi
          // (saran perbaikan ikut memakai versi aman yang sama).
          const safe = redactTurnUrl(url);
          console.log(
            `  - ${safe} → gunakan turns:${safe.slice('turn:'.length)} atau tambahkan ?transport=tcp`,
          );
        }
        process.exit(2);
      }
      console.log(
        'TURN-TCP: semua URL non-UDP ke server (turns:/transport=tcp) — kandidat relay HANYA bisa terbentuk lewat TCP/TLS,\n' +
          'ekuivalen lapisan-ICE dari jaringan yang memblokir UDP (bukti: relayProtocol pasangan terpilih).',
      );
    }
    iceServers = resolveIceServers(source).iceServers;
    iceTransportPolicy = 'relay';
    console.log(
      'TURN: enabled — probe RELAY-FORCED (iceTransportPolicy "relay" di kedua peer).\n' +
        'Koneksi hanya mungkin bila TURN sungguhan merelay. Nilai kredensial tidak dicetak.',
    );
  }

  console.log(
    `iceServers: ${TURN_MODE ? 'STUN default + TURN (nilai tidak dicetak)' : JSON.stringify(STUN)} — transport: ${iceTransportPolicy} — runs: ${RUNS}`,
  );
  const browser = await chromium.launch();
  const results = [];
  try {
    for (let i = 1; i <= RUNS; i += 1) {
      results.push(await runOnce(browser, `run ${i}/${RUNS}`, { iceServers, iceTransportPolicy }));
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
    const s = summarizeNumbers(times);
    const ice = summarizeNumbers(timesAfterExchange);
    printDistribution('total offer→connected (termasuk tunggu full-gather non-trickle)', s);
    printDistribution('ICE pasca-tukar-kandidat (bandingkan dgn watchdog 8-c 15s)', ice);
    if (ice.max > 15_000) {
      console.log('  ⚠ ICE pasca-tukar melebihi ambang watchdog 8-c (15s) — restart akan terpicu.');
    } else {
      console.log(
        `  ✓ seluruh ICE pasca-tukar di bawah ambang watchdog 8-c (15s) — p95=${formatMs(ice.p95)} (5% koneksi terlambatnya ≥ nilai ini).`,
      );
    }
    if (ice.n < 10) {
      console.log(
        '  catatan: n < 10 — persentil masih kasar; --runs ≥ 20 disarankan untuk distribusi yang stabil.',
      );
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

  if (TURN_MODE) {
    const relayPairs = results.filter((r) => r.pairA?.localType === 'relay');
    const tcpTlsPairs = results.filter(
      (r) => r.pairA !== null && isSelectedPairRelayOverTcpOrTls(r.pairA),
    );
    if (TURN_TCP) {
      if (connectedRuns.length === results.length && tcpTlsPairs.length === results.length) {
        console.log(
          `\nTURN RELAY TCP/TLS TERVERIFIKASI ✅ — ${connectedRuns.length}/${results.length} run tersambung dgn pasangan relay yang kakinya ke TURN tcp/tls ` +
            `(contoh: relayProto=${tcpTlsPairs[0].pairA.localRelayProtocol}). ` +
            'DoD P0-2 terpenuhi: sesi tetap hidup via relay saat UDP diblokir.',
        );
        process.exit(0);
      }
      console.log(
        `\nTURN TCP/TLS TIDAK terverifikasi ❌ — ${connectedRuns.length}/${results.length} run tersambung; ` +
          `pasangan relay tcp/tls: ${tcpTlsPairs.length}/${results.length} (sisanya relayProtocol udp/tidak terbaca).`,
      );
      process.exit(1);
    }
    if (connectedRuns.length === results.length && relayPairs.length === results.length) {
      console.log(
        `\nTURN RELAY TERVERIFIKASI ✅ — ${connectedRuns.length}/${results.length} run tersambung dgn pasangan terpilih relay (A=${relayPairs[0].pairA.localType}, ` +
          `relayProto=${relayPairs[0].pairA.localRelayProtocol ?? 'tidak terbaca'}).`,
      );
      process.exit(0);
    }
    console.log(
      `\nTURN TIDAK terverifikasi ❌ — ${connectedRuns.length}/${results.length} run tersambung; pasangan relay: ${relayPairs.length}/${results.length}.`,
    );
    process.exit(1);
  }

  process.exit(connectedRuns.length > 0 ? 0 : 1);
}
