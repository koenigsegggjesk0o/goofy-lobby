import { describe, expect, it } from 'vitest';
import {
  MAX_PITCH_SHIFT_SEMITONES,
  MIN_PITCH_SHIFT_SEMITONES,
  applyPlaybackRatePitchShift,
  clampSemitones,
  semitonesToPlaybackRate,
} from './playback-rate-pitch-shift';

describe('semitonesToPlaybackRate', () => {
  it('titik acuan musik: 0 → 1, +12 → 2, -12 → 0.5', () => {
    expect(semitonesToPlaybackRate(0)).toBe(1);
    expect(semitonesToPlaybackRate(12)).toBe(2);
    expect(semitonesToPlaybackRate(-12)).toBeCloseTo(0.5, 12);
  });

  it('kuint: +7 semitone ≈ 1.498307 (rasio temperamen sama)', () => {
    expect(semitonesToPlaybackRate(7)).toBeCloseTo(1.4983070768766815, 12);
  });

  it('input di-clamp ke ±24 SEBELUM eksponensial (bukan sesudah)', () => {
    // +36 semitone tanpa clamp = 8; dengan clamp = +24 → 4.
    expect(semitonesToPlaybackRate(36)).toBe(4);
    expect(semitonesToPlaybackRate(-36)).toBeCloseTo(0.25, 12);
  });

  it('NaN / Infinity / -Infinity / non-angka → RangeError', () => {
    expect(() => semitonesToPlaybackRate(Number.NaN)).toThrow(RangeError);
    expect(() => semitonesToPlaybackRate(Number.POSITIVE_INFINITY)).toThrow(RangeError);
    expect(() => semitonesToPlaybackRate(Number.NEGATIVE_INFINITY)).toThrow(RangeError);
    // @ts-expect-error — uji jalur defensif terhadap pemanggil JS tanpa tipe
    expect(() => semitonesToPlaybackRate('tujuh')).toThrow(RangeError);
  });
});

describe('clampSemitones', () => {
  it('nilai dalam rentang diteruskan apa adanya', () => {
    for (const value of [0, 1, -13.5, 24, -24, 0.01]) {
      expect(clampSemitones(value)).toBe(value);
    }
  });

  it('nilai di luar rentang dipotong ke batas', () => {
    expect(clampSemitones(25)).toBe(MAX_PITCH_SHIFT_SEMITONES);
    expect(clampSemitones(1_000)).toBe(MAX_PITCH_SHIFT_SEMITONES);
    expect(clampSemitones(-25)).toBe(MIN_PITCH_SHIFT_SEMITONES);
    expect(clampSemitones(-1_000)).toBe(MIN_PITCH_SHIFT_SEMITONES);
  });
});

describe('applyPlaybackRatePitchShift', () => {
  it('men-set playbackRate.value dan mengembalikan rate yang sama', () => {
    const source = { playbackRate: { value: 1 } };
    const rate = applyPlaybackRatePitchShift(source, 12);
    expect(rate).toBe(2);
    expect(source.playbackRate.value).toBe(2);
  });

  it('nilai clamp juga berlaku lewat jalur apply', () => {
    const source = { playbackRate: { value: 1 } };
    const rate = applyPlaybackRatePitchShift(source, 100);
    expect(rate).toBe(semitonesToPlaybackRate(24));
    expect(source.playbackRate.value).toBe(4);
  });
});
