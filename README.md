# goofy-lobby

MVP web app sosial berbasis **voice chat dengan spatial audio real-time**
(WebRTC mesh P2P, maks. 8 orang per room, lobby 2D dengan posisi avatar).

> **Status: Fase 1 SELESAI (sistem inti) + Fase 2: TURN/observabilitas &
> LAPISAN LOGIKA FITUR SOSIAL (friends, chat, soundboard, voicefilter,
> payment + migrasi + skeleton webhook Paddle) — semua TANPA UI.**
> Audit DoD Fase 1 lengkap (bukti per item): lihat [`docs/dod-audit-fase1.md`](docs/dod-audit-fase1.md).
> Status & pemetaan file Fase 2: lihat [`docs/fase-2-fitur-logika.md`](docs/fase-2-fitur-logika.md).
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

| Perintah                          | Fungsi                                                                                                                                      |
| --------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| `bun run dev`                     | Dev server Vite di port 3000                                                                                                                |
| `bun run build`                   | Type-check (`tsc --noEmit`) + build produksi                                                                                                |
| `bun run preview`                 | Preview hasil build                                                                                                                         |
| `bun run lint`                    | ESLint (flat config, typescript-eslint strict)                                                                                              |
| `bun run typecheck`               | Type-check saja                                                                                                                             |
| `bun run test`                    | Vitest (unit test logic murni)                                                                                                              |
| `bun run test:e2e`                | Playwright E2E lewat test-harness                                                                                                           |
| `bun run test:e2e:stress`         | Runner stress e2e `--repeat-each=N` + distribusi durasi per spec                                                                            |
| `bun run probe:webrtc`            | Probe diagnostik ICE + pasangan terpilih; `--runs N`; `--turn` = verifikasi relay-forced TURN Fase 2                                        |
| `bun run format` / `format:check` | Prettier                                                                                                                                    |
| `bun run doctor`                  | Triage env/dev-server/git/matriks spec e2e                                                                                                  |
| `bun run verify`                  | Gerbang lengkap SATU perintah: typecheck → lint → format → unit → build → e2e (spec runnable saat ini) — exit code tidak bisa tertelan pipa |

## Testing

- **Vitest** — unit test untuk logic murni (Zod schema, SDP munging,
  kalkulasi posisi, cache). Tidak butuh browser. 668 test, 47 file (termasuk scripts/dev/e2e-stress.test.mts — agregasi stress dites langsung)
  (termasuk `src/db/migrations.test.ts` — migrasi dieksekusi di PostgreSQL
  asli via PGlite/WASM + RLS/grant/trigger diuji empiris).
- **Playwright** — E2E via `test-harness/` (halaman HTML polos yang memuat
  modul sistem dan mengekspos fungsinya ke `window.__harness` supaya bisa
  dipanggil lewat `page.evaluate()`). Halaman ini sengaja tanpa styling —
  itu alat uji, bukan UI produk. 14 spec e2e hidup terhadap Supabase/Sentry
  asli (Chromium, workers=1).

### Cakupan e2e (F1.6)

- `auth.spec.ts` — halaman harness siap; signup TANPA captcha ditolak
  `captcha_failed` (DoD #4); signin QA happy path (captcha dummy test key);
  password salah → `invalid_credentials`; signout mengakhiri sesi.
- `profiles-rls.spec.ts` — anon melihat 0 baris; authenticated membaca semua
  baris; update baris sendiri + pulihkan; tulis baris user lain diblokir
  RLS (0 baris tersentuh + readback tidak berubah).
- `snippet.spec.ts` — rekam dari stream sintetis (oscillator →
  MediaStreamDestination) lewat MediaRecorder asli; upload ke folder sendiri;
  profil menunjuk path baru; signed URL ter-fetch (200 + `audio/webm`);
  cleanup menyisakan bucket bersih; upload ke folder user lain ditolak RLS.
- `monitoring.spec.ts` — init Sentry dari DSN; captureException menghasilkan
  eventId; flush terkirim; probe langsung ke endpoint ingest HTTP 200.
- `mesh.spec.ts` — DUA konteks browser (alpha + bravo): presence saling
  menemukan, signaling offer/answer/ice via Realtime broadcast, koneksi P2P
  `connected` di kedua sisi, track audio diterima, posisi mengalir lewat
  DataChannel, leave bersih.
- `audio-smoke.spec.ts` — SpatialAudioEngine hidup di AudioContext asli
  (voice peer + posisi panner + listener + dispose).

### Pemakaian harness manual (devtools)

Buka `http://localhost:3000/test-harness/` lalu panggil dari console:

```js
await window.__harness.signIn(email, password); // captcha dummy otomatis
await window.__harness.getProfile();
await window.__harness.recordMockSnippet(1500);
await window.__harness.uploadLastRecording();
window.__harness.meshLog(); // jejak signaling utk debugging
```

Semua method defensif — tidak pernah melempar, selalu mengembalikan objek
`{ ok, ... }` serializable. Halaman juga menampilkan log teks polos.

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

### Catatan desain monitoring (F1.8)

- **Error monitoring saja** (spek): `tracesSampleRate: 0`, tanpa replay/
  feedback/session-replay — jejak network minimal, fokus event error.
- **No-op terdokumentasi**: DSN kosong → `initMonitoring` melaporkan
  `skipped: 'empty-dsn'` dan SEMUA helper tetap aman dipanggil (dev
  tanpa DSN tidak pernah crash).
- **Kebersihan data**: `beforeSend` memangkas query string URL dan
  mengganti nilai kunci sensitif (`token|secret|password|authorization|
apikey`) dengan `[difilter]` — kredensial tidak pernah sampai dashboard.
- **Context terisolasi**: `captureError(error, {context, data})`
  menempel konteks lewat `withScope` — tidak bocor ke event lain.
- **Never-throw**: semua helper membungkus SDK dalam try/catch —
  kegagalan monitoring tidak boleh menjatuhkan aplikasi.
- **Breadcrumb mesh (Task 8-g)**: `mesh-trail.ts` memetakan event siklus
  mesh (join/leave/peer-*/error) ke breadcrumb dengan batas ukurannya
  (pesan 64 / nilai 256 karakter, maks 8 kunci detail — berlebih dihitung
  di `detailKeysDropped`; objek sirkular tidak pernah melempar).
  `addTrail` menerima `level` opsional — event mesh `'error'` dikirim
  sebagai level `error`, sisanya `info`. Harness memanggilnya di setiap
  `#pushMeshLog` + join/leave attempt, jadi error mesh di dashboard
  membawa jejak konteks terakhir, bukan stack trace kosong.
- **Ring jejak lokal (Task 10-a)**: `trail-log.ts` merekam setiap
  `addTrail` ke ring FIFO 50 entri SEBELUM menyentuh SDK — jejak
  breadcrumb teramati via `window.__harness.trailLog()` TANPA DSN
  (e2e no-auth `mesh-trail.spec.ts`); dashboard-side tetap butuh DSN.

## Supabase keepalive (anti auto-pause)

Project free tier Supabase dapat auto-pause setelah lama tanpa aktivitas.
Workflow GitHub Actions `supabase-keepalive.yml` (cron tiap 3 hari)
melakukan health-check project via Supabase Management API.

Setup (sekali, oleh pemilik repo):

1. Buka repo GitHub → **Settings → Secrets and variables → Actions**
2. **New repository secret** (dua buah):
   - Name: `SUPABASE_ACCESS_TOKEN` — token akun Supabase
     (`supabase.com/dashboard/account/tokens`)
   - Name: `SUPABASE_PROJECT_REF` — ref project (tercantum di `.env`
     lokal sebagai `SUPABASE_PROJECT_REF`)
3. Workflow `supabase-keepalive.yml` sudah terpasang (F1.7); bisa juga
   dipicu manual dari tab **Actions → Supabase keepalive → Run workflow**.
   Endpoint kueri diverifikasi live (HTTP 200/201, hasil `[{"?column?":1}]`).

## Struktur (Fase 1 — sistem inti; status per modul + TURN Fase 2)

```
src/
  lib/           env (validasi VITE_*), supabase client, typed emitter
  webrtc/        ✅ F1.3:
                 types (Zod: signal/presence/posisi, konstanta protokol)
                 signaling-client (broadcast Supabase Realtime 'signal')
                 peer-connection-manager (mesh ≤7 remote peer,
                   perfect negotiation polite/impolite, STUN default,
                   trickle penuh + buffer kandidat dua arah — F1.6)
                 data-channel-sync (~15 posisi/detik, throttle +
                   backpressure bufferedAmount, Zod di sisi terima)
                 ice-restart-handler (failed → restart, disconnected →
                   tenggang 5s, backoff 0/2s/4s, maks 3 percobaan;
                   watchdog establishment 15s — Fase 2/8-c: mentok di
                   new/connecting → eskalasi restart, hanya sisi inisiator)
                 mesh-room-controller (presence → penemuan peer,
                   kapasitas 8 deterministik, lifecycle join/leave,
                   antrean sinyal utk race presence vs broadcast — F1.6)
                 turn-config (✅ Fase 2: env VITE_TURN_* → iceServers;
                   union disabled/enabled/invalid, alasan terkumpul;
                   fallback STUN-only bila kosong/invalid)
  audio/         ✅ F1.4:
                 types (konvensi dunia 2D → bidang x-z audio, yaw →
                   vektor orientasi, helper posisi modern/legacy,
                   bentuk longgar parameter sender RTP)
                 spatial-audio-engine (MediaStreamSource → PannerNode
                   HRTF → masterGain per peer; mute/volume global;
                   posisi bisa datang sebelum suara; clamp ulang)
                 audio-listener-sync (posisi + orientasi telinga
                   lokal dari posisi dunia + yaw, fallback legacy)
                 bitrate-adaptation (DUA sumber keputusan — Task 13-b:
                   tier Opus 24k/20k/16k SEMUA dalam rentang main prompt
                   "Opus 16–24 kbps"; state koneksi + SAMPEL STATS
                   jaringan via observeStats/getStats; tenggang
                   disconnected 5s; dedupe; retry saat setParameters gagal)
                 bitrate-decision (13-b BARU: keputusan tier MURNI dari
                   median jendela sampel loss+jitter — histeresis alami
                   anti-spike; median via percentile type-7 src/lib/stats;
                   validasi keras RangeError untuk sampel korup)
  profile/       ✅ F1.5:
                 types (skema Zod display name/warna/path snippet,
                   like-type Supabase storage+postgrest, adapter
                   asProfileClient)
                 voice-recorder (MediaRecorder audio/webm, timeslice
                   500ms, auto-stop durasi 15s & budget 25MiB,
                   cleanup track di semua jalur keluar)
                 voice-snippet-service (upload folder-per-user
                   {userId}/{snippetId}.webm, contentType persis
                   audio/webm, tanpa upsert — bucket tanpa policy
                   UPDATE; signed URL playback; delete; list)
                 profile-service (CRUD profiles, validasi Zod dua
                   arah: patch sebelum kirim + baris hasil sebelum
                   dipakai; whitelist kolom update)
                 voice-snippet-manager (orkestrasi ganti/hapus
                   snippet: upload → arahkan profil → hapus lama,
                   penghapusan lama best-effort)
  monitoring/     ✅ F1.8:
                 sentry (init dari VITE_SENTRY_DSN, no-op bila kosong;
                   idempoten; tracesSampleRate 0 = error monitoring saja;
                   beforeSend memangkas query URL + kunci sensitif;
                   captureError dengan context terisolasi via withScope;
                   addTrail breadcrumb; flushMonitoring; semua helper
                   tidak pernah melempar)
  friends/       ✅ Fase 2/12:
                 types (Zod friendships/blocks/profil ringkas, filter
                   kanonik SIMETRIS anti-injection uuid, error domain)
                 friendship-service (send/accept/decline/cancel/unfriend,
                   listFriends dua arah + profil, state 4 nilai; pemetaan
                   23505/23514/trigger-blokir → kode error)
                 block-service (block idempoten, unblock, daftar;
                   RLS blocker-only dijaga migrasi 0008)
  chat/          ✅ Fase 2/12:
                 types (Zod body btrim 1–500 PERSIS constraint DB,
                   baris snake_case, rantai struktural)
                 rate-limiter (sliding window murni, jam di-inject,
                   retryAfterMs, prune malas — default 10/30 dtk)
                 message-service (kirim: rate → gate pertemanan → insert
                   → revalidasi; percakapan dua arah, kursor before,
                   hasil ASCENDING)
  soundboard/    ✅ Fase 2/12:
                 preset-sounds (katalog 8 id stabil — aset audio fisik
                   menunggu Fase 3, TIDAK ada placeholder)
                 custom-sound-service (bucket soundboard-sounds 5 MiB,
                   5 MIME + peta ekstensi, mirror pola snippet)
  voicefilter/   ✅ Fase 2/12:
                 playback-rate-pitch-shift (naif: 2^(semitones/12),
                   clamp ±24)
                 pitch-worklet-processor.js (granular dual-tap:
                   delay fraksional slope 1−ratio, jendela sin/cos
                   kuadrat-jumlah-1, bypass identitas di |s|<0.01 —
                   frekuensi terbukti zero-crossing ±5%)
                 audio-worklet-pitch-shift (controller struktural,
                   addModule sekali per context, transisi bypass ↔
                   worklet idempoten, pabrik browser bebas-cast)
  payment/       ✅ Fase 2/12:
                 paddle-signature (verifikasi PERSIS docs resmi:
                   ts;h1 multi-secret, HMAC-SHA256 crypto.subtle,
                   timing-safe, toleransi 5 dtk — murni, Deno & Node)
                 paddle-webhook (router event: transaction.completed →
                 premium, subscription.canceled → non; core teruji)
                 premium-status-service (baca is_premium + revalidasi)
  db/            ✅ Fase 2/12 (test-only): migrations.test.ts — 13
                 migrasi dijalankan di PGlite + idempotensi + matriks
                 RLS + lockdown kolom is_premium + guard blokir
supabase/
  migrations/    0001–0006 (F1) + 0007–0013 (Fase 2: friendships+blocks+
                 guard trigger, messages+RLS gate pertemanan, is_premium+
                 lockdown column-grant, bucket soundboard + storage RLS)
  functions/
    paddle-webhook/ SKELETON Deno (di-ignore tsc/eslint proyek; import
                 map terkunci + sloppy-imports; BELUM pernah dijalankan —
                 butuh deploy + secrets, lihat header file)
test-harness/    ✅ F1.6 + Fase 2/12: alat uji polos — window.__harness
                 (auth, profil+RLS probe, snippet, monitoring, mesh,
                 audio smoke, voicefilter: initPitchShift/setSemitones/
                 dispose + pitchShiftMath; semua method defensif, log di
                 halaman; voicefilter TANPA kredensial bisa diuji live)
e2e/             ✅ F1.6: 17 spec Playwright (Chromium, workers=1,
                 helpers/qa-env.ts baca .env lokal — kredensial QA
                 tidak pernah masuk bundle browser; mesh-three-peers
                 3 konteks alpha+bravo+charlie — PREP 8-e, dieksekusi
                 setelah TEST_USER_* lengkap)
scripts/
  db/            ✅ F1.2: apply-migrations.mjs (Management API)
  dev/           ✅ F1.6: probe-webrtc.mjs (diagnostik ICE/mDNS + waktu
                 establishment dual-metrik: total offer→connected dan ICE
                 pasca-tukar-kandidat; --runs N untuk distribusi — kalibrasi
                 ambang watchdog 8-c)
                 ✅ 13-a: distribusi PERSENTIL min/p50/p75/p90/p95/p99/max
                 + mean + stdev (interpolasi type 7) via src/lib/stats.ts —
                 SATU sumber kebenaran bersama e2e-stress, teruji unit
                 ✅ 9-b: doctor.mjs (triage .env per grup NAMA saja + dev
                 server + git push + matriks spec e2e runnable)
                 ✅ 8-f PREP: e2e-stress.mjs (bun run test:e2e:stress —
                 playwright --repeat-each=N + agregasi durasi per spec
                 persentil p50–p99 + mean/stdev via src/lib/stats.ts;
                 metodologi distribusi 8-f)
supabase/
  migrations/    ✅ F1.2 (profiles + RLS + bucket voice-snippets + grants)
                  ✅ F1.5 (0006: voice_snippet_path + policy select authenticated)
.github/
  workflows/     ✅ F1.7:
                 ci.yml (push/PR main: lint + typecheck + test + build
                   via bun; e2e tetap lokal — butuh secrets TEST_USER_* +
                   VITE_* di repo bila mau diaktifkan di CI)
                 supabase-keepalive.yml (cron tiap 3 hari: `select 1`
                   lewat Management API — anti auto-pause free tier)
```

### Catatan desain TURN fallback (Fase 2, Task 8-b)

- Env `VITE_TURN_URL` / `VITE_TURN_USERNAME` / `VITE_TURN_CREDENTIAL`
  (opsional). Prefix `VITE_` diperlukan karena `RTCPeerConnection`
  berjalan di browser — kredensial TURN statis memang sampai ke bundle
  klien (praktik standar WebRTC untuk kredensial statis; dapat di-revoke
  kapan saja dari dashboard Metered). Kredensial ephemeral via backend
  tercatat sebagai opsi masa depan.
- `parseTurnEnv` murni: hasil union `disabled | enabled | invalid` dengan
  seluruh alasan terkumpul (bukan hanya yang pertama). URL boleh banyak
  (dipisah koma), skema wajib `turn:`/`turns:`.
- Kosong/invalid → fallback STUN-only (`DEFAULT_ICE_SERVERS` yang sama
  dengan manager — tidak duplikat daftar), alasan tetap diekspos ke
  pemanggil agar tidak tertelan diam-diam.
- Malam implementasi: env nyata belum berisi TURN → `envStatus` harness
  menampilkan `turn: disabled` (jujur, bukan dipaksa tampak aktif).
  Live-verifikasi jalur `enabled` menunggu kredensial Metered dari user.
- **Verifikasi end-to-end (Task 11-a)**: `bun run probe:webrtc --turn` —
  relay-forced (`iceTransportPolicy "relay"`), memakai `parseTurnEnv`
  yang sama dengan mesh (satu sumber kebenaran), membuktikan relay lewat
  pasangan kandidat TERPILIH bertipe relay, exit code bermakna, nilai
  kredensial tidak pernah dicetak. Runbook lengkap:
  `docs/fase-2-turn-verifikasi.md`.
- **Observabilitas pasangan terpilih di mesh nyata (Task 11-b)**: saat peer
  `connected`, manager membaca `getStats()` lewat parser yang sama
  (`relay-stats.ts`) → event `selected-pair` (viaRelay) + snapshot
  `PeerState.selectedPair`; harness mengeksposnya via
  `meshState().peers[].selectedPair` + entri `meshLog` (otomatis jadi
  breadcrumb monitoring). Sampel segera + satu re-sample tertunda 1,5 dtk
  (nominasi lambat khas TURN); dedupe signature — tanpa info baru, tanpa
  emisi; `getStats` gagal = diam (observabilitas tidak boleh menjatuhkan
  koneksi); nol biaya bila tidak ada konsumen.
- **Ketangguhan buffer & timer (Task 11-d)**: tiga perbaikan bedah minimal
  dari audit empiris — (1) `dropPeer` kini juga membuang cache `positions`
  (tidak bocor memori + peer yang rejoin tidak mewarisi posisi basi);
  (2) antrean kandidat remote sebelum `remoteDescription` dibatasi 50/peer
  drop-terlama-dulu (satu-satunya buffer yang dikendalikan pihak jaringan —
  spam `ice` tanpa deskripsi tidak lagi menumbuhkan memori);
  (3) timer re-sample pasangan terpilih dilepas saat episode `connected`
  berakhir — peer yang flap cepat tidak menumpuk timer pending (invariant
  ≤ 1 timer hidup per peer; dibuktikan mutation test: tanpa fix = 12 panggilan
  getStats, dengan fix = 7).
- **Distribusi persentil pengukuran durasi (Task 13-a)**: statistik
  distribusi (min/p50/p75/p90/p95/p99/max + mean + stdev sampel) dipindah
  ke modul murni `src/lib/stats.ts` (interpolasi "type 7" — default
  numpy/R; p50 ≡ median, p0 = min, p1 = max; stdev sampel n−1, n=1 → 0;
  masukan kosong/tak-hingga → RangeError — data korup ditolak keras).
  Sebelumnya `probe-webrtc` dan `e2e-stress` memelihara DUPLIKAT logika
  min/median/mean/max tanpa test; kini keduanya mengimpor modul yang sama
  (teruji unit 19 test) dan outputnya kaya persentil — dasar kalibrasi
  watchdog 8-c dan metodologi distribusi 8-f dengan bentuk yang konsisten.

### Catatan desain mesh (F1.3, direvisi F1.6)

- **Perfect negotiation** (pola WebRTC modern): sisi dengan sessionId lebih
  besar = _polite_ (me-rollback offer saat glare), yang kecil = inisiator
  (membuat DataChannel + offer awal). Kedua sisi tetap aman menawar kapan pun.
- **Trickle penuh dengan buffer dua arah** (revisi F1.6, bukti e2e): desain
  awal menunggu kandidat ICE ≤2 detik lalu mengirim SDP utuh (non-trickle).
  Window tunggu itu ternyata medan race — offer yang di-rollback saat glare
  tetap terkirim dengan deskripsi basi ("m-lines doesn't match offer",
  "Failed to set SSL role"), dan answer bisa salah pasangan. Sekarang:
  deskripsi dikirim SEGERA setelah `setLocalDescription`; kandidat lokal
  yang muncul lebih dulu di-buffer lalu di-flush; kandidat remote yang tiba
  sebelum `remoteDescription` siap juga di-buffer. Biaya: beberapa pesan
  `ice` ekstra per peer (host mDNS + srflx) — jauh di bawah rate-limit
  Realtime.
- **Guard race di deskripsi**: offer hanya dikirim bila `signalingState`
  masih `have-local-offer` (dijawab cepat / di-rollback = batal); answer
  dibatalkan bila `remoteDescriptionEpoch` berganti (offer lain datang di
  tengah pemrosesan). Perbandingan string SDP TIDAK bisa dipakai — browser
  menormalisasi SDP saat setRemote.
- **Antrean sinyal peer-tak-dikenal** (controller): broadcast bisa tiba
  SEBELUM presence sync selesai (~1-2 s) — pesan dari peer yang belum
  terdaftar diantrekan (maks 50/peer, TTL 10 s) lalu di-flush saat peer
  terdaftar. Tanpa ini, offer pertama terbuang → deadlock negosiasi.
- **Watchdog establishment (8-c)**: koneksi yang mentok di `new`/
  `connecting` selama 15 detik (dapat dikonfigurasi lewat opsi manager
  `establishmentTimeoutMs`) kini dieskalasi ke ICE restart lewat jalur
  backoff/give-up yang sama — terinspirasi outlier e2e 35.6s (Task 7-a).
  Hanya sisi INISIATOR yang di-`arm()`: sisi polite hanya menunggu offer;
  kalau inisiator mati, presence-level liveness (peer-left Supabase)
  yang menghapus peer — watchdog di sisi polite akan menghasilkan
  kematian peer palsu. Restart selalu membuka jendela establishment
  baru (re-arm), berlaku juga saat pemicu reaktif (failed/disconnected).
  Bukti live: mesh e2e 6/6 beruntun hijau dengan watchdog aktif
  (koneksi nyata 3-7s, jauh di bawah ambang 15s).
- **Kapasitas room 8 orang** dipilih deterministik (urutan sessionId terkecil)
  sehingga semua klien sepakat tanpa koordinasi tambahan; pendatang ke-9+
  menerima event `room-full` lalu auto-leave.
- **Semua payload lintas jaringan divalidasi Zod** (signal, presence, posisi);
  yang gugur dilaporkan lewat event `invalid-signal`/`invalid-position` untuk
  metrik, tidak pernah diteruskan.

### Catatan desain audio (F1.4)

- **Konvensi ruang**: dunia 2D (x timur, y utara) dipetakan ke bidang x-z
  Web Audio — utara menjadi -z. Listener yaw 0 menghadap utara; suara peer
  ditempatkan via `PannerNode` HRTF dengan model jarak `inverse`
  (refDistance 1, rolloff 1) — makin jauh makin pelan, tanpa cone arah
  (voice omnidirectional).
- **Dua jalur penulisan posisi**: AudioParam modern (`positionX.value`)
  bila tersedia, fallback `setPosition`/`setOrientation` deprecated untuk
  browser lama — hasil jalur dilaporkan lewat `onApplyResult` untuk metrik.
- **Pertahanan kedua**: posisi remote dari DataChannelSync hanya divalidasi
  `finite` (bukan clamp), jadi lapisan audio meng-clamp ulang ke batas dunia
  sebelum menyentuh panner.
- **Urutan bebas**: posisi peer boleh datang sebelum track suara — disimpan
  lalu diterapkan saat `addPeerVoice` (paket posisi ~15Hz biasanya mendahului
  koneksi audio).
- **Adaptasi bitrate — DUA sumber keputusan (Task 13-b, direvisi dari F1.4
  yang hanya state-based)**: main prompt mensyaratkan "Opus 16–24 kbps,
  adaptif berbasis getStats() (packet loss, jitter)". (1) STATE koneksi:
  `BitrateAdaptation` tetap reaktif — host memanggil
  `observe(sessionId, connectionState)` dari event `peer-state`:
  `connected` → 24 kbps, `disconnected` 5 detik → 20 kbps, `failed` →
  16 kbps, pulih → naik lagi. (2) STATS jaringan (medan utama):
  host memanggil `observeStats(sessionId, {fractionLost, jitterMs})`
  dari `getStats()` — keputusan tier oleh `decideBitrateTier` MURNI dari
  MEDIAN jendela 5 sampel (median kebal spike satu-sampel = histeresis
  alami; median dihitung `percentile(…, 0.5)` type-7 dari src/lib/stats —
  satu sumber kebenaran). Ambang awal (kebijakan bisa disetel, menunggu
  telemetri): loss ≥ 8% → low; loss ≥ 3% ATAU jitter ≥ 30 ms → medium;
  di bawah itu → high. `setParameters` ditulis hanya saat tier berubah
  (Chrome tidak suka spam parameter) dan diulang bila gagal. Sender baru
  (mikrofon dipasang belakangan) dilayani lewat `applyCurrentTier`.
  Sampel korup ditolak keras (`RangeError` dari validasi murni) →
  `onError('observe-stats')`, jendela tak tercemar. Nilai tier lama F1.4
  (50k/24k/12k) BERAKHIR di 13-b — semuanya kini dalam rentang 16–24 kbps
  sesuai main prompt. Integrasi host (polling getStats berkala →
  observeStats) menunggu perakitan mesh+audio di Fase 3 — modul siap.
- **Tahan-NaN lapisan audio (Task 13-b)**: audit empiris menemukan NaN
  lolos dari `clampPosition` (Math.min/max tidak menetralkan NaN) dan
  bisa ditulis ke AudioParam dari jalur LOKAL (listener/posisi/volume
  dari host — harness/UI Fase 3 — yang tidak melewati Zod; jalur remote
  sudah dijamin finite oleh `z.number().finite()` di DataChannelSync).
  Probe Chromium (13-b): penulisan nilai non-finite ke AudioParam.value
  MELEMPAR `TypeError` keras ("The provided float value is
  non-finite") — terbukti pada gain maupun panner.positionX — jadi bug
  host satu kali NaN cukup untuk meruntuhkan graf audio. Perbaikan:
  `sanitizePosition` mengganti komponen non-finite dengan 0 (netral
  jarak, bug host terdengar jelas), `setMasterVolume` menetralkan NaN
  ke 0 di penyimpanan (unmute tidak menulis ulang gain NaN), dan
  `setYaw` MELEWATI yaw non-finite sepenuhnya (tidak ada substitusi
  netral orientasi — orientasi valid terakhir dipertahankan, tanpa
  lompatan audible).

### Catatan desain profil & snippet suara (F1.5)

- **Migrasi 0006**: kolom `profiles.voice_snippet_path` (penunjuk snippet
  aktif, constraint format satu-level `{folder}/{file}.webm`) + policy
  SELECT bucket `voice-snippets` dilonggarkan ke semua user authenticated
  (snippet = intro suara profil, memang untuk didengar member lain).
  INSERT/DELETE bucket tetap owner-only (folder-per-user).
- **Tanpa upsert**: bucket `voice-snippets` sengaja tidak punya policy
  UPDATE — snippet baru selalu path baru (`{userId}/snippet-{ts}-{rand}.webm`);
  mengganti = unggah baru → arahkan profil → hapus objek lama. Gagal hapus
  lama = non-fatal (objek orphan, tidak membocorkan apa pun, dilaporkan ke
  `onError` untuk metrik).
- **Urutan aman**: profil SELALU menunjuk objek yang ada — bila update
  profil gagal setelah upload, objek baru yang jadi orphan (bukan profil
  menunjuk objek hilang).
- **MIME dua lapis**: perekaman memilih MIME pertama yang didukung dari
  `audio/webm` / `audio/webm;codecs=opus`; header Content-Type upload selalu
  PERSIS `audio/webm` (allowed_mime_types bucket tidak menerima varian
  `;codecs=`). Validasi blob lokal (ukuran 1 B–25 MiB, MIME awalan
  `audio/webm`) terjadi sebelum menyentuh jaringan.
- **Auto-stop dua lapis**: durasi 15 detik + budget byte 25 MiB dipantau
  SELAMA perekaman (timeslice 500 ms); hasil tetap valid dengan flag
  `autoStopped` menjelaskan alasan. Semua jalur keluar (stop/cancel/error)
  menghentikan track mikropon supaya indikator mic browser tidak nyangkut.
- **Validasi dua arah**: patch profil divalidasi Zod sebelum kirim
  (whitelist kolom), baris hasil PostgREST divalidasi ulang sebelum dipakai
  — baris jahat tidak pernah diteruskan mentah.
- **Bukti kompatibilitas Supabase**: sisi storage dibuktikan level-tipe
  (klien asli assignable tanpa cast); sisi PostgREST tidak mungkin statis
  (TS2589 — generics `GetResult` atas schema `any`), jadi dibuktikan runtime
  di `type-compat.test.ts` + adapter `asProfileClient()` (cast tunggal
  terdokumentasi).

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
