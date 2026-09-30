# Backup & Recovery Runbook — goofy-lobby

> Remediasi audit keamanan Task 25 **HIGH H3**: tidak ada mekanisme backup apa
> pun di proyek; tier gratis Supabase **TIDAK menyediakan backup otomatis**
> (dok resmi: _"regularly export their data using the Supabase CLI db dump
> command"_). Riwayat 6× reset sandbox destruktif di lingkungan dev memperbesar
> likelihood kehilangan data — runbook ini menutup risiko sisi database.

## 1. Komponen

| Komponen                                                   | Lokasi | Fungsi                                                                                   |
| ---------------------------------------------------------- | ------ | ---------------------------------------------------------------------------------------- |
| `scripts/backup/backup.sh`                                 | repo   | dump → gzip → (opsional) enkripsi age → retensi                                          |
| `scripts/backup/restore-drill.sh`                          | repo   | latihan pemulihan ke db staging + sanity row-count                                       |
| `ci/workflows/backup.yml` → `.github/workflows/backup.yml` | repo   | jadwal harian 02:30 WIB via GitHub Actions (aktif setelah secrets diisi + file ter-push) |

## 2. Variabel lingkungan (kontrak)

| Env                                              | Wajib?           | Keterangan                                                                                                                                                                      |
| ------------------------------------------------ | ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `DATABASE_URL`                                   | jalur utama      | conn string Postgres (di Supabase: Dashboard → Project Settings → Database → Connection string; **buat role khusus read-only** untuk backup, jangan pakai `postgres` superuser) |
| `SUPABASE_ACCESS_TOKEN` + `SUPABASE_PROJECT_REF` | jalur alternatif | `supabase db dump` (butuh CLI di PATH)                                                                                                                                          |
| `AGE_RECIPIENT`                                  | wajib di CI      | publik key `age` (penerima enkripsi). Artifact repo **publik** dapat diunduh user GitHub manapun → enkripsi WAJIB                                                               |
| `BACKUP_DIR`                                     | opsional         | default `./backups`                                                                                                                                                             |
| `BACKUP_RETENTION_DAYS`                          | opsional         | default `14`                                                                                                                                                                    |

Output: `backups/backup-<UTC-stamp>.sql.gz` atau `.sql.gz.age` (terenkripsi).

## 3. Penjadwalan

**GitHub Actions** (disarankan, sudah tersedia): isi secrets `DATABASE_URL`
(read-only role!) + `AGE_RECIPIENT` di repo → workflow `backup.yml` berjalan
`30 19 * * *` UTC (02:30 WIB). Workflow **memverifikasi** file berekstensi
`.age` sebelum upload artifact — menolak menyimpan plaintext.

**Cron server alternatif** (bila tidak ingin backup lewat GitHub):

```cron
30 2 * * * cd /srv/goofy-lobby && \
  DATABASE_URL='postgresql://backup_ro:...' AGE_RECIPIENT='age1...' \
  bash scripts/backup/backup.sh >> /var/log/goofy-backup.log 2>&1
```

## 4. Penanganan kunci age

1. `age-keygen -o backups.key` → `age1...` (publik) + `AGE-SECRET-KEY-1...` (privat).
2. Publik key → `AGE_RECIPIENT` (env/secret CI). Privat key → **di luar repo**
   (password manager / vault). Tanpa privat key backup TIDAK bisa dibaca —
   simpan 2 salinan (mis. vault + offline).
3. Rotasi kunci: buat pasangan baru → backup baru otomatis memakai recipient
   baru → setelah retensi lama habis (default 14 hari), pensiunkan kunci lama.

## 5. Restore drill (KUARTALAN — wajib)

Backup yang belum pernah di-restore bukan backup. Prosedur:

```bash
# 1. Siapkan db staging KOSONG (bukan produksi!)
#    (mis. db docker lokal / project Supabase staging)
AGE_IDENTITY=/path/ke/backups.key \
  bash scripts/backup/restore-drill.sh backups/backup-XXXX.sql.gz.age \
  "postgresql://user:pass@localhost:5432/goofy_drill"
# 2. Script: dekripsi → gunzip → psql ON_ERROR_STOP → sanity row-count
#    (profiles, messages, friendships, blocks, rooms) → exit non-zero bila gagal.
```

Catat hasil drill (tanggal + row counts) di tiket/log tim. Bila restore gagal
→ anggap seluruh jendela retensi rusak → perbaiki sebelum menghapus backup lama.

## 6. Yang TIDAK tercakup pg_dump

`pg_dump` hanya mencakup **database**. **Isi bucket Storage** (file audio
voice-snippet + soundboard) TIDAK ikut. Sampai skrip ekspor storage dibuat:

- Eksport manual berkala: Dashboard → Storage → bucket → Download (feasible
  untuk volume kecil), atau `rclone`/skrip REST `storage.list` + download per
  objek (backlog: `scripts/backup/export-storage.sh`).
- Konsol: profile voice snippet per-user ≤ 5 file × 25 MiB, custom sound ≤ 30 ×
  5 MiB (batas quota layanan) — maksimum teoretis per user 100 MiB + 150 MiB.
- Konfigurasi **Supabase Auth users / dashboard settings** juga di luar
  pg_dump (auth.users ikut; konfigurasi provider/OAuth tidak).

## 7. Runbook rotasi service_role key

Kunci `SUPABASE_SERVICE_ROLE_KEY` dipakai Edge Functions (paddle-webhook,
account-erasure) — bila terindikasi bocor:

1. **Putuskan akses lama dulu bila darurat**: Supabase Dashboard → Settings →
   API → _Regenerate_ `service_role` (semua konsumen langsung mati).
2. Perbarui semua konsumen (urutan bebas, lalu verifikasi):
   - `supabase secrets set SUPABASE_SERVICE_ROLE_KEY=...` (berlaku untuk SEMUA
     functions), redeploy tidak perlu — secrets dibaca per-invocation.
   - GitHub secrets terkait (tidak ada yang memakai service_role hari ini;
     `DATABASE_URL` backup pakai role read-only terpisah).
   - Env lokal developer (JANGAN pernah commit — `.env` ter-gitignore).
3. Verifikasi: kirim `curl` test ke paddle-webhook (signature salah → 401),
   panggil turn-credentials tanpa JWT → 401.
4. Tulis insiden: rentang waktu pemakaian kunci lama (Dashboard → Logs →
   API/Functions), daftar operasi service_role di jendela itu.

## 8. Ekspektasi RTO/RPO

- **RPO**: 24 jam (jadwal harian). Butu lebih ketat? Naikkan frekuensi workflow
  (biaya: artifact lebih banyak; retensi 14 hari menjaga plafon).
- **RTO**: lama waktu `restore-drill.sh` + deploy ulang aplikasi (target < 1
  jam untuk dataset fase ini — database < 500 MB tier gratis).
