import { DataChannelSync } from './data-channel-sync';
import { IceRestartHandler } from './ice-restart-handler';
import { pickSelectedPair, type SelectedPairInfo, type StatsEntryLike } from './relay-stats';
import {
  DATA_CHANNEL_LABEL,
  MAX_REMOTE_PEERS,
  PROTOCOL_VERSION,
  type IceSignalMessage,
  type Position,
  type SessionInfo,
  type SignalMessage,
} from './types';

/** STUN publik default — TURN (Metered) menyusul di Fase 2 lewat opsi. */
export const DEFAULT_ICE_SERVERS: RTCIceServer[] = [
  { urls: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302'] },
];

export type PeerConnectionFactory = (config: RTCConfiguration) => RTCPeerConnection;

export const defaultPeerConnectionFactory: PeerConnectionFactory = (config) =>
  new RTCPeerConnection(config);

/**
 * Jeda re-sample pasangan terpilih setelah 'connected' (Task 11-b):
 * nominasi/pemilihan pasangan bisa selesai SETELAH event connected menyala
 * (khususnya jalur TURN yang lambat). Satu kali saja per episode — terbatas,
 * bukan polling. Di-inject lewat opsi selectedPairResampleMs untuk test.
 */
export const DEFAULT_SELECTED_PAIR_RESAMPLE_MS = 1_500;

/**
 * Batas antrean kandidat remote per peer (Task 11-d) — kandidat yang tiba
 * sebelum remoteDescription siap. Kandidat asli dari ICE stack terbatas
 * (antarmuka jaringan × server ICE), tapi pesan 'ice' dari peer jaringan
 * dikendalikan pihak jaringan: peer buggy/malicious bisa spam tanpa pernah
 * mengirim deskripsi. Drop-terlama-dulu, konsisten dengan antrean sinyal
 * controller (PENDING_SIGNAL_MAX_PER_PEER = 50).
 */
const MAX_PENDING_REMOTE_CANDIDATES = 50;

type Timer = ReturnType<typeof setTimeout>;

interface ManagedPeer {
  session: SessionInfo;
  pc: RTCPeerConnection;
  /**
   * Perfect negotiation: sisi polite me-rollback offer-nya saat glare.
   * Konvensi: sessionId yang lebih besar = polite; yang kecil = inisiator.
   */
  polite: boolean;
  makingOffer: boolean;
  ignoreOffer: boolean;
  isSettingRemoteAnswerPending: boolean;
  /** true setelah offer/answer terkirim — kandidat setelahnya di-trickle. */
  descriptionSent: boolean;
  /** Naik setiap deskripsi remote diterima — pendeteksi answer basi. */
  remoteDescriptionEpoch: number;
  /** Kandidat lokal yang muncul sebelum deskripsi terkirim (menanti flush). */
  pendingLocalCandidates: RTCIceCandidateInit[];
  /** Kandidat remote yang tiba sebelum remoteDescription siap (menanti flush). */
  pendingRemoteCandidates: RTCIceCandidateInit[];
  sync: DataChannelSync | null;
  restart: IceRestartHandler;
  /** true selama episode 'connected' yang pasangan terpilihnya sudah disampling. */
  connectedSampled: boolean;
  /** Timer re-sample pasangan terpilih (dibersihkan saat peer ditutup). */
  pairSampleTimer: Timer | null;
  /** Signature pasangan terakhir yang dipancarkan — dedupe emisi berulang. */
  lastPairSignature: string | null;
}

export interface PeerConnectionManagerOptions {
  selfSessionId: string;
  iceServers?: RTCIceServer[];
  createPeerConnection?: PeerConnectionFactory;
  /** Sinyal keluar (offer/answer/ice) — kirimkan via SignalingClient. */
  onOutgoingSignal: (message: SignalMessage) => void;
  onTrack: (sessionId: string, track: MediaStreamTrack, stream: MediaStream | null) => void;
  onConnectionState: (
    sessionId: string,
    connectionState: RTCPeerConnectionState,
    iceConnectionState: RTCIceConnectionState,
  ) => void;
  onPosition: (sessionId: string, position: Position) => void;
  onInvalidPosition?: (sessionId: string, reason: string) => void;
  onError?: (sessionId: string, context: string, error?: unknown) => void;
  /**
   * Pasangan kandidat terpilih berhasil DIBACA (Task 11-b) — dipanggil saat
   * peer memasuki 'connected' (sampel segera + satu re-sample tertunda) dan
   * hanya bila infonya berubah sejak emisi terakhir. Sampul null TIDAK
   * dipancarkan (belum ada informasi = tidak ada derau). getStats gagal
   * juga diam — observabilitas tidak boleh menjatuhkan koneksi.
   */
  onSelectedPair?: (sessionId: string, pair: SelectedPairInfo) => void;
  /**
   * Jeda re-sample pasangan terpilih setelah 'connected' (default
   * DEFAULT_SELECTED_PAIR_RESAMPLE_MS). Di-inject untuk test.
   */
  selectedPairResampleMs?: number;
  /**
   * Batas waktu pembentukan koneksi per peer (watchdog establishment) —
   * diteruskan ke IceRestartHandler setiap addPeer; hanya sisi inisiator
   * (impolite) yang di-arm. Default 15_000 ms; nilai ≤ 0 mematikannya.
   */
  establishmentTimeoutMs?: number;
}

/**
 * Manajemen RTCPeerConnection per remote peer (mesh ≤ 7 remote peer).
 *
 * Implementasi perfect negotiation (polite/impolite peer) sehingga offer
 * dari kedua sisi tidak saling bertabrakan: sisi impolite mengabaikan offer
 * lawan saat glare, sisi polite me-rollback offer-nya lalu menjawab.
 *
 * Deskripsi (offer/answer) dikirim SEGERA setelah setLocalDescription —
 * tanpa menunggu pengumpulan kandidat — lalu semua kandidat di-trickle
 * lewat pesan 'ice'. Evolusi desain F1.6: menunggu kandidat menciptakan
 * window race panjang tempat deskripsi bisa kehilangan pasangannya saat
 * glare/rollback (bukti e2e: "m-lines doesn't match" / "SSL role" gagal).
 * Kandidat yang muncul sebelum deskripsi terkirim, atau tiba sebelum
 * remoteDescription siap, di-buffer lalu di-flush pada titik yang aman.
 */
export class PeerConnectionManager {
  private readonly selfSessionId: string;
  private readonly iceServers: RTCIceServer[];
  private readonly createPeerConnection: PeerConnectionFactory;
  private readonly onOutgoingSignal: (message: SignalMessage) => void;
  private readonly onTrack: PeerConnectionManagerOptions['onTrack'];
  private readonly onConnectionState: PeerConnectionManagerOptions['onConnectionState'];
  private readonly onPosition: PeerConnectionManagerOptions['onPosition'];
  private readonly onInvalidPosition?: PeerConnectionManagerOptions['onInvalidPosition'];
  private readonly onError?: PeerConnectionManagerOptions['onError'];
  private readonly onSelectedPair?: PeerConnectionManagerOptions['onSelectedPair'];
  private readonly selectedPairResampleMs: number;
  private readonly establishmentTimeoutMs: number | undefined;
  private readonly peers = new Map<string, ManagedPeer>();
  private localStream: MediaStream | null = null;

  constructor(options: PeerConnectionManagerOptions) {
    this.selfSessionId = options.selfSessionId;
    this.iceServers = options.iceServers ?? DEFAULT_ICE_SERVERS;
    this.createPeerConnection = options.createPeerConnection ?? defaultPeerConnectionFactory;
    this.onOutgoingSignal = options.onOutgoingSignal;
    this.onTrack = options.onTrack;
    this.onConnectionState = options.onConnectionState;
    this.onPosition = options.onPosition;
    this.onInvalidPosition = options.onInvalidPosition;
    this.onError = options.onError;
    this.onSelectedPair = options.onSelectedPair;
    this.selectedPairResampleMs =
      options.selectedPairResampleMs ?? DEFAULT_SELECTED_PAIR_RESAMPLE_MS;
    this.establishmentTimeoutMs = options.establishmentTimeoutMs;
  }

  // ============================================================
  // Query
  // ============================================================

  has(sessionId: string): boolean {
    return this.peers.has(sessionId);
  }

  get size(): number {
    return this.peers.size;
  }

  sessionIds(): string[] {
    return [...this.peers.keys()];
  }

  getSession(sessionId: string): SessionInfo | null {
    return this.peers.get(sessionId)?.session ?? null;
  }

  getConnectionState(sessionId: string): RTCPeerConnectionState | null {
    return this.peers.get(sessionId)?.pc.connectionState ?? null;
  }

  getIceConnectionState(sessionId: string): RTCIceConnectionState | null {
    return this.peers.get(sessionId)?.pc.iceConnectionState ?? null;
  }

  /**
   * Sender RTP milik satu peer — dibaca oleh BitrateAdaptation (lapisan audio)
   * untuk menyetel maxBitrate sesuai kondisi koneksi. Peer tak dikenal → [].
   */
  getSendersOf(sessionId: string): RTCRtpSender[] {
    const peer = this.peers.get(sessionId);
    return peer === undefined ? [] : [...peer.pc.getSenders()];
  }

  // ============================================================
  // Lifecycle peer
  // ============================================================

  /**
   * Mendaftarkan remote peer baru + membuat RTCPeerConnection-nya.
   * Sisi impolite (!polite) langsung membuat DataChannel posisi sehingga
   * negotiationneeded menyala dan offer awal terkirim otomatis.
   */
  addPeer(session: SessionInfo, polite: boolean): void {
    if (this.peers.has(session.sessionId)) {
      throw new Error(`peer ${session.sessionId} sudah terdaftar`);
    }
    if (this.peers.size >= MAX_REMOTE_PEERS) {
      throw new Error(`kapasitas mesh tercapai (maks ${MAX_REMOTE_PEERS} remote peer)`);
    }
    const pc = this.createPeerConnection({ iceServers: this.iceServers });
    const peer: ManagedPeer = {
      session,
      pc,
      polite,
      makingOffer: false,
      ignoreOffer: false,
      isSettingRemoteAnswerPending: false,
      descriptionSent: false,
      remoteDescriptionEpoch: 0,
      pendingLocalCandidates: [],
      pendingRemoteCandidates: [],
      sync: null,
      connectedSampled: false,
      pairSampleTimer: null,
      lastPairSignature: null,
      restart: new IceRestartHandler({
        getConnectionState: () => pc.connectionState,
        getIceConnectionState: () => pc.iceConnectionState,
        establishmentTimeoutMs: this.establishmentTimeoutMs,
        onRestart: async () => {
          // Hanya sisi inisiator yang me-restart — sisi polite menunggu
          // (restart dari dua sisi bersamaan = glare yang tidak perlu).
          if (!peer.polite) {
            await this.makeOffer(peer, { iceRestart: true });
          }
        },
        onGiveUp: (attempts) => {
          this.onError?.(session.sessionId, 'ice-restart-give-up');
          this.onConnectionState(session.sessionId, pc.connectionState, pc.iceConnectionState);
          void attempts;
        },
      }),
    };
    this.peers.set(session.sessionId, peer);
    this.wirePeer(peer);
    if (!polite) {
      const dc = pc.createDataChannel(DATA_CHANNEL_LABEL, { ordered: false, maxRetransmits: 0 });
      this.attachDataChannel(peer, dc);
      // Watchdog establishment hanya dipasang di sisi INISIATOR (impolite):
      // sisi polite sekadar menunggu offer dari inisiator — bila inisiator
      // mati, presence-level liveness (peer-left via Supabase presence) yang
      // menghapus peer. Watchdog ICE di sisi polite justru menghitung menuju
      // give-up hanya karena inisiator lambat (false peer-death). Sisi
      // inisiatorlah pemilik proses pembentukan koneksi.
      peer.restart.arm();
    }
    this.attachLocalTracks(peer);
  }

  /** Menutup satu peer (idempoten). */
  removePeer(sessionId: string): void {
    const peer = this.peers.get(sessionId);
    if (peer === undefined) {
      return;
    }
    this.peers.delete(sessionId);
    if (peer.pairSampleTimer !== null) {
      clearTimeout(peer.pairSampleTimer);
      peer.pairSampleTimer = null;
    }
    peer.restart.close();
    peer.sync?.close();
    try {
      peer.pc.close();
    } catch {
      // sudah tertutup — tidak masalah
    }
  }

  closeAll(): void {
    for (const sessionId of [...this.peers.keys()]) {
      this.removePeer(sessionId);
    }
  }

  // ============================================================
  // Signaling masuk
  // ============================================================

  handleSignal(message: SignalMessage): void {
    const peer = this.peers.get(message.from);
    if (peer === undefined) {
      return; // peer tidak dikenal — controller yang memutuskan (self-heal/abaikan)
    }
    switch (message.type) {
      case 'offer':
        void this.handleDescription(peer, { type: 'offer', sdp: message.sdp });
        break;
      case 'answer':
        void this.handleDescription(peer, { type: 'answer', sdp: message.sdp });
        break;
      case 'ice':
        this.handleRemoteCandidate(peer, message);
        break;
      case 'bye':
        break; // ditangani controller (butuh event peer-left)
    }
  }

  // ============================================================
  // Media lokal
  // ============================================================

  /** Memasang stream mikrofon ke semua peer (replaceTrack bila sudah ada). */
  attachLocalStream(stream: MediaStream): void {
    this.localStream = stream;
    for (const peer of this.peers.values()) {
      this.attachLocalTracks(peer);
    }
  }

  /** Melepas track media lokal dari semua peer (transceiver tetap ada). */
  detachLocalStream(): void {
    this.localStream = null;
    for (const peer of this.peers.values()) {
      for (const sender of peer.pc.getSenders()) {
        if (sender.track !== null) {
          void sender.replaceTrack(null).catch((error: unknown) => {
            this.onError?.(peer.session.sessionId, 'replace-track', error);
          });
        }
      }
    }
  }

  // ============================================================
  // Posisi
  // ============================================================

  /** Mengirim posisi ke semua peer (throttle internal per DataChannel). */
  sendPositionToAll(position: Position): void {
    for (const peer of this.peers.values()) {
      peer.sync?.sendPosition(position);
    }
  }

  // ============================================================
  // Internal
  // ============================================================

  private wirePeer(peer: ManagedPeer): void {
    const { pc } = peer;

    pc.addEventListener('negotiationneeded', () => {
      void this.makeOffer(peer);
    });

    pc.addEventListener('icecandidate', (event) => {
      if (event.candidate === null) {
        return; // penanda end-of-candidates
      }
      const candidate: RTCIceCandidateInit = {
        candidate: event.candidate.candidate,
        sdpMid: event.candidate.sdpMid,
        sdpMLineIndex: event.candidate.sdpMLineIndex,
        usernameFragment: event.candidate.usernameFragment,
      };
      if (!peer.descriptionSent) {
        // Deskripsi belum keluar — tahan kandidat, flush setelah terkirim
        // (deskripsi instan memang tidak memuat kandidat lagi).
        peer.pendingLocalCandidates.push(candidate);
        return;
      }
      this.sendCandidate(peer, candidate);
    });

    pc.addEventListener('track', (event) => {
      this.onTrack(peer.session.sessionId, event.track, event.streams[0] ?? null);
    });

    const notifyState = () => {
      this.onConnectionState(peer.session.sessionId, pc.connectionState, pc.iceConnectionState);
      peer.restart.observe();
      this.sampleSelectedPairOnConnected(peer);
    };
    pc.addEventListener('connectionstatechange', notifyState);
    pc.addEventListener('iceconnectionstatechange', notifyState);

    pc.addEventListener('datachannel', (event) => {
      if (event.channel.label !== DATA_CHANNEL_LABEL) {
        return; // channel tak dikenal diabaikan
      }
      this.attachDataChannel(peer, event.channel);
    });
  }

  private attachDataChannel(peer: ManagedPeer, dc: RTCDataChannel): void {
    if (peer.sync !== null) {
      return; // channel posisi kedua untuk peer yang sama diabaikan
    }
    peer.sync = new DataChannelSync(dc, {
      onPosition: (position) => this.onPosition(peer.session.sessionId, position),
      onInvalid: (reason) => this.onInvalidPosition?.(peer.session.sessionId, reason),
    });
  }

  // ============================================================
  // Observabilitas pasangan terpilih (Task 11-b)
  // ============================================================

  /**
   * Sampel pasangan terpilih tiap memasuki episode 'connected' (dedupe via
   * flag episode — connectionstatechange + iceconnectionstatechange untuk
   * transisi yang sama hanya memicu SATU rangkaian sampel). Episode berakhir
   * saat state meninggalkan 'connected' (mis. blip 'disconnected' atau ICE
   * restart) → masuk 'connected' lagi = episode baru = sampel baru.
   * No-op total bila tidak ada callback onSelectedPair (nol biaya).
   */
  private sampleSelectedPairOnConnected(peer: ManagedPeer): void {
    if (this.onSelectedPair === undefined) {
      return;
    }
    if (peer.pc.connectionState !== 'connected') {
      peer.connectedSampled = false;
      // Episode berakhir (blip/restart) — re-sample episode ini tidak lagi
      // relevan. Lepas timernya supaya flapping cepat tidak menumpuk timer
      // pending tanpa batas (Task 11-d: ≤ 1 timer hidup per peer, selalu).
      this.clearPairSampleTimer(peer);
      return;
    }
    if (peer.connectedSampled) {
      return;
    }
    peer.connectedSampled = true;
    void this.readAndEmitSelectedPair(peer);
    // Episode baru: pastikan slot timer kosong (normalnya sudah dibersihkan
    // saat episode sebelumnya berakhir — ini jalur defensif).
    this.clearPairSampleTimer(peer);
    peer.pairSampleTimer = setTimeout(() => {
      peer.pairSampleTimer = null;
      // Hanya bila peer masih hidup di sini dan masih connected — timer
      // bisa menyala setelah blip/restart; pairSampleTimer sudah dibersihkan
      // removePeer, guard ini menutup sisa jalur.
      if (
        this.peers.get(peer.session.sessionId) === peer &&
        peer.pc.connectionState === 'connected'
      ) {
        void this.readAndEmitSelectedPair(peer);
      }
    }, this.selectedPairResampleMs);
  }

  /** Membersihkan timer re-sample yang tertunda (bila ada) + nol-kan slotnya. */
  private clearPairSampleTimer(peer: ManagedPeer): void {
    if (peer.pairSampleTimer !== null) {
      clearTimeout(peer.pairSampleTimer);
      peer.pairSampleTimer = null;
    }
  }

  /** Baca stats → pancarkan hanya bila ada info BARU (signature berubah). */
  private async readAndEmitSelectedPair(peer: ManagedPeer): Promise<void> {
    const pair = await this.readSelectedPair(peer);
    if (pair === null) {
      return; // belum ada pasangan / getStats gagal — diam, jujur tanpa derau
    }
    const signature = `${pair.localType}/${pair.remoteType}/${pair.state ?? '-'}/${
      pair.nominated ?? '-'
    }/${pair.selected ?? '-'}`;
    if (signature === peer.lastPairSignature) {
      return;
    }
    peer.lastPairSignature = signature;
    this.onSelectedPair?.(peer.session.sessionId, pair);
  }

  /**
   * Baca pasangan terpilih dari getStats() — tidak pernah melempar.
   * (RTCStatsReport di-spread lalu dilempar ke parser murni; cast tunggal
   * karena lib.dom tidak memberi index signature pada RTCStats.)
   */
  private async readSelectedPair(peer: ManagedPeer): Promise<SelectedPairInfo | null> {
    if (peer.pc.signalingState === 'closed') {
      return null;
    }
    try {
      const report = await peer.pc.getStats();
      return pickSelectedPair([...report] as unknown as StatsEntryLike[]);
    } catch {
      return null;
    }
  }

  private attachLocalTracks(peer: ManagedPeer): void {
    const stream = this.localStream;
    if (stream === null) {
      return;
    }
    for (const track of stream.getTracks()) {
      const sender = peer.pc
        .getSenders()
        .find((candidate) => candidate.track !== null && candidate.track.kind === track.kind);
      if (sender === undefined) {
        peer.pc.addTrack(track, stream); // memicu negotiationneeded
      } else if (sender.track !== track) {
        void sender.replaceTrack(track).catch((error: unknown) => {
          this.onError?.(peer.session.sessionId, 'replace-track', error);
        });
      }
    }
  }

  /**
   * Membuat + mengirim offer. makingOffer hanya true selama setLocalDescription
   * (sesuai pola perfect negotiation). Offer dikirim SEGERA tanpa menunggu
   * kandidat (trickle penuh — lihat catatan kelas) supaya tidak ada window
   * race yang bisa membius deskripsi saat glare/rollback.
   */
  private async makeOffer(peer: ManagedPeer, opts: { iceRestart?: boolean } = {}): Promise<void> {
    if (peer.pc.signalingState === 'closed') {
      return;
    }
    try {
      peer.makingOffer = true;
      if (opts.iceRestart === true) {
        const offer = await peer.pc.createOffer({ iceRestart: true });
        await peer.pc.setLocalDescription(offer);
      } else {
        await peer.pc.setLocalDescription();
      }
    } catch (error) {
      this.onError?.(peer.session.sessionId, 'make-offer', error);
      return;
    } finally {
      peer.makingOffer = false;
    }
    // Race rollback (bukti e2e F1.6): bila offer ini dijawab cepat atau
    // di-rollback oleh offer remote dalam microtask window, jangan kirim
    // deskripsi basi.
    if (peer.pc.signalingState !== 'have-local-offer') {
      return;
    }
    const description = peer.pc.localDescription;
    if (
      description === null ||
      description.type !== 'offer' ||
      description.sdp === null ||
      description.sdp === ''
    ) {
      this.onError?.(
        peer.session.sessionId,
        'send-offer',
        new Error('localDescription bukan offer yang tertunda'),
      );
      return;
    }
    this.onOutgoingSignal({
      v: PROTOCOL_VERSION,
      type: 'offer',
      from: this.selfSessionId,
      to: peer.session.sessionId,
      sdp: description.sdp,
    });
    peer.descriptionSent = true;
    this.flushLocalCandidates(peer);
  }

  /** Menangani offer/answer masuk dengan semantik perfect negotiation. */
  private async handleDescription(
    peer: ManagedPeer,
    description: RTCSessionDescriptionInit,
  ): Promise<void> {
    const readyForOffer =
      !peer.makingOffer &&
      (peer.pc.signalingState === 'stable' || peer.isSettingRemoteAnswerPending);
    const offerCollision = description.type === 'offer' && !readyForOffer;
    peer.ignoreOffer = !peer.polite && offerCollision;
    if (peer.ignoreOffer) {
      return; // sisi impolite mengabaikan offer saat glare
    }
    peer.isSettingRemoteAnswerPending = description.type === 'answer';
    // Epoch: naik tiap deskripsi remote yang diterima. Bila offer LAIN datang
    // di tengah pemrosesan offer ini, epoch berganti — answer utk offer ini
    // batal dikirim (jalur offer baru yang mengirim answer-nya sendiri).
    // (Perbandingan string SDP tidak bisa dipakai: browser menormalisasi SDP
    // saat setRemote — bukti e2e F1.6.)
    const epoch = ++peer.remoteDescriptionEpoch;
    try {
      // Sisi polite otomatis me-rollback offer-nya di sini (rollback implisit).
      await peer.pc.setRemoteDescription(description);
      // remoteDescription kini ada — kandidat remote yang tertahan bisa masuk.
      this.flushRemoteCandidates(peer);
      if (description.type === 'offer') {
        await peer.pc.setLocalDescription();
        if (peer.remoteDescriptionEpoch !== epoch) {
          return; // offer lain sudah diproses — answer ini basi
        }
        const local = peer.pc.localDescription;
        if (local === null || local.type !== 'answer' || local.sdp === null || local.sdp === '') {
          throw new Error('localDescription bukan answer setelah setLocalDescription');
        }
        this.onOutgoingSignal({
          v: PROTOCOL_VERSION,
          type: 'answer',
          from: this.selfSessionId,
          to: peer.session.sessionId,
          sdp: local.sdp,
        });
        peer.descriptionSent = true;
        this.flushLocalCandidates(peer);
      }
    } catch (error) {
      this.onError?.(peer.session.sessionId, 'handle-description', error);
    } finally {
      peer.isSettingRemoteAnswerPending = false;
    }
  }

  private handleRemoteCandidate(peer: ManagedPeer, message: IceSignalMessage): void {
    const candidate: RTCIceCandidateInit = {
      candidate: message.candidate ?? undefined,
      sdpMid: message.sdpMid,
      sdpMLineIndex: message.sdpMLineIndex,
      ...(message.usernameFragment != null ? { usernameFragment: message.usernameFragment } : {}),
    };
    if (peer.pc.remoteDescription === null) {
      // Deskripsi remote belum diterapkan — tahan, flush oleh handleDescription.
      // Terbatas MAX_PENDING_REMOTE_CANDIDATES (drop terlama) — pesan 'ice'
      // dikendalikan pihak jaringan, antrean tak boleh tumbuh tak berbatas.
      if (peer.pendingRemoteCandidates.length >= MAX_PENDING_REMOTE_CANDIDATES) {
        peer.pendingRemoteCandidates.shift();
      }
      peer.pendingRemoteCandidates.push(candidate);
      return;
    }
    void peer.pc.addIceCandidate(candidate).catch((error: unknown) => {
      // Kandidat yang datang sebelum remote description wajar tertolak;
      // hanya laporkan bila bukan akibat offer yang sengaja diabaikan.
      if (!peer.ignoreOffer) {
        this.onError?.(peer.session.sessionId, 'add-ice-candidate', error);
      }
    });
  }

  // ============================================================
  // Trickle helpers
  // ============================================================

  private sendCandidate(peer: ManagedPeer, candidate: RTCIceCandidateInit): void {
    this.onOutgoingSignal({
      v: PROTOCOL_VERSION,
      type: 'ice',
      from: this.selfSessionId,
      to: peer.session.sessionId,
      candidate: candidate.candidate ?? null,
      sdpMid: candidate.sdpMid ?? null,
      sdpMLineIndex: candidate.sdpMLineIndex ?? null,
      usernameFragment: candidate.usernameFragment ?? null,
    });
  }

  /** Kirim semua kandidat lokal yang tertahan (dipanggil saat deskripsi keluar). */
  private flushLocalCandidates(peer: ManagedPeer): void {
    const pending = peer.pendingLocalCandidates;
    if (pending.length === 0) {
      return;
    }
    peer.pendingLocalCandidates = [];
    for (const candidate of pending) {
      this.sendCandidate(peer, candidate);
    }
  }

  /** Terapkan semua kandidat remote yang tertahan (dipanggil setelah setRemote). */
  private flushRemoteCandidates(peer: ManagedPeer): void {
    const pending = peer.pendingRemoteCandidates;
    if (pending.length === 0) {
      return;
    }
    peer.pendingRemoteCandidates = [];
    for (const candidate of pending) {
      void peer.pc.addIceCandidate(candidate).catch((error: unknown) => {
        if (!peer.ignoreOffer) {
          this.onError?.(peer.session.sessionId, 'add-ice-candidate', error);
        }
      });
    }
  }
}
