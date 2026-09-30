import type { RealtimeChannel } from '@supabase/supabase-js';
import { Emitter } from '../lib/typed-emitter';
import { defaultBlockListProvider, type BlockListProvider } from './block-muting';
import { PeerConnectionManager, type PeerConnectionFactory } from './peer-connection-manager';
import { isSelectedPairRelay, type SelectedPairInfo } from './relay-stats';
import { SignalingClient } from './signaling-client';
import {
  MAX_ROOM_SIZE,
  PROTOCOL_VERSION,
  RoomCodeSchema,
  SessionInfoSchema,
  clampPosition,
  normalizeRoomCode,
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
  /**
   * Penyedia daftar blokir untuk block-muting mesh (remediasi 25-c M4).
   * Default: fetchOwnBlockedPeerIds lewat klien supabase yang sama BILA
   * klien itu punya kemampuan query (.from/.auth — SupabaseClient asli);
   * klien tanpa kemampuan query (fake test) → fitur mati (bukan error).
   * Suntik eksplisit untuk test: `() => Promise.resolve(new Set([...]))`.
   */
  blockListProvider?: BlockListProvider;
  /** Jam injeksi untuk test. */
  now?: () => number;
}

type JoinState = 'idle' | 'joined' | 'left';

/** Umur maksimum sinyal tertahan (peer tak dikenal) sebelum dibersihkan. */
const PENDING_SIGNAL_TTL_MS = 10_000;
/** Batas antrean per peer — sinyal lebih lama dibuang (terlama duluan). */
const PENDING_SIGNAL_MAX_PER_PEER = 50;

/**
 * Batas antrean per pengirim TAK DIKENAL (remediasi 25-c, from-roster
 * check): lebih ketat dari peer yang sudah terlihat — race presence-signal
 * nyata hanya mengantre beberapa pesan (1 offer + segelintir kandidat),
 * sementara penyerang bisa mengirim offer 128 KiB (cap SDP) per pesan.
 */
const PENDING_SIGNAL_MAX_PER_UNKNOWN_SENDER = 16;

/**
 * Batas jumlah PENGIRIM berbeda yang boleh tertahan di antrean pending
 * (remediasi 25-c, from-roster check). Room sah ≤ 7 remote peer; 16 memberi
 * margin 2x — pengirim tak dikenal ke-17 dan seterusnya DI-DROP + trail.
 */
const PENDING_UNKNOWN_SENDER_MAX = 16;

/** Batas hardcoded jumlah sessionId yang pernah terlihat (anti-bocor memori). */
const SEEN_SESSIONS_MAX = 1_024;

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
  /**
   * sessionId yang PERNAH terlihat di presence (remediasi 25-c, from-roster
   * check) — pengirim dari luar kumpulan ini (dan di luar roster/handshake
   * saat ini) dianggap tak dikenal. Hanya terisi dari key presence server
   * (integritas key==sessionId divalidasi readPresence) — tidak bisa
   * dibanjiri penyerang lewat broadcast.
   */
  private readonly seenSessions = new Set<string>();
  /** Penyedia daftar blokir (block-muting 25-c M4) — undefined = fitur mati. */
  private readonly blockListProvider: BlockListProvider | undefined;
  /** UserId yang diblokir (cache hasil provider) — kosong = tidak ada mute. */
  private blockedUserIds = new Set<string>();

  constructor(options: MeshRoomControllerOptions) {
    super();
    // P0-1: input dinormalisasi dulu (uppercase + strip + O/I/L → 0/1/1 —
    // aturan identik dengan SQL normalize_room_code) supaya topic channel
    // SELALU cocok dengan kode yang disimpan server di room_participants.
    const roomCode = RoomCodeSchema.safeParse(normalizeRoomCode(options.roomCode));
    if (!roomCode.success) {
      throw new Error(
        `room code tidak valid: ${options.roomCode} (harus 8 karakter [0-9A-Z] tanpa I/L/O/U)`,
      );
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
    // Block-muting (25-c M4): provider default = fetchOwnBlockedPeerIds atas
    // klien yang sama BILA klien punya kemampuan query (SupabaseClient asli);
    // fake unit test tanpa .from/.auth → undefined → fitur mati (aman).
    this.blockListProvider =
      options.blockListProvider ?? defaultBlockListProvider(options.supabase);
    // P0-1: channel PRIVATE — server menolak subscribe tanpa tiket
    // kepesertaan (RLS realtime.messages, 0017). Subscribe tanpa otorisasi
    // → CHANNEL_ERROR "Unauthorized: You do not have permissions to read
    // from this Channel topic: room:{kode}" → SDP/ICE (IP) tidak bocor.
    // Topic MEMAKAI kode ternormalisasi (roomCode.data) supaya selalu cocok
    // dengan kode yang disimpan server di room_participants.
    this.channel = options.supabase.channel(`room:${roomCode.data}`, {
      config: { private: true, presence: { key: this.self.sessionId } },
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
   * Melempar bila subscribe gagal (CHANNEL_ERROR/TIMED_OUT/CLOSED) atau
   * track gagal, atau bila room-full auto-leave menang di sela track
   * (audit 23-b M1/M3).
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
    try {
      await new Promise<void>((resolve, reject) => {
        this.channel.subscribe((status, err) => {
          if (status === 'SUBSCRIBED') {
            resolve();
          } else if (
            // Audit 23-b M1: 'CLOSED' (channel ditutup pihak server saat join
            // berjalan) HARUS ditangani — tanpa ini Promise tidak pernah
            // settle dan await join() menggantung selamanya.
            status === 'CHANNEL_ERROR' ||
            status === 'TIMED_OUT' ||
            status === 'CLOSED'
          ) {
            reject(
              new Error(`gagal subscribe channel room: ${status}${err ? ` — ${String(err)}` : ''}`),
            );
          }
        });
      });
    } catch (error) {
      // Audit 23-b M2: jangan bocorkan channel + handler presence pada join
      // yang gagal — tanpa ini setiap retry join menambah satu channel hidup
      // di client Supabase bersama (kebocoran memori sesi panjang).
      this.signaling.unbind();
      try {
        await this.channel.unsubscribe();
      } catch {
        // best-effort — removeChannel tetap di bawah
      }
      if (typeof this.supabase.removeChannel === 'function') {
        try {
          await this.supabase.removeChannel(this.channel);
        } catch {
          // best-effort
        }
      }
      throw error;
    }
    this.state = 'joined';
    // Block-muting (25-c M4): muat daftar blokir SEKALI per join — tanpa
    // await (fail-open): presence sync pertama bisa menyala sebelum fetch
    // selesai; applyBlockList setelah fetch menutup peer yang terlanjur
    // terhubung, connectPeer memeriksa cache untuk peer berikutnya.
    void this.refreshBlockedPeers();
    const tracked = await this.channel.track({ ...this.self });
    // Audit 23-b M3: auto-leave room-full bisa menang di sela await track()
    // (presence sync server tiba setelah subscribe). Tanpa cek ulang ini,
    // join() resolve SUKSES untuk controller yang sudah 'left' — pemanggil
    // mengira join berhasil padahal channel sudah dibuang.
    if (this.state !== 'joined') {
      throw new Error('room penuh: keluar otomatis selama join (presence sync)');
    }
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

  /**
   * Apakah sebuah peer sedang di-mute karena block-list (25-c M4).
   * Peer tak dikenal → false.
   */
  isPeerMuted(sessionId: string): boolean {
    return this.manager.isPeerMuted(sessionId);
  }

  /**
   * Memuat ulang daftar blokir + menerapkannya ke semua peer saat ini
   * (block-muting 25-c M4). Dipanggil otomatis saat join; panggil manual
   * setelah user memblokir/membuka blokir di tengah sesi. FAIL-OPEN:
   * kegagalan provider → daftar dianggap kosong + log — join mesh tidak
   * pernah terganggu. Tidak pernah melempar.
   */
  async refreshBlockedPeers(): Promise<void> {
    if (this.blockListProvider === undefined) {
      return; // fitur mati (klien tanpa kemampuan query / tidak di-inject)
    }
    let blocked: Set<string>;
    try {
      blocked = await this.blockListProvider();
    } catch (error) {
      // Fail-open + log (mandat 25-c M4): anggap kosong.
      console.warn(
        '[mesh] blockListProvider melempar — daftar blokir dianggap kosong (fail-open):',
        error instanceof Error ? error.message : String(error),
      );
      blocked = new Set();
    }
    if (this.state !== 'joined') {
      return; // leave terjadi di sela fetch — jangan sentuh peer yang sudah dibuang
    }
    this.blockedUserIds = blocked;
    this.applyBlockList();
  }

  /** Menerapkan block-list saat ini ke semua peer terhubang + event trail. */
  private applyBlockList(): void {
    for (const sessionId of this.manager.sessionIds()) {
      const session = this.manager.getSession(sessionId);
      if (session === null) {
        continue;
      }
      this.applyMuteForSession(session);
    }
  }

  /** Mute/unmute satu peer sesuai block-list + pancarkan event (trail). */
  private applyMuteForSession(session: SessionInfo): void {
    const shouldMute = this.blockedUserIds.has(session.userId);
    if (this.manager.isPeerMuted(session.sessionId) === shouldMute) {
      return; // tidak berubah — tidak ada event derau
    }
    this.manager.setPeerMuted(session.sessionId, shouldMute);
    this.emit('peer-muted', { sessionId: session.sessionId, muted: shouldMute });
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
        //
        // FROM-ROSTER CHECK (remediasi 25-c, spoofing insider LOW): pesan
        // dari pengirim TAK DIKENAL — bukan di roster presence, bukan pula
        // sedang handshake/pending-dial (manager/pendingSignals), dan tidak
        // pernah terlihat di presence (seenSessions) — di-DROP + trail
        // bila buffer pending sudah penuh pengirim berbeda. Pesan PERTAMA
        // dari pengirim baru tetap diantrekan (dengan batas ketat per
        // pengirim) supaya race presence-ADD yang terdokumentasi tidak
        // pecah — pengirim yang sah akan segera muncul di presence dan
        // meng-flush antreannya; pengirim fiktif tidak pernah muncul dan
        // antreannya TTL 10 s.
        if (
          !this.seenSessions.has(message.from) &&
          !this.pendingSignals.has(message.from) &&
          this.pendingSignals.size >= PENDING_UNKNOWN_SENDER_MAX
        ) {
          this.emit('invalid-signal', {
            reason:
              `from-roster check: pesan dari ${message.from} di-drop — ` +
              `pengirim tak dikenal (bukan roster presence / handshake / pending-dial)`,
          });
          return;
        }
        this.queuePendingSignal(message);
        return;
      }
      this.rememberSeenSession(message.from);
      // Audit 23-b M6: jalur self-heal ini TIDAK boleh melampaui kapasitas
      // mesh — addPeer MELEMPAR saat penuh dan exception dari handler
      // broadcast menyebar ke dispatcher realtime. Aturan deterministiknya
      // sama dengan handlePresenceSync:MAX_ROOM_SIZE (diri + maks 7 remote).
      if (this.manager.size >= MAX_ROOM_SIZE - 1) {
        return; // di luar kapasitas — abaikan; presence sync tetap otoritatif
      }
      try {
        this.connectPeer(session);
      } catch (error) {
        // Lapisan pertahanan: kegagalan pembuatan PeerConnection (mis. factory
        // melempar) tidak boleh menyebar ke dispatcher broadcast.
        this.emit('error', {
          message: `peer ${message.from}: gagal self-heal connect`,
          ...(error !== undefined ? { cause: error } : {}),
        });
      }
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
    // From-roster check (25-c): pengirim tak dikenal dapat antrean jauh lebih
    // ketat — race sah hanya butuh 1 offer + beberapa kandidat; penyerang
    // bisa mengisi 50 slot dengan SDP 128 KiB per pesan.
    const cap = this.seenSessions.has(message.from)
      ? PENDING_SIGNAL_MAX_PER_PEER
      : PENDING_SIGNAL_MAX_PER_UNKNOWN_SENDER;
    if (queue.length >= cap) {
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
    // From-roster check (25-c): semua key presence sah dicatat sebagai
    // "pernah terlihat" — sinyal dari mereka tetap dipercaya walau presence
    // mereka sempat hilang (blip jaringan) saat sinyal masih di jalur.
    for (const sessionId of sessions.keys()) {
      this.rememberSeenSession(sessionId);
    }
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
    // Posisi terakhir milik sesi yang pergi — dibuang supaya tidak bocor
    // (memori) dan tidak muncul sebagai posisi BASI bila peer yang sama
    // bergabung kembali nanti (Task 11-d).
    this.positions.delete(sessionId);
    this.manager.removePeer(sessionId);
    this.lastEmittedStates.delete(sessionId);
    this.selectedPairs.delete(sessionId);
    this.emit('peer-left', { sessionId });
  }

  private connectPeer(session: SessionInfo): void {
    // sessionId lebih besar = polite (mengalah saat glare), kecil = inisiator.
    const polite = this.self.sessionId > session.sessionId;
    this.manager.addPeer(session, polite);
    // Block-muting (25-c M4): peer baru dicek terhadap cache block-list —
    // mencakup roster ADD maupun sinkronisasi pertama setelah join.
    this.applyMuteForSession(session);
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

  /** Mencatat sessionId terlihat di presence (from-roster check 25-c) — terbatas. */
  private rememberSeenSession(sessionId: string): void {
    if (this.seenSessions.has(sessionId)) {
      return;
    }
    if (this.seenSessions.size >= SEEN_SESSIONS_MAX) {
      // FIFO: Set JavaScript menjaga urutan penyisipan — hapus yang terlama.
      const oldest = this.seenSessions.values().next().value;
      if (oldest !== undefined) {
        this.seenSessions.delete(oldest);
      }
    }
    this.seenSessions.add(sessionId);
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
