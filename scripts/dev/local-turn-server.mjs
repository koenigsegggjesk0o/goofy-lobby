#!/usr/bin/env bun
/**
 * scripts/dev/local-turn-server.mjs — TURN server LOKAL untuk validasi rig
 * (P0-2) dan pengembangan offline. BUKAN untuk produksi.
 *
 * Kenapa ada: probe `probe-webrtc.mjs --turn/--turn-tcp` membuktikan DoD
 * relay, tetapi mengujinya terhadap penyedia eksternal membutuhkan akun +
 * kredensial. Server lokal (paket `turn-server`, pure JS, devDependency)
 * memungkinkan seluruh rantai — RTCPeerConnection Chromium asli → alokasi
 * TURN long-term auth → relaying → getStats pasangan terpilih — terverifikasi
 * TANPA akun eksternal, kapan saja (termasuk CI / jaringan terputus).
 *
 * KEAMANAN BY CONSTRUCTION:
 * - HANYA bind ke 127.0.0.1 (loopback). Tidak ada opsi membuka 0.0.0.0 —
 *   server ini memakai kredensial uji statis dan TIDAK boleh terekspos.
 * - Kredensial uji: localprobe/localprobe (kebetoran disengaja — hanya
 *   bermakna di mesin ini, untuk sesi uji ini).
 * - allowLoopback: peer uji adalah konteks browser di mesin yang sama,
 *   sehingga alamat relay peer juga loopback (RFC 5766 melarangnya secara
 *   default; di sini justru itu yang diuji).
 *
 * Endpoints (default):
 *   turn:127.0.0.1:3478                      (UDP — jalur relay normal)
 *   turn:127.0.0.1:3478?transport=tcp         (TCP — simulasi firewall blokir-UDP)
 *
 * Jalankan:
 *   bun scripts/dev/local-turn-server.mjs                # UDP+TCP 3478
 *   TURN_PORT=3480 bun scripts/dev/local-turn-server.mjs # port lain
 *
 * Pasangan uji lengkap (dijalankan dari direktori proyek):
 *   bun scripts/dev/local-turn-server.mjs &
 *   VITE_TURN_URL="turn:127.0.0.1:3478" \
 *     VITE_TURN_USERNAME=localprobe VITE_TURN_CREDENTIAL=localprobe \
 *     bun scripts/dev/probe-webrtc.mjs --turn
 *   VITE_TURN_URL="turn:127.0.0.1:3478?transport=tcp" \
 *     VITE_TURN_USERNAME=localprobe VITE_TURN_CREDENTIAL=localprobe \
 *     bun scripts/dev/probe-webrtc.mjs --turn --turn-tcp
 *   kill %1
 *
 * Exit code: 0 = dimatikan bersih (SIGINT/SIGTERM); 1 = gagal mulai.
 */
import { createServer } from 'turn-server';

const PORT = Number.parseInt(process.env.TURN_PORT ?? '3478', 10);
if (!Number.isInteger(PORT) || PORT < 1024 || PORT > 65535) {
  console.error(`❌ TURN_PORT tidak sah: ${process.env.TURN_PORT ?? ''} (harus 1024..65535)`);
  process.exit(1);
}

const LOOPBACK = '127.0.0.1';
const USERNAME = 'localprobe';
const PASSWORD = 'localprobe';

const server = createServer({
  software: 'goofy-lobby-local-turn (dev only)',
  auth: {
    mechanism: 'long-term',
    realm: 'goofy-local.test',
    credentials: { [USERNAME]: PASSWORD },
  },
  // Relay address di loopback — peer uji ada di mesin yang sama.
  relay: { ip: LOOPBACK, externalIp: LOOPBACK },
  allowLoopback: true,
});

server.on('listening', (info) => {
  console.log(`listening: ${info.address}:${info.port}/${info.transport}`);
});
server.on('error', (err) => {
  console.error(`server error: ${err.message}`);
  process.exitCode = 1;
});
server.on('allocate', () => {
  console.log(`allocate: ok (total klien aktif: ${server.getClientCount()})`);
});

server.listen(
  [
    { port: PORT, transport: 'udp', address: LOOPBACK },
    { port: PORT, transport: 'tcp', address: LOOPBACK },
  ],
  () => {
    console.log(`TURN server LOKAL siap (dev only) — ${LOOPBACK}:${PORT} udp+tcp`);
    console.log(
      `uji: VITE_TURN_URL="turn:${LOOPBACK}:${PORT}" (udp) atau "turn:${LOOPBACK}:${PORT}?transport=tcp"`,
    );
  },
);

function shutdown(signal) {
  console.log(`\n${signal} diterima — mematikan TURN server lokal...`);
  server.stop(() => {
    console.log('bersih berhenti.');
    process.exit(0);
  });
  // Jangan menggantung selamanya bila stop() bermasalah.
  setTimeout(() => {
    console.error('stop() tidak selesai dalam 3 dtk — keluar paksa.');
    process.exit(1);
  }, 3000).unref?.();
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
