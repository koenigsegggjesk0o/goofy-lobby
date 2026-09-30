# Account Erasure — Spec & Operasi (GDPR Art. 17)

> Remediasi audit Task 25 (M3 25-b + lifecycle 25-d): penghapusan akun dulu =
> _profile-bricked + storage orphan + auth ghost_. Sekarang tersedia mekanisme
> penghapusan penuh yang teruji unit: **storage → db → auth**, idempoten-retry.

## 1. Komponen

| Komponen                                      | Lokasi        | Fungsi                                                                |
| --------------------------------------------- | ------------- | --------------------------------------------------------------------- |
| `src/account/erasure-service.ts` (+test)      | src           | logika inti murni (injector `db`/`storage`/`adminAuth`) — 9 test unit |
| `supabase/functions/account-erasure/index.ts` | Edge Function | endpoint Deno: verifikasi JWT → jalankan erasure via service_role     |

## 2. Kontrol akses (keputusan keamanan)

- **Self-erasure SAJA**: `uid` diambil **hanya** dari JWT terverifikasi
  (`auth.getUser(token)` via klien anon). Body request TIDAK PERNAH dipercaya
  untuk identitas — menerima `uid` dari body = celah hapus-akun-orang-lain.
- Method `POST` saja; tanpa bearer token → 401 seragam (bukan orakel enumerasi).
- Tidak ada CORS terbuka — function dipanggil same-origin dari aplikasi.

## 3. Apa yang dihapus (urutan — lihat header erasure-service.ts)

1. **Storage** (paling dulu — paling aman diulang): kedua bucket
   `VOICE_BUCKET_NAME` + `SOUNDBOARD_BUCKET_NAME`, prefix `${userId}/`,
   list paginated → remove semua objek.
2. **DB eksplisit dua arah**: `paddle_transactions` (0021), `friendships`
   (requester ATAU addressee), `blocks` (blocker ATAU blocked), `messages`
   (sender ATAU recipient). (Semua FK memang `ON DELETE CASCADE` ke profiles —
   delete eksplisit tetap dilakukan supaya ringkasan terlihat di log.)
3. **`profiles`** baris identitas terakhir (cascade menutup sisanya).
4. **auth user** (`adminAuth.deleteUser`) paling akhir — meminimalkan jendela
   "auth hidup tanpa profile". Room milik user ikut tersapu via FK ke
   `auth.users` + TTL 1 jam (0016) sebagai jaring pengaman.

Idempoten: kegagalan parsial boleh diulang utuh (list ulang, delete yang
sudah hilang = 0 baris, remove path absen tetap sukses).

## 4. Deploy (butuh kredensial operator — lihat docs/deploy-checklist.md)

```bash
supabase functions deploy account-erasure
supabase secrets set SUPABASE_URL=... SUPABASE_ANON_KEY=... \
  SUPABASE_SERVICE_ROLE_KEY=...
```

(SUPABASE_URL/ANON_KEY otomatis di-inject Supabase saat deploy — cukup set
SERVICE_ROLE.)

## 5. Pemakaian (UI Fase 3 "hapus akun")

```ts
const {
  data: { session },
} = await supabase.auth.getSession();
const res = await fetch(`${FUNCTIONS_URL}/account-erasure`, {
  method: 'POST',
  headers: { Authorization: `Bearer ${session?.access_token ?? ''}` },
});
// 200 {erased:true, summary:{removedFiles, deletedRows}}
// 401 {reason:'invalid-token'} · 500 {reason:'erasure-failed'|'setup'}
```

SARAN UI: minta **re-auth** (ketik ulang password) sebelum POST — konsisten
praktik GDPR (memastikan pemegang sesi = pemilik akun).

## 6. Audit trail & catatan GDPR

- Satu-satunya jejak tersisa pasca-erasure: **log function Supabase**
  (Dashboard → Functions → account-erasure → Logs) — timestamp + uid.
  Log operasional berumur pendek = _legitimate interest_, diizinkan GDPR.
  JANGAN menambah PII ke log.
- `paddle_transactions` ikut terhapus (cascade) — bila regulasi pajak
  mensyaratkan retensi transaksi finansial > masa akun, pisahkan ke tabel
  anonimized (backlog produk; catat keputusan legal dulu).
- Kebijakan retensi data umum (TTL messages, purge IP) — lihat register GDPR
  di worklog Task 25 (item 15); mayoritas menunggu keputusan owner/Fase 3.
