/**
 * Jejak breadcrumb LOKAL berbatas ukuran (Task 10-a) — pola QA-instrumentasi
 * yang sama dengan `meshLog` di harness: `addTrail` tetap teramati TANPA
 * DSN Sentry (SDK belum init → addBreadcrumb no-op di SDK), menutup celah
 * kejujuran Task 8-g ("breadcrumb tidak bisa diverifikasi live tanpa DSN").
 *
 * - Ring FIFO: maksimum TRAIL_LOG_LIMIT entri — entri terlama dibuang
 *   (breadcrumb = konteks TERAKHIR sebelum error, bukan dump penuh).
 * - `getTrailLog()` mengembalikan snapshot (copy) — mutasi hasil tidak
 *   mengubah state internal.
 * - Bukan UI produk: infrastruktur monitoring/harness (F1.8/F1.6).
 */

/** Jumlah entri trail lokal maksimum yang disimpan (ring FIFO). */
export const TRAIL_LOG_LIMIT = 50;

/** Level trail — sama dengan level breadcrumb addTrail. */
export type TrailLogLevel = 'info' | 'error';

/** Satu entri jejak breadcrumb (snapshot pemanggilan addTrail). */
export interface TrailLogEntry {
  /** Waktu addTrail dipanggil (ISO 8601). */
  at: string;
  message: string;
  category: string;
  level: TrailLogLevel;
  data?: Record<string, unknown>;
}

const entries: TrailLogEntry[] = [];

/**
 * Menambahkan entri trail lokal (dipanggil addTrail SEBELUM menyentuh SDK —
 * jejak tetap tercatat walau SDK melempar/belum init).
 * `data` di-shallow-copy supaya mutasi objek pemanggil setelahnya tidak
 * mengubah entri yang sudah terekam.
 */
export function pushTrailLog(
  message: string,
  data: Record<string, unknown> | undefined,
  category: string,
  level: TrailLogLevel,
): TrailLogEntry {
  const entry: TrailLogEntry = {
    at: new Date().toISOString(),
    message,
    category,
    level,
    ...(data === undefined ? {} : { data: { ...data } }),
  };
  entries.push(entry);
  if (entries.length > TRAIL_LOG_LIMIT) {
    entries.splice(0, entries.length - TRAIL_LOG_LIMIT);
  }
  return entry;
}

/**
 * Snapshot trail terakhir (maksimum TRAIL_LOG_LIMIT) — entri di-clone satu
 * level (termasuk `data`), jadi mutasi hasil tidak pernah mengubah state
 * internal ring. (array.slice saja TIDAK cukup — objek entri masih shared;
 * tertangkap unit test 10-a.)
 */
export function getTrailLog(): TrailLogEntry[] {
  return entries.map((entry) => ({
    ...entry,
    ...(entry.data === undefined ? {} : { data: { ...entry.data } }),
  }));
}

/** Mengosongkan ring (khusus isolasi test — bukan jalur produk). */
export function __resetTrailLogForTests(): void {
  entries.length = 0;
}
