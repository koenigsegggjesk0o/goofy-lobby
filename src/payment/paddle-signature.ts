// ============================================================
// Verifikasi signature webhook Paddle.
// Mekanisme PERSIS dokumentasi developer.paddle.com —
// webhooks/about/signature-verification:
//   header     : "ts=<unix-detik>;h1=<hex64>" — saat rotasi secret bisa
//                ada LEBIH DARI SATU h1; cocok dengan salah satu = lolos.
//   payload    : `${ts}:${rawBody}` — raw body TIDAK boleh ditransformasi
//                (tanpa reformat/whitespace).
//   signature  : HMAC-SHA256(secretKey, signedPayload) → hex lowercase.
//   perbandingan WAJIB timing-safe (jangan `===`).
//   anti-replay: umur timestamp dibatasi toleransi (default SDK resmi
//                Paddle = 5 detik).
// Murni: hanya globalThis.crypto.subtle (kompatibel Node 20+ & Deno) —
// TANPA import node:crypto, bahkan tanpa import modul lain sama sekali.
// ============================================================

/** Hasil sukses parsing header signature Paddle. */
export interface ParsedPaddleSignature {
  /** Unix timestamp dalam DETIK, persis angka dari header. */
  ts: number;
  /** SEMUA nilai h1 (≥1) — hex 64 char, dinormalisasi lowercase. */
  signatures: string[];
}

export type PaddleSignatureFailure = 'malformed-header' | 'stale-timestamp' | 'signature-mismatch';

/**
 * Hasil parser — deterministik untuk test: parser TIDAK PERNAH melempar
 * exception; semua input rusak menjadi { ok:false, reason:'malformed-header' }.
 */
export type PaddleSignatureParseResult =
  { ok: true; value: ParsedPaddleSignature } | { ok: false; reason: 'malformed-header' };

/** Toleransi umur timestamp default — 5000 ms = 5 detik (SDK resmi Paddle). */
export const PADDLE_SIGNATURE_TOLERANCE_MS = 5000;

/** Panjang hex signature HMAC-SHA256 (32 byte → 64 karakter). */
const SIGNATURE_HEX_LENGTH = 64;

const SIGNATURE_HEX_PATTERN = new RegExp(`^[0-9a-fA-F]{${SIGNATURE_HEX_LENGTH}}$`);

// ============================================================
// Parser header
// ============================================================

/**
 * Memecah header Paddle-Signature.
 * Aturan persis spec: bagian dipisah ';' → tiap bagian di-trim → pasangan
 * kunci=nilai dipisah pada '=' PERTAMA saja (nilai hex tak mengandung '=').
 * - `ts` wajib tepat satu, angka bulat kanonik (tanpa leading zero —
 *   rekonstruksi `${ts}:` untuk signed payload harus identik byte-per-byte
 *   dengan teks header).
 * - SEMUA nilai `h1` dikumpulkan (≥1), masing-masing wajib hex 64 char,
 *   dinormalisasi lowercase agar sebanding dengan hasil compute.
 * - Kunci asing (mis. `h2` di masa depan) DIABAIKAN — forward-compatible
 *   dan tidak melemahkan verifikasi: tanpa secret, penyerang tetap tak
 *   bisa memalsukan HMAC yang cocok.
 * - Spasi di sekitar '=' tidak ditoleransi (Paddle tidak pernah
 *   mengirimkannya); bagian kosong (mis. ';' ganda) diabaikan.
 */
export function parsePaddleSignature(header: string): PaddleSignatureParseResult {
  const tsCandidates: string[] = [];
  const signatures: string[] = [];
  for (const rawPart of header.split(';')) {
    const part = rawPart.trim();
    if (part === '') {
      continue;
    }
    const eqIndex = part.indexOf('=');
    if (eqIndex <= 0) {
      return { ok: false, reason: 'malformed-header' }; // tanpa '=' / kunci kosong
    }
    const key = part.slice(0, eqIndex);
    const value = part.slice(eqIndex + 1);
    if (key === 'ts') {
      tsCandidates.push(value);
    } else if (key === 'h1') {
      if (!SIGNATURE_HEX_PATTERN.test(value)) {
        return { ok: false, reason: 'malformed-header' }; // hex salah panjang / bukan hex
      }
      signatures.push(value.toLowerCase());
    }
  }
  if (tsCandidates.length !== 1) {
    return { ok: false, reason: 'malformed-header' }; // ts wajib tepat satu
  }
  const tsValue = tsCandidates[0] ?? '';
  if (!/^(0|[1-9]\d*)$/.test(tsValue)) {
    return { ok: false, reason: 'malformed-header' }; // wajib angka bulat kanonik
  }
  const ts = Number(tsValue);
  if (!Number.isSafeInteger(ts)) {
    return { ok: false, reason: 'malformed-header' };
  }
  if (signatures.length === 0) {
    return { ok: false, reason: 'malformed-header' }; // minimal satu h1
  }
  return { ok: true, value: { ts, signatures } };
}

// ============================================================
// HMAC via crypto.subtle
// ============================================================

/**
 * HMAC-SHA256(secret, signedPayload) → hex lowercase.
 * Kontrak: secret HARUS non-empty — WebCrypto melempar DataError untuk
 * zero-length key; jalur pemanggilan tak terkontrol dilindungi guard
 * secret kosong di verifyPaddleSignature.
 */
export async function computePaddleHmac(secret: string, signedPayload: string): Promise<string> {
  const encoder = new TextEncoder();
  const key = await globalThis.crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const mac = await globalThis.crypto.subtle.sign('HMAC', key, encoder.encode(signedPayload));
  return bytesToHex(new Uint8Array(mac));
}

function bytesToHex(bytes: Uint8Array): string {
  let hex = '';
  for (const byte of bytes) {
    hex += byte.toString(16).padStart(2, '0');
  }
  return hex;
}

// ============================================================
// Verifikasi lengkap
// ============================================================

/**
 * Memverifikasi header Paddle-Signature terhadap raw body + secret.
 *
 * Kontrak satuan: `ts` header = UNIX DETIK (format Paddle); `now` dan
 * `toleranceMs` = MILIDETIK (default Date.now() / 5000 ms = 5 detik,
 * toleransi SDK resmi Paddle). ts dikonversi ke ms sebelum dibandingkan;
 * umur dibandingkan ABSOLUT — timestamp masa depan di luar toleransi
 * juga ditolak (clock skew / replay).
 *
 * Multi-h1 (rotasi secret): cocok dengan SALAH SATU h1 = lolos.
 */
export async function verifyPaddleSignature(input: {
  header: string;
  rawBody: string;
  secret: string;
  now?: () => number;
  toleranceMs?: number;
}): Promise<{ ok: true } | { ok: false; reason: PaddleSignatureFailure }> {
  const parsed = parsePaddleSignature(input.header);
  if (!parsed.ok) {
    return { ok: false, reason: parsed.reason };
  }
  const nowMs = input.now?.() ?? Date.now();
  const toleranceMs = input.toleranceMs ?? PADDLE_SIGNATURE_TOLERANCE_MS;
  const tsMs = parsed.value.ts * 1000;
  if (Math.abs(nowMs - tsMs) > toleranceMs) {
    return { ok: false, reason: 'stale-timestamp' };
  }
  if (input.secret === '') {
    // Secret kosong = konfigurasi tidak sah (Edge Function wajib fail-fast
    // 500 sebelum sampai sini) — gagal deterministik TANPA exception,
    // karena WebCrypto melempar DataError untuk zero-length key.
    return { ok: false, reason: 'signature-mismatch' };
  }
  // Signed payload = `${ts}:${rawBody}` — ts direkonstruksi dari angka
  // kanonik (parser menolak leading zero) sehingga identik byte-per-byte
  // dengan teks header; rawBody dipakai mentah, tanpa transformasi.
  const signedPayload = `${parsed.value.ts}:${input.rawBody}`;
  const computed = await computePaddleHmac(input.secret, signedPayload);
  let matched = false;
  // Bandingkan dengan SETIAP h1 — akumulasi OR tanpa early-return:
  // cocok satu = lolos, dan waktu eksekusi tidak membocorkan POSISI
  // h1 mana yang cocok.
  for (const candidate of parsed.value.signatures) {
    if (timingSafeEqualHex(computed, candidate)) {
      matched = true;
    }
  }
  return matched ? { ok: true } : { ok: false, reason: 'signature-mismatch' };
}

// ============================================================
// Perbandingan timing-safe
// ============================================================

/**
 * Membandingkan dua string hex secara timing-safe:
 * - panjang beda → mismatch LANGSUNG (panjang bukan rahasia);
 * - XOR-accumulate SELURUH byte — tanpa early-return per byte, sehingga
 *   waktu eksekusi konstan untuk pasangan berpanjang sama.
 * Input diasumsikan hex valid: parser memvalidasi h1 (64 char), hasil
 * compute selalu hex lowercase 64 char.
 */
function timingSafeEqualHex(a: string, b: string): boolean {
  const aBytes = hexToBytes(a);
  const bBytes = hexToBytes(b);
  if (aBytes.length !== bBytes.length) {
    return false;
  }
  let diff = 0;
  for (let i = 0; i < aBytes.length; i += 1) {
    diff |= (aBytes[i] ?? 0) ^ (bBytes[i] ?? 0);
  }
  return diff === 0;
}

function hexToBytes(hex: string): Uint8Array {
  const bytes = new Uint8Array(Math.floor(hex.length / 2));
  for (let i = 0; i < bytes.length; i += 1) {
    bytes[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return bytes;
}
