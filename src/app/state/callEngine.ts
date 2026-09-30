/**
 * Mesin panggilan — orkestrasi satu sesi voice room:
 *   RoomGate (tiket server) → MeshRoomController (WebRTC mesh) → mic +
 *   SpatialAudioEngine (HRTF per peer) + meter level suara (indikator bicara)
 *   + ICE bootstrap: TURN ephemeral (Edge Function) → fallback statis → STUN.
 *
 * Kelas murni di luar React; CallProvider menyambungkannya ke UI lewat
 * subscribe() + tick render. Satu instance per sesi login (ref di provider).
 */
import { SpatialAudioEngine } from '../../audio/spatial-audio-engine';
import { MeshRoomController } from '../../webrtc/mesh-room-controller';
import { RoomGate } from '../../webrtc/room-gate';
import { resolveEphemeralTurn, resolveIceServers } from '../../webrtc/turn-config';
import type { PeerState, Position, SessionInfo } from '../../webrtc/types';
import { sb } from '../lib/services';

export type CallStatus = 'idle' | 'connecting' | 'ringing' | 'active';
export type IceMode = 'ephemeral-turn' | 'static-turn' | 'stun';

export interface CallSnapshot {
  status: CallStatus;
  code: string | null;
  self: SessionInfo | null;
  peers: PeerState[];
  micMuted: boolean;
  deafened: boolean;
  /** false bila device mikrofon tidak tersedia (mode dengar-saja). */
  micAvailable: boolean;
  selfPosition: Position | null;
  startedAt: number | null;
  error: string | null;
  selfSpeaking: boolean;
  speaking: ReadonlySet<string>;
  ice: IceMode;
}

interface Meter {
  analyser: AnalyserNode;
  buf: Float32Array<ArrayBuffer>;
}

const SPEAK_RMS_THRESHOLD = 0.045;
const METER_INTERVAL_MS = 150;
/** Batas panggung spasial (meter dunia; ± audio identitas koordinat). */
export const STAGE_BOUND_M = 2.4;

export class CallEngine {
  #gate: RoomGate | null = null;
  #controller: MeshRoomController | null = null;
  #mic: MediaStream | null = null;
  #spatial: SpatialAudioEngine | null = null;
  #meterCtx: AudioContext | null = null;
  #zeroGain: GainNode | null = null;
  #meters = new Map<string, Meter>();
  #listeners = new Set<() => void>();
  #speakTimer: number | null = null;

  #status: CallStatus = 'idle';
  #code: string | null = null;
  #self: SessionInfo | null = null;
  #micMuted = false;
  #deafened = false;
  #micAvailable = true;
  #selfPosition: Position = { x: 0, y: 0 };
  #startedAt: number | null = null;
  #error: string | null = null;
  #selfSpeaking = false;
  #speaking = new Set<string>();
  #ice: IceMode = 'stun';

  get snapshot(): CallSnapshot {
    return {
      status: this.#status,
      code: this.#code,
      self: this.#self,
      peers: this.#controller?.getPeers() ?? [],
      micMuted: this.#micMuted,
      deafened: this.#deafened,
      micAvailable: this.#micAvailable,
      selfPosition: this.#selfPosition,
      startedAt: this.#startedAt,
      error: this.#error,
      selfSpeaking: this.#selfSpeaking,
      speaking: this.#speaking,
      ice: this.#ice,
    };
  }

  subscribe(fn: () => void): () => void {
    this.#listeners.add(fn);
    return () => {
      this.#listeners.delete(fn);
    };
  }

  #notify(): void {
    for (const fn of this.#listeners) fn();
  }

  /**
   * Memulai sesi: resolve ICE → gate (create/join) → mic → controller.join
   * → pasang stream. Melempar Error berbahasa Indonesia pada kegagalan;
   * state internal selalu dibersihkan jalur catch.
   */
  async start(opts: { mode: 'create' | 'join'; code?: string; self: SessionInfo }): Promise<void> {
    if (this.#controller !== null) throw new Error('masih di dalam room — keluar dulu');
    this.#status = 'connecting';
    this.#error = null;
    this.#self = opts.self;
    this.#notify();

    let gate: RoomGate | null = null;
    let controller: MeshRoomController | null = null;
    let mic: MediaStream | null = null;
    let spatial: SpatialAudioEngine | null = null;
    try {
      // 1) ICE — ephemeral TURN bila Edge Function terpasang.
      let iceServers: RTCIceServer[] | undefined;
      const ephemeralUrl = import.meta.env.VITE_TURN_EPHEMERAL_URL;
      if (typeof ephemeralUrl === 'string' && ephemeralUrl !== '') {
        const { data } = await sb().auth.getSession();
        const token = data.session?.access_token ?? '';
        if (token !== '') {
          const ephemeral = await resolveEphemeralTurn({
            url: ephemeralUrl,
            getAccessToken: async () => token,
          });
          if (ephemeral !== null) {
            iceServers = [ephemeral];
            this.#ice = 'ephemeral-turn';
          }
        }
      }
      if (iceServers === undefined) {
        const resolved = resolveIceServers();
        iceServers = resolved.iceServers;
        this.#ice = resolved.turnStatus === 'enabled' ? 'static-turn' : 'stun';
      }

      // 2) Tiket room server-side (P0-1).
      gate = new RoomGate({
        supabase: sb(),
        onHeartbeatError: (error) => console.warn('[goofy] heartbeat room gagal:', error),
      });
      const code =
        opts.mode === 'create'
          ? await gate.createRoom()
          : await gate.joinRoom(opts.code === undefined ? '' : opts.code);
      this.#code = code;
      this.#notify();

      // 3) Mikrofon — bila device tidak ada/ditolak, lanjut MODE DENGAR-SAJA
      //    (lebih berguna daripada memblokir join; UI menampilkan banner).
      try {
        mic = await navigator.mediaDevices.getUserMedia({
          audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
        });
      } catch (error) {
        const name = (error as DOMException).name;
        this.#micAvailable = false;
        console.warn(
          '[goofy] mikrofon tidak tersedia — mode dengar-saja:',
          name,
          error instanceof Error ? error.message : String(error),
        );
      }

      // 4) Audio spasial + meter level.
      spatial = new SpatialAudioEngine();
      if (spatial.contextState === 'suspended') {
        await spatial.resume();
      }
      const meterCtx = new AudioContext();
      const zeroGain = meterCtx.createGain();
      zeroGain.gain.value = 0;
      zeroGain.connect(meterCtx.destination);
      if (meterCtx.state === 'suspended') await meterCtx.resume();
      if (mic !== null) {
        const selfSource = meterCtx.createMediaStreamSource(mic);
        const selfAnalyser = meterCtx.createAnalyser();
        selfAnalyser.fftSize = 512;
        selfSource.connect(selfAnalyser);
        selfAnalyser.connect(zeroGain);
        this.#meters.set('self', {
          analyser: selfAnalyser,
          buf: new Float32Array(selfAnalyser.fftSize),
        });
      }

      // 5) Controller mesh + event wiring.
      const self = opts.self;
      controller = new MeshRoomController({ supabase: sb(), roomCode: code, self, iceServers });
      controller.on('peer-joined', ({ peer }) => {
        void peer;
        this.#markActive();
      });
      controller.on('peer-state', () => this.#notify());
      controller.on('peer-left', ({ sessionId }) => {
        this.#spatial?.removePeerVoice(sessionId);
        this.#meters.delete(sessionId);
        this.#speaking.delete(sessionId);
        this.#notify();
      });
      controller.on('remote-stream', ({ sessionId, stream }) => {
        if (this.#spatial === null || stream === null) return;
        if (!this.#spatial.hasPeerVoice(sessionId)) {
          this.#spatial.addPeerVoice(sessionId, stream);
        }
        if (this.#meterCtx !== null && this.#zeroGain !== null && !this.#meters.has(sessionId)) {
          const source = this.#meterCtx.createMediaStreamSource(stream);
          const analyser = this.#meterCtx.createAnalyser();
          analyser.fftSize = 512;
          source.connect(analyser);
          analyser.connect(this.#zeroGain);
          this.#meters.set(sessionId, { analyser, buf: new Float32Array(analyser.fftSize) });
        }
        this.#notify();
      });
      controller.on('remote-position', ({ sessionId, position }) => {
        this.#spatial?.setPeerPosition(sessionId, position);
        this.#notify();
      });
      controller.on('room-full', ({ size, max }) => {
        this.#error = `room penuh (${String(size)}/${String(max)})`;
        this.#notify();
      });
      controller.on('error', ({ message }) => console.warn('[goofy] mesh:', message));
      controller.on('invalid-signal', ({ reason }) => console.warn('[goofy] sinyal invalid:', reason));

      await controller.join();
      if (mic !== null) controller.attachLocalStream(mic);

      this.#gate = gate;
      this.#controller = controller;
      this.#mic = mic;
      this.#spatial = spatial;
      this.#meterCtx = meterCtx;
      this.#zeroGain = zeroGain;
      this.#selfPosition = { x: 0, y: 0 };
      this.#spatial.listener.update({ x: 0, y: 0 });
      controller.setLocalPosition({ x: 0, y: 0 });
      // Jangan timpa 'active': peer yang sudah lebih dulu ada di room memicu
      // peer-joined (→ markActive) SELAMA await join() — callee langsung aktif.
      if (!this.#isActive()) this.#status = 'ringing';
      this.#startMeterLoop();
      this.#notify();
    } catch (error) {
      // Bersihkan semua sumber daya setengah-jalan.
      this.#stopMeterLoop();
      for (const track of mic?.getTracks() ?? []) track.stop();
      try {
        await controller?.leave();
      } catch {
        // best-effort
      }
      gate?.dispose();
      try {
        await spatial?.dispose();
      } catch {
        // best-effort
      }
      await meterCtxClose(this.#meterCtx);
      this.#meterCtx = null;
      this.#zeroGain = null;
      this.#meters.clear();
      this.#spatial = null;
      this.#mic = null;
      this.#controller = null;
      this.#gate = null;
      this.#code = null;
      this.#status = 'idle';
      this.#error = null;
      this.#speaking.clear();
      this.#selfSpeaking = false;
      this.#startedAt = null;
      this.#micAvailable = true;
      this.#notify();
      throw error instanceof Error ? error : new Error(String(error));
    }
  }

  /** Keluar room + bersihkan semua sumber daya. Aman dipanggil berulang. */
  async leave(): Promise<void> {
    const controller = this.#controller;
    const gate = this.#gate;
    const mic = this.#mic;
    const spatial = this.#spatial;
    this.#stopMeterLoop();
    for (const track of mic?.getTracks() ?? []) track.stop();
    this.#meters.clear();
    this.#speaking.clear();
    this.#selfSpeaking = false;
    this.#controller = null;
    this.#gate = null;
    this.#mic = null;
    this.#spatial = null;
    const ctx = this.#meterCtx;
    this.#meterCtx = null;
    this.#zeroGain = null;
    this.#code = null;
    this.#status = 'idle';
    this.#startedAt = null;
    this.#micMuted = false;
    this.#deafened = false;
    this.#micAvailable = true;
    this.#error = null;
    this.#notify();
    try {
      await controller?.leave();
    } catch {
      // best-effort
    }
    try {
      await gate?.leaveRoom();
    } catch {
      // TTL server membersihkan tiket sisa.
    }
    try {
      await spatial?.dispose();
    } catch {
      // best-effort
    }
    await meterCtxClose(ctx);
  }

  setMicMuted(muted: boolean): void {
    this.#micMuted = muted;
    for (const track of this.#mic?.getTracks() ?? []) track.enabled = !muted;
    this.#notify();
  }

  /** Deafen = bisukan semua audio remote + (konvensi chat) matikan mic juga. */
  setDeafened(deafened: boolean): void {
    this.#deafened = deafened;
    this.#spatial?.setMuted(deafened);
    this.setMicMuted(deafened);
  }

  /** Gerakkan posisi diri (meter dunia, dipanggil dari drag panggung). */
  moveSelf(x: number, y: number): void {
    const bx = Math.max(-STAGE_BOUND_M, Math.min(STAGE_BOUND_M, x));
    const by = Math.max(-STAGE_BOUND_M, Math.min(STAGE_BOUND_M, y));
    this.#selfPosition = { x: bx, y: by };
    this.#spatial?.listener.update(this.#selfPosition);
    this.#controller?.setLocalPosition(this.#selfPosition);
    this.#notify();
  }

  #markActive(): void {
    if (this.#status === 'active') return;
    this.#status = 'active';
    this.#startedAt = Date.now();
    this.#notify();
  }

  /** Pembacaan lewat method — mencegah narrowing TS yang salah atas
   *  mutasi #status oleh event handler selama await (callee langsung aktif). */
  #isActive(): boolean {
    return this.#status === 'active';
  }

  #startMeterLoop(): void {
    this.#stopMeterLoop();
    this.#speakTimer = window.setInterval(() => {
      let changed = false;
      const selfMeter = this.#meters.get('self');
      if (selfMeter !== undefined) {
        const speaking = rmsOf(selfMeter) >= SPEAK_RMS_THRESHOLD;
        if (speaking !== this.#selfSpeaking) {
          this.#selfSpeaking = speaking;
          changed = true;
        }
      }
      for (const [sessionId, meter] of this.#meters) {
        if (sessionId === 'self') continue;
        const speaking = rmsOf(meter) >= SPEAK_RMS_THRESHOLD;
        if (speaking !== this.#speaking.has(sessionId)) {
          if (speaking) this.#speaking.add(sessionId);
          else this.#speaking.delete(sessionId);
          changed = true;
        }
      }
      if (changed) this.#notify();
    }, METER_INTERVAL_MS);
  }

  #stopMeterLoop(): void {
    if (this.#speakTimer !== null) {
      window.clearInterval(this.#speakTimer);
      this.#speakTimer = null;
    }
  }
}

function rmsOf(meter: Meter): number {
  meter.analyser.getFloatTimeDomainData(meter.buf);
  let sum = 0;
  for (const v of meter.buf) sum += v * v;
  return Math.sqrt(sum / meter.buf.length);
}

async function meterCtxClose(ctx: AudioContext | null): Promise<void> {
  try {
    await ctx?.close();
  } catch {
    // best-effort
  }
}
