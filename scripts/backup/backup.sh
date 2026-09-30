#!/usr/bin/env bash
# ============================================================================
# scripts/backup/backup.sh — backup database goofy-lobby (remediasi audit 25
# HIGH H3: zero backup; tier gratis Supabase TANPA backup otomatis — dok
# resmi: "regularly export their data using the Supabase CLI db dump command").
#
# SUMBER DATA (prioritas):
#   1. DATABASE_URL        — pg_dump langsung (conn string Postgres apa pun;
#                            di Supabase: Dashboard → Database → Connection
#                            string, pilih role READ-ONLY + pooler "Session").
#   2. SUPABASE_ACCESS_TOKEN + SUPABASE_PROJECT_REF — `supabase db dump`
#      (hanya bila CLI tersedia di PATH).
#   Salah satu jalur wajib ada; selain itu gagal keras dengan pesan jelas.
#
# OUTPUT: ${BACKUP_DIR:-./backups}/backup-<UTC YYYYmmdd-HHMMSS>.sql.gz
#   Bila AGE_RECIPIENT di-set → file dienkripsi age → .sql.gz.age (plaintext
#   DIHAPUS). Enkripsi WAJIB bila backup disimpan di tempat yang bisa dibaca
#   pihak lain (mis. artifact GitHub Actions repo publik — artifact repo
#   publik bisa diunduh user GitHub manapun; lihat ci/workflows/backup.yml).
#
# RETENSI: hapus backup lama > ${BACKUP_RETENTION_DAYS:-14} hari (hanya pola
#   nama milik script ini — file lain di direktori tidak disentuh).
#
# CATATAN: pg_dump TIDAK mencakup isi bucket Storage (file audio) — lihat
#   docs/backup-runbook.md untuk strategi ekspor storage.
#
# KELUAR: 0 sukses; non-zero gagal (pesan ke stderr). set -euo pipefail.
# ============================================================================
set -euo pipefail

BACKUP_DIR="${BACKUP_DIR:-./backups}"
RETENTION_DAYS="${BACKUP_RETENTION_DAYS:-14}"
STAMP="$(date -u +%Y%m%d-%H%M%S)"
OUT_PREFIX="${BACKUP_DIR%/}/backup-${STAMP}"

mkdir -p "${BACKUP_DIR}"

# --- pilih sumber -----------------------------------------------------------
dump_sql() {
  if [ -n "${DATABASE_URL:-}" ]; then
    echo "[backup] sumber: DATABASE_URL (pg_dump)" >&2
    # -x/--no-owner/--no-privileges: restore tidak bergantung role asal;
    # --clean kalau mau drop-before-create saat restore (tidak — restore
    # drill memakai db kosong).
    pg_dump --no-owner --no-privileges --format=plain "${DATABASE_URL}"
  elif [ -n "${SUPABASE_ACCESS_TOKEN:-}" ] && [ -n "${SUPABASE_PROJECT_REF:-}" ]; then
    if ! command -v supabase >/dev/null 2>&1; then
      echo "[backup] ERROR: supabase CLI tidak ada di PATH — pasang CLI atau set DATABASE_URL." >&2
      return 1
    fi
    echo "[backup] sumber: supabase db dump (project ${SUPABASE_PROJECT_REF})" >&2
    supabase db dump --project-ref "${SUPABASE_PROJECT_REF}"
  else
    cat >&2 <<'MSG'
[backup] ERROR: tidak ada sumber data.
Set salah satu:
  DATABASE_URL="postgresql://..."                     (pg_dump langsung)
  SUPABASE_ACCESS_TOKEN=... SUPABASE_PROJECT_REF=...  (butuh CLI supabase)
MSG
    return 1
  fi
}

# --- dump + gzip ------------------------------------------------------------
echo "[backup] mulai ${STAMP} (UTC)" >&2
if ! dump_sql | gzip -9 > "${OUT_PREFIX}.sql.gz"; then
  rm -f "${OUT_PREFIX}.sql.gz"
  echo "[backup] ERROR: dump gagal — file parsal dihapus." >&2
  exit 1
fi
PLAIN="${OUT_PREFIX}.sql.gz"
FINAL="${PLAIN}"

# --- enkripsi age (opsional lokal, WAJIB di workflow CI) --------------------
if [ -n "${AGE_RECIPIENT:-}" ]; then
  if ! command -v age >/dev/null 2>&1; then
    rm -f "${PLAIN}"
    echo "[backup] ERROR: AGE_RECIPIENT diset tapi binary age tidak ada — menolak menyimpan plaintext." >&2
    exit 1
  fi
  if ! age -r "${AGE_RECIPIENT}" -o "${PLAIN}.age" "${PLAIN}"; then
    rm -f "${PLAIN}" "${PLAIN}.age"
    echo "[backup] ERROR: enkripsi age gagal — plaintext dihapus." >&2
    exit 1
  fi
  rm -f "${PLAIN}"
  FINAL="${PLAIN}.age"
fi

# --- retensi ----------------------------------------------------------------
if [ "${RETENTION_DAYS}" -gt 0 ] 2>/dev/null; then
  # find -mtime hari (bulat ke bawah) + hanya pola milik script ini.
  find "${BACKUP_DIR}" -maxdepth 1 -type f -name 'backup-*.sql.gz' -mtime "+${RETENTION_DAYS}" -print -delete 2>/dev/null || true
  find "${BACKUP_DIR}" -maxdepth 1 -type f -name 'backup-*.sql.gz.age' -mtime "+${RETENTION_DAYS}" -print -delete 2>/dev/null || true
fi

SIZE="$(du -h "${FINAL}" | cut -f1)"
echo "[backup] selesai: ${FINAL} (${SIZE})" >&2
echo "${FINAL}"
