// ============================================================
// PlaybackRatePitchShift — pendekatan NAIF pitch shift (Fase 2)
// ============================================================
// Mengubah `playbackRate` pada AudioBufferSourceNode mengubah pitch DAN
// kecepatan sekaligus (rate 2 = nada naik oktaf + tempo 2x). Ini opsi
// "cheap" untuk efek voice filter; jalur berkualitas (tempo utuh, hanya
// pitch yang bergeser) ada di audio-worklet-pitch-shift.ts.
// ============================================================

/** Rentang semitone yang masuk akal untuk voice filter (±2 oktaf). */
export const MAX_PITCH_SHIFT_SEMITONES = 24;

/** Batas bawah/atas semitone — cermin dari MAX. */
export const MIN_PITCH_SHIFT_SEMITONES = -MAX_PITCH_SHIFT_SEMITONES;

/**
 * Mengubah semitone → faktor playbackRate: 2^(semitones/12).
 * - +12 → 2.0 (naik satu oktaf)
 * - 0  → 1.0
 * - -12 → 0.5 (turun satu oktaf)
 *
 * Input di-clamp ke ±MAX_PITCH_SHIFT_SEMITONES lebih dulu; NaN/Infinity
 * ditolak keras (bukan diam-diam dibulatkan — angka tak masuk akal hampir
 * pasti bug pemanggil).
 */
export function semitonesToPlaybackRate(semitones: number): number {
  assertFiniteSemitones(semitones);
  const clamped = clampSemitones(semitones);
  return Math.pow(2, clamped / 12);
}

/** Membatasi semitone ke rentang [-24, +24]. */
export function clampSemitones(semitones: number): number {
  assertFiniteSemitones(semitones);
  if (semitones > MAX_PITCH_SHIFT_SEMITONES) {
    return MAX_PITCH_SHIFT_SEMITONES;
  }
  if (semitones < MIN_PITCH_SHIFT_SEMITONES) {
    return MIN_PITCH_SHIFT_SEMITONES;
  }
  return semitones;
}

/**
 * Menerapkan pitch shift naif pada node bersumber buffer
 * (AudioBufferSourceNode atau bentuk strukturalnya) dan mengembalikan
 * rate yang dipasang.
 */
export function applyPlaybackRatePitchShift(
  source: { playbackRate: { value: number } },
  semitones: number,
): number {
  const rate = semitonesToPlaybackRate(semitones);
  source.playbackRate.value = rate;
  return rate;
}

function assertFiniteSemitones(semitones: number): void {
  if (typeof semitones !== 'number' || !Number.isFinite(semitones)) {
    throw new RangeError(`semitones harus angka hingga, dapat: ${String(semitones)}`);
  }
}
