# Kebijakan Keamanan

> Salinan kanonik — file `.github/` tidak bisa di-commit (PAT tanpa scope
> workflow; lihat header `scripts/dev/restore-ci.mjs`). File ini
> disinkronkan ke `.github/SECURITY.md` oleh script itu.

## Versi yang didukung

Proyek ini masih dalam **pengembangan** — belum ada rilis berversi.
Perbaikan keamanan diterapkan ke branch `main` saja; belum ada versi lama
yang perlu di-patch terpisah.

| Versi                | Didukung |
| -------------------- | -------- |
| development (`main`) | ✅       |

## Melaporkan kerentanan

Gunakan **GitHub Private Vulnerability Reporting** — jangan membuka issue
publik untuk kerentanan:

1. Buka repo → tab **Security** → **Report a vulnerability**.
2. Isi deskripsi masalah + langkah reproduksi (payload/konfigurasi bila
   relevan) + commit yang terdampak bila diketahui.

> Pemilik repo: fitur ini harus **diaktifkan dulu** di
> **Settings → Code security → Private vulnerability reporting**
> (default nonaktif) — langkah tercantum di `docs/deploy-checklist.md`
> seksi GitHub.

## Cakupan

- **Di dalam cakupan**: kode di repo ini — aplikasi web (`src/`),
  migrasi SQL (`supabase/migrations/`), Edge Function, workflow CI
  (`ci/`), skrip (`scripts/`).
- **Di luar cakupan**: layanan cloud pihak ketiga (Supabase, Cloudflare,
  Paddle, Sentry) — kerentanan platform dilaporkan ke provider
  masing-masing; konfigurasi akun/layanan ditangani pemilik produk lewat
  `docs/deploy-checklist.md`.
