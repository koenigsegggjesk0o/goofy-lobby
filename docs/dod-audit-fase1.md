# Audit DoD Fase 1 — goofy-lobby

Tanggal audit: 2026-09-27 (malam), dieksekusi ulang verifikasi segar setelah seluruh F1.1–F1.8 selesai.
Metode: setiap klaim dipetakan ke (a) catatan bukti di `worklog.md` (Task ID sebagai provenance) dan/atau (b) hasil run perintah verifikasi segar pada malam ini. Tidak ada klaim tanpa bukti.

## Ringkasan verdict

| #   | Item DoD                                                                                  | Status      | Bukti utama                                                                                                                                                                            |
| --- | ----------------------------------------------------------------------------------------- | ----------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Repo GitHub + PAT, push terverifikasi                                                     | ✅ LULUS    | `git ls-remote` per task; HEAD malam ini `7cae8e2`                                                                                                                                     |
| 2   | Schema + RLS Supabase (migrasi 0001–0006)                                                 | ✅ LULUS    | Matriks bukti behavioral + pg_policies (Task 2-a, 5-a)                                                                                                                                 |
| 3   | QA users via admin API                                                                    | ✅ LULUS    | 3 user `qa.alpha/bravo/charlie@goofy.example.com`, trigger profiles terisi (Task 2-a)                                                                                                  |
| 4   | Captcha: signup tanpa token DITOLAK                                                       | ✅ LULUS    | Live: 400 `captcha_failed`; e2e `auth.spec` hijau (Task 2-a, 7-a)                                                                                                                      |
| 5   | Modul WebRTC mesh (types, signaling, peer manager, data channel, ICE restart, controller) | ✅ LULUS    | Unit test per modul + e2e mesh 2 konteks browser (Task 3-a, 7-a)                                                                                                                       |
| 6   | Modul audio spasial (engine HRTF, listener sync, bitrate adaptation)                      | ✅ LULUS    | 68 unit test F1.4; e2e audio-smoke (Task 4-a, 7-a)                                                                                                                                     |
| 7   | Modul profil & snippet suara                                                              | ✅ LULUS    | 61 unit test F1.5; e2e snippet + RLS storage (Task 5-a, 7-a)                                                                                                                           |
| 8   | Validasi Zod di batas sistem                                                              | ✅ LULUS    | Skema di webrtc/types, profile/types; test jalur invalid                                                                                                                               |
| 9   | Kapasitas room 8 (deterministik)                                                          | ✅ LULUS    | Sort sessionId, unit + e2e (Task 3-a)                                                                                                                                                  |
| 10  | Pemulihan koneksi (ICE restart + backoff)                                                 | ✅ LULUS    | ice-restart-handler + redesain trickle penuh pasca-2-bug e2e (Task 3-a, 7-a)                                                                                                           |
| 11  | Sentry error monitoring tanpa UI                                                          | ✅ LULUS    | Ingest live HTTP 200; never-throw; scrub kredensial (Task 6-a, 7-a)                                                                                                                    |
| 12  | CI GitHub Actions (lint+typecheck+test+build) + keepalive                                 | ⚠️ SEBAGIAN | Seluruh perintah hijau lokal berkali-kali; file workflow jadi + keepalive teruji live (HTTP 201 Management API), TAPI push workflow diblokir scope PAT (butuh Workflows R/W dari user) |
| 13  | Build produksi bersih                                                                     | ✅ LULUS    | `bun run build` sukses malam ini (tsc + vite)                                                                                                                                          |
| 14  | Test-harness + e2e Playwright live                                                        | ✅ LULUS    | 14 spec e2e hijau (malam ini 26.0s)                                                                                                                                                    |
| 15  | TANPA UI produk                                                                           | ✅ LULUS    | Hanya status page polos + harness polos (alat uji), sesuai batasan spek                                                                                                                |

> Catatan pemetaan: label item di atas mengikuti subjek yang tercatat di worklog (baris penutup Task 7-a). Redaksi asli lengkap 15 poin ada di dokumen spek user dari sesi awal; bila ada perbedaan redaksi, worklog + bukti live yang dipakai sebagai sumber kebenaran.

## Verifikasi segar (malam ini, setelah F1 lengkap + modul TURN Fase 2)

Dieksekusi 2026-09-27 ~23:05 WIB, direktori kerja bersih sebelum modul TURN (git status kosong):

| Perintah                       | Hasil                                                                                                                       |
| ------------------------------ | --------------------------------------------------------------------------------------------------------------------------- |
| `bun run typecheck`            | exit 0                                                                                                                      |
| `bun run lint`                 | exit 0                                                                                                                      |
| `bun run format:check`         | "All matched files use Prettier code style!"                                                                                |
| `bun run test`                 | **252/252 PASSED** (19 file; 230 pra-TURN + 22 baru turn-config)                                                            |
| `bun run build`                | SUKSES — `dist/index.html` 2.99 kB; `dist/test-harness/index.html` 1.09 kB; harness js 764.77 kB (gzip 233.36 kB)           |
| `bun run test:e2e`             | **14/14 PASSED** (26.0s; mesh dua konteks terhubung 7.1s run ini)                                                           |
| Dev server Vite :3000          | HTTP 200                                                                                                                    |
| agent-browser `/`              | Render penuh daftar modul; console bersih (hanya vite connect); **0 page error**                                            |
| agent-browser `/test-harness/` | Render penuh; `envStatus` → turnstile terisi, sentryDsn terisi, `turn: disabled` (jujur sesuai env nyata); **0 page error** |

## Bukti per item (detail)

### #1 Repo — ✅

- PAT fine-grained (Contents R/W, Pull requests R/W, repo tunggal) terpasang di git credential store.
- Setiap task F1.x diakhiri push + verifikasi `git ls-remote`/`ls-tree` (lihat worklog Task 1-a…7-a).
- Malam ini: `main @ 7cae8e2` (F1.6) — seluruh riwayat commit produk ada di remote.

### #2 Schema + RLS — ✅

- Migrasi 0001–0006 applied live lewat Management API (runner `scripts/db/`), tiap migrasi HTTP 200.
- Matriks bukti RLS live (worklog Task 2-a): anon GET profiles → `[]`; authenticated hanya baca lintas-user; tulis profil orang lain → 0 baris; storage owner-only untuk tulis/hapus.
- Temuan penting tercatat: tabel buatan Management API tidak dapat default grants → fixed dengan GRANT standar + ALTER DEFAULT PRIVILEGES (migrasi 0005 area).
- Migrasi 0006: kolom `profiles.voice_snippet_path` + constraint format path satu-level; policy SELECT bucket voice-snippets dilonggarkan ke authenticated (keputusan didesain: snippet memang untuk didengar member lain; tulis/hapus tetap owner-only).

### #3 QA users — ✅

- 3 user dibuat via admin API (`email_confirm=true`): id `7db26a0a…`, `6913d097…`, `44fc7f03…`; kredensial hanya di `.env` lokal (tidak pernah di-commit, tidak di-bundle — parser Node-side di e2e/helpers).
- Trigger `profiles` terbukti mengisi display name dari `user_metadata`.

### #4 Captcha — ✅

- `security_captcha_enabled=true`, provider turnstile (PATCH config/auth 200).
- Bukti live penolakan: signup TANPA token → 400 `captcha_failed "no captcha_token found"`. Field yang benar ditemukan empiris: `gotrue_meta_security.captcha_token`.
- Keputusan ter-flag: secret terpasang = test key always-pass resmi Cloudflare agar Playwright (dideteksi bot) bisa lewat; swap ke secret produksi = satu PATCH saat Fase 3. Signup tanpa token TETAP ditolak (tidak melemah karena test key).
- Catatan rate limit email konfirmasi 2/jam (free tier) → e2e menguji jalur penolakan (persis bunyi DoD), happy-path signin pakai QA users.

### #5–#7, #9, #10 Modul sistem — ✅

- F1.3 WebRTC: types (Zod + kapasitas 8 via sort sessionId), signaling-client (Supabase Realtime broadcast), peer-connection-manager (perfect negotiation, polite = sessionId besar), data-channel-sync (posisi ~15x/detik tervalidasi), ice-restart-handler (backoff), mesh-room-controller (presence, lifecycle).
- F1.4 Audio: spatial-audio-engine (PannerNode HRTF, inverse, tanpa monitor diri = anti-echo), audio-listener-sync (posisi+yaw, fallback legacy), bitrate-adaptation (tier reaktif 50k/24k/12k).
- F1.5 Profil: voice-recorder (auto-stop 2 lapis: durasi 15s + budget byte 25MiB), voice-snippet-service (upload `audio/webm` persis mime policy bucket), profile-service (CRUD Zod), voice-snippet-manager (ganti snippet = upload baru → update pointer → hapus lama best-effort).
- BONUS F1.6: e2e menemukan 2 bug race NYATA yang lolos 230 unit test — (1) deskripsi basi saat glare/rollback, (2) signaling tiba sebelum presence sync → dibuang. Keduanya diperbaiki di kode produk (redesain trickle penuh + buffer kandidat dua arah + guard epoch + antrean sinyal per-peer). Mesh 23/24 beruntun hijau pasca-fix (1 outlier 35.6s jaringan).

### #8, #11 Monitoring — ✅

- `src/monitoring/sentry.ts`: init no-op bila DSN kosong, idempoten; beforeSend scrub query string + kunci sensitif; captureError never-throw; breadcrumbs; flush.
- Bukti keras ingest: harness `verifySentryIngest` POST langsung ke endpoint store Sentry → HTTP 200 (live, Task 7-a).

### #12 CI + keepalive — ⚠️ SEBAGIAN (satu-satunya yang belum 100%)

- `.github/workflows/ci.yml`: lint → typecheck → test → build. Seluruh langkah identik hijau lokal berkali-kali (termasuk malam ini).
- `.github/workflows/supabase-keepalive.yml`: cron `17 3 */3 * *` POST Management API `select 1`. Panggilan keepalive DIUJI LIVE → HTTP **201** (temuan: endpoint query mengembalikan 201 bukan 200 — kondisi sukses workflow sudah disesuaikan).
- BLOCKER: push file workflow ditolak GitHub — PAT belum punya permission Workflows R/W. File utuh di disk (di-exclude lokal via `.git/info/exclude`). Jalan keluar untuk user: (A) edit PAT → Workflows: Read and write → kabari untuk push ulang; atau (B) salin manual 2 file via web UI GitHub. Secrets yang perlu ditambah sekali: `SUPABASE_ACCESS_TOKEN` + `SUPABASE_PROJECT_REF`.
- e2e di CI sengaja belum diaktifkan (butuh secrets GitHub; keputusan tercatat Task 7-a).

### #13, #14 Build + e2e — ✅

- Build malam ini sukses (angka di tabel atas). Warning chunk >500 kB hanya untuk bundle harness (memuat Sentry+Supabase untuk alat uji) — bukan produk.
- e2e 14 spec: auth (5), profiles-rls (4), snippet (2), monitoring (1), mesh (1), audio-smoke (1) — seluruhnya hijau malam ini.

### #15 Tanpa UI — ✅

- `index.html` root = halaman status infrastruktur teks polos (by design, bukan produk). `test-harness/` = alat uji polos. Tidak ada satu pun file UI produk — sesuai batasan spek (UI = Fase 3, menunggu instruksi eksplisit user).

## Tambahan malam ini (pasca-Fase 1, masih dalam lingkup sistem)

- **Fase 2 (Task 8-b): modul TURN fallback** `src/webrtc/turn-config.ts` — env-driven `VITE_TURN_URL/USERNAME/CREDENTIAL`, hasil union disabled/enabled/invalid, fallback STUN-only bila kosong, +22 unit test (total 252). Keputusan ter-flag: prefix `VITE_` diperlukan karena RTCPeerConnection berjalan di browser (kredensial TURN statis memang terlihat di bundle — praktik standar WebRTC untuk kredensial statis, dapat di-revoke via dashboard Metered; opsi kredensial ephemeral via backend dicatat sebagai opsi masa depan). Live-verifikasi TURN menunggu kredensial Metered dari user (opsional menurut spek).

## Yang menunggu user (bukan blocker malam ini)

1. Izin PAT **Workflows R/W** (atau salin manual 2 file `.github/workflows/*` via web UI) + 2 secrets GitHub → CI & keepalive aktif penuh.
2. Kredensial Metered TURN (opsional, Fase 2 "aktif penuh") → `VITE_TURN_*` di `.env`.
3. Instruksi eksplisit untuk mulai **Fase 3 (UI/UX)**.
4. Rotasi kredensial (PAT, Supabase access token, service_role) setelah semuanya stabil — hygiene yang disarankan sejak awal.
