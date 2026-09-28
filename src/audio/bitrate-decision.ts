import { percentile } from '../lib/stats';
import type { BitrateTier } from './types';

/**
 * Keputusan tier bitrate dari sampel statistik jaringan — MURNI, dipakai
 * BitrateAdaptation.observeStats (Task 13-b; main prompt: "adaptif berbasis
 * getStats() (packet loss, jitter)").
 *
 * Sumber sampel (kontrak host): metrik `fractionLost` (0..1, bidang
 * RTCStats inbound-rtp/outbound-rtp) dan `jitter` yang dikonversi host ke
 * milidetik (RTCStats menyimpan detik). Host memanggil observeStats secara
 * berkala untuk peer yang terhubung; modul ini tidak berlangganan apa pun.
 *
 * Metode: MEDIAN atas jendela sampel (bukan rata-rata/nilai instan) —
 * median kebal spike satu-sampel sehingga menjadi histeresis alami: satu
 * burst loss sesaat tidak menurunkan tier, dan pemulihan sesaat tidak
 * menaikkannya. Median dihitung lewat percentile(…, 0.5) dari
 * src/lib/stats.ts (type 7 — SATU sumber kebenaran, teruji unit).
 *
 * Ambang awal (angka kebijakan — SENGAJA konstanta yang bisa disetel,
 * belum ada data produksi; kalibrasi menunggu telemetri nyata):
 * - median loss ≥ 8%        → 'low'   (darurat: prioritas keberlanjutan)
 * - median loss ≥ 3% ATAU median jitter ≥ 30 ms → 'medium' (terdegradasi)
 * - di bawah itu semua      → 'high'  (sehat)
 */

/** Satu sampel metrik jaringan untuk sebuah peer. */
export interface BitrateStatsSample {
  /** Fraksi paket hilang 0..1 (RTCStats fractionLost). */
  fractionLost: number;
  /** Jitter dalam milidetik (RTCStats jitter [detik] × 1000). */
  jitterMs: number;
}

/** Jumlah sampel minimum sebelum keputusan dibuat (median butuh basis). */
export const MIN_STATS_SAMPLES = 3;

/** Ambang median fractionLost untuk tier 'medium'. */
export const STATS_LOSS_MEDIUM = 0.03;

/** Ambang median fractionLost untuk tier 'low'. */
export const STATS_LOSS_LOW = 0.08;

/** Ambang median jitter (ms) untuk tier 'medium'. */
export const STATS_JITTER_MEDIUM_MS = 30;

/**
 * Validasi satu sampel — korup ditolak keras (RangeError, konvensi
 * src/lib/stats.ts): data jaringan yang salah bentuk harus terdengar,
 * bukan diam-diam menggeser keputusan bitrate.
 */
export function assertValidStatsSample(sample: BitrateStatsSample): void {
  if (!Number.isFinite(sample.fractionLost) || sample.fractionLost < 0 || sample.fractionLost > 1) {
    throw new RangeError(`fractionLost harus angka 0..1, diterima: ${String(sample.fractionLost)}`);
  }
  if (!Number.isFinite(sample.jitterMs) || sample.jitterMs < 0) {
    throw new RangeError(`jitterMs harus angka ≥ 0, diterima: ${String(sample.jitterMs)}`);
  }
}

/**
 * Menentukan tier dari jendela sampel (urutan bebas). Mengembalikan null
 * bila sampel belum cukup (MIN_STATS_SAMPLES) — "belum tahu" lebih jujur
 * daripada menebak sehat. Melempar RangeError bila ada sampel korup.
 */
export function decideBitrateTier(samples: readonly BitrateStatsSample[]): BitrateTier | null {
  if (samples.length < MIN_STATS_SAMPLES) {
    return null;
  }
  for (const sample of samples) {
    assertValidStatsSample(sample);
  }
  const lossMedian = percentile(
    samples.map((sample) => sample.fractionLost),
    0.5,
  );
  const jitterMedian = percentile(
    samples.map((sample) => sample.jitterMs),
    0.5,
  );
  if (lossMedian >= STATS_LOSS_LOW) {
    return 'low';
  }
  if (lossMedian >= STATS_LOSS_MEDIUM || jitterMedian >= STATS_JITTER_MEDIUM_MS) {
    return 'medium';
  }
  return 'high';
}
