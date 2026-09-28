# Fase 2 — Lapisan Logika Fitur Sosial (tanpa UI)

> Dokumen status Task 12 (sesi ini). Prinsip: **setiap klaim di bawah punya
> bukti** (unit test / gerbang verify / browser live) atau **dinyatakan
> terbuka** sebagai belum terverifikasi. Tidak ada UI — seluruh lapisan ini
> modul TypeScript murni + SQL + skeleton Edge Function, sesuai batasan
> main prompt (UI menunggu instruksi eksplisit = Fase 3).

## Pemetaan file spec → file repo

Spec main prompt menamai file `useXxx.ts` (konvensi hook) — repo sejak Fase 1
memakai konvensi _service class / fungsi murni_ (main prompt sendiri
mengizinkan: _"kalau kamu ragu, tulis sebagai function biasa dulu"_). Skema
Zod juga tidak dikumpulkan di `src/schemas/` melainkan co-located di
`types.ts` tiap domain (konvensi repo teraudit Fase 1). Pemetaan lengkap:

| Spec (main prompt)                                    | Repo                                           | Keterangan                                                                |
| ----------------------------------------------------- | ---------------------------------------------- | ------------------------------------------------------------------------- |
| `src/friends/useFriends.ts`                           | `src/friends/friendship-service.ts`            | service class, deps-injected                                              |
| `src/friends/useBlocks.ts`                            | `src/friends/block-service.ts`                 | service class, deps-injected                                              |
| `src/chat/useMessages.ts`                             | `src/chat/message-service.ts`                  | service class, deps-injected                                              |
| `src/chat/rateLimiter.ts`                             | `src/chat/rate-limiter.ts`                     | sliding window murni, jam di-inject                                       |
| `src/soundboard/presetSounds.ts`                      | `src/soundboard/preset-sounds.ts`              | data model saja (aset audio = Fase 3)                                     |
| `src/soundboard/useCustomSounds.ts`                   | `src/soundboard/custom-sound-service.ts`       | mirror VoiceSnippetService, multi-MIME                                    |
| `src/voicefilter/PlaybackRatePitchShift.ts`           | `src/voicefilter/playback-rate-pitch-shift.ts` | pendekatan naif (rate = pitch+tempo)                                      |
| `src/voicefilter/AudioWorkletPitchShift.ts`           | `src/voicefilter/audio-worklet-pitch-shift.ts` | controller struktural + pabrik browser                                    |
| `src/voicefilter/pitch-worklet-processor.js`          | `src/voicefilter/pitch-worklet-processor.js`   | PERSIS (plain JS AudioWorkletGlobalScope)                                 |
| `src/payment/usePremiumStatus.ts`                     | `src/payment/premium-status-service.ts`        | baca `profiles.is_premium`                                                |
| `src/schemas/friendRequestSchema.ts`                  | `src/friends/types.ts`                         | Zod co-located (konvensi repo)                                            |
| `src/schemas/messageSchema.ts`                        | `src/chat/types.ts`                            | Zod co-located (konvensi repo)                                            |
| `supabase/functions/paddle-webhook/index.ts`          | `supabase/functions/paddle-webhook/index.ts`   | PERSIS (skeleton Deno)                                                    |
| migrasi `0005_friends_blocks` … `0008_premium_status` | `0007`–`0013`                                  | penomoran berlanjut (0005/0006 sudah terpakai era F1) + bucket soundboard |

## Migrasi baru (0007–0013)

| File                              | Isi                                                                                                                                                                                                                 |
| --------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `0007_friends_blocks.sql`         | tabel `friendships` (unique index kanonik least/greatest — A→B dan B→A saling meniadakan), `blocks`, trigger `friendships_block_guard` (SECURITY DEFINER — menolak friend request bila penerima memblokir pengirim) |
| `0008_friends_blocks_rls.sql`     | RLS: friendships SELECT kedua pihak / INSERT requester / UPDATE addressee (accept) / DELETE kedua pihak; blocks PRIVAT (blocker-only)                                                                               |
| `0009_messages.sql`               | tabel `messages` (body btrim 1–500, no-self), dua indeks pasangan, trigger `messages_block_guard`                                                                                                                   |
| `0010_messages_rls.sql`           | RLS: SELECT peserta; INSERT hanya pengirim **dan wajib berteman** (WITH CHECK exists friendship accepted)                                                                                                           |
| `0011_premium_status.sql`         | kolom `profiles.is_premium` + **lockdown column-level**: revoke UPDATE dari anon/authenticated, grant hanya `(display_name, avatar_color, voice_snippet_path)` — client tidak bisa menulis is_premium               |
| `0012_soundboard_bucket.sql`      | bucket privat `soundboard-sounds` (cap 5 MiB, 5 MIME)                                                                                                                                                               |
| `0013_soundboard_storage_rls.sql` | storage RLS: insert/delete folder-per-user, select authenticated (sesama room perlu mendengar)                                                                                                                      |

## Verifikasi (bukti, bukan klaim)

- **Unit: 597/597 hijau, 44 file** (`bun run test`) — rincian per domain:
  friends 82 (4 file), chat 52 (4), soundboard 38 (4), payment 48 (4),
  db/PGlite 11 (1), voicefilter 33 (3), + 331 warisan F1/F2-TURN.
- **PGlite (Postgres WASM asli, `src/db/migrations.test.ts`)**: 13 migrasi
  apply bersih berurutan + idempoten (pass kedua), RLS dieksekusi empiris
  dengan `set role authenticated` + klaim JWT di GUC: privasi blocks,
  gate pertemanan insert message, guard blokir (P0001), kanonik (23505),
  lockdown `is_premium` (42501 utk client, sukses utk superuser/service-role
  analog), dan **jawaban empiris**: trigger `updated_at` tetap jalan di bawah
  column-grant terbatas.
- **DSP voicefilter dibuktikan lewat frekuensi**: processor dievaluasi di
  sandbox AudioWorkletGlobalScope, keluaran sinus 440 Hz diukur zero-crossing:
  +12 semitone → ≈880 Hz, −12 → ≈220 Hz, +7 → ≈659 Hz (semua ±5%),
  bypass 0 semitone → identitas byte-per-byte, amplitudo terjaga.
- **Webhook Paddle**: mekanisme verifikasi PERSIS dokumentasi resmi
  (developer.paddle.com — diambil live saat sesi): header `ts=…;h1=…`
  (multi-h1 utk rotasi), signed payload `ts:rawBody`, HMAC-SHA256
  crypto.subtle, timing-safe, toleransi 5 dtk. Unit test menandatangani
  payload dengan WebCrypto sungguhan (bukan angka karangan).
- **Gerbang proyek**: `bun run verify` 6/6 (lihat worklog entri 12-h).
- **Browser live**: `initPitchShift()` di test harness memuat modul
  `pitch-worklet-processor.js` di Chromium sungguhan (bukti: halaman uji).

## Skeleton yang JUJUR belum pernah dijalankan

- `supabase/functions/paddle-webhook/index.ts` — butuh deploy Supabase CLI +
  secrets (`PADDLE_WEBHOOK_SECRET`, `SUPABASE_URL`,
  `SUPABASE_SERVICE_ROLE_KEY`) + registrasi endpoint di dashboard Paddle.
  Core-nya (`src/payment/paddle-signature.ts`, `paddle-webhook.ts`) sudah
  terunit-test penuh; file Deno hanya lem tipis (di-ignore tsc/eslint
  proyek, type-check saat deploy; import map versi terkunci di `deno.json`
  - `sloppy-imports`).
- Migrasi 0007–0013 **belum di-apply ke Supabase asli** (butuh
  SUPABASE_ACCESS_TOKEN) — terverifikasi lokal via PGlite.
- Modul friends/chat/soundboard/premium **belum menyentuh Supabase live**
  (kredensial klien belum tersedia) — unit test memakai fake struktural +
  type-compat membuktikan rantai pada SupabaseClient asli.

## Keputusan desain & asumsi terbuka (menunggu konfirmasi pemilik produk)

1. **Model friends**: satu baris per pasangan (kanonik), status
   `pending|accepted`; decline/cancel/unfriend = DELETE (tanpa histori).
   Re-request setelah decline = insert baru.
2. **Blokir ditegakkan di DB** (trigger SECURITY DEFINER) karena RLS blocks
   blocker-only membuat client TIDAK BISA memeriksa blokir milik orang lain.
3. **Message immutable** (tanpa policy UPDATE/DELETE) — MVP.
4. **Gate pertemanan message** dobel: policy WITH CHECK (defense in depth)
   - pra-cek service (error jelas).
5. **Rate limit chat**: 10 pesan / 30 detik / user (konstanta, mudah
   diganti — angka kebijakan awal, belum ada data produksi).
6. **Preset soundboard**: katalog id stabil + validasi saja; **file audio
   fisik belum ada** (Fase 3, aset dari pemilik produk — TIDAK dibuatkan
   placeholder).
7. **Transport pemutaran soundboard ke room** (mix ke jalur keluar mic)
   BELUM ditentukan spec — pertanyaan terbuka untuk Fase 3.
8. **Mapping event Paddle**: `transaction.completed` → premium true,
   `subscription.canceled` → false, via `data.custom_data.user_id`;
   event lain di-acknowledge 200 tanpa aksi. Filter produk (price_id)
   menyusul saat produk Paddle didefinisikan.
9. **TURN Metered** tetap menunggu kredensial (opsional) — jalur buktinya
   siap sejak Task 11-a/11-b.
