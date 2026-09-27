import { Emitter } from '../lib/typed-emitter';
import {
  MAX_VOICE_DURATION_MS,
  MAX_VOICE_SNIPPET_BYTES,
  PREFERRED_RECORDING_MIMES,
  RECORDER_TIMESLICE_MS,
  VoiceSnippetError,
  type VoiceRecordingResult,
} from './types';
type Timer = ReturnType<typeof setTimeout>;

// ============================================================
// Bentuk longgar MediaRecorder (lihat catatan di bawah)
// ============================================================

/**
 * Kontrak MediaRecorder yang dibutuhkan VoiceRecorder. Handler event
 * memakai bentuk longgar; adapter default meng-cast recorder asli satu
 * kali di satu tempat (terkontrol) — fake test mengimplementasikan
 * kontrak ini secara langsung.
 */
export interface MediaRecorderLike {
  readonly mimeType: string;
  readonly state: 'inactive' | 'recording' | 'paused';
  start(timeslice?: number): void;
  stop(): void;
  ondataavailable: ((event: { data: Blob }) => void) | null;
  onstop: ((event: unknown) => void) | null;
  onerror: ((event: unknown) => void) | null;
}

/** Hasil yang sama dengan MediaRecorder, tetapi bebas tipe DOM. */
export interface RecorderStreamLike {
  getTracks(): Array<{ stop(): void }>;
}

export interface VoiceRecorderDeps {
  /** Membuka mikrofon (default: navigator.mediaDevices.getUserMedia). */
  getUserMedia?: () => Promise<RecorderStreamLike>;
  /** Pabrik MediaRecorder (default: konstruktor global, di-cast ke like). */
  createRecorder?: (stream: RecorderStreamLike, mimeType: string) => MediaRecorderLike;
  /** Pemeriksa MIME (default: MediaRecorder.isTypeSupported). */
  isTypeSupported?: (mimeType: string) => boolean;
  /** Override durasi maksimum (ms). */
  maxDurationMs?: number;
  /** Override budget byte perekaman. */
  maxBytes?: number;
  /** Jam terkontrol untuk pengukuran durasi (test). */
  now?: () => number;
}

export interface VoiceRecorderEventMap {
  'recording-started': { mimeType: string };
  'recording-stopped': VoiceRecordingResult;
  'recording-cancelled': { durationMs: number };
  error: { message: string; code: string };
}

/**
 * Perekam snippet suara profil di atas MediaRecorder.
 *
 * - MIME dipilih dari PREFERRED_RECORDING_MIMES yang pertama didukung;
 *   bila tidak ada satupun → error 'unsupported-mime' (tidak diam-diam
 *   memakai format lain — bucket hanya menerima audio/webm).
 * - `start(timeslice)` memakai RECORDER_TIMESLICE_MS supaya byte budget
 *   terpantau SELAMA perekaman, bukan setelah selesai.
 * - Auto-stop dua lapis: durasi maksimum (15 s) dan budget byte (25 MiB);
 *   hasil tetap valid — flag `autoStopped` menjelaskan alasannya.
 * - Semua track mikrofon dihentikan di semua jalur keluar (stop/cancel/
 *   error) supaya indikator mic browser tidak nyangkut.
 * - stop() mengembalikan hasil perekaman; cancel() membuangnya;
 *   kegagalan recorder (onerror) me-reject stop() yang tertunda.
 */
export class VoiceRecorder extends Emitter<VoiceRecorderEventMap> {
  readonly #getUserMedia: () => Promise<RecorderStreamLike>;
  readonly #createRecorder: (stream: RecorderStreamLike, mimeType: string) => MediaRecorderLike;
  readonly #isTypeSupported: (mimeType: string) => boolean;
  readonly #maxDurationMs: number;
  readonly #maxBytes: number;
  readonly #now: () => number;

  #state: 'idle' | 'recording' = 'idle';
  #recorder: MediaRecorderLike | null = null;
  #stream: RecorderStreamLike | null = null;
  #chunks: Blob[] = [];
  #totalBytes = 0;
  #startedAt = 0;
  #durationTimer: Timer | null = null;
  #pendingStop: ((result: VoiceRecordingResult) => void) | null = null;
  #pendingReject: ((error: VoiceSnippetError) => void) | null = null;

  constructor(deps: VoiceRecorderDeps = {}) {
    super();
    this.#getUserMedia = deps.getUserMedia ?? defaultGetUserMedia;
    this.#createRecorder = deps.createRecorder ?? defaultCreateRecorder;
    this.#isTypeSupported = deps.isTypeSupported ?? defaultIsTypeSupported;
    this.#maxDurationMs = deps.maxDurationMs ?? MAX_VOICE_DURATION_MS;
    this.#maxBytes = deps.maxBytes ?? MAX_VOICE_SNIPPET_BYTES;
    this.#now = deps.now ?? Date.now;
  }

  /** Berlangganan event (recording-started/stopped/cancelled, error). */
  // on() diwarisi dari Emitter — emit() protected hanya dipakai internal.

  get state(): 'idle' | 'recording' {
    return this.#state;
  }

  /** Lama perekaman berjalan saat ini (0 bila idle). */
  elapsedMs(): number {
    return this.#state === 'recording' ? this.#now() - this.#startedAt : 0;
  }

  /**
   * Membuka mikrofon dan mulai merekam.
   * Melempar VoiceSnippetError bila: sedang merekam, MIME tidak didukung,
   * atau izin mikrofon ditolak.
   */
  async start(): Promise<void> {
    if (this.#state !== 'idle') {
      throw new VoiceSnippetError('busy', 'perekaman sudah berjalan');
    }
    const mimeType = PREFERRED_RECORDING_MIMES.find((candidate) =>
      this.#isTypeSupported(candidate),
    );
    if (mimeType === undefined) {
      const error = new VoiceSnippetError(
        'unsupported-mime',
        'browser tidak mendukung perekaman audio/webm',
      );
      this.emit('error', { message: error.message, code: error.code });
      throw error;
    }
    let stream: RecorderStreamLike;
    try {
      stream = await this.#getUserMedia();
    } catch (cause) {
      const error = new VoiceSnippetError(
        'mic-denied',
        'gagal membuka mikrofon (izin ditolak atau tidak ada perangkat)',
        cause,
      );
      this.emit('error', { message: error.message, code: error.code });
      throw error;
    }
    this.#stream = stream;
    const recorder = this.#createRecorder(stream, mimeType);
    this.#recorder = recorder;
    this.#chunks = [];
    this.#totalBytes = 0;
    this.#startedAt = this.#now();
    recorder.ondataavailable = (event) => this.#handleChunk(event.data);
    recorder.onstop = () => this.#handleStop();
    recorder.onerror = (event) => this.#handleRecorderError(event);
    recorder.start(RECORDER_TIMESLICE_MS);
    this.#state = 'recording';
    this.#durationTimer = setTimeout(() => {
      void this.autoStop('duration');
    }, this.#maxDurationMs);
    this.emit('recording-started', { mimeType });
  }

  /**
   * Menghentikan perekaman dan mengambil hasilnya.
   * Melempar bila sedang idle atau recorder gagal sebelum sempat berhenti.
   */
  async stop(): Promise<VoiceRecordingResult> {
    if (this.#state !== 'recording' || this.#recorder === null) {
      throw new VoiceSnippetError('empty-recording', 'tidak ada perekaman yang berjalan');
    }
    return new Promise<VoiceRecordingResult>((resolve, reject) => {
      this.#pendingStop = resolve;
      this.#pendingReject = reject;
      this.#clearDurationTimer();
      // onstop fake browser maupun asli sama-sama sinkron di sini; promise
      // tetap aman bila onstop datang belakangan (microtask/event loop).
      this.#recorder?.stop();
    });
  }

  /**
   * Menghentikan perekaman dan MEMBUANG hasilnya (idempoten — aman dipanggil
   * saat idle). Selalu mengembalikan kontrol setelah track mikropon berhenti.
   */
  async cancel(): Promise<void> {
    if (this.#state !== 'recording' || this.#recorder === null) {
      return;
    }
    const durationMs = this.elapsedMs();
    this.#clearDurationTimer();
    const recorder = this.#recorder;
    this.#detachRecorder(recorder);
    try {
      recorder.stop();
    } catch {
      // Recorder sudah mati sendiri — tidak ada yang perlu dibuang.
    }
    this.#stopTracks();
    this.#state = 'idle';
    // stop() yang masih menunggu tidak boleh menggantung selamanya.
    const reject = this.#pendingReject;
    this.#pendingStop = null;
    this.#pendingReject = null;
    reject?.(new VoiceSnippetError('empty-recording', 'perekaman dibatalkan'));
    this.emit('recording-cancelled', { durationMs });
  }

  /** Dipanggil timer durasi/budget byte — stop dengan penanda alasan. */
  private async autoStop(reason: 'duration' | 'byte-cap'): Promise<void> {
    if (this.#state !== 'recording') {
      return;
    }
    // Penanda HARUS terpasang sebelum stop(): onstop bisa terpicu sinkron
    // di dalam pemanggilan recorder.stop() — #handleStop membacanya di sana.
    this.#lastAutoStop = reason;
    try {
      await this.stop();
    } catch {
      // onerror sudah emit 'error'; tidak ada hasil untuk dilaporkan.
    }
  }

  #lastAutoStop: 'duration' | 'byte-cap' | null = null;

  // ============================================================
  // Internal
  // ============================================================

  #handleChunk(data: Blob): void {
    if (this.#state !== 'recording') {
      return;
    }
    this.#chunks.push(data);
    this.#totalBytes += data.size;
    if (this.#totalBytes >= this.#maxBytes) {
      void this.autoStop('byte-cap');
    }
  }

  #handleStop(): void {
    if (this.#state !== 'recording') {
      return;
    }
    const autoStopped = this.#lastAutoStop;
    this.#lastAutoStop = null;
    const durationMs = this.#now() - this.#startedAt;
    const recorder = this.#recorder;
    const mimeType = recorder !== null ? recorder.mimeType : 'audio/webm';
    this.#clearDurationTimer();
    this.#stopTracks();
    this.#state = 'idle';
    const blob = new Blob(this.#chunks, { type: mimeType });
    const result: VoiceRecordingResult = { blob, durationMs, autoStopped };
    this.#chunks = [];
    const resolve = this.#pendingStop;
    this.#pendingStop = null;
    this.#pendingReject = null;
    this.emit('recording-stopped', result);
    resolve?.(result);
  }

  #handleRecorderError(event: unknown): void {
    if (this.#state !== 'recording') {
      return;
    }
    const detail = (event as { error?: { message?: unknown } } | null)?.error;
    const message = typeof detail?.message === 'string' ? detail.message : 'MediaRecorder gagal';
    this.#clearDurationTimer();
    this.#stopTracks();
    this.#state = 'idle';
    const error = new VoiceSnippetError('recorder-error', message, event);
    const reject = this.#pendingReject;
    this.#pendingStop = null;
    this.#pendingReject = null;
    this.emit('error', { message, code: error.code });
    reject?.(error);
  }

  #detachRecorder(recorder: MediaRecorderLike): void {
    recorder.ondataavailable = null;
    recorder.onstop = null;
    recorder.onerror = null;
  }

  #stopTracks(): void {
    for (const track of this.#stream?.getTracks() ?? []) {
      try {
        track.stop();
      } catch {
        // Track sudah mati — abaikan.
      }
    }
    this.#stream = null;
    this.#recorder = null;
  }

  #clearDurationTimer(): void {
    if (this.#durationTimer !== null) {
      clearTimeout(this.#durationTimer);
      this.#durationTimer = null;
    }
  }
}

// ============================================================
// Adapter default (dipakai di browser; tidak tersentuh di test Node)
// ============================================================

async function defaultGetUserMedia(): Promise<RecorderStreamLike> {
  const media = (globalThis as { navigator?: { mediaDevices?: { getUserMedia?: unknown } } })
    .navigator?.mediaDevices?.getUserMedia;
  if (typeof media !== 'function') {
    throw new Error('getUserMedia tidak tersedia di lingkungan ini');
  }
  return (media as () => Promise<RecorderStreamLike>)();
}

function defaultIsTypeSupported(mimeType: string): boolean {
  const ctor = (globalThis as { MediaRecorder?: { isTypeSupported?: (m: string) => boolean } })
    .MediaRecorder;
  return typeof ctor?.isTypeSupported === 'function' ? ctor.isTypeSupported(mimeType) : false;
}

function defaultCreateRecorder(stream: RecorderStreamLike, mimeType: string): MediaRecorderLike {
  const ctor = (globalThis as { MediaRecorder?: new (s: unknown, o?: unknown) => unknown })
    .MediaRecorder;
  if (ctor === undefined) {
    throw new Error('MediaRecorder tidak tersedia di lingkungan ini');
  }
  // Satu-satunya tempat cast di modul ini: kontrak handler memakai bentuk
  // longgar agar fake test dapat mengimplementasikannya tanpa DOM penuh.
  const recorder = new ctor(stream, { mimeType, audioBitsPerSecond: 32_000 });
  return recorder as MediaRecorderLike;
}
