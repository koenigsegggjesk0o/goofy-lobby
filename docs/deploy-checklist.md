# Checklist Deploy & Aksi Sisi-Cloud (pasca-audit 25)

> Konsolidasi **seluruh aksi yang harus dijalankan pemilik produk di sisi
> cloud/dashboard** — bukan di repo. Sumber: audit keamanan Task 25
> (subagent 25-a/b/c/d + verifikasi mandiri main; 0 CRITICAL / 4 HIGH /
> ~10 MEDIUM). Setiap item memuat: **APA**, **MENGAPA** (referensi temuan
> audit), **BAGAIMANA**, dan **CARA VERIFIKASI**.
>
> Tanda **[USER]** = butuh keputusan/akun pemilik produk. Bagian kode yang
> berkaitan sudah/sedang diremediasi di repo (Task 26); dokumen ini hanya
> sisi yang TIDAK bisa dikerjakan dari repo.

## Urutan yang disarankan

1. **GitHub: repo private** (seksi g) — **SEBELUM push berikutnya**
   (H4: commit lokal memuat project ref + intel audit).
2. Branch protection + Dependabot + pelaporan kerentanan (seksi g).
3. Apply migrasi tertunda 0018+ (seksi b — rantai friendship-spoof masih
   hidup di cloud).
4. Secrets: Paddle (d), account-erasure (e), TURN ephemeral (c).
5. Backup secrets + jadwal (f).
6. Header keamanan host (a) — saat host produksi ditentukan.
7. Sentry DSN (h, opsional) → verifikasi pasca-deploy (i).

## a. Header keamanan produksi (host-level)

- **APA**: set header keamanan di server/host yang melayani build produksi
  (`dist/`). Saat ini TIDAK ada — kedua HTML (`index.html`,
  `test-harness/index.html`) polos dan `vite.config.ts` tidak menyetel
  header (bukti audit 25-a: "absent now, host-level later").
- **MENGAPA**: tanpa header ini, berbagai kelas serangan injeksi konten /
  pembajakan frame / kebocoran referrer jadi mungkin di host produksi
  (temuan checklist 25-a; XSS di kode sendiri = nol — ini lapisan pertahanan
  host).
- **BAGAIMANA**: tergantung host yang dipilih (belum ada keputusan host di
  repo): `_headers` (Cloudflare Pages/Netlify), `headers` di `vercel.json`,
  atau config nginx/Caddy. Draft nilai:

  ```text
  Content-Security-Policy: default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data: blob: https://*.supabase.co; media-src 'self' blob:; connect-src 'self' https://*.supabase.co wss://*.supabase.co; worker-src 'self' blob:; frame-ancestors 'none'; base-uri 'self'; form-action 'self'
  Strict-Transport-Security: max-age=31536000; includeSubDomains
  X-Frame-Options: DENY
  X-Content-Type-Options: nosniff
  Referrer-Policy: no-referrer
  Permissions-Policy: microphone=(self), camera=(), geolocation=()
  Cross-Origin-Opener-Policy: same-origin
  ```

  Catatan draft CSP: `media-src`/`worker-src` membolehkan `blob:` karena
  playback snippet memakai object-URL dan AudioWorklet; `connect-src`
  mencakup REST + Realtime Supabase (`wss://`). **Uji dulu** dengan
  `Content-Security-Policy-Report-Only` (atau jalankan lokal di belakang
  proxy) sampai console bersih SEBELUM enforce — salah satu direktif yang
  terlalu ketat mematikan audio/mesh diam-diam. `preload` HSTS opsional
  (mengikat domain permanen ke HTTPS — hanya bila domain pasti).

- **CARA VERIFIKASI**: `curl -sI https://<host>/` memuat semua header di
  atas; lalu buka aplikasi di browser → console TANPA error CSP; uji
  sign-in + join room + rekam/play snippet (jalur blob/media) tetap hidup.
  Pemindai eksternal (mis. securityheaders.com) sebagai sanity check.

## b. Supabase — migrasi tertunda, rate limit, email, monitoring

- **APA 1 — apply migrasi tertunda**: `0018_audit_fixes` **wajib**;
  `0019`–`0021` (remedi audit 25) begitu merge.
- **MENGAPA 1**: HIGH — 0018 sudah ada di repo sejak 23-d tapi **belum
  di-apply ke cloud** (state Task 24): rantai friendship-spoof (temuan
  25-b, masih terbuka khusus cloud) **hidup di database cloud** sampai
  0018 applied. 0014–0017 sudah applied (tercatat Task 24).
- **BAGAIMANA 1**: dua jalur (pilih satu):
  1. Runner rumah: isi `SUPABASE_ACCESS_TOKEN` (+ `SUPABASE_PROJECT_REF`)
     di `.env`, lalu `bun scripts/db/apply-migrations.mjs --dry-run` untuk
     melihat pending, tanpa `--dry-run` untuk apply.
  2. CLI resmi: `supabase link --project-ref <ref>` lalu
     `supabase db push` (butuh `SUPABASE_ACCESS_TOKEN` juga).
- **CARA VERIFIKASI 1**: dry-run runner menunjukkan 0018–0021 sudah tidak
  pending; spot-check semantik di dashboard SQL editor (mis. policy baru
  0018 ada di `pg_policies`); e2e jalur friendship di-cloud hijau.
- **APA 2 — rate limit Realtime per-klien**.
- **MENGAPA 2**: HIGH-1 (25-c): broadcast signaling TIDAK ada rate limit
  server (RLS tidak bisa membatasi laju) — 1 klien nakal dapat mencapai
  cap **100 msg/s per project** dan Supabase memutus SEMUA koneksi
  project-wide (outage semua user).
- **BAGAIMANA 2**: aktifkan/pasang limit **per-klien** agar klien nakal
  terputus sendiri sebelum quota project tersentuh — opsi di dashboard
  Supabase (Settings → Realtime / konfigurasi project) atau config
  `realtime` (mis. `max_events_per_second`) bila via CLI/self-host;
  pastikan nilai < jatah project (100 msg/s di free tier). Di kode, rate
  limit pesan server-side sudah masuk migrasi 0019 — tapi flood broadcast
  Realtime sendiri TIDAK bisa dibatasi di level DB (catatan 0017/0019),
  jadi knob cloud ini tetap wajib.
- **CARA VERIFIKASI 2**: dari dua tab, spam broadcast > limit → klien
  pelanggar terputus/di-throttle, klien lain tetap nyambung; dashboard
  Realtime metrics tidak menunjukkan diskoneksi project-wide.
- **APA 3 — keputusan konfirmasi email [USER]**.
- **MENGAPA 3**: 25-a (LOW): pesan error signUp diteruskan verbatim —
  pola enumerasi email bergantung konfigurasi cloud confirm-email; free
  tier juga membatasi email konfirmasi 2/jam.
- **BAGAIMANA 3**: rekomendasi default: **biarkan confirm email AKTIF**
  (signup selalu menjawab seragam → tidak membocorkan keberadaan akun).
  Bila ingin UX tanpa konfirmasi, sadari trade-off enumerasi + siapkan
  pola error seragam di sisi klien (tugas kode, bukan cloud).
- **CARA VERIFIKASI 3**: signup email baru → respons tidak membocorkan
  "email sudah terdaftar".
- **APA 4 — monitoring kuota egress/storage [USER]**.
- **MENGAPA 4**: 25-b/25-c (MEDIUM): storage tanpa quota per-user (burn
  1 GB oleh 1 user), egress free tier 5 GB/bulan; free tier TIDAK punya
  alert kustom.
- **BAGAIMANA 4**: cek dashboard Supabase (Settings → Usage/metrics)
  berkala (mis. mingguan) — atau upgrade tier untuk alert; mekanisme quota
  per-user di sisi kode ada di antrean remediasi.
- **CARA VERIFIKASI 4**: usage dashboard < ambang; kalender/kebiasaan cek
  berkala terbentuk.

## c. TURN ephemeral (Cloudflare Calls)

- **APA**: ganti kredensial TURN **statis** (ter-ekspor di bundle klien via
  `VITE_TURN_*`) dengan **ephemeral ber-TTL**: deploy Edge Function
  `turn-credentials` (kode di repo hasil remediasi 26) + set client env
  `VITE_TURN_EPHEMERAL_URL`; **hapus** `VITE_TURN_URL` /
  `VITE_TURN_USERNAME` / `VITE_TURN_CREDENTIAL` dari env klien begitu
  jalur ephemeral live.
- **MENGAPA**: HIGH H2 (25-c): kredensial statis bisa diekstrak SIAPA PUN
  tanpa akun → alokasi relay unlimited = **denial-of-wallet**. Riset 22-f
  - verifikasi docs 25-c (Sep 2026): Cloudflare Realtime TURN dikenakan
    **$0.05/GB egress** bila berdiri sendiri; promo 1.000 GB/bulan gratis
    kemungkinan **hanya** bersama SFU mereka (kita TIDAK memakai SFU) →
    ephemeral + monitoring bukan opsional.
- **BAGAIMANA**:
  1. Buat akun Cloudflare (gratis) → dashboard **Realtime → TURN** →
     create **TURN key** (simpan key id + API token).
  2. Deploy function `turn-credentials` (lihat header file function untuk
     perintah deploy), lalu set secrets-nya:
     `TURN_SECRET`, `TURN_URLS`, `TURN_TTL_SECONDS` (TTL pendek, mis.
     5–15 menit).
  3. Set `VITE_TURN_EPHEMERAL_URL` di env host produksi (endpoint function
     Supabase).
  4. Hapus tiga env TURN statis dari host & `.env` lokal.
- **CARA VERIFIKASI**:
  - `bun run probe:webrtc --turn` (dan `--turn --turn-tcp`) tetap
    `TURN RELAY TERVERIFIKASI ✅` lewat endpoint ephemeral — runbook:
    `docs/fase-2-turn-verifikasi.md`.
  - Credential yang ditahan > TTL ditolak server (bukti TTL hidup).
  - Dashboard billing Cloudflare: egress TURN terpantau (angka kecil).

## d. Paddle — secrets webhook + allowlist harga

- **APA**: set secrets Edge Function `paddle-webhook`:
  `PADDLE_WEBHOOK_SECRET` (pola sudah ada) + `PADDLE_ALLOWED_PRICE_IDS`
  (remedi 26 — verifikasi harga via migrasi `0021_paddle_events`), lalu
  registrasi endpoint webhook di dashboard Paddle.
- **MENGAPA**: MEDIUM 25-c: `transaction.completed` dulu men-set premium
  untuk transaksi APA PUN tanpa cek harga; remediasi kode (migrasi
  `0021_paddle_events` + router) menambah allowlist price id + ledger
  idempotency — allowlist kosong = **grant ditolak (fail-closed)**, jadi
  secret HARUS diisi agar premium bisa aktif sama sekali.
- **BAGAIMANA**:
  1. Dashboard Paddle → **Products** → salin price id produk premium
     (`pri_...`).
  2. Set secrets function: `supabase secrets set PADDLE_WEBHOOK_SECRET=...`
     (dari Paddle → Developer tools → Notifications / webhook) dan
     `PADDLE_ALLOWED_PRICE_IDS=pri_...` (multi: dipisah koma, sesuai
     format header function).
  3. Paddle → Developer tools → Notifications → tambah endpoint webhook
     function (`https://<ref>.functions.supabase.co/paddle-webhook`).
- **CARA VERIFIKASI**: kirim **test transaction** dari dashboard Paddle
  (sandbox): transaksi dengan price id terdaftar → `is_premium` true;
  price id lain / allowlist kosong → ditolak tercatat di log function;
  event dengan signature salah → 401.

## e. account-erasure — secrets Edge Function

- **APA**: set secrets Edge Function `account-erasure` (kode hasil
  remediasi 26 — lihat header file untuk daftar lengkap; minimal
  `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`).
- **MENGAPA**: 25-d (GDPR gap): penghapusan akun belum menghapus storage
  orphan + `auth.users` ghost; function menutup lifecycle itu.
- **BAGAIMANA**: `supabase secrets set SUPABASE_SERVICE_ROLE_KEY=...` (dsb.
  sesuai header function). Key service_role hanya di secret server-side —
  JANGAN pernah diberi prefix `VITE_`.
- **CARA VERIFIKASI**: jalankan erasure pada QA user: profiles, baris
  terkait, objek storage, dan `auth.users` user itu bersih; user lain
  tidak tersentuh.

## f. Backup database — secrets + jadwal + restore drill

- **APA**: aktifkan workflow **Backup DB** (`ci/workflows/backup.yml` —
  cron 02:30 WIB harian + pemicu manual) dengan secrets GitHub Actions
  `DATABASE_URL` + `AGE_RECIPIENT`; jadwalkan **restore-drill kuartalan**.
- **MENGAPA**: HIGH-3 (25-d): backup = NOL; free tier Supabase TANPA
  backup otomatis (docs resmi) — plus riwayat 6 insiden reset destruktif
  di proyek ini sendiri.
- **BAGAIMANA**:
  1. Buat keypair age: `age-keygen -o age-backup.txt` → baris `age1...`
     = `AGE_RECIPIENT` (public), file identity (private) disimpan AMAN
     OFFLINE (password manager / vault — bukan di repo).
  2. `DATABASE_URL`: **lebih baik user read-only** (hanya SELECT yang
     dibutuhkan pg_dump) daripada service_role — buat user terbatas di
     database bila memungkinkan.
  3. Repo GitHub → Settings → Secrets and variables → Actions →
     `DATABASE_URL`, `AGE_RECIPIENT`.
  4. Workflow tidak aktif sampai file `.github/workflows/backup.yml`
     ter-push (lihat seksi g — PAT scope workflow / salin manual) — job
     `preflight` akan gagal jujur bila secrets belum terisi.
- **CARA VERIFIKASI**: tab **Actions → Backup DB → Run workflow** → run
  hijau; unduh artefak `db-backup-<run_id>`, lalu dekripsi lokal:
  `age -d -i age-backup.txt backup-*.sql.gz.age | gunzip | head` (SQL
  terbaca = rantai enkripsi-dekripsi utuh). Restore drill kuartalan:
  ikuti `docs/backup-runbook.md`.

## g. GitHub — repo private, branch protection, Dependabot, pelaporan

- **APA 1 — repo PRIVATE [USER]**.
- **MENGAPA 1**: HIGH-4 (25-d): repo saat ini **public**; commit lokal
  berisi project ref + intel audit ("0018 belum di-apply") — **push
  berikutnya akan mempublish intel keamanan**. Artefak backup terenkripsi
  pun lebih aman di repo private (siapa pun yang login bisa mengunduh).
- **BAGAIMANA 1**: repo → Settings → General → Danger Zone →
  **Change visibility → Private**.
- **CARA VERIFIKASI 1**: buka repo dalam mode incognito/tanpa login → 404.
- **APA 2 — branch protection `main`**.
- **MENGAPA 2**: tanpa proteksi, force-push/commit langsung bisa
  menghapus riwayat — melindungi canonical (termasuk `ci/workflows/`
  yang dipercaya restore-ci).
- **BAGAIMANA 2**: Settings → Branches → Add branch ruleset `main`:
  require pull request + 1 review (Code Owners aktif via
  `.github/CODEOWNERS` — file kini dikelola kanonik di `ci/github/` +
  `scripts/dev/restore-ci.mjs`), block force push & deletions.
- **CARA VERIFIKASI 2**: push langsung ke `main` ditolak; PR butuh review.
- **APA 3 — Dependabot + private vulnerability reporting**.
- **MENGAPA 3**: 25-d (hygiene): Dependabot/CODEOWNERS/SECURITY.md
  sebelumnya ABSENT. File-file itu kini tersedia (kanonik `ci/github/`,
  disinkronkan ke `.github/` oleh restore-ci) — tinggal diaktifkan
  sisi-GitHub.
- **BAGAIMANA 3**: tidak ada toggle khusus untuk dependabot.yml — file
  aktif begitu `.github/dependabot.yml` ada di repo (pastikan file
  `.github/` ter-push, lihat item 5). Private vulnerability reporting:
  Settings → Code security → aktifkan (referensi:
  `.github/SECURITY.md`).
- **CARA VERIFIKASI 3**: tab Insights → Dependency graph terisi; tab
  Security → Dependabot aktif; PR Dependabot pertama muncul ≤ 1 minggu;
  tab Security → "Report a vulnerability" tersedia.
- **APA 4 — 2FA org [USER]** (bila repo berada di organisasi).
- **MENGAPA 4**: akun anggota tanpa 2FA = jalur pembajakan repo termudah.
- **BAGAIMANA 4**: org → Settings → Authentication security → require
  two-factor authentication.
- **APA 5 — PAT scope workflow (opsional) [USER]**.
- **MENGAPA 5**: file `.github/` tidak bisa di-commit dengan PAT saat ini
  (push DITOLAK MENYELURUH) — makanya pola kanonik `ci/` + restore-ci
  ada. Selama pola itu dipertahankan, scope ini opsional.
- **BAGAIMANA 5**: edit PAT GitHub → Fine-grained permissions →
  Workflows: Read and write → minta agent: hapus `.github/` dari
  `.git/info/exclude`, `git add -f .github`, push, lalu restore-ci boleh
  dipensiunkan.
- **CARA VERIFIKASI 5**: `.github/` terlihat di repo remote; `git push`
  yang menyentuh `.github/` diterima.

## h. Sentry (opsional)

- **APA**: set `VITE_SENTRY_DSN` di env host produksi.
- **MENGAPA**: error monitoring produksi (F1.8); DSN memang publik by
  design. Scrub `beforeSend` sudah built-in (query string dipangkas,
  kunci `token|secret|password|authorization|apikey` → `[difilter]`).
- **BAGAIMANA**: Sentry → project settings → DSN → env host. (Catatan
  gap: breadcrumb/contexts belum disikat sedalam `beforeSend` — 23-c
  LOW-7, remediasi kode terpisah.)
- **CARA VERIFIKASI**: trigger error uji → event muncul di dashboard
  TANPA kredensial di payload.

## i. Verifikasi pasca-deploy (smoke test)

Jalankan BERURUTAN setelah item di atas; semua harus lulus sebelum
dinyatakan live:

| #   | Uji                                 | Lolos bila                                                                                  |
| --- | ----------------------------------- | ------------------------------------------------------------------------------------------- |
| 1   | Signup tanpa captcha token          | ditolak `captcha_failed` (captcha hidup di cloud)                                           |
| 2   | Sign-in user QA + signout           | sesi hidup/berakhir benar; error password seragam `invalid_credentials`                     |
| 3   | Join room 2 peer (2 browser/device) | presence saling melihat, koneksi P2P `connected`, posisi & audio mengalir                   |
| 4   | Snippet suara rekam→upload→playback | upload ke folder sendiri; playback via signed URL `https://*.supabase.co` (jalur CSP hidup) |
| 5   | Webhook Paddle (test transaction)   | premium hanya utk price id allowlist; signature salah → 401                                 |
| 6   | Actions → Supabase keepalive → Run  | HTTP 200/201, `select 1` sukses                                                             |
| 7   | Actions → Backup DB → Run           | run hijau, artefak `.age` terunduh + terdekripsi lokal                                      |
| 8   | `curl -sI` host produksi            | semua header seksi (a) hadir; console browser tanpa pelanggaran CSP                         |
| 9   | TURN ephemeral                      | probe `--turn` relay-verified via endpoint ephemeral; TTL kadaluarsa ditolak                |

## Lintas-referensi

- `docs/backup-runbook.md` — prosedur restore + drill.
- `docs/fase-2-turn-verifikasi.md` — runbook verifikasi TURN (rig lokal +
  ephemeral).
- `ci/workflows/backup.yml`, `ci/github/*`, `scripts/dev/restore-ci.mjs` —
  artefak sisi-repo dari checklist ini (Task 26-e).
- `worklog.md` Task 25/25-a..25-d — bukti temuan audit per item.

---

## j. Deploy Vercel — UI produk Fase 3 (Task 32, 30 Sep 2026)

Build produk murni: `bun install && bun run build` → `dist/` (SPA statis,
TANPA test-harness — gating BUILD_HARNESS tetap aktif). Vercel mendeteksi
Vite otomatis.

**Langkah:**

1. Import repo GitHub ke Vercel (framework preset: **Vite**).
2. Environment Variables (semua publik by-design):
   - `VITE_SUPABASE_URL` = `https://llaeglakcheqxlbwvheo.supabase.co`
   - `VITE_SUPABASE_ANON_KEY` = anon key (dashboard → Settings → API)
   - `VITE_TURN_EPHEMERAL_URL` =
     `https://llaeglakcheqxlbwvheo.supabase.co/functions/v1/turn-credentials`
   - (opsional) `VITE_SENTRY_DSN`
3. Deploy. SPA satu halaman — tidak perlu rewrite rule.
4. Supabase dashboard → Authentication → URL Configuration: tambahkan
   domain Vercel ke **Site URL** + **Redirect URLs**.

**Catatan keamanan:**

- Captcha Turnstile sengaja **dimatikan sementara** (30 Sep 2026) karena
  site key tidak tersedia di repo/env — tanpa itu login pasti gagal
  `captcha_failed`. Secret masih tersimpan di dashboard. Cara menyalakan
  lagi: Authentication → Sign In / Up → Security → Captcha → ON, isi
  site key + secret lama, lalu tambahkan **site key** ke env
  `VITE_TURNSTILE_SITE_KEY` di Vercel dan hostnamenya (domain Vercel +
  preview) ke widget Turnstile di Cloudflare.
- Realtime `private_only=true` tetap ON; channel aplikasi
  (`goofy:presence`, `goofy:pokes`) diizinkan policy 0022 khusus role
  authenticated — room:{kode} tetap eksklusif tiket (P0-1 utuh).
- Edge Function `turn-credentials` sudah live (mode REST Cloudflare,
  secrets TURN_KEY_ID/TURN_API_TOKEN terpasang, TTL 3600s).

**Akun demo publik** (tombol cepat di layar masuk, untuk mencoba telepon
dua tab): qa.alpha/bravo/charlie@goofy.example.com — password di .env
lokal (TEST_USER_*). Hapus via dashboard bila tidak mau ada di produksi.
