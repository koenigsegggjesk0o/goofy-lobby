// ============================================================================
// supabase/functions/paddle-webhook/index.ts — Edge Function Deno (SKELETON)
// ============================================================================
// STATUS JUJUR: SKELETON — file ini BELUM PERNAH DIJALANKAN. Menghidupkannya
// butuh (urutan):
//   1. Deploy via Supabase CLI (runtime Deno terpisah dari proyek Vite):
//        supabase functions deploy paddle-webhook
//   2. Secrets — JANGAN pernah hardcode kredensial di file / .env proyek:
//        supabase secrets set PADDLE_WEBHOOK_SECRET=... \
//          SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=... \
//          PADDLE_ALLOWED_PRICE_IDS=pri_...,pri_...
//      (PADDLE_ALLOWED_PRICE_IDS opsional namun WAJIB diisi sebelum go-live
//      pembayaran — kosong = semua grant ditolak fail-closed per event;
//      lihat docs/backup-runbook.md utk rotasi secret.)
//   3. Daftarkan endpoint webhook di dashboard Paddle → URL function ini,
//      lalu uji dengan event uji Paddle (Dev Tools → Notifications).
//
// Catatan tooling: file ini DI-IGNORE eslint & tsc proyek (lihat
// eslint.config.mjs — runtime Deno terpisah, di-type-check saat deploy via
// Supabase CLI). Import map (zod, @supabase/supabase-js versi PERSIS sama
// dengan package.json) + pengaturan resolution ada di deno.json sebelah
// file ini.
//
// Kontrak DB (migrasi 0011): kolom profiles.is_premium HANYA boleh ditulis
// service_role — function ini (memakai SUPABASE_SERVICE_ROLE_KEY) adalah
// satu-satunya penulis yang sah; klien aplikasi diblokir lewat
// column-level grants (revoke update, grant kolom terbatas).
// ============================================================================

import { createClient } from '@supabase/supabase-js';
// Router core dibagikan dengan unit test proyek (murni, tanpa runtime
// Deno/Node) — path relatif DENGAN ekstensi .ts sesuai aturan Deno.
import { handlePaddleWebhook } from '../../../src/payment/paddle-webhook.ts';
import { asPaddleWebhookDb } from '../../../src/payment/types.ts';
import type { PaddleWebhookOutcome } from '../../../src/payment/types.ts';

function json(status: number, body: Record<string, unknown>): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

/** Mapping outcome router core → status HTTP (kontrak spec modul payment). */
function outcomeToResponse(outcome: PaddleWebhookOutcome): Response {
  if (outcome.ok) {
    return json(200, {
      ok: true,
      handled: outcome.handled,
      event_type: outcome.eventType,
      // 'duplicate' | 'granted' | 'revoked' | 'price_rejected' — bila ada.
      ...(outcome.status === undefined ? {} : { status: outcome.status }),
    });
  }
  // Keaslian tak terbukti → 401 (seragam untuk semua kegagalan signature).
  if (
    outcome.reason === 'malformed-header' ||
    outcome.reason === 'stale-timestamp' ||
    outcome.reason === 'signature-mismatch'
  ) {
    return json(401, { ok: false, reason: outcome.reason });
  }
  // Bentuk event tak dipahami / tak terpetakan ke user → 400 generik
  // (remediasi audit 23-c LOW: detail zod HANYA di console.error router —
  // body tidak membocorkan struktur validasi internal; retry dari Paddle
  // tidak akan memperbaiki data, delivery memang harus gagal).
  if (
    outcome.reason === 'invalid-json' ||
    outcome.reason === 'invalid-event' ||
    outcome.reason === 'missing-user-id'
  ) {
    console.error('[paddle-webhook] ditolak 400:', outcome.reason);
    return json(400, { error: 'invalid_payload' });
  }
  // apply-failed → 500; detail HANYA ke log server — jangan bocorkan
  // internal Supabase ke pemanggil eksternal.
  console.error('[paddle-webhook] apply-failed:', outcome.detail);
  return json(500, { ok: false, reason: outcome.reason });
}

Deno.serve(async (req) => {
  try {
    // Semua kredensial dari env — TIDAK ADA nilai default/hardcoded.
    const secret = Deno.env.get('PADDLE_WEBHOOK_SECRET');
    if (secret === undefined || secret === '') {
      return json(500, {
        ok: false,
        reason: 'setup',
        message:
          'PADDLE_WEBHOOK_SECRET belum diset — jalankan: ' +
          'supabase secrets set PADDLE_WEBHOOK_SECRET=...',
      });
    }
    const supabaseUrl = Deno.env.get('SUPABASE_URL');
    const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
    if (
      supabaseUrl === undefined ||
      supabaseUrl === '' ||
      serviceRoleKey === undefined ||
      serviceRoleKey === ''
    ) {
      return json(500, {
        ok: false,
        reason: 'setup',
        message:
          'SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY belum diset — jalankan: ' +
          'supabase secrets set SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=...',
      });
    }

    // Raw body TIDAK di-parse dulu — teks mentah persis yang ditandatangani
    // Paddle; header signature dibaca apa adanya (null → '' → malformed).
    const rawBody = await req.text();
    const header = req.headers.get('Paddle-Signature') ?? '';

    // service_role: satu-satunya role yang boleh menulis is_premium (0011)
    // dan ledger paddle_events/paddle_transactions (0021).
    const supabase = createClient(supabaseUrl, serviceRoleKey);

    // ALLOWLIST price (remediasi audit 25 MEDIUM — verifikasi harga):
    // env PADDLE_ALLOWED_PRICE_IDS = daftar price_id PISAH KOMA. Sengaja
    // TIDAK fail-fast boot bila kosong — penolakan dilakukan PER-EVENT
    // fail-closed oleh router (grant ditolak + transaksi dicatat
    // 'price_rejected'), supaya kekosongan konfigurasi tidak mematikan
    // seluruh endpoint (event tetap ter-ledger utk audit).
    const allowedPriceIds = (Deno.env.get('PADDLE_ALLOWED_PRICE_IDS') ?? '')
      .split(',')
      .map((id) => id.trim())
      .filter((id) => id !== '');

    const applyPremiumStatus = async (userId: string, isPremium: boolean): Promise<void> => {
      const { error } = await supabase
        .from('profiles')
        .update({ is_premium: isPremium })
        .eq('id', userId);
      if (error !== null) {
        throw new Error(`update profiles.is_premium gagal: ${error.message}`);
      }
    };

    const outcome = await handlePaddleWebhook({
      header,
      rawBody,
      secret,
      applyPremiumStatus,
      db: asPaddleWebhookDb(supabase),
      allowedPriceIds,
    });
    return outcomeToResponse(outcome);
  } catch (error) {
    // Jalur tak terduga (mis. req.text() gagal) — 500 generik, detail ke log.
    console.error('[paddle-webhook] unexpected:', error);
    return json(500, { ok: false, reason: 'unexpected' });
  }
});
