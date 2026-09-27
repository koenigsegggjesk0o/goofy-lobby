/**
 * Konfigurasi TURN fallback (Fase 2) — env-driven, murni, tanpa UI.
 *
 * Mengubah VITE_TURN_URL / VITE_TURN_USERNAME / VITE_TURN_CREDENTIAL menjadi
 * daftar RTCIceServer untuk opsi `iceServers` di PeerConnectionManager /
 * MeshRoomController. Tanpa variabel TURN sama sekali → STUN-only
 * (DEFAULT_ICE_SERVERS milik peer-connection-manager — tidak diduplikasi
 * di sini) — degradasi anggun, bukan error: TURN memang opsional.
 *
 * Pola injeksi sumber env mengikuti readClientEnv (src/lib/env.ts): fungsi
 * utama parseTurnEnv murni (sumber wajib diberikan), sementara
 * import.meta.env hanya disentuh sebagai argumen default adapter tipis
 * readTurnEnvFromVite / resolveIceServers — tidak ada akses env maupun efek
 * samping apa pun di top-level modul, jadi tetap tree-shakable.
 */
import { DEFAULT_ICE_SERVERS } from './peer-connection-manager';

/**
 * Batas panjang VITE_TURN_USERNAME setelah trim — menolak payload raksasa
 * sebelum nilai masuk ke konfigurasi RTCPeerConnection.
 */
export const TURN_USERNAME_MAX_LENGTH = 512;

/** Status hasil pembacaan env TURN. */
export type TurnEnvStatus = 'disabled' | 'enabled' | 'invalid';

/**
 * Hasil pembacaan env TURN (discriminated union):
 * - `disabled` — tidak ada variabel TURN terisi sama sekali (STUN-only);
 * - `enabled`  — konfigurasi sah, siap dipakai sebagai `iceServers`;
 * - `invalid`  — konfigurasi setengah terisi/tidak sah; SEMUA masalah
 *   dikumpulkan di `reasons` (bukan cuma yang pertama).
 */
export type TurnEnvResult =
  | { status: 'disabled' }
  | { status: 'enabled'; iceServers: RTCIceServer[] }
  | { status: 'invalid'; reasons: string[] };

/** Hasil kenyamanan resolveIceServers — alasan invalid ikut terbawa. */
export interface ResolvedIceServers {
  iceServers: RTCIceServer[];
  turnStatus: TurnEnvStatus;
  /** Hanya terisi bila turnStatus === 'invalid' (fallback STUN-only dipakai). */
  reasons?: string[];
}

/** Sama seperti readOptional di src/lib/env.ts — trim, kosong = undefined. */
function readTrimmed(source: Record<string, string | undefined>, name: string): string | undefined {
  const value = source[name]?.trim();
  return value === undefined || value === '' ? undefined : value;
}

function isTurnScheme(url: string): boolean {
  return url.startsWith('turn:') || url.startsWith('turns:');
}

/**
 * Salinan bebas-mutasi dari daftar ice server (array luar, objek entri, dan
 * array urls semuanya objek baru) — pemanggil boleh mengubah hasilnya tanpa
 * mencemari DEFAULT_ICE_SERVERS yang dipakai pemanggil lain.
 */
function cloneIceServers(servers: readonly RTCIceServer[]): RTCIceServer[] {
  return servers.map((server) => ({
    ...server,
    urls: Array.isArray(server.urls) ? [...server.urls] : server.urls,
  }));
}

/**
 * Mem-parse env TURN dari `source` (injeksi untuk test — pemanggilan dengan
 * import.meta.env sebaiknya lewat readTurnEnvFromVite).
 *
 * Aturan:
 * - Ketiga variabel kosong/whitespace → `disabled`.
 * - VITE_TURN_URL boleh berisi beberapa URL dipisah koma (tiap bagian
 *   dipangkas, bagian kosong dibuang); setiap URL wajib diawali `turn:` atau
 *   `turns:` (skema lain seperti http:/stun: ditolak dengan alasan yang
 *   menyebut nilainya).
 * - Username wajib terisi, maksimum TURN_USERNAME_MAX_LENGTH karakter;
 *   credential wajib terisi (TURN Metered selalu butuh user:pass).
 * - Konfigurasi setengah terisi (ada URL tanpa username/credential, atau
 *   sebaliknya) → `invalid` dengan alasan per variabel yang hilang.
 */
export function parseTurnEnv(source: Record<string, string | undefined>): TurnEnvResult {
  const url = readTrimmed(source, 'VITE_TURN_URL');
  const username = readTrimmed(source, 'VITE_TURN_USERNAME');
  const credential = readTrimmed(source, 'VITE_TURN_CREDENTIAL');

  if (url === undefined && username === undefined && credential === undefined) {
    return { status: 'disabled' };
  }

  const reasons: string[] = [];
  const turnUrls: string[] = [];

  if (url === undefined) {
    reasons.push('VITE_TURN_URL wajib diisi bila VITE_TURN_USERNAME/VITE_TURN_CREDENTIAL terisi');
  } else {
    const parts = url
      .split(',')
      .map((part) => part.trim())
      .filter((part) => part !== '');
    for (const part of parts) {
      if (isTurnScheme(part)) {
        turnUrls.push(part);
      } else {
        reasons.push(`URL TURN tidak valid: "${part}" (harus diawali turn: atau turns:)`);
      }
    }
    if (parts.length === 0) {
      reasons.push('VITE_TURN_URL tidak memuat URL apa pun (hanya kosong/koma)');
    }
  }

  if (username === undefined) {
    reasons.push(
      'VITE_TURN_USERNAME wajib diisi bila VITE_TURN_URL terisi (TURN Metered selalu butuh user:pass)',
    );
  } else if (username.length > TURN_USERNAME_MAX_LENGTH) {
    reasons.push(
      `VITE_TURN_USERNAME terlalu panjang: ${username.length} karakter ` +
        `(maksimum ${TURN_USERNAME_MAX_LENGTH})`,
    );
  }

  if (credential === undefined) {
    reasons.push(
      'VITE_TURN_CREDENTIAL wajib diisi bila VITE_TURN_URL terisi (TURN Metered selalu butuh user:pass)',
    );
  }

  // reasons kosong seharusnya sudah menjamin semua variabel terisi; cek
  // eksplisit tetap dipertahankan sebagai pertahanan kedua (sekaligus
  // narrowing TS) agar nilai undefined tak pernah bocor ke RTCIceServer.
  if (username === undefined || credential === undefined || reasons.length > 0) {
    return { status: 'invalid', reasons };
  }

  return {
    status: 'enabled',
    iceServers: [...cloneIceServers(DEFAULT_ICE_SERVERS), { urls: turnUrls, username, credential }],
  };
}

/**
 * Kenyamanan: env TURN → daftar ice server siap pakai.
 *
 * - `enabled`  → STUN default + entri TURN `{ urls, username, credential }`.
 * - `disabled` → STUN-only (sama nilainya dengan DEFAULT_ICE_SERVERS).
 * - `invalid`  → STUN-only fallback — masalah TIDAK ditelan: `turnStatus`
 *   bernilai 'invalid' dan `reasons` terisi supaya pemanggil bisa
 *   melaporkannya (pola monitoring proyek — modul ini sendiri tetap murni).
 *
 * Sumber default import.meta.env (pola readClientEnv); test menyuntikkan
 * source eksplisit agar deterministik.
 */
export function resolveIceServers(
  source: Record<string, string | undefined> = import.meta.env,
): ResolvedIceServers {
  const result = parseTurnEnv(source);
  switch (result.status) {
    case 'enabled':
      return { iceServers: result.iceServers, turnStatus: 'enabled' };
    case 'disabled':
      return { iceServers: cloneIceServers(DEFAULT_ICE_SERVERS), turnStatus: 'disabled' };
    case 'invalid':
      return {
        iceServers: cloneIceServers(DEFAULT_ICE_SERVERS),
        turnStatus: 'invalid',
        reasons: result.reasons,
      };
  }
}

/**
 * Adapter tipis: parseTurnEnv atas import.meta.env (pola argumen default
 * readClientEnv). Tanpa efek samping saat import — tree-shakable.
 */
export function readTurnEnvFromVite(
  source: Record<string, string | undefined> = import.meta.env,
): TurnEnvResult {
  return parseTurnEnv(source);
}
