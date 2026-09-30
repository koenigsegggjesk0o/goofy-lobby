#!/usr/bin/env bash
# ============================================================================
# scripts/backup/restore-drill.sh — latihan pemulihan backup (remediasi audit
# 25 H3). Backup yang belum pernah di-restore BUKAN backup — drill kuartalan
# memastikan file bisa dipulihkan + data inti utuh.
#
# PEMAKAIAN:
#   bash scripts/backup/restore-drill.sh <file-backup> <DATABASE_URL_STAGING>
#     <file-backup>       : backup-*.sql.gz atau backup-*.sql.gz.age
#     <DATABASE_URL_STAGING>: Postgres KOSONG/korban-latihan (BUKAN produksi!)
#                             — drill MENIMPA isinya.
#   Env tambahan utk file .age: AGE_IDENTITY (file kunci privat, atau string
#   "AGE-SECRET-KEY-1...").
#
# SANITY CHECK pasca-restore: row count tabel inti (profiles, messages,
# friendships, blocks, rooms) dicetak; exit non-zero bila psql error atau
# tabel inti tidak ada.
#
# KELUAR: 0 sukses; non-zero gagal. set -euo pipefail.
# ============================================================================
set -euo pipefail

if [ "$#" -lt 2 ]; then
  echo "pemakaian: $0 <file-backup> <DATABASE_URL_STAGING>" >&2
  exit 2
fi

BACKUP_FILE="$1"
STAGING_URL="$2"

if [ ! -f "${BACKUP_FILE}" ]; then
  echo "[drill] ERROR: file backup tidak ada: ${BACKUP_FILE}" >&2
  exit 1
fi

# --- dekripsi bila perlu ------------------------------------------------------
SQL_PIPE=(cat)
TMP_DECRYPTED=""
if [[ "${BACKUP_FILE}" == *.age ]]; then
  if ! command -v age >/dev/null 2>&1; then
    echo "[drill] ERROR: file terenkripsi age tapi binary age tidak ada." >&2
    exit 1
  fi
  if [ -z "${AGE_IDENTITY:-}" ]; then
    echo "[drill] ERROR: file .age memerlukan env AGE_IDENTITY (path kunci privat)." >&2
    exit 1
  fi
  TMP_DECRYPTED="$(mktemp -t goofy-drill-XXXXXX).sql.gz"
  age --decrypt -i "${AGE_IDENTITY}" -o "${TMP_DECRYPTED}" "${BACKUP_FILE}"
  BACKUP_FILE="${TMP_DECRYPTED}"
fi
trap '[ -n "${TMP_DECRYPTED:-}" ] && rm -f "${TMP_DECRYPTED}"' EXIT

# --- restore ------------------------------------------------------------------
echo "[drill] restore ${BACKUP_FILE} → staging…" >&2
if ! gunzip -c "${BACKUP_FILE}" | psql "${STAGING_URL}" --set ON_ERROR_STOP=1 --quiet; then
  echo "[drill] ERROR: psql gagal — restore tidak bersih." >&2
  exit 1
fi

# --- sanity row count tabel inti ------------------------------------------------
echo "[drill] sanity row count tabel inti:" >&2
FAIL=0
for T in public.profiles public.messages public.friendships public.blocks public.rooms; do
  COUNT="$(psql "${STAGING_URL}" --tuples-only --no-align --quiet -c "select count(*) from ${T}" 2>/dev/null || echo "MISSING")"
  if [ "${COUNT}" = "MISSING" ]; then
    echo "  ✗ ${T}: TABEL TIDAK ADA" >&2
    FAIL=1
  else
    echo "  ✓ ${T}: ${COUNT} baris" >&2
  fi
done

if [ "${FAIL}" -eq 1 ]; then
  echo "[drill] GAGAL — tabel inti hilang; backup tidak valid utk restore penuh." >&2
  exit 1
fi
echo "[drill] SUKSES — backup terverifikasi bisa dipulihkan." >&2
