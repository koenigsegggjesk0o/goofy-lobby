import { describe, expect, it, vi } from 'vitest';
import {
  assertValidStatsSample,
  decideBitrateTier,
  MIN_STATS_SAMPLES,
  STATS_JITTER_MEDIUM_MS,
  STATS_LOSS_LOW,
  STATS_LOSS_MEDIUM,
  type BitrateStatsSample,
} from './bitrate-decision';
import { BitrateAdaptation, type BitrateAdaptationOptions } from './bitrate-adaptation';
import { DEFAULT_BITRATE_TIERS } from './types';
import { FakeParamsRtpSender, fakeTrack } from './test-utils';

/** Sampel jaringan sehat (jauh di bawah semua ambang). */
const healthy = (): BitrateStatsSample => ({ fractionLost: 0, jitterMs: 5 });

/** Sampel terdegradasi loss (di atas ambang medium, di bawah ambang low). */
const degradedLoss = (): BitrateStatsSample => ({ fractionLost: 0.05, jitterMs: 5 });

/** Sampel buruk loss (di atas ambang low). */
const badLoss = (): BitrateStatsSample => ({ fractionLost: 0.2, jitterMs: 5 });

describe('decideBitrateTier — murni (main prompt: getStats packet loss + jitter)', () => {
  it('jendela kosong / di bawah MIN_STATS_SAMPLES → null (belum tahu)', () => {
    expect(decideBitrateTier([])).toBeNull();
    expect(decideBitrateTier([healthy(), healthy()])).toBeNull();
    expect(MIN_STATS_SAMPLES).toBe(3);
  });

  it('jendela sehat → high', () => {
    expect(decideBitrateTier([healthy(), healthy(), healthy()])).toBe('high');
  });

  it('median loss ≥ ambang medium → medium', () => {
    expect(decideBitrateTier([healthy(), degradedLoss(), degradedLoss()])).toBe('medium');
  });

  it('median loss ≥ ambang low → low (menang atas jitter)', () => {
    expect(decideBitrateTier([badLoss(), badLoss(), badLoss()])).toBe('low');
  });

  it('median jitter ≥ ambang medium → medium walau loss sehat', () => {
    const jittery: BitrateStatsSample[] = [
      { fractionLost: 0, jitterMs: STATS_JITTER_MEDIUM_MS },
      { fractionLost: 0, jitterMs: STATS_JITTER_MEDIUM_MS + 1 },
      { fractionLost: 0, jitterMs: STATS_JITTER_MEDIUM_MS + 2 },
    ];
    expect(decideBitrateTier(jittery)).toBe('medium');
  });

  it('histeresis median: SATU spike loss di antara sampel sehat tidak menurunkan tier', () => {
    // median dari [0, 0, 0, 0, 0.5] = 0 → high; mean = 0.1 akan salah turun
    const window = [healthy(), healthy(), healthy(), healthy(), badLoss()];
    expect(decideBitrateTier(window)).toBe('high');
  });

  it('histeresis median: satu sampel sehat di antara sampel buruk tidak menaikkan tier', () => {
    const window = [badLoss(), badLoss(), badLoss(), badLoss(), healthy()];
    expect(decideBitrateTier(window)).toBe('low');
  });

  it('urutan sampel bebas (median tak peduli urutan)', () => {
    const a = [degradedLoss(), healthy(), degradedLoss()];
    const b = [degradedLoss(), degradedLoss(), healthy()];
    expect(decideBitrateTier(a)).toBe('medium');
    expect(decideBitrateTier(b)).toBe('medium');
  });

  it('tepat di ambang dikategorikan ke tier lebih rendah (≥)', () => {
    const atMedium: BitrateStatsSample[] = [
      { fractionLost: STATS_LOSS_MEDIUM, jitterMs: 0 },
      { fractionLost: STATS_LOSS_MEDIUM, jitterMs: 0 },
      { fractionLost: STATS_LOSS_MEDIUM, jitterMs: 0 },
    ];
    expect(decideBitrateTier(atMedium)).toBe('medium');
    const atLow: BitrateStatsSample[] = [
      { fractionLost: STATS_LOSS_LOW, jitterMs: 0 },
      { fractionLost: STATS_LOSS_LOW, jitterMs: 0 },
      { fractionLost: STATS_LOSS_LOW, jitterMs: 0 },
    ];
    expect(decideBitrateTier(atLow)).toBe('low');
  });

  it('sampel korup (non-finite / di luar pita) → RangeError keras', () => {
    expect(() =>
      decideBitrateTier([healthy(), healthy(), { fractionLost: Number.NaN, jitterMs: 5 }]),
    ).toThrow(RangeError);
    expect(() =>
      decideBitrateTier([healthy(), healthy(), { fractionLost: 1.5, jitterMs: 5 }]),
    ).toThrow(RangeError);
    expect(() =>
      decideBitrateTier([healthy(), healthy(), { fractionLost: -0.1, jitterMs: 5 }]),
    ).toThrow(RangeError);
    expect(() =>
      decideBitrateTier([healthy(), healthy(), { fractionLost: 0, jitterMs: -1 }]),
    ).toThrow(RangeError);
    expect(() =>
      decideBitrateTier([
        healthy(),
        healthy(),
        { fractionLost: 0, jitterMs: Number.POSITIVE_INFINITY },
      ]),
    ).toThrow(RangeError);
  });

  it('assertValidStatsSample: batas pita 0..1 dan jitter ≥ 0 diterima', () => {
    expect(() => assertValidStatsSample({ fractionLost: 0, jitterMs: 0 })).not.toThrow();
    expect(() => assertValidStatsSample({ fractionLost: 1, jitterMs: 0 })).not.toThrow();
    expect(() =>
      assertValidStatsSample({ fractionLost: STATS_LOSS_MEDIUM, jitterMs: STATS_JITTER_MEDIUM_MS }),
    ).not.toThrow();
  });
});

describe('BitrateAdaptation.observeStats — integrasi jendela + tier', () => {
  function makeHarness(options?: Partial<BitrateAdaptationOptions>) {
    const store = new Map<string, FakeParamsRtpSender[]>();
    const adaptation = new BitrateAdaptation({
      getSenders: (sessionId) => store.get(sessionId) ?? [],
      ...options,
    });
    return { adaptation, store };
  }

  function audioSender() {
    return new FakeParamsRtpSender(fakeTrack('audio'));
  }

  it('sampel sehat bertubi-tubi: hanya menulis SEKALI (dedupe) walau 10 sampel', () => {
    const { adaptation, store } = makeHarness();
    const sender = audioSender();
    store.set('peer-1', [sender]);

    for (let i = 0; i < 10; i += 1) adaptation.observeStats('peer-1', healthy());

    expect(sender.setParametersCalls).toHaveLength(1);
    expect(sender.setParametersCalls[0]?.encodings?.[0]?.maxBitrate).toBe(
      DEFAULT_BITRATE_TIERS.high,
    );
    expect(adaptation.currentTier('peer-1')).toBe('high');
  });

  it('jendela buruk menurunkan tier ke low (16 kbps — batas bawah main prompt)', () => {
    const { adaptation, store } = makeHarness();
    const sender = audioSender();
    store.set('peer-1', [sender]);
    for (let i = 0; i < 3; i += 1) adaptation.observeStats('peer-1', healthy());

    for (let i = 0; i < 5; i += 1) adaptation.observeStats('peer-1', badLoss());

    const calls = sender.setParametersCalls;
    expect(calls).toHaveLength(2);
    expect(calls[1]?.encodings?.[0]?.maxBitrate).toBe(16_000);
    expect(adaptation.currentTier('peer-1')).toBe('low');
  });

  it('pemulihan: jendela kembali sehat → naik ke high lagi', () => {
    const { adaptation, store } = makeHarness();
    const sender = audioSender();
    store.set('peer-1', [sender]);
    for (let i = 0; i < 5; i += 1) adaptation.observeStats('peer-1', badLoss());
    for (let i = 0; i < 5; i += 1) adaptation.observeStats('peer-1', healthy());

    const calls = sender.setParametersCalls;
    expect(calls).toHaveLength(2);
    expect(calls[1]?.encodings?.[0]?.maxBitrate).toBe(24_000);
  });

  it('jendela BERBATAS: sampel ke-6 menggeser jendela (spike tua menua keluar)', () => {
    const { adaptation, store } = makeHarness();
    const sender = audioSender();
    store.set('peer-1', [sender]);
    // 5 sampel sehat → high; lalu 5 sampel degraded → medium; lalu 5 sehat lagi.
    // Setelah blok degraded selesai, jendela berisi 5 sampel TERAKHIR (sehat)
    // — bukan campuran — sehingga tier kembali high (median murni).
    for (let i = 0; i < 5; i += 1) adaptation.observeStats('peer-1', healthy());
    for (let i = 0; i < 5; i += 1) adaptation.observeStats('peer-1', degradedLoss());
    expect(adaptation.currentTier('peer-1')).toBe('medium');
    for (let i = 0; i < 5; i += 1) adaptation.observeStats('peer-1', healthy());
    expect(adaptation.currentTier('peer-1')).toBe('high');
    expect(sender.setParametersCalls).toHaveLength(3);
  });

  it('ukuran jendela kustom dihormati (statsWindow: 3)', () => {
    const { adaptation } = makeHarness({ statsWindow: 3 });
    // 3 sampel sehat cukup untuk keputusan pada jendela 3.
    for (let i = 0; i < 3; i += 1) adaptation.observeStats('peer-1', healthy());
    expect(adaptation.currentTier('peer-1')).toBe('high');
  });

  it('sampel korup → onError observe-stats, jendela tak tercemar, tier tak berubah', () => {
    const onError = vi.fn();
    const { adaptation, store } = makeHarness({ onError });
    const sender = audioSender();
    store.set('peer-1', [sender]);
    for (let i = 0; i < 3; i += 1) adaptation.observeStats('peer-1', healthy());
    expect(sender.setParametersCalls).toHaveLength(1);

    adaptation.observeStats('peer-1', { fractionLost: Number.NaN, jitterMs: 5 });

    expect(onError).toHaveBeenCalledWith('peer-1', 'observe-stats', expect.any(RangeError));
    expect(adaptation.currentTier('peer-1')).toBe('high');
    // jendela masih berisi 3 sampel sehat: sampel ke-4 sehat → tetap high,
    // BUKAN 4 sampel (korup tidak masuk) — tier tidak berubah = dedupe.
    adaptation.observeStats('peer-1', healthy());
    expect(sender.setParametersCalls).toHaveLength(1);
  });

  it('session tak dikenal: observeStats tetap membangun state (kontrak sama dgn observe)', () => {
    const { adaptation } = makeHarness();
    for (let i = 0; i < 3; i += 1) adaptation.observeStats('peer-hantu', healthy());
    expect(adaptation.currentTier('peer-hantu')).toBe('high');
  });

  it('close() membuang jendela — sesi ulang butuh sampel segar sebelum memutuskan', () => {
    const { adaptation } = makeHarness();
    for (let i = 0; i < 3; i += 1) adaptation.observeStats('peer-1', healthy());
    expect(adaptation.currentTier('peer-1')).toBe('high');

    adaptation.close('peer-1');
    expect(adaptation.currentTier('peer-1')).toBeNull();

    // 2 sampel segar belum cukup (MIN_STATS_SAMPLES = 3) → masih null.
    adaptation.observeStats('peer-1', badLoss());
    adaptation.observeStats('peer-1', badLoss());
    expect(adaptation.currentTier('peer-1')).toBeNull();
    adaptation.observeStats('peer-1', badLoss());
    expect(adaptation.currentTier('peer-1')).toBe('low');
  });

  it('sinyal state dan stats bekerja berurutan: connected→high lalu stats buruk→low', () => {
    const { adaptation, store } = makeHarness();
    const sender = audioSender();
    store.set('peer-1', [sender]);

    adaptation.observe('peer-1', 'connected');
    for (let i = 0; i < 5; i += 1) adaptation.observeStats('peer-1', badLoss());

    expect(adaptation.currentTier('peer-1')).toBe('low');
    expect(sender.setParametersCalls).toHaveLength(2);
  });
});
