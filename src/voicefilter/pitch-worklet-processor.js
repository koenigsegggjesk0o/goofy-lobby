// ============================================================
// pitch-worklet-processor.js — Pitch shifter granular dual-tap (Fase 2)
// ============================================================
// BERJALAN DI AudioWorkletGlobalScope BROWSER — file ini PLAIN JavaScript,
// TANPA import apa pun, di-load lewat audioContext.audioWorklet.addModule().
// (Karena itulah file ini tidak mengikuti ekosistem TS proyek dan
// di-ignore eslint: globals registerProcessor / sampleRate /
// AudioWorkletProcessor hanya ada di scope worklet.)
//
// ALGORITMA (granular dual-tap delay-line pitch shifter):
// - Keluaran = campuran DUA pembacaan history pada delay fraksional d1, d2
//   yang masing-masing bergeser dengan kemiringan (1 - ratio) per sampel,
//   dengan ratio = 2^(semitones/12).
//   Posisi baca = posisi tulis - d, sehingga posisi baca bergerak dengan
//   laju 1 - (1 - ratio) = ratio → pitch tergeser sebesar ratio, tempo utuh.
// - Delay dibatasi [0, GRAIN_SAMPLES) dan di-wrap (gergaji). Saat wrap,
//   tap "melompat" — artefak diredam jendela sin: tap menjadi senyap
//   tepat di titik wrap (sin(0) = sin(π) = 0).
// - d2 = d1 + GRAIN/2 (mod GRAIN) → jendela w1 = sin(π·d1/G) dan
//   w2 = sin(π·d2/G) = cos(π·d1/G) → w1² + w2² = 1 (amplitude-preserving
//   untuk sinyal berkorelasi — kedua tap membaca sumber yang sama).
// - BYPASS: |semitones| < 0.01 → salinan identitas input→output.
//   WAJIB: pada ratio tepat 1 kedua tap membaca history yang BERBEDA
//   sehingga jumlahnya menjadi comb-filter, bukan identitas.
// ============================================================

const GRAIN_SAMPLES = 2048;
const BYPASS_SEMITONES_EPSILON = 0.01;
const MIN_SEMITONES = -24;
const MAX_SEMITONES = 24;

/** State per channel (malas dibuat saat channel pertama kali terlihat). */
function createChannelState() {
  return {
    buffer: new Float32Array(GRAIN_SAMPLES),
    writeIndex: 0,
    d1: GRAIN_SAMPLES / 4,
    d2: (GRAIN_SAMPLES / 4 + GRAIN_SAMPLES / 2) % GRAIN_SAMPLES,
  };
}

/** Wrap delay fraksional ke [0, GRAIN_SAMPLES). */
function wrapDelay(value) {
  const g = GRAIN_SAMPLES;
  return ((value % g) + g) % g;
}

/** Pembacaan history pada delay fraksional d (interpolasi linear). */
function readInterpolated(state, delay) {
  const g = GRAIN_SAMPLES;
  const readPos = state.writeIndex - delay;
  const i0 = Math.floor(readPos);
  const frac = readPos - i0;
  const idx0 = ((i0 % g) + g) % g;
  const idx1 = (idx0 + 1) % g;
  const s0 = state.buffer[idx0];
  const s1 = state.buffer[idx1];
  return s0 + (s1 - s0) * frac;
}

class PitchShiftProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.channelStates = [];
  }

  static get parameterDescriptors() {
    return [
      {
        name: 'semitones',
        defaultValue: 0,
        minValue: MIN_SEMITONES,
        maxValue: MAX_SEMITONES,
        automationRate: 'k-rate',
      },
    ];
  }

  process(inputs, outputs, parameters) {
    const input = inputs[0];
    const output = outputs[0];
    const paramArray = parameters.semitones;
    const semitones = paramArray.length > 0 ? paramArray[0] : 0;
    const bypass = Math.abs(semitones) < BYPASS_SEMITONES_EPSILON;
    const ratio = Math.pow(2, semitones / 12);
    const slope = 1 - ratio;

    const blockLength = output.length > 0 ? output[0].length : 0;
    for (let n = 0; n < blockLength; n += 1) {
      for (let c = 0; c < output.length; c += 1) {
        if (this.channelStates.length <= c) {
          this.channelStates.push(createChannelState());
        }
        const state = this.channelStates[c];
        const inData = input !== undefined ? input[c] : undefined;
        const inSample = inData !== undefined && n < inData.length ? inData[n] : 0;

        // Tulis dulu supaya delay 0 membaca sampel ini sendiri.
        state.buffer[state.writeIndex] = inSample;

        if (bypass) {
          output[c][n] = inSample;
        } else {
          state.d1 = wrapDelay(state.d1 + slope);
          state.d2 = wrapDelay(state.d2 + slope);
          const w1 = Math.sin((Math.PI * state.d1) / GRAIN_SAMPLES);
          const w2 = Math.sin((Math.PI * state.d2) / GRAIN_SAMPLES);
          const mixed =
            w1 * readInterpolated(state, state.d1) + w2 * readInterpolated(state, state.d2);
          // Pengaman kecil overshoot interpolasi — jangan biarkan |out|>1.
          output[c][n] = mixed < -1 ? -1 : mixed > 1 ? 1 : mixed;
        }

        state.writeIndex = (state.writeIndex + 1) % GRAIN_SAMPLES;
      }
    }
    return true;
  }
}

registerProcessor('pitch-shift-processor', PitchShiftProcessor);
