import type { RealtimeChannel } from '@supabase/supabase-js';
import { Emitter } from '../lib/typed-emitter';
import { PeerConnectionManager, type PeerConnectionFactory } from './peer-connection-manager';
import { isSelectedPairRelay, type SelectedPairInfo } from './relay-stats';
import { SignalingClient } from './signaling-client';
import {
  MAX_ROOM_SIZE,
  PROTOCOL_VERSION,
  RoomCodeSchema,
  SessionInfoSchema,
  clampPosition,
  type MeshRoomEventMap,
  type PeerState,
  type Position,
  type SessionInfo,
  type SignalMessage,
  type SupabaseRealtimeLike,
} from './types';

export interface MeshRoomControllerOptions {
  /** Klien Supabase (cukup kemampuan channel/removeChannel). */
  supabase: SupabaseRealtimeLike;
  roomCode: string;
  /** Metadata sesi diri sendiri (divalidasi schema). */
  self: SessionInfo;
  iceServers?: RTCIceServer[];
  createPeerConnection?: PeerConnectionFactory;
  /** Jam injeksi untuk test. */
  now?: () => number;
}

type JoinState = 'idle' | 'joined' | 'left';

/** Umur maksimum sinyal tertahan (peer tak dikenal) sebelum dibersihkan. */
const PENDING_SIGNAL_TTL_MS = 10_000;
/** Batas antrean per peer — sinyal lebih lama dibuang (terlama duluan). */
const PENDING_SIGNAL_MAX_PER_PEER = 50;

/**
 * Orkestrator satu room mesh: gabung channel Realtime (broadcast signaling +
 * presence), temukan peer, negosiasikan WebRTC (lewat PeerConnectionManager),
 * dan kelola siklus hidup sampai leave().
 *
 * Aturan kapasitas: maksimum MAX_ROOM_SIZE sesi per room, dipilih deterministik
 * (urutan sessionId terkecil) sehingga semua klien sepakat siapa yang boleh
 * ikut tanpa perlu koordinasi tambahan. Pendatang di luar kapasitas menerima
 * event 'room-full' lalu otomatis leave.
 */
export class MeshRoomController extends Emitter<MeshRoomEventMap> {
  private readonly supabase: SupabaseRealtimeLike;
  private readonly self: SessionInfo;
  private readonly channel: RealtimeChannel;
  private readonly signaling: SignalingClient;
  private readonly manager: PeerConnectionManager;
  private readonly now: () => number;
  private state: JoinState = 'idle';
  private readonly positions = new Map<string, { position: Position; at: number }>();
  /** State terakhir yang dipancarkan per peer — mencegah event ganda dari
   *  pasangan event connectionstatechange + iceconnectionstatechange. */
  private readonly lastEmittedStates = new Map<
    string,
    { connectionState: RTCPeerConnectionState; iceConnectionState: RTCIceConnectionState }
  >();
  /** Cache pasangan terpilih terakhir per peer (Task 11-b) — diumpan ke
   *  snapshot PeerState.selectedPair; dibersihkan saat peer dilepas. */
  private readonly selectedPairs = new Map<string, SelectedPairInfo>();

  constructor(options: MeshRoomControllerOptions) {
    super();
    const roomCode = RoomCodeSchema.safeParse(options.roomCode);
    if (!roomCode.success) {
      throw new Error(`room code tidak valid: ${options.roomCode} (harus [a-z0-9]{4,12})`);
    }
    const self = SessionInfoSchema.safeParse(options.self);
    if (!self.success) {
      throw new Error(
        `metadata sesi tidak valid: ${self.error.issues.map((i) => i.message).join('; ')}`,
      );
    }
    this.supabase = options.supabase;
    this.self = self.data;
    this.now = options.now ?? Date.now;
    this.channel = options.supabase.channel(`room:${options.roomCode}`, {
      config: { presence: { key: this.self.sessionId } },
    });
    this.signaling = new SignalingClient({
      channel: this.channel,
      selfSessionId: this.self.sessionId,
      onMessage: (message) => this.handleSignal(message),
      onInvalid: (reason) => this.emit('invalid-signal', { reason }),
      onSendError: (response) =>
        this.emit('error', { message: `pengiriman signaling tidak ok: ${response}` }),
    });
    this.manager = new PeerConnectionManager({
      selfSessionId: this.self.sessionId,
      iceServers: options.iceServers,
      createPeerConnection: options.createPeerConnection,
      onOutgoingSignal: (message) => this.signaling.send(message),
      onTrack: (sessionId, track, stream) =>
        this.emit('remote-stream', { sessionId, track, stream }),
      onConnectionState: (sessionId, connectionState, iceConnectionState) => {
        const last = this.lastEmittedStates.get(sessionId);
        if (
          last !== undefined &&
          last.connectionState === connectionState &&
          last.iceConnectionState === iceConnectionState
        ) {
          return;
        }
        this.lastEmittedStates.set(sessionId, { connectionState, iceConnectionState });
        const peer = this.buildPeerState(sessionId);
        if (peer !== null) {
          this.emit('peer-state', { peer });
        }
      },
      onPosition: (sessionId, position) => this.handleRemotePosition(sessionId, position),
      onInvalidPosition: (sessionId, reason) =>
        this.emit('invalid-position', { sessionId, reason }),
      onSelectedPair: (sessionId, pair) => {
        this.selectedPairs.set(sessionId, pair);
        this.emit('selected-pair', {
          sessionId,
          pair,
          viaRelay: isSelectedPairRelay(pair),
        });
      },
      onError: (sessionId, context, error) =>
        this.emit('error', {
          message: `peer ${sessionId}: kegagalan ${context}`,
          ...(error !== undefined ? { cause: error } : {}),
        }),
    });
  }

  // ============================================================
  // Siklus hidup
  // ============================================================

  /**
   * Berlangganan channel room + mulai melacak presence.
   * Melempar bila subscribe gagal (CHANNEL_ERROR/TIMED_OUT) atau track gagal.
   */
  async join(): Promise<void> {
    if (this.state === 'joined') {
      throw new Error('sudah join');
    }
    if (this.state === 'left') {
      throw new Error('controller sudah leave — buat instance baru untuk join lagi');
    }
    this.signaling.bind();
    this.channel.on('presence', { event: 'sync' }, () => this.handlePresenceSync());
    await new Promise<void>((resolve, reject) => {
      this.channel.subscribe((status, err) => {
        if (status === 'SUBSCRIBED') {
          resolve();
        } else if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT') {
          reject(
            new Error(`gagal subscribe channel room: ${status}${err ? ` — ${String(err)}` : ''}`),
          );
        }
      });
    });
    this.state = 'joined';
    const tracked = await this.channel.track({ ...this.self });
    if (tracked !== 'ok') {
      await this.leave();
      throw new Error(`gagal melacak presence: ${tracked}`);
    }
  }

  /** Keluar room: broadcast bye, tutup semua peer, lepas presence + channel. */
  async leave(): Promise<void> {
    if (this.state === 'left') {
      return;
    }
    const wasJoined = this.state === 'joined';
    this.state = 'left';
    this.pendingSignals.clear();
    if (wasJoined) {
      this.signaling.send({ v: PROTOCOL_VERSION, type: 'bye', from: this.self.sessionId, to: '*' });
    }
    for (const sessionId of this.manager.sessionIds()) {
      this.dropPeer(sessionId);
    }
    this.signaling.unbind();
    try {
      await this.channel.untrack();
    } catch {
      // upaya terakhir — biarkan removeChannel yang membersihkan
    }
    try {
      await this.channel.unsubscribe();
    } catch {
      // idem
    }
    if (typeof this.supabase.removeChannel === 'function') {
      try {
        await this.supabase.removeChannel(this.channel);
      } catch {
        // idem
      }
    }
  }

  // ============================================================
  // API untuk pemanggil (harness F1.6 / UI Fase 3)
  // ============================================================

  /** Memasang stream mikrofon lokal ke semua peer (bisa dipanggil ulang). */
  attachLocalStream(stream: MediaStream): void {
    this.manager.attachLocalStream(stream);
  }

  /** Melepas mikrofon lokal (mis. user mute permanen / keluar ruang suara). */
  detachLocalStream(): void {
    this.manager.detachLocalStream();
  }

  /**
   * Memperbarui posisi diri sendiri (dipanggil sesering apa pun oleh input —
   * throttle 15 Hz per peer ada di DataChannelSync). Nilianya di-clamp ke
   * batas dunia supaya payload selalu kecil dan masuk akal.
   */
  setLocalPosition(position: Position): void {
    this.manager.sendPositionToAll(clampPosition(position));
  }

  /** Snapshot semua remote peer beserta kondisi koneksi + posisi terakhir. */
  getPeers(): PeerState[] {
    const peers: PeerState[] = [];
    for (const sessionId of this.manager.sessionIds()) {
      const peer = this.buildPeerState(sessionId);
      if (peer !== null) {
        peers.push(peer);
      }
    }
    return peers;
  }

  get roomSize(): number {
    return this.manager.size + 1;
  }

  // ============================================================
  // Internal
  // ============================================================

  private handleSignal(message: SignalMessage): void {
    if (message.type === 'bye') {
      if (this.manager.has(message.from)) {
        this.dropPeer(message.from);
      }
      return;
    }
    if (!this.manager.has(message.from)) {
      // Self-heal race presence/signal: peer valid di presence tapi belum
      // sempat didaftarkan oleh sync → daftarkan sekarang, lalu proses pesan.
      const session = this.readPresence().get(message.from);
      if (session === undefined) {
        // Race e2e F1.6: broadcast bisa tiba SEBELUM presence sync selesai
        // (subscribe+track lebih dulu, sync ~1-2 s belakangan). Membuang
        // offer/kandidat di sini = deadlock negosiasi — antrekan, nanti
        // di-flush saat peer benar-benar terdaftar lewat connectPeer.
        this.queuePendingSignal(message);
        return;
      }
      this.connectPeer(session);
    }
    this.manager.handleSignal(message);
  }

  /** Antrean pesan signaling dari peer yang belum terdaftar (race presence). */
  private readonly pendingSignals = new Map<string, { at: number; message: SignalMessage }[]>();

  private queuePendingSignal(message: SignalMessage): void {
    const now = this.now();
    this.sweepPendingSignals(now);
    let queue = this.pendingSignals.get(message.from);
    if (queue === undefined) {
      queue = [];
      this.pendingSignals.set(message.from, queue);
    }
    if (queue.length >= PENDING_SIGNAL_MAX_PER_PEER) {
      queue.shift(); // terbatas — buang yang terlama
    }
    queue.push({ at: now, message });
  }

  private sweepPendingSignals(now: number): void {
    for (const [sessionId, queue] of this.pendingSignals) {
      const alive = queue.filter((entry) => now - entry.at <= PENDING_SIGNAL_TTL_MS);
      if (alive.length === 0) {
        this.pendingSignals.delete(sessionId);
      } else {
        this.pendingSignals.set(sessionId, alive);
      }
    }
  }

  private handlePresenceSync(): void {
    if (this.state !== 'joined') {
      return;
    }
    const sessions = this.readPresence();
    const ids = [...sessions.keys()].sort();
    let allowed: Set<string> | null = null;
    if (ids.length > MAX_ROOM_SIZE) {
      const allowedSet = new Set(ids.slice(0, MAX_ROOM_SIZE));
      if (!allowedSet.has(this.self.sessionId)) {
        this.emit('room-full', { size: ids.length, max: MAX_ROOM_SIZE });
        void this.leave();
        return;
      }
      allowed = allowedSet;
    }
    for (const [sessionId, session] of sessions) {
      if (sessionId === this.self.sessionId) {
        continue;
      }
      if (allowed !== null && !allowed.has(sessionId)) {
        continue; // di luar kapasitas — abaikan secara deterministik
      }
      if (!this.manager.has(sessionId)) {
        this.connectPeer(session);
      }
    }
    for (const sessionId of this.manager.sessionIds()) {
      if (!sessions.has(sessionId)) {
        this.dropPeer(sessionId);
      }
    }
  }

  /** Melepas peer + membersihkan cache + memancarkan peer-left. */
  private dropPeer(sessionId: string): void {
    this.pendingSignals.delete(sessionId);
    this.manager.removePeer(sessionId);
    this.lastEmittedStates.delete(sessionId);
    this.selectedPairs.delete(sessionId);
    this.emit('peer-left', { sessionId });
  }

  private connectPeer(session: SessionInfo): void {
    // sessionId lebih besar = polite (mengalah saat glare), kecil = inisiator.
    const polite = this.self.sessionId > session.sessionId;
    this.manager.addPeer(session, polite);
    const queued = this.pendingSignals.get(session.sessionId);
    this.pendingSignals.delete(session.sessionId);
    const peer = this.buildPeerState(session.sessionId);
    if (peer !== null) {
      this.emit('peer-joined', { peer });
    }
    // Flush sinyal yang sempat tertahan saat race presence — urutan terjaga.
    if (queued !== undefined) {
      for (const entry of queued) {
        this.manager.handleSignal(entry.message);
      }
    }
  }

  /** Membaca + memvalidasi presence state channel menjadi Map<sessionId, SessionInfo>. */
  private readPresence(): Map<string, SessionInfo> {
    const result = new Map<string, SessionInfo>();
    const raw = this.channel.presenceState();
    for (const [key, metas] of Object.entries(raw)) {
      const meta = metas?.[0];
      if (meta === undefined) {
        continue;
      }
      const parsed = SessionInfoSchema.safeParse(meta);
      if (!parsed.success) {
        continue; // payload presence tidak dikenali — abaikan
      }
      if (parsed.data.sessionId !== key) {
        continue; // integrity: key presence harus cocok sessionId payload
      }
      result.set(key, parsed.data);
    }
    return result;
  }

  private handleRemotePosition(sessionId: string, position: Position): void {
    const receivedAt = this.now();
    this.positions.set(sessionId, { position, at: receivedAt });
    this.emit('remote-position', { sessionId, position, receivedAt });
  }

  private buildPeerState(sessionId: string): PeerState | null {
    const session = this.manager.getSession(sessionId);
    if (session === null) {
      return null;
    }
    const last = this.positions.get(sessionId) ?? null;
    return {
      sessionId,
      session,
      connectionState: this.manager.getConnectionState(sessionId) ?? 'closed',
      iceConnectionState: this.manager.getIceConnectionState(sessionId) ?? 'closed',
      lastPosition: last?.position ?? null,
      lastPositionAt: last?.at ?? null,
      selectedPair: this.selectedPairs.get(sessionId) ?? null,
    };
  }
}
