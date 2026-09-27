import { DataChannelSync } from './data-channel-sync';
import { IceRestartHandler } from './ice-restart-handler';
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
 * Menunggu kandidat ICE terkumpul (non-trickle: SDP dikirim utuh sekali),
 * dengan batas waktu supaya STUN yang lambat tidak menggantung signaling.
 */
export function waitForIceGathering(pc: RTCPeerConnection, timeoutMs: number): Promise<void> {
  if (pc.iceGatheringState === 'complete') {
    return Promise.resolve();
  }
  return new Promise<void>((resolve) => {
    const finish = () => {
      clearTimeout(timer);
      pc.removeEventListener('icegatheringstatechange', onChange);
      resolve();
    };
    const timer = setTimeout(finish, timeoutMs);
    const onChange = () => {
      if (pc.iceGatheringState === 'complete') {
        finish();
      }
    };
    pc.addEventListener('icegatheringstatechange', onChange);
  });
}

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
  sync: DataChannelSync | null;
  restart: IceRestartHandler;
}

export interface PeerConnectionManagerOptions {
  selfSessionId: string;
  iceServers?: RTCIceServer[];
  createPeerConnection?: PeerConnectionFactory;
  /** Batas waktu pengumpulan kandidat ICE sebelum SDP dikirim (default 2000 ms). */
  gatherTimeoutMs?: number;
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
}

/**
 * Manajemen RTCPeerConnection per remote peer (mesh ≤ 7 remote peer).
 *
 * Implementasi perfect negotiation (polite/impolite peer) sehingga offer
 * dari kedua sisi tidak saling bertabrakan: sisi impolite mengabaikan offer
 * lawan saat glare, sisi polite me-rollback offer-nya lalu menjawab.
 *
 * SDP dikirim utuh setelah kandidat terkumpul (atau timeout) — satu pesan
 * signaling per deskripsi, ramah rate-limit broadcast Supabase Realtime.
 * Kandidat yang datang terlambat tetap di-trickle lewat pesan 'ice'.
 */
export class PeerConnectionManager {
  private readonly selfSessionId: string;
  private readonly iceServers: RTCIceServer[];
  private readonly createPeerConnection: PeerConnectionFactory;
  private readonly gatherTimeoutMs: number;
  private readonly onOutgoingSignal: (message: SignalMessage) => void;
  private readonly onTrack: PeerConnectionManagerOptions['onTrack'];
  private readonly onConnectionState: PeerConnectionManagerOptions['onConnectionState'];
  private readonly onPosition: PeerConnectionManagerOptions['onPosition'];
  private readonly onInvalidPosition?: PeerConnectionManagerOptions['onInvalidPosition'];
  private readonly onError?: PeerConnectionManagerOptions['onError'];
  private readonly peers = new Map<string, ManagedPeer>();
  private localStream: MediaStream | null = null;

  constructor(options: PeerConnectionManagerOptions) {
    this.selfSessionId = options.selfSessionId;
    this.iceServers = options.iceServers ?? DEFAULT_ICE_SERVERS;
    this.createPeerConnection = options.createPeerConnection ?? defaultPeerConnectionFactory;
    this.gatherTimeoutMs = options.gatherTimeoutMs ?? 2_000;
    this.onOutgoingSignal = options.onOutgoingSignal;
    this.onTrack = options.onTrack;
    this.onConnectionState = options.onConnectionState;
    this.onPosition = options.onPosition;
    this.onInvalidPosition = options.onInvalidPosition;
    this.onError = options.onError;
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
      sync: null,
      restart: new IceRestartHandler({
        getConnectionState: () => pc.connectionState,
        getIceConnectionState: () => pc.iceConnectionState,
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
      if (!peer.descriptionSent) {
        return; // kandidat sudah tercakup dalam SDP yang dikirim
      }
      this.onOutgoingSignal({
        v: PROTOCOL_VERSION,
        type: 'ice',
        from: this.selfSessionId,
        to: peer.session.sessionId,
        candidate: event.candidate.candidate,
        sdpMid: event.candidate.sdpMid,
        sdpMLineIndex: event.candidate.sdpMLineIndex,
        usernameFragment: event.candidate.usernameFragment,
      });
    });

    pc.addEventListener('track', (event) => {
      this.onTrack(peer.session.sessionId, event.track, event.streams[0] ?? null);
    });

    const notifyState = () => {
      this.onConnectionState(peer.session.sessionId, pc.connectionState, pc.iceConnectionState);
      peer.restart.observe();
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
   * (sesuai pola perfect negotiation); pengumpulan ICE ditunggu sesudahnya
   * supaya offer tidak dianggap menggantung saat answer datang lebih dulu.
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
    try {
      await waitForIceGathering(peer.pc, this.gatherTimeoutMs);
      const description = peer.pc.localDescription;
      if (description === null || description.sdp === null || description.sdp === '') {
        throw new Error('localDescription tidak tersedia setelah setLocalDescription');
      }
      this.onOutgoingSignal({
        v: PROTOCOL_VERSION,
        type: 'offer',
        from: this.selfSessionId,
        to: peer.session.sessionId,
        sdp: description.sdp,
      });
      peer.descriptionSent = true;
    } catch (error) {
      this.onError?.(peer.session.sessionId, 'send-offer', error);
    }
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
    try {
      // Sisi polite otomatis me-rollback offer-nya di sini (rollback implisit).
      await peer.pc.setRemoteDescription(description);
      if (description.type === 'offer') {
        await peer.pc.setLocalDescription();
        await waitForIceGathering(peer.pc, this.gatherTimeoutMs);
        const local = peer.pc.localDescription;
        if (local === null || local.sdp === null || local.sdp === '') {
          throw new Error('localDescription kosong saat menjawab offer');
        }
        this.onOutgoingSignal({
          v: PROTOCOL_VERSION,
          type: 'answer',
          from: this.selfSessionId,
          to: peer.session.sessionId,
          sdp: local.sdp,
        });
        peer.descriptionSent = true;
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
    void peer.pc.addIceCandidate(candidate).catch((error: unknown) => {
      // Kandidat yang datang sebelum remote description wajar tertolak;
      // hanya laporkan bila bukan akibat offer yang sengaja diabaikan.
      if (!peer.ignoreOffer) {
        this.onError?.(peer.session.sessionId, 'add-ice-candidate', error);
      }
    });
  }
}
