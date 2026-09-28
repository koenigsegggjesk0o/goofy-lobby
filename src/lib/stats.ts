/**
 * Statistik distribusi angka MURNI (tanpa import, tanpa efek samping) —
 * SATU sumber kebenaran bagi alat pengukuran durasi proyek:
 * - scripts/dev/probe-webrtc.mjs — distribusi waktu establishment ICE
 *   (kalibrasi ambang watchdog 8-c);
 * - scripts/dev/e2e-stress.mjs — metodologi distribusi 8-f (durasi siklus
 *   e2e per spec).
 *
 * Tidak ada konsumen bundle browser saat ini — modul sengaja hidup di
 * src/lib supaya tunduk pada gerbang yang sama dengan kode produksi
 * (tsc strict + eslint + vitest), bukan JS lepas tanpa jaring pengaman;
 * Vite tidak akan menyertakannya di bundle selama tidak ada yang
 * mengimpornya dari jalur aplikasi.
 *
 * Metode persentil: interpolasi LINEAR "type 7" (default numpy.percentile
 * dan R quantile) atas salinan terurut:
 *   rank = (n − 1) · p
 *   nilai = v[floor(rank)] + (rank − floor(rank)) · (v[ceil(rank)] − v[floor(rank)])
 * Konsekuensi yang disengaja: p50 SELALU sama dengan median standar
 * (termasuk rata-rata dua nilai tengah saat n genap), p0 = min, p1 = max.
 *
 * stdev: standar deviasi SAMPEL (penyebut n − 1, koreksi Bessel) untuk
 * n ≥ 2; n = 1 → 0 — satu titik data memang tidak menyebar, dan 0 dipilih
 * agar tipe tetap number (NaN akan menjalar diam-diam ke tampilan).
 *
 * Validasi fail-fast: masukan kosong / tak-hingga (NaN, ±Infinity) dan
 * persentil di luar [0, 1] melempar RangeError — data korup harus terdengar
 * keras, bukan diam-diam menggeser mean/persentil.
 */

/** Ringkasan distribusi satu gugus angka. */
export interface DistributionStats {
  n: number;
  min: number;
  max: number;
  mean: number;
  median: number;
  stdev: number;
  p50: number;
  p75: number;
  p90: number;
  p95: number;
  p99: number;
}

/**
 * Baca elemen array terurut pada indeks — helper narrow tanpa non-null
 * assertion (konvensi proyek: helper yang throw bila invariant dilanggar).
 * Invariant pemanggil: 0 ≤ index < sorted.length (dijaga validasi p ∈ [0,1]
 * sebelum rank dihitung).
 */
function at(sorted: readonly number[], index: number): number {
  const value = sorted[index];
  if (value === undefined) {
    throw new Error(`indeks ${index} di luar jangkauan array terurut (internal)`);
  }
  return value;
}

/** Validasi gugus angka: tidak kosong dan seluruhnya hingga (finite). */
function assertValidValues(values: readonly number[]): void {
  if (values.length === 0) {
    throw new RangeError('gugus angka kosong — tidak ada distribusi yang bisa diringkas');
  }
  for (const value of values) {
    if (!Number.isFinite(value)) {
      throw new RangeError(
        `nilai tak-hingga ditemui (${String(value)}) — data korup harus ditolak keras`,
      );
    }
  }
}

/** Validasi persentil p: angka hingga dalam [0, 1]. */
function assertValidPercentile(p: number): void {
  if (!Number.isFinite(p) || p < 0 || p > 1) {
    throw new RangeError(`persentil harus angka 0..1, diterima: ${String(p)}`);
  }
}

/**
 * Persentil atas array SUDAH TERURUT naik (internal — tanpa validasi
 * ulang; pemanggil publik memvalidasi dulu). Metode type 7 lihat header
 * modul.
 */
function percentileOfSorted(sorted: readonly number[], p: number): number {
  const rank = (sorted.length - 1) * p;
  const lo = Math.floor(rank);
  const hi = Math.ceil(rank);
  const vLo = at(sorted, lo);
  if (lo === hi) return vLo;
  return vLo + (rank - lo) * (at(sorted, hi) - vLo);
}

/**
 * Persentil ke-p·100 dari gugus angka (urutan masukan bebas — diurutkan
 * pada SALINAN, masukan tidak pernah dimutasi). Contoh: p = 0.9 → p90.
 */
export function percentile(values: readonly number[], p: number): number {
  assertValidPercentile(p);
  assertValidValues(values);
  const sorted = [...values].sort((a, b) => a - b);
  return percentileOfSorted(sorted, p);
}

/**
 * Ringkasan lengkap distribusi: n, min/max, mean, median, stdev sampel,
 * dan persentil p50/p75/p90/p95/p99 (type 7). Melempar RangeError untuk
 * gugus kosong atau berisi nilai tak-hingga.
 */
export function summarizeNumbers(values: readonly number[]): DistributionStats {
  assertValidValues(values);
  const sorted = [...values].sort((a, b) => a - b);
  const n = sorted.length;
  const min = at(sorted, 0);
  const max = at(sorted, n - 1);
  const mean = sorted.reduce((sum, value) => sum + value, 0) / n;

  let stdev = 0;
  if (n >= 2) {
    const sumSq = sorted.reduce((sum, value) => sum + (value - mean) ** 2, 0);
    stdev = Math.sqrt(sumSq / (n - 1));
  }

  return {
    n,
    min,
    max,
    mean,
    median: percentileOfSorted(sorted, 0.5),
    stdev,
    p50: percentileOfSorted(sorted, 0.5),
    p75: percentileOfSorted(sorted, 0.75),
    p90: percentileOfSorted(sorted, 0.9),
    p95: percentileOfSorted(sorted, 0.95),
    p99: percentileOfSorted(sorted, 0.99),
  };
}
