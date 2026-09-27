/**
 * Pemetaan event mesh → breadcrumb monitoring (Task 8-g) — murni, tanpa
 * akses SDK/env/efek samping, jadi sepenuhnya unit-testable.
 *
 * Dipakai test-harness (F1.6): setiap event siklus mesh (peer-joined,
 * peer-left, peer-state, error, …) juga dikirim sebagai breadcrumb lewat
 * addTrail supaya error yang tertangkap Sentry membawa jejak konteks mesh
 * terakhir (join/leave/peer/restart) — bukan cuma stack trace kosong.
 *
 * Batas ukuran eksplisit (breadcrumb = konteks, bukan dump penuh):
 * pesan ≤ MESH_TRAIL_MESSAGE_MAX_CHARS karakter; nilai ≤
 * MESH_TRAIL_VALUE_MAX_CHARS (objek di-serial jadi teks dulu — objek
 * sirkular TIDAK boleh melempar); maksimum MESH_TRAIL_DETAIL_MAX_KEYS
 * entri (sisanya dihitung di `detailKeysDropped`).
 */

/** Panjang maksimum pesan breadcrumb (nama event + prefix). */
export const MESH_TRAIL_MESSAGE_MAX_CHARS = 64;
/** Panjang maksimum nilai per entri (karakter, setelah serial bila perlu). */
export const MESH_TRAIL_VALUE_MAX_CHARS = 256;
/** Jumlah entri detail maksimum (kunci berlebih dibuang, dihitung). */
export const MESH_TRAIL_DETAIL_MAX_KEYS = 8;

/** Level breadcrumb — event 'error' dinaikkan ke 'error', sisanya 'info'. */
export type MeshTrailLevel = 'info' | 'error';

export interface MeshTrail {
  message: string;
  category: 'mesh';
  level: MeshTrailLevel;
  data: { event: string; detail?: Record<string, unknown>; detailKeysDropped?: number };
}

function clampString(text: string, maxChars: number): string {
  return text.length <= maxChars
    ? text
    : `${text.slice(0, maxChars)}…(terpotong, ${text.length} chars)`;
}

/**
 * Nilai aman-breadcrumb: primitif diteruskan (string dipangkas), objek
 * di-serial ke teks (sirkular → String() fallback, tidak pernah melempar),
 * tipe eksotis (function/symbol/bigint/undefined) jadi bentuk teksnya.
 */
function toTrailValue(value: unknown): string | number | boolean | null {
  switch (typeof value) {
    case 'number':
    case 'boolean':
      return value;
    case 'string':
      return clampString(value, MESH_TRAIL_VALUE_MAX_CHARS);
    case 'object': {
      if (value === null) return null;
      let serialized: string;
      try {
        serialized = JSON.stringify(value) ?? String(value);
      } catch {
        // Objek sirkular: JSON.stringify melempar — fallback aman.
        serialized = String(value);
      }
      return clampString(serialized, MESH_TRAIL_VALUE_MAX_CHARS);
    }
    default:
      return clampString(String(value), MESH_TRAIL_VALUE_MAX_CHARS);
  }
}

/**
 * Memetakan (event, detail) mesh menjadi breadcrumb siap addTrail.
 * - event kosong/whitespace → 'unknown' (tetap tercatat, tidak hilang).
 * - event 'error' → level 'error'; lainnya 'info'.
 * - detail kosong → kunci `detail` dihilangkan (breadcrumb ringkas).
 */
export function meshTrail(event: string, detail: Record<string, unknown>): MeshTrail {
  const name = event.trim() === '' ? 'unknown' : event.trim();
  const message = clampString(`mesh ${name}`, MESH_TRAIL_MESSAGE_MAX_CHARS);
  const level: MeshTrailLevel = name === 'error' ? 'error' : 'info';

  const entries = Object.entries(detail);
  const included = entries.slice(0, MESH_TRAIL_DETAIL_MAX_KEYS);
  const dropped = entries.length - included.length;

  const data: MeshTrail['data'] = { event: name };
  if (included.length > 0) {
    const mapped: Record<string, unknown> = {};
    for (const [key, value] of included) {
      mapped[key] = toTrailValue(value);
    }
    data.detail = mapped;
  }
  if (dropped > 0) {
    data.detailKeysDropped = dropped;
  }
  return { message, category: 'mesh', level, data };
}
