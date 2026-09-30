// ============================================================================
// supabase/functions/turn-credentials/index.ts — Edge Function Deno
// ============================================================================
// STATUS JUJUR: SKELETON — file ini BELUM PERNAH DIJALANKAN (sama seperti
// paddle-webhook / account-erasure). Menghidupkannya butuh (urutan):
//   1. Deploy via Supabase CLI:
//        supabase functions deploy turn-credentials
//   2. Secrets (fail-fast ala paddle-webhook; JANGAN hardcode kredensial
//      di file / .env proyek):
//        supabase secrets set TURN_SECRET=... \
//          TURN_URLS=turn:xxx.turn.example:3478,turns:xxx.turn.example:5349 \
//          TURN_TTL_SECONDS=3600
//   3. Klien membaca env VITE_TURN_EPHEMERAL_URL = URL function ini, lalu
//      memanggil resolveEphemeralTurn (src/webrtc/turn-config.ts) dengan
//      access token sesi — lihat header modul itu utk alur bootstrap.
//
// MENGAPA (remediasi audit 25-c HIGH H2 — denial-of-wallet): kredensial TURN
// STATIS di bundle klien bisa diekstrak SIAPA PUN (bahkan tanpa akun) untuk
// memakai relay tanpa batas (Cloudflare TURN standalone $0.05/GB keluar).
// EPHEMERAL memberi: (a) TTL pendek — credential bocor pun berumur menit,
// (b) hanya pemilik JWT sah yang bisa minta — kuota relay terikat identitas
// yang bisa di-audit/di-ban.
//
// FORMAT KREDENSIAL (Cloudflare Calls TURN REST API — kompatibel RFC 8489
// "REST API" style / coturn `use-auth-secret`):
//   username    = "<unix-epoch-detik kedaluwarsa>"
//   credential  = base64( HMAC-SHA256( key = TURN_SECRET, msg = username ) )
// Padanan verifikasi via openssl (dari mesin apa pun):
//   echo -n "<username>" | openssl dgst -binary -sha256 -hmac "<TURN_SECRET>" | base64
// TURN_SECRET = API token Cloudflare Calls TURN (atau secret statis coturn
// Anda) — DIJAGA HANYA DI SISI SERVER (supabase secrets).
// ============================================================================

import { createClient } from '@supabase/supabase-js';

function json(status: number, body: Record<string, unknown>): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'Content-Type': 'application/json',
      // Kredensial bersifat pribadi + berumur pendek — jangan pernah di-cache
      // oleh perantara (audit 25 M1 kelas egress/quota).
      'Cache-Control': 'no-store',
    },
  });
}

/** Default TTL kredensial (detik) bila TURN_TTL_SECONDS tidak diset. */
const DEFAULT_TTL_SECONDS = 3_600;
const MIN_TTL_SECONDS = 300;
const MAX_TTL_SECONDS = 86_400;

/** Clamp TTL ke rentang aman — tolak nilai tak masuk akal dari env. */
function clampTtl(raw: string | undefined): number {
  const parsed = raw === undefined ? Number.NaN : Number(raw);
  if (!Number.isFinite(parsed)) {
    return DEFAULT_TTL_SECONDS;
  }
  return Math.min(Math.max(Math.trunc(parsed), MIN_TTL_SECONDS), MAX_TTL_SECONDS);
}

/** base64(HMAC-SHA256(key, message)) via Web Crypto (tersedia di Deno). */
async function hmacSha256Base64(key: string, message: string): Promise<string> {
  const encoder = new TextEncoder();
  const cryptoKey = await crypto.subtle.importKey(
    'raw',
    encoder.encode(key),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const signature = await crypto.subtle.sign('HMAC', cryptoKey, encoder.encode(message));
  // bytes → base64 manual (btoa tersedia di Deno; iterasi Uint8Array aman).
  let binary = '';
  const bytes = new Uint8Array(signature);
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary);
}

Deno.serve(async (req) => {
  try {
    // Hanya GET — permintaan kredensial bersifat baca-titik-waktu; POST tidak
    // memberi apa pun (tidak ada state server).
    if (req.method !== 'GET') {
      return json(405, { ok: false, reason: 'method-not-allowed' });
    }

    // Semua kredensial dari env — TIDAK ADA nilai default/hardcoded
    // (fail-fast ala paddle-webhook). TURN_SECRET KOSONG = 500 eksplisit:
    // lebih baik gagal keras daripada diam-diam menerbitkan credential lemah.
    const turnSecret = Deno.env.get('TURN_SECRET');
    const turnUrlsRaw = Deno.env.get('TURN_URLS');
    if (
      turnSecret === undefined ||
      turnSecret === '' ||
      turnUrlsRaw === undefined ||
      turnUrlsRaw === ''
    ) {
      return json(500, {
        ok: false,
        reason: 'setup',
        message:
          'TURN_SECRET / TURN_URLS belum diset — jalankan: ' +
          'supabase secrets set TURN_SECRET=... TURN_URLS=turn:host:3478[,turns:host:5349] ' +
          '[TURN_TTL_SECONDS=3600]',
      });
    }
    const urls = turnUrlsRaw
      .split(',')
      .map((u) => u.trim())
      .filter((u) => u !== '');
    if (urls.length === 0) {
      return json(500, { ok: false, reason: 'setup', message: 'TURN_URLS kosong setelah parsing' });
    }

    // Verifikasi pemanggil: wajib Bearer JWT sah (kredensial TURN hanya utk
    // user login — ini inti remediasi H2). Diverifikasi lewat klien ANON:
    // auth.getUser(token) menolak token palsu/kedaluwarsa sebelum kita
    // menerbitkan apa pun.
    const supabaseUrl = Deno.env.get('SUPABASE_URL');
    const anonKey = Deno.env.get('SUPABASE_ANON_KEY');
    if (
      supabaseUrl === undefined ||
      supabaseUrl === '' ||
      anonKey === undefined ||
      anonKey === ''
    ) {
      return json(500, {
        ok: false,
        reason: 'setup',
        message: 'SUPABASE_URL / SUPABASE_ANON_KEY belum diset (inject otomatis saat deploy)',
      });
    }
    const authHeader = req.headers.get('Authorization') ?? '';
    if (!authHeader.startsWith('Bearer ')) {
      return json(401, { ok: false, reason: 'missing-bearer-token' });
    }
    const token = authHeader.slice('Bearer '.length).trim();
    const anonClient = createClient(supabaseUrl, anonKey);
    const { data: userData, error: userError } = await anonClient.auth.getUser(token);
    if (userError !== null || userData?.user?.id === undefined) {
      // 401 seragam — bukan orakel "format salah vs kedaluwarsa".
      return json(401, { ok: false, reason: 'invalid-token' });
    }

    // Terbitkan kredensial ephemeral.
    const ttl = clampTtl(Deno.env.get('TURN_TTL_SECONDS'));
    const expiresAtSec = Math.floor(Date.now() / 1000) + ttl;
    const username = String(expiresAtSec);
    const credential = await hmacSha256Base64(turnSecret, username);

    // Log MINIM tanpa PII: uid saja (untuk audit kuota relay per identitas —
    // justru tujuan remediasi DoW). JANGAN log credential/token.
    console.log('[turn-credentials] issued', { uid: userData.user.id, ttl, urls: urls.length });

    return json(200, {
      ok: true,
      urls,
      username,
      credential,
      // MILLISECOND epoch — kontrak skema klien (EphemeralTurnResponseSchema).
      expiresAt: expiresAtSec * 1000,
    });
  } catch (error) {
    console.error('[turn-credentials] gagal:', error);
    return json(500, { ok: false, reason: 'credentials-failed' });
  }
});
