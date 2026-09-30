// ============================================================================
// supabase/functions/account-erasure/index.ts — Edge Function Deno
// ============================================================================
// STATUS JUJUR: SKELETON — file ini BELUM PERNAH DIJALANKAN (sama seperti
// paddle-webhook). Menghidupkannya butuh (urutan):
//   1. Deploy via Supabase CLI:
//        supabase functions deploy account-erasure
//   2. Secrets (fail-fast ala paddle-webhook; JANGAN hardcode kredensial
//      di file / .env proyek):
//        supabase secrets set SUPABASE_URL=... \
//          SUPABASE_ANON_KEY=... SUPABASE_SERVICE_ROLE_KEY=...
//   3. Panggil dari klien (Fase 3 UI "hapus akun") — lihat
//      docs/account-erasure.md utk spec lengkap + implikasi GDPR.
//
// KONTROL AKSES — SELF-ERASURE SAJA (keputusan keamanan):
//   - Wajib POST + header Authorization: Bearer <JWT>.
//   - JWT diverifikasi via klien ANON: auth.getUser(token) — menolak token
//     palsu/kedaluwarsa (401) SEBELUM menyentuh service_role.
//   - uid diambil HANYA dari token terverifikasi — body TIDAK PERNAH
//     dipercaya utk identitas (tidak ada parameter uid; menerima uid dari
//     body = celah hapus-akun-orang-lain).
//
// AUDIT TRAIL: function log Supabase (Dashboard → Functions → Logs)
// mencatat setiap permintaan (timestamp + uid dari klaim token) — itu
// satu-satunya jejak yang TERSISA setelah erasure (by design: GDPR right
// to erasure menuntut data pribadi dihapus; log operasional singkat
// dengan umur terbatas diperbolehkan sebagai legitimate interest).
// JANGAN mencatat PII tambahan di sini.
//
// GDPR (Art. 17 — Right to Erasure): endpoint ini adalah mekanisme
// penghapusan penuh (storage + db + auth). Harus dipanggil TANPA
// syarat tambahan bagi user yang meminta penghapusan; konfirmasi ulang
// (re-auth / ketik password) disarankan di UI pemanggil sebelum POST.
// ============================================================================

import { createClient } from '@supabase/supabase-js';
// Layanan core dibagikan dengan unit test proyek (murni, tanpa runtime
// Deno/Node) — path relatif DENGAN ekstensi .ts sesuai aturan Deno.
import { asErasureDb, eraseUserData } from '../../../src/account/erasure-service.ts';

function json(status: number, body: Record<string, unknown>): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

Deno.serve(async (req) => {
  try {
    // Hanya POST — tidak ada alasan membaca/mendaftar erasure lewat REST.
    if (req.method !== 'POST') {
      return json(405, { ok: false, reason: 'method-not-allowed' });
    }

    // Semua kredensial dari env — TIDAK ADA nilai default/hardcoded
    // (fail-fast ala paddle-webhook).
    const supabaseUrl = Deno.env.get('SUPABASE_URL');
    const anonKey = Deno.env.get('SUPABASE_ANON_KEY');
    const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
    if (
      supabaseUrl === undefined ||
      supabaseUrl === '' ||
      anonKey === undefined ||
      anonKey === '' ||
      serviceRoleKey === undefined ||
      serviceRoleKey === ''
    ) {
      return json(500, {
        ok: false,
        reason: 'setup',
        message:
          'SUPABASE_URL / SUPABASE_ANON_KEY / SUPABASE_SERVICE_ROLE_KEY belum diset — ' +
          'jalankan: supabase secrets set SUPABASE_URL=... SUPABASE_ANON_KEY=... ' +
          'SUPABASE_SERVICE_ROLE_KEY=...',
      });
    }

    // Verifikasi pemanggil: Bearer JWT diverifikasi lewat klien ANON.
    const authHeader = req.headers.get('Authorization') ?? '';
    if (!authHeader.startsWith('Bearer ')) {
      return json(401, { ok: false, reason: 'missing-bearer-token' });
    }
    const token = authHeader.slice('Bearer '.length).trim();
    const anonClient = createClient(supabaseUrl, anonKey);
    const { data: userData, error: userError } = await anonClient.auth.getUser(token);
    const uid = userData?.user?.id;
    if (userError !== null || uid === undefined || uid === '') {
      // 401 seragam — tanpa membedakan "format salah" vs "kedaluwarsa"
      // (jangan jadi orakel enumerasi).
      return json(401, { ok: false, reason: 'invalid-token' });
    }

    // Eksekusi erasure memakai klien service_role (RLS owner-only tidak
    // bisa menjangkau data user lain; lihat header erasure-service.ts).
    const serviceClient = createClient(supabaseUrl, serviceRoleKey);
    const summary = await eraseUserData({
      db: asErasureDb(serviceClient),
      storage: serviceClient,
      adminAuth: serviceClient.auth.admin,
      userId: uid,
    });

    console.log('[account-erasure] selesai', {
      uid,
      removedFiles: summary.removedFiles,
      deletedRows: summary.deletedRows,
    });
    return json(200, { erased: true, summary });
  } catch (error) {
    // ErasureError (storage/db/auth gagal) atau jalur tak terduga — 500
    // generik; detail HANYA ke log server (jangan bocorkan internal
    // Supabase ke pemanggil).
    console.error('[account-erasure] gagal:', error);
    return json(500, { ok: false, reason: 'erasure-failed' });
  }
});
