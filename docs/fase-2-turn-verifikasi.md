# Runbook: Verifikasi TURN Fase 2 (relay-forced)

> Tujuan: **membuktikan TURN sungguh-sangguh merelay traffic** — bukan
> sekadar "terpasang di konfigurasi". Kandidat relay yang terkumpul bukan
> bukti; pasangan kandidat TERPILIH (selected pair) yang bertipe `relay`
> pada koneksi aktif adalah buktinya.

## Prasyarat

1. `VITE_TURN_URL` / `VITE_TURN_USERNAME` / `VITE_TURN_CREDENTIAL` terisi
   di `.env` (grup "TURN Fase 2" — lihat `.env.example`). Kredensial
   Metered dari dashboard Anda.
2. `bun run doctor` — grup TURN harus menampilkan lengkap 3/3.

## Langkah

```bash
bun run probe:webrtc --turn
```

Apa yang dilakukannya:

- Membaca ketiga var TURN dari environment (bun memuat `.env` otomatis).
- Memvalidasi lewat `parseTurnEnv` — **modul yang sama** dengan yang
  dipakai mesh asli (satu sumber kebenaran, `src/webrtc/turn-config.ts`).
- Menjalankan dua konteks browser terisolasi dengan
  `iceTransportPolicy: "relay"` di KEDUA peer: koneksi **hanya mungkin**
  bila TURN benar-benar merelay (jalur host/srflx dimatikan paksa).
- Mencetak pasangan kandidat terpilih per run + ringkasan akhir.

**Nilai kredensial tidak pernah dicetak** — hanya status dan alasan
validasi.

## Interpretasi hasil

| Output akhir                                                                            | Arti                                                                                                                            |
| --------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| `TURN RELAY TERVERIFIKASI ✅ — N/N run tersambung dgn pasangan terpilih relay` + exit 0 | TURN terbukti end-to-end: koneksi hidup DAN jalurnya relay.                                                                     |
| `TURN TIDAK terverifikasi ❌` + exit 1, kandidat relay tidak muncul sama sekali         | TURN server tidak terjangkau / kredensial ditolak. Periksa: URL+port benar, whitelist IP bila ada, kredensial belum kadaluarsa. |
| `TURN: invalid — konfigurasi tidak sah` + daftar alasan                                 | Env salah isi (skema bukan `turn:`/`turns:`, atau setengah terisi). Alasan per variabel tercetak.                               |
| `TURN: disabled — env kosong`                                                           | Ketiga var belum diisi. Tidak ada yang bisa diverifikasi.                                                                       |

Diagnosa tambahan bila gagal: log per-run menampilkan setiap kandidat yang
terkumpul (baris `A relay: candidate:...`). Nol baris relay = server tidak
merespons allocation. Ada kandidat relay tapi gagal connect = kredensial
allocation ditolak atau jalur terblokir.

## Catatan

- Mode `--runs N` berlaku juga untuk `--turn` (distribusi durasi N run).
- Mode normal (tanpa `--turn`) tetap tersedia sebagai diagnostik ICE biasa
  (host/mDNS/srflx + waktu establishment) — dan kini juga melaporkan
  pasangan terpilih, contoh: `A=host B=host (state=succeeded nominated=true)`.
- Exit code bermakna: 0 = sukses sesuai mode (`--turn`: SEMUA run relay;
  normal: minimal satu run tersambung), 1 = gagal sesuai ketentuan mode —
  bisa dipakai di script/CI.
- Mesh asli memakai konfigurasi yang SAMA via `resolveIceServers` (Task
  8-d) — probe ini adalah alat verifikasi terisolasi atas jalur tersebut.
- Kredensial TURN statis memang sampai ke bundle klien (VITE_*) — sudah
  didokumentasikan di catatan desain 8-b; itu karakteristik TURN credential
  statis, bukan kebocoran.

## Status verifikasi saat dokumen ini ditulis (Task 11-a)

- Jalur `disabled` / `invalid` / `enabled` — terverifikasi live di sandbox
  (lihat worklog 11-a). Untuk jalur `enabled`, digunakan TURN publik
  openrelay (kredensial publik milik proyek openrelay, via env inline,
  tidak dipersist) — host tersebut ternyata TIDAK terjangkau dari jaringan
  sandbox (TCP timeout; DNS normal; metered.ca utama 200 OK), sehingga
  koneksi relay gagal dan dilaporkan jujur `TURN TIDAK terverifikasi ❌`
  exit 1 — perilaku yang BENAR untuk "server tak terjangkau".
- Bukti penuh `relay ✅` menunggu kredensial Metered Anda: isi env →
  `bun run doctor` → `bun run probe:webrtc --turn`.
