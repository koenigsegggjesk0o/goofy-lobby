# goofy-lobby

MVP web app sosial berbasis **voice chat dengan spatial audio real-time**
(WebRTC mesh P2P, maks. 8 orang per room, lobby 2D dengan posisi avatar).

> **Status: Fase 1 — Sistem inti (TANPA UI).**
> Sesuai keputusan pemilik produk: tidak ada satu baris kode UI pun sampai
> Fase 3. Satu-satunya halaman di dev server adalah halaman status `/`
> (infrastruktur) dan test harness `/test-harness/` (alat uji polos untuk
> Playwright — tanpa styling, bukan UI produk).

## Prasyarat

- [Bun](https://bun.sh) (atau Node 20+)
- Akun free tier: [Supabase](https://supabase.com), [Cloudflare Turnstile](https://dash.cloudflare.com),
  [Sentry](https://sentry.io) (Developer plan), GitHub

## Setup

```bash
bun install
cp .env.example .env   # lalu isi semua nilai
bun run dev            # Vite di http://localhost:3000
```

## Environment variables

Lihat `.env.example` — setiap variabel terdokumentasi lengkap dengan cara
mengambil nilainya.

Aturan penting (keharusan Vite + keamanan):

- Hanya variabel berprefix `VITE_` yang diekspos ke browser
  (`import.meta.env.VITE_*`).
- Secret (service_role key, Turnstile secret, access token) **tidak boleh**
  diberi prefix `VITE_` — kalau diberi, secret akan masuk bundle klien.

## Scripts

| Perintah                          | Fungsi                                         |
| --------------------------------- | ---------------------------------------------- |
| `bun run dev`                     | Dev server Vite di port 3000                   |
| `bun run build`                   | Type-check (`tsc --noEmit`) + build produksi   |
| `bun run preview`                 | Preview hasil build                            |
| `bun run lint`                    | ESLint (flat config, typescript-eslint strict) |
| `bun run typecheck`               | Type-check saja                                |
| `bun run test`                    | Vitest (unit test logic murni)                 |
| `bun run test:e2e`                | Playwright E2E lewat test-harness              |
| `bun run format` / `format:check` | Prettier                                       |

## Testing

- **Vitest** — unit test untuk logic murni (Zod schema, SDP munging,
  kalkulasi posisi, cache). Tidak butuh browser.
- **Playwright** — E2E via `test-harness/` (halaman HTML polos yang memuat
  modul sistem dan mengekspos fungsinya ke `window.__harness` supaya bisa
  dipanggil lewat `page.evaluate()`). Halaman ini sengaja tanpa styling —
  itu alat uji, bukan UI produk.

## Migrasi database (Supabase)

File SQL berada di `supabase/migrations/` (urut nomor, idempotent). Runner
lokal memakai **Supabase Management API** — bukan koneksi DB langsung:

```bash
bun scripts/db/apply-migrations.mjs --dry-run   # lihat yang pending
bun scripts/db/apply-migrations.mjs               # apply yang pending
```

- Membaca `SUPABASE_ACCESS_TOKEN` + `SUPABASE_PROJECT_REF` dari `.env`
  (token wajib punya permission `database_migrations_write`).
- Sudah applied ditandai oleh `name` di history migrasi server — aman
  dijalankan ulang (skip yang sudah ada).
- Catatan penting: tabel yang dibuat lewat Management API **tidak menerima
  default grants** untuk role PostgREST — migrasi `0005_postgrest_grants`
  memulihkannya (pola standar docs Supabase).

## Supabase keepalive (anti auto-pause)

Project free tier Supabase dapat auto-pause setelah lama tanpa aktivitas.
Workflow GitHub Actions `supabase-keepalive.yml` (cron tiap 3 hari)
melakukan health-check project via Supabase Management API.

Setup (sekali, oleh pemilik repo):

1. Buka repo GitHub → **Settings → Secrets and variables → Actions**
2. **New repository secret**:
   - Name: `SUPABASE_ACCESS_TOKEN`
   - Value: token akun Supabase (`supabase.com/dashboard/account/tokens`)
3. Workflow file ditambahkan pada langkah F1.7 (lihat rencana fase di bawah).

## Struktur (Fase 1 — sistem inti; status per modul)

```
src/
  lib/           env (validasi VITE_*), supabase client, typed emitter
  webrtc/        ✅ F1.3:
                 types (Zod: signal/presence/posisi, konstanta protokol)
                 signaling-client (broadcast Supabase Realtime 'signal')
                 peer-connection-manager (mesh ≤7 remote peer,
                   perfect negotiation polite/impolite, STUN default,
                   non-trickle + gather-timeout 2s, trickle sisa)
                 data-channel-sync (~15 posisi/detik, throttle +
                   backpressure bufferedAmount, Zod di sisi terima)
                 ice-restart-handler (failed → restart, disconnected →
                   tenggang 5s, backoff 0/2s/4s, maks 3 percobaan)
                 mesh-room-controller (presence → penemuan peer,
                   kapasitas 8 deterministik, lifecycle join/leave)
  audio/         ⏳ SpatialAudioEngine (HRTF) — F1.4
  profile/       ⏳ voiceRecorderLogic — F1.5
  monitoring/    ⏳ sentry — F1.8
test-harness/    ⏳ alat uji polos — F1.6
e2e/             ⏳ spec Playwright — F1.6
supabase/
  migrations/    ✅ F1.2 (profiles + RLS + bucket voice-snippets + grants)
.github/
  workflows/     ⏳ CI + keepalive — F1.7
```

### Catatan desain mesh (F1.3)

- **Perfect negotiation** (pola WebRTC modern): sisi dengan sessionId lebih
  besar = *polite* (me-rollback offer saat glare), yang kecil = inisiator
  (membuat DataChannel + offer awal). Kedua sisi tetap aman menawar kapan pun.
- **SDP non-trickle dengan timeout**: deskripsi dikirim utuh setelah kandidat
  ICE terkumpul (atau 2 detik) — satu pesan signaling per deskripsi, ramah
  rate-limit Realtime. Kandidat yang datang terlambat tetap di-trickle.
- **Kapasitas room 8 orang** dipilih deterministik (urutan sessionId terkecil)
  sehingga semua klien sepakat tanpa koordinasi tambahan; pendatang ke-9+
  menerima event `room-full` lalu auto-leave.
- **Semua payload lintas jaringan divalidasi Zod** (signal, presence, posisi);
  yang gugur dilaporkan lewat event `invalid-signal`/`invalid-position` untuk
  metrik, tidak pernah diteruskan.

## Keputusan teknis terverifikasi (2026-06)

- **TypeScript 6.0.3** — bukan 7.0.2 (terbaru di registry) karena
  `typescript-eslint@8.70.1` mendukung maksimal TS `<6.1.0`. Dipilih versi
  tertinggi yang kompatibel dengan toolchain.
- ESLint 10 + flat config (`eslint.config.mjs` — padanan `.eslintrc` modern).
- Vite 8, Vitest 5, Playwright 1.63, Zod 4, `@supabase/supabase-js` 2.x,
  `@sentry/browser` 11 — semua versi diverifikasi dari registry npm saat
  scaffold.

## Aturan proyek (ringkas)

- Prioritas: **benar & teruji** > banyak fitur. Dilarang mock untuk fitur inti.
- Semua tabel Postgres wajib punya RLS policy eksplisit sebelum menyimpan
  data user asli. Kolom `is_premium` hanya boleh ditulis service_role.
- Tanpa UI sampai Fase 3 (instruksi eksplisit pemilik produk).
