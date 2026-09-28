// ============================================================
// AudioWorkletPitchShift — controller pitch shift berkualitas (Fase 2)
// ============================================================
// Merangkai jalur:
//
//     source ──► pitch-shift-processor (worklet) ──► destination
//        └────────────── (bypass, |semitones| < eps) ──►┘
//
// - addModule SEKALI per context per URL (WeakMap) — create() berkali-kali
//   pada context sama tidak memuat ulang modul.
// - Transisi aktif ↔ bypass idempoten: koneksi hanya dibuat/dilepas saat
//   state berubah (jumlah connect konstan walau setSemitones dipanggil
//   berulang dengan nilai setara).
// - Semua bentuk node/context adalah tipe struktural minimal — fake test
//   assignable tanpa cast; pabrik browser (createBrowserPitchShiftController
//   di bawah) memakai tipe DOM asli dan juga bebas cast (metode Web Audio
//   kompatibel secara bivarian).
// ============================================================

import { clampSemitones } from './playback-rate-pitch-shift';

/** Nama processor yang didaftarkan pitch-worklet-processor.js. */
export const PITCH_SHIFT_PROCESSOR_NAME = 'pitch-shift-processor';

/** Nama AudioParam semitone di processor. */
const PITCH_SHIFT_PROCESSOR_PARAM_NAME = 'semitones';

/** Ambang |semitones| untuk mode bypass (selaras processor). */
export const BYPASS_SEMITONES_EPSILON = 0.01;

export type VoiceFilterErrorCode =
  'invalid-semitones' | 'missing-parameter' | 'disposed' | 'worklet-load-failed';

/** Error domain modul voice filter — mesin pesan seragam (pola repo). */
export class VoiceFilterError extends Error {
  readonly code: VoiceFilterErrorCode;
  readonly cause?: unknown;

  constructor(code: VoiceFilterErrorCode, message: string, cause?: unknown) {
    super(message);
    this.name = 'VoiceFilterError';
    this.code = code;
    if (cause !== undefined) {
      this.cause = cause;
    }
  }
}

// ============================================================
// Bentuk struktural Web Audio (hanya sub-kemampuan yang dipakai)
// ============================================================

/** Node yang bisa di-connect/disconnect (AudioNode atau fake). */
export interface AudioNodeLike {
  connect(destination: AudioNodeLike): unknown;
  disconnect(destination?: AudioNodeLike): void;
}

/** Node worklet — ditambah parameter AudioParam 'semitones'. */
export interface AudioWorkletNodeLike extends AudioNodeLike {
  parameters: { get(name: string): { value: number } | undefined };
}

/** Konteks pemilik audioWorklet.addModule (AudioContext atau fake). */
export interface AudioWorkletContextLike {
  audioWorklet: { addModule(moduleUrl: string): Promise<void> };
}

/** URL default file processor relatif terhadap modul ini (Vite dev/build & Node). */
export function defaultPitchShiftProcessorUrl(): string {
  return new URL('./pitch-worklet-processor.js', import.meta.url).href;
}

/** URL modul yang sudah dimuat per context (WeakMap — tidak memblokir GC context). */
const loadedModuleUrls = new WeakMap<AudioWorkletContextLike, Set<string>>();

export interface PitchShiftControllerDeps {
  /** Konteks audio pemilik worklet. */
  context: AudioWorkletContextLike;
  /** Sumber suara yang akan difilter (mis. MediaStreamAudioSourceNode). */
  source: AudioNodeLike;
  /** Tujuan keluaran (mis. MediaStreamAudioDestinationNode / GainNode). */
  destination: AudioNodeLike;
  /** Pabrik node worklet — di-inject agar test bebas fake. */
  createWorkletNode: () => AudioWorkletNodeLike;
  /** URL modul processor (default: defaultPitchShiftProcessorUrl()). */
  processorUrl?: string;
}

export type PitchShiftRoute = 'worklet' | 'bypass';

/**
 * Controller pitch shift berbasis AudioWorklet.
 * Dibuat lewat {@link PitchShiftWorkletController.create} (async — addModule).
 */
export class PitchShiftWorkletController {
  readonly #source: AudioNodeLike;
  readonly #destination: AudioNodeLike;
  readonly #workletNode: AudioWorkletNodeLike;
  #semitones = 0;
  #route: PitchShiftRoute = 'worklet';
  #workletWired = false;
  #directWired = false;
  #disposed = false;

  private constructor(deps: PitchShiftControllerDeps, workletNode: AudioWorkletNodeLike) {
    this.#source = deps.source;
    this.#destination = deps.destination;
    this.#workletNode = workletNode;
  }

  /** Memuat modul processor (sekali per context+URL) lalu membuat controller. */
  static async create(deps: PitchShiftControllerDeps): Promise<PitchShiftWorkletController> {
    const processorUrl = deps.processorUrl ?? defaultPitchShiftProcessorUrl();
    let loaded = loadedModuleUrls.get(deps.context);
    if (loaded === undefined) {
      loaded = new Set<string>();
      loadedModuleUrls.set(deps.context, loaded);
    }
    if (!loaded.has(processorUrl)) {
      try {
        await deps.context.audioWorklet.addModule(processorUrl);
      } catch (error) {
        throw new VoiceFilterError(
          'worklet-load-failed',
          `gagal memuat modul worklet ${processorUrl}: ${
            error instanceof Error ? error.message : String(error)
          }`,
          error,
        );
      }
      loaded.add(processorUrl);
    }
    const controller = new PitchShiftWorkletController(deps, deps.createWorkletNode());
    // Wiring awal: BYPASS terpasang — sinyal mengalir identitas sampai
    // setSemitones() pertama memindahkannya ke worklet. Tanpa ini, periode
    // antara create() dan set pertama memutus sumber dari tujuan sama sekali.
    controller.#routeBypass();
    return controller;
  }

  /** Semitone aktif saat ini (sudah di-clamp ±24). */
  getSemitones(): number {
    return this.#semitones;
  }

  /** Jalur sinyal aktif: 'worklet' (difilter) atau 'bypass' (identitas). */
  getRoute(): PitchShiftRoute {
    return this.#route;
  }

  get isDisposed(): boolean {
    return this.#disposed;
  }

  /**
   * Mengatur geseran pitch dalam semitone (di-clamp ±24).
   * |s| < 0.01 → bypass identitas; selain itu sinyal lewat worklet.
   */
  setSemitones(semitones: number): void {
    this.#assertAlive();
    if (typeof semitones !== 'number' || !Number.isFinite(semitones)) {
      throw new VoiceFilterError(
        'invalid-semitones',
        `semitones tidak valid: ${String(semitones)}`,
      );
    }
    const clamped = clampSemitones(semitones);
    this.#semitones = clamped;

    if (Math.abs(clamped) < BYPASS_SEMITONES_EPSILON) {
      this.#routeBypass();
    } else {
      this.#routeWorklet();
      const param = this.#workletNode.parameters.get(PITCH_SHIFT_PROCESSOR_PARAM_NAME);
      if (param === undefined) {
        throw new VoiceFilterError(
          'missing-parameter',
          `parameter '${PITCH_SHIFT_PROCESSOR_PARAM_NAME}' tidak ditemukan pada node worklet`,
        );
      }
      param.value = clamped;
    }
  }

  /** Melepas seluruh koneksi — idempoten; pemakaian pasca-dispose melempar. */
  dispose(): void {
    if (this.#disposed) {
      return;
    }
    if (this.#workletWired) {
      this.#source.disconnect(this.#workletNode);
      this.#workletNode.disconnect(this.#destination);
      this.#workletWired = false;
    }
    if (this.#directWired) {
      this.#source.disconnect(this.#destination);
      this.#directWired = false;
    }
    this.#disposed = true;
  }

  #routeBypass(): void {
    if (this.#workletWired) {
      this.#source.disconnect(this.#workletNode);
      this.#workletNode.disconnect(this.#destination);
      this.#workletWired = false;
    }
    if (!this.#directWired) {
      this.#source.connect(this.#destination);
      this.#directWired = true;
    }
    this.#route = 'bypass';
  }

  #routeWorklet(): void {
    if (this.#directWired) {
      this.#source.disconnect(this.#destination);
      this.#directWired = false;
    }
    if (!this.#workletWired) {
      this.#source.connect(this.#workletNode);
      this.#workletNode.connect(this.#destination);
      this.#workletWired = true;
    }
    this.#route = 'worklet';
  }

  #assertAlive(): void {
    if (this.#disposed) {
      throw new VoiceFilterError('disposed', 'controller sudah di-dispose');
    }
  }
}

// ============================================================
// Pabrik jalur browser (tipe DOM asli — tanpa cast)
// ============================================================

export interface BrowserPitchShiftOptions {
  /** AudioContext browser sungguhan. */
  context: AudioContext;
  /** Sumber suara (mis. MediaStreamAudioSourceNode mic). */
  source: AudioNode;
  /** Tujuan keluaran (mis. MediaStreamAudioDestinationNode). */
  destination: AudioNode;
  /** URL modul processor (default: di samping modul ini). */
  processorUrl?: string;
}

/**
 * Membuat controller pada AudioContext browser asli.
 * Satu-satunya titik yang menyentuh konstruktor AudioWorkletNode DOM —
 * tidak diunit-test (butuh browser); perilaku controller diuji penuh
 * lewat tipe struktural di atas.
 */
export async function createBrowserPitchShiftController(
  options: BrowserPitchShiftOptions,
): Promise<PitchShiftWorkletController> {
  const { context, source, destination, processorUrl } = options;
  return PitchShiftWorkletController.create({
    context,
    source,
    destination,
    processorUrl,
    createWorkletNode: () => new AudioWorkletNode(context, PITCH_SHIFT_PROCESSOR_NAME),
  });
}
