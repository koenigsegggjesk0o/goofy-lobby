/**
 * Unit test pitch-worklet-processor.js — file PLAIN JS AudioWorklet.
 *
 * File processor TIDAK bisa diimpor (dia berjalan di AudioWorkletGlobalScope
 * browser, bergantung pada globals registerProcessor/sampleRate/
 * AudioWorkletProcessor). Strategi: baca sumber via node:fs, evaluasi di
 * sandbox yang MENYEDIAKAN globals itu, tangkap konstruktor yang
 * didaftarkan, lalu panggil process() langsung dengan blok 128 sampel —
 * persis kontrak AudioWorkletProcessor.process.
 *
 * Bukti kebenaran DSP: frekuensi keluaran diukur lewat HITUNG ZERO-CROSSING
 * pada region stabil (transient 2×GRAIN dibuang) dan dibandingkan dengan
 * frekuensi input × 2^(semitones/12).
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const SAMPLE_RATE = 48_000;
const BLOCK_SIZE = 128;
const GRAIN_SAMPLES = 2048;
const TRANSIENT_SAMPLES = 2 * GRAIN_SAMPLES;

interface ProcessorInstance {
  process(
    inputs: Float32Array[][],
    outputs: Float32Array[][],
    parameters: { semitones: Float32Array },
  ): boolean;
}

type ProcessorConstructor = new (options: unknown) => ProcessorInstance;

interface LoadedProcessor {
  name: string;
  ctor: ProcessorConstructor;
}

function loadProcessor(): LoadedProcessor {
  const source = readFileSync(new URL('./pitch-worklet-processor.js', import.meta.url), 'utf8');
  let registeredName: string | null = null;
  let registeredCtor: ProcessorConstructor | null = null;
  const registerProcessor = (name: string, ctor: unknown): void => {
    registeredName = name;
    registeredCtor = ctor as ProcessorConstructor;
  };
  class AudioWorkletProcessorStub {
    // Stub dasar — processor asli tidak memanggil anggota base class.
    // `port` adalah anggota nyata AudioWorkletProcessor (MessagePort);
    // null di stub karena tidak pernah disentuh di jalur uji.
    readonly port = null;
  }
  // Evaluasi sumber dengan globals worklet — new Function memberi scope
  // bersih tanpa menyentuh global test runner.
  const evaluate = new Function(
    'sampleRate',
    'currentTime',
    'registerProcessor',
    'AudioWorkletProcessor',
    `"use strict";\n${source}`,
  );
  evaluate(SAMPLE_RATE, 0, registerProcessor, AudioWorkletProcessorStub);
  if (registeredCtor === null || registeredName === null) {
    throw new Error('processor tidak memanggil registerProcessor — file rusak?');
  }
  return { name: registeredName, ctor: registeredCtor };
}

interface FeedOptions {
  semitones: number;
  /** Frekuensi sinus input (Hz). */
  inputFreq: number;
  /** Jumlah blok 128 sampel. */
  blocks: number;
  amplitude?: number;
}

interface FeedResult {
  output: Float32Array;
  input: Float32Array;
  returnValue: boolean;
}

function feed(ctor: ProcessorConstructor, options: FeedOptions): FeedResult {
  const { semitones, inputFreq, blocks, amplitude = 0.5 } = options;
  const processor = new ctor({ numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [1] });
  const outputChunks: Float32Array[] = [];
  const inputChunks: Float32Array[] = [];
  let returnValue = true;
  for (let block = 0; block < blocks; block += 1) {
    const input = new Float32Array(BLOCK_SIZE);
    for (let i = 0; i < BLOCK_SIZE; i += 1) {
      const t = (block * BLOCK_SIZE + i) / SAMPLE_RATE;
      input[i] = amplitude * Math.sin(2 * Math.PI * inputFreq * t);
    }
    const output = new Float32Array(BLOCK_SIZE);
    returnValue = processor.process([[input]], [[output]], {
      semitones: new Float32Array([semitones]),
    });
    inputChunks.push(input);
    outputChunks.push(output);
  }
  return {
    output: concatChunks(outputChunks),
    input: concatChunks(inputChunks),
    returnValue,
  };
}

function concatChunks(chunks: Float32Array[]): Float32Array {
  const total = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  const merged = new Float32Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.length;
  }
  return merged;
}

/** Estimasi frekuensi via hitung zero-crossing (naik+turun). */
function measureFrequency(samples: Float32Array): number {
  let crossings = 0;
  for (let i = 1; i < samples.length; i += 1) {
    // `?? 0` hanya untuk noUncheckedIndexedAccess — indeks selalu valid
    // di dalam rentang loop.
    const previous = samples[i - 1] ?? 0;
    const current = samples[i] ?? 0;
    if ((previous < 0 && current >= 0) || (previous >= 0 && current < 0)) {
      crossings += 1;
    }
  }
  return (crossings / 2) * (SAMPLE_RATE / samples.length);
}

function rms(samples: Float32Array): number {
  let sumSquares = 0;
  for (const sample of samples) {
    sumSquares += sample * sample;
  }
  return Math.sqrt(sumSquares / samples.length);
}

function sliceStable(samples: Float32Array): Float32Array {
  return samples.slice(TRANSIENT_SAMPLES);
}

describe('pitch-worklet-processor (dievaluasi di sandbox AudioWorkletGlobalScope)', () => {
  it('mendaftarkan diri dengan nama pitch-shift-processor', () => {
    const { name } = loadProcessor();
    expect(name).toBe('pitch-shift-processor');
  });

  it('BYPASS: semitones 0 → keluaran PERSIS identik dengan masukan', () => {
    const { ctor } = loadProcessor();
    const { output, input, returnValue } = feed(ctor, {
      semitones: 0,
      inputFreq: 440,
      blocks: 40,
    });
    expect(returnValue).toBe(true);
    expect(output.length).toBe(input.length);
    for (let i = 0; i < input.length; i += 1) {
      expect(output[i]).toBe(input[i]);
    }
  });

  it('DSP +12 semitone: sinus 440 Hz → frekuensi keluaran ≈ 880 Hz (±5%)', () => {
    const { ctor } = loadProcessor();
    const { output } = feed(ctor, { semitones: 12, inputFreq: 440, blocks: 220 });
    const measured = measureFrequency(sliceStable(output));
    expect(measured).toBeGreaterThan(880 * 0.95);
    expect(measured).toBeLessThan(880 * 1.05);
  });

  it('DSP -12 semitone: sinus 440 Hz → frekuensi keluaran ≈ 220 Hz (±5%)', () => {
    const { ctor } = loadProcessor();
    const { output } = feed(ctor, { semitones: -12, inputFreq: 440, blocks: 220 });
    const measured = measureFrequency(sliceStable(output));
    expect(measured).toBeGreaterThan(220 * 0.95);
    expect(measured).toBeLessThan(220 * 1.05);
  });

  it('DSP +7 semitone: sinus 440 Hz → ≈ 659.26 Hz (rasio temperamen sama, ±5%)', () => {
    const { ctor } = loadProcessor();
    const expected = 440 * Math.pow(2, 7 / 12);
    const { output } = feed(ctor, { semitones: 7, inputFreq: 440, blocks: 220 });
    const measured = measureFrequency(sliceStable(output));
    expect(measured).toBeGreaterThan(expected * 0.95);
    expect(measured).toBeLessThan(expected * 1.05);
  });

  it('amplitudo terjaga: RMS region stabil 0.3–1.6 × RMS input (+12)', () => {
    const { ctor } = loadProcessor();
    const { output, input } = feed(ctor, { semitones: 12, inputFreq: 440, blocks: 220 });
    const ratio = rms(sliceStable(output)) / rms(sliceStable(input));
    expect(ratio).toBeGreaterThan(0.3);
    expect(ratio).toBeLessThan(1.6);
  });

  it('input kosong (channel tak ada): tidak melempar, keluaran nol, tetap hidup', () => {
    const { ctor } = loadProcessor();
    const processor = new ctor({ numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [1] });
    const output = new Float32Array(BLOCK_SIZE);
    const returnValue = processor.process([[]], [[output]], {
      semitones: new Float32Array([5]),
    });
    expect(returnValue).toBe(true);
    for (const sample of output) {
      expect(sample).toBe(0);
    }
  });
});
