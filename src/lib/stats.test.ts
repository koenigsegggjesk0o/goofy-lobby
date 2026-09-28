import { describe, expect, it } from 'vitest';
import { percentile, summarizeNumbers } from './stats';
import type { DistributionStats } from './stats';

/**
 * Acuan dihitung TANGAN (metode type 7 — lihat header stats.ts):
 * dataset 1..10 (n=10, terurut):
 *   rank(p) = 9p → p50: 4.5 → 5.5 | p75: 6.75 → 7.75 | p90: 8.1 → 9.1
 *   p95: 8.55 → 9.55 | p99: 8.91 → 9.91
 *   stdev sampel = sqrt(Σ(v−5.5)²/9) = sqrt(82.5/9)
 */
const ONE_TO_TEN = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];

describe('percentile', () => {
  it('p0 = min dan p1 = max (batas interval valid)', () => {
    expect(percentile(ONE_TO_TEN, 0)).toBe(1);
    expect(percentile(ONE_TO_TEN, 1)).toBe(10);
  });

  it('dataset 1..10 — p50/p75/p90/p95/p99 hasil interpolasi type 7', () => {
    expect(percentile(ONE_TO_TEN, 0.5)).toBeCloseTo(5.5, 10);
    expect(percentile(ONE_TO_TEN, 0.75)).toBeCloseTo(7.75, 10);
    expect(percentile(ONE_TO_TEN, 0.9)).toBeCloseTo(9.1, 10);
    expect(percentile(ONE_TO_TEN, 0.95)).toBeCloseTo(9.55, 10);
    expect(percentile(ONE_TO_TEN, 0.99)).toBeCloseTo(9.91, 10);
  });

  it('n genap: p50 = rata-rata dua nilai tengah; interpolasi fraksional', () => {
    // [10,20,30,40]: rank(0.5)=1.5 → 25; rank(0.9)=2.7 → 30+0.7·10=37; rank(0.25)=0.75 → 17.5
    expect(percentile([10, 20, 30, 40], 0.5)).toBeCloseTo(25, 10);
    expect(percentile([10, 20, 30, 40], 0.9)).toBeCloseTo(37, 10);
    expect(percentile([10, 20, 30, 40], 0.25)).toBeCloseTo(17.5, 10);
  });

  it('urutan masukan bebas — hasil sama dengan masukan terurut', () => {
    const shuffled = [9, 1, 7, 3, 5, 10, 2, 8, 4, 6];
    expect(percentile(shuffled, 0.9)).toBeCloseTo(percentile(ONE_TO_TEN, 0.9), 10);
    expect(percentile(shuffled, 0.5)).toBeCloseTo(percentile(ONE_TO_TEN, 0.5), 10);
  });

  it('konsisten dengan summarizeNumbers (p90 jalur yang sama)', () => {
    const values = [130, 42, 999, 7, 256, 88];
    expect(percentile(values, 0.9)).toBe(summarizeNumbers(values).p90);
  });

  it('p di luar [0,1] atau tak-hingga → RangeError', () => {
    for (const bad of [-0.1, 1.1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => percentile([1, 2, 3], bad)).toThrow(RangeError);
    }
  });

  it('gugus kosong → RangeError', () => {
    expect(() => percentile([], 0.5)).toThrow(RangeError);
  });

  it('nilai tak-hingga dalam gugus → RangeError (data korup ditolak keras)', () => {
    expect(() => percentile([1, Number.NaN, 3], 0.5)).toThrow(RangeError);
    expect(() => percentile([1, Number.POSITIVE_INFINITY], 0.5)).toThrow(RangeError);
    expect(() => percentile([Number.NEGATIVE_INFINITY, 2], 0.5)).toThrow(RangeError);
  });

  it('masukan TIDAK dimutasi (pengurutan pada salinan)', () => {
    const input = [30, 10, 20];
    const snapshot = [...input];
    percentile(input, 0.9);
    expect(input).toEqual(snapshot);
  });
});

describe('summarizeNumbers', () => {
  it('dataset 1..10 — seluruh bidang ringkasan', () => {
    const s = summarizeNumbers(ONE_TO_TEN);
    expect(s.n).toBe(10);
    expect(s.min).toBe(1);
    expect(s.max).toBe(10);
    expect(s.mean).toBeCloseTo(5.5, 10);
    expect(s.median).toBeCloseTo(5.5, 10);
    expect(s.p50).toBeCloseTo(5.5, 10);
    expect(s.p75).toBeCloseTo(7.75, 10);
    expect(s.p90).toBeCloseTo(9.1, 10);
    expect(s.p95).toBeCloseTo(9.55, 10);
    expect(s.p99).toBeCloseTo(9.91, 10);
    expect(s.stdev).toBeCloseTo(Math.sqrt(82.5 / 9), 10);
  });

  it('n ganjil tak terurut [3,1,2] — median/mean/stdev sampel', () => {
    const s = summarizeNumbers([3, 1, 2]);
    expect(s.n).toBe(3);
    expect(s.min).toBe(1);
    expect(s.max).toBe(3);
    expect(s.mean).toBe(2);
    expect(s.median).toBe(2);
    // Σ(v−2)² = 1+0+1 = 2; sampel: sqrt(2/2) = 1
    expect(s.stdev).toBeCloseTo(1, 10);
    expect(s.p90).toBeCloseTo(2.8, 10);
  });

  it('n = 1 — semua statistik = nilai itu, stdev 0 (bukan NaN)', () => {
    const s = summarizeNumbers([42]);
    expect(s.n).toBe(1);
    expect(s.min).toBe(42);
    expect(s.max).toBe(42);
    expect(s.mean).toBe(42);
    expect(s.median).toBe(42);
    expect(s.p50).toBe(42);
    expect(s.p99).toBe(42);
    expect(s.stdev).toBe(0);
  });

  it('n = 2 [1,2] — median rata-rata, stdev sampel sqrt(0.5)', () => {
    const s = summarizeNumbers([1, 2]);
    expect(s.median).toBeCloseTo(1.5, 10);
    // Σ(v−1.5)² = 0.25+0.25 = 0.5; sampel: sqrt(0.5/1)
    expect(s.stdev).toBeCloseTo(Math.sqrt(0.5), 10);
  });

  it('duplikat penuh [5,5,5,5] — dispersi nol', () => {
    const s = summarizeNumbers([5, 5, 5, 5]);
    expect(s.min).toBe(5);
    expect(s.max).toBe(5);
    expect(s.mean).toBe(5);
    expect(s.p95).toBe(5);
    expect(s.stdev).toBe(0);
  });

  it('nilai negatif [-10,0,10] — mean 0, p90 interpolasi positif', () => {
    const s = summarizeNumbers([-10, 0, 10]);
    expect(s.mean).toBe(0);
    expect(s.median).toBe(0);
    // rank(0.9) = 1.8 → 0 + 0.8·10 = 8
    expect(s.p90).toBeCloseTo(8, 10);
    expect(s.min).toBe(-10);
  });

  it('invariant median === p50 lintas bentuk gugus', () => {
    for (const values of [[7], [4, 9], [2, 8, 3], [100, 1, 50, 25, 75]]) {
      const s = summarizeNumbers(values);
      expect(s.median).toBeCloseTo(s.p50, 10);
    }
  });

  it('gugus kosong → RangeError', () => {
    expect(() => summarizeNumbers([])).toThrow(RangeError);
    expect(() => summarizeNumbers([])).toThrow(/kosong/);
  });

  it('NaN / ±Infinity dalam gugus → RangeError', () => {
    expect(() => summarizeNumbers([1, Number.NaN])).toThrow(RangeError);
    expect(() => summarizeNumbers([Number.POSITIVE_INFINITY])).toThrow(RangeError);
    expect(() => summarizeNumbers([Number.NEGATIVE_INFINITY, 0])).toThrow(RangeError);
  });

  it('masukan TIDAK dimutasi — urutan asli dipertahankan', () => {
    const input = [30, 10, 20];
    const snapshot = [...input];
    const s: DistributionStats = summarizeNumbers(input);
    expect(input).toEqual(snapshot);
    expect(s.n).toBe(3);
  });
});
