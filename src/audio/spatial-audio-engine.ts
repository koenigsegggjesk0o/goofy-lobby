import type { Position } from '../webrtc/types';
import { AudioListenerSync } from './audio-listener-sync';
import {
  PANNER_DISTANCE_MODEL,
  PANNER_MAX_DISTANCE,
  PANNER_PANNING_MODEL,
  PANNER_REF_DISTANCE,
  PANNER_ROLLOFF_FACTOR,
  applySpatialPosition,
  sanitizePosition,
  worldToAudioXYZ,
} from './types';

/** Pabrik AudioContext — disuntik supaya test bisa memasang fake. */
export type AudioContextFactory = () => AudioContext;

export const defaultAudioContextFactory: AudioContextFactory = () => new AudioContext();

export interface SpatialAudioEngineOptions {
  createAudioContext?: AudioContextFactory;
  panningModel?: PanningModelType;
  distanceModel?: DistanceModelType;
  refDistance?: number;
  maxDistance?: number;
  rolloffFactor?: number;
  /** Hook error non-fatal (mis. gagal menutup context saat dispose). */
  onError?: (context: string, error: unknown) => void;
}

interface PeerVoice {
  source: MediaStreamAudioSourceNode;
  panner: PannerNode;
}

/**
 * Mesin spatial audio untuk satu room: setiap remote peer mendapat rantai
 *
 *     MediaStreamSource → PannerNode (HRTF) → masterGain → destination
 *
 * - masterGain bersifat global (mute/volume lokal, tanpa menyentuh panner);
 * - posisi peer diterapkan ke panner pada bidang x-z (konvensi types.ts);
 * - posisi bisa datang SEBELUM suara (paket posisi lebih dulu dari track) —
 *   disimpan lalu diterapkan saat addPeerVoice;
 * - posisi selalu di-clamp ke batas dunia (pertahanan kedua: posisi remote
 *   dari DataChannelSync hanya divalidasi finite, tidak di-clamp);
 * - listener lokal diakses lewat getter `listener` (AudioListenerSync).
 *
 * Tidak ada monitor suara sendiri — suara lokal TIDAK diputar ke speaker
 * (mencegah echo; mic playback hanya lewat earphone fisik bila ada).
 */
export class SpatialAudioEngine {
  private readonly ctx: AudioContext;
  private readonly masterGain: GainNode;
  private readonly onError?: SpatialAudioEngineOptions['onError'];
  private readonly voices = new Map<string, PeerVoice>();
  private readonly positions = new Map<string, Position>();
  private readonly listenerSync: AudioListenerSync;
  private readonly panningModel: PanningModelType;
  private readonly distanceModel: DistanceModelType;
  private readonly refDistance: number;
  private readonly maxDistance: number;
  private readonly rolloffFactor: number;
  private masterVolume = 1;
  private muted = false;
  private disposed = false;

  constructor(options: SpatialAudioEngineOptions = {}) {
    this.onError = options.onError;
    this.panningModel = options.panningModel ?? PANNER_PANNING_MODEL;
    this.distanceModel = options.distanceModel ?? PANNER_DISTANCE_MODEL;
    this.refDistance = options.refDistance ?? PANNER_REF_DISTANCE;
    this.maxDistance = options.maxDistance ?? PANNER_MAX_DISTANCE;
    this.rolloffFactor = options.rolloffFactor ?? PANNER_ROLLOFF_FACTOR;
    this.ctx = (options.createAudioContext ?? defaultAudioContextFactory)();
    this.masterGain = this.ctx.createGain();
    this.masterGain.connect(this.ctx.destination);
    this.listenerSync = new AudioListenerSync(this.ctx.listener);
  }

  /** Sinkronisasi telinga lokal — panggil setiap posisi/yaw lokal berubah. */
  get listener(): AudioListenerSync {
    return this.listenerSync;
  }

  /** State AudioContext ('suspended' | 'running' | 'closed'). */
  get contextState(): AudioContextState {
    return this.ctx.state;
  }

  get isMuted(): boolean {
    return this.muted;
  }

  get isDisposed(): boolean {
    return this.disposed;
  }

  get peerVoiceIds(): string[] {
    return [...this.voices.keys()];
  }

  hasPeerVoice(sessionId: string): boolean {
    return this.voices.has(sessionId);
  }

  /** Posisi peer terakhir yang diketahui engine (sudah di-clamp), atau null. */
  getPeerPosition(sessionId: string): Position | null {
    const position = this.positions.get(sessionId);
    return position === undefined ? null : { ...position };
  }

  /**
   * Mendaftarkan suara remote peer. Posisi yang sudah diketahui sebelumnya
   * langsung diterapkan ke panner.
   */
  addPeerVoice(sessionId: string, stream: MediaStream): void {
    this.assertNotDisposed();
    if (this.voices.has(sessionId)) {
      throw new Error(`voice peer ${sessionId} sudah terdaftar`);
    }
    const source = this.ctx.createMediaStreamSource(stream);
    const panner = this.ctx.createPanner();
    panner.panningModel = this.panningModel;
    panner.distanceModel = this.distanceModel;
    panner.refDistance = this.refDistance;
    panner.maxDistance = this.maxDistance;
    panner.rolloffFactor = this.rolloffFactor;
    const known = this.positions.get(sessionId);
    if (known !== undefined) {
      const xyz = worldToAudioXYZ(known);
      applySpatialPosition(panner, xyz.x, xyz.y, xyz.z);
    }
    source.connect(panner);
    panner.connect(this.masterGain);
    this.voices.set(sessionId, { source, panner });
  }

  /** Melepas suara peer (idempoten — aman dipanggil setelah dispose). */
  removePeerVoice(sessionId: string): void {
    const voice = this.voices.get(sessionId);
    if (voice === undefined) {
      return;
    }
    this.voices.delete(sessionId);
    this.positions.delete(sessionId);
    try {
      voice.source.disconnect();
      voice.panner.disconnect();
    } catch (error) {
      this.onError?.('remove-peer-voice', error);
    }
  }

  /**
   * Memperbarui posisi peer. Bisa dipanggil sebelum addPeerVoice — posisi
   * disimpan dan diterapkan begitu suaranya terdaftar.
   */
  setPeerPosition(sessionId: string, position: Position): void {
    this.assertNotDisposed();
    const sanitized = sanitizePosition(position);
    this.positions.set(sessionId, sanitized);
    const voice = this.voices.get(sessionId);
    if (voice === undefined) {
      return;
    }
    const xyz = worldToAudioXYZ(sanitized);
    applySpatialPosition(voice.panner, xyz.x, xyz.y, xyz.z);
  }

  /** Volume master 0..1 (di-clamp); tidak berlaku saat muted. */
  setMasterVolume(volume: number): void {
    this.assertNotDisposed();
    this.masterVolume = Math.min(1, Math.max(0, volume));
    if (!this.muted) {
      this.masterGain.gain.value = this.masterVolume;
    }
  }

  /** Mute lokal: gain 0 tanpa membongkar panner; unmute mengembalikan volume. */
  setMuted(muted: boolean): void {
    this.assertNotDisposed();
    this.muted = muted;
    this.masterGain.gain.value = muted ? 0 : this.masterVolume;
  }

  /** Melanjutkan rendering audio (wajib dipanggil dari gesture user di browser). */
  async resume(): Promise<void> {
    this.assertNotDisposed();
    await this.ctx.resume();
  }

  async suspend(): Promise<void> {
    this.assertNotDisposed();
    await this.ctx.suspend();
  }

  /** Menutup seluruh engine (idempoten). removePeerVoice tetap aman setelahnya. */
  async dispose(): Promise<void> {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    for (const sessionId of [...this.voices.keys()]) {
      this.removePeerVoice(sessionId);
    }
    try {
      this.masterGain.disconnect();
    } catch (error) {
      this.onError?.('dispose-master-gain', error);
    }
    if (this.ctx.state !== 'closed') {
      try {
        await this.ctx.close();
      } catch (error) {
        this.onError?.('close-context', error);
      }
    }
  }

  private assertNotDisposed(): void {
    if (this.disposed) {
      throw new Error('SpatialAudioEngine sudah di-dispose');
    }
  }
}
