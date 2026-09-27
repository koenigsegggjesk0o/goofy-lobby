/**
 * Fake objek WebRTC + Supabase Realtime untuk unit test (lingkungan Node,
 * tanpa browser). Hanya diimpor dari file *.test.ts — tidak pernah masuk
 * bundle produksi.
 */
import type { RealtimeChannel } from '@supabase/supabase-js';
import type { SessionInfo, SupabaseRealtimeLike } from './types';

// ============================================================
// Event target sederhana
// ============================================================

type AnyListener = (event: never) => void;

export class FakeEventTarget {
  #listeners = new Map<string, Set<AnyListener>>();

  addEventListener(type: string, listener: AnyListener): void {
    let set = this.#listeners.get(type);
    if (set === undefined) {
      set = new Set<AnyListener>();
      this.#listeners.set(type, set);
    }
    set.add(listener);
  }

  removeEventListener(type: string, listener: AnyListener): void {
    this.#listeners.get(type)?.delete(listener);
  }

  fire(type: string, event?: unknown): void {
    const set = this.#listeners.get(type);
    if (set === undefined) {
      return;
    }
    for (const listener of [...set]) {
      (listener as unknown as (payload: unknown) => void)(event);
    }
  }
}

// ============================================================
// RTCDataChannel
// ============================================================

export class FakeRTCDataChannel extends FakeEventTarget {
  readonly label: string;
  readyState: RTCDataChannelState = 'open';
  bufferedAmount = 0;
  sent: string[] = [];

  constructor(label: string) {
    super();
    this.label = label;
  }

  send(data: string): void {
    this.sent.push(data);
  }

  close(): void {
    this.readyState = 'closed';
    this.fire('close', undefined);
  }

  /** Simulasi pesan masuk dari remote peer. */
  deliver(data: unknown): void {
    this.fire('message', { data });
  }
}

// ============================================================
// RTCPeerConnection
// ============================================================

export class FakeRTCRtpSender {
  track: MediaStreamTrack | null;
  replaced: Array<MediaStreamTrack | null> = [];

  constructor(track: MediaStreamTrack | null) {
    this.track = track;
  }

  replaceTrack(track: MediaStreamTrack | null): Promise<void> {
    this.track = track;
    this.replaced.push(track);
    return Promise.resolve();
  }
}

export class FakeRTCPeerConnection extends FakeEventTarget {
  lastConfig: RTCConfiguration | undefined;
  signalingState: RTCSignalingState = 'stable';
  connectionState: RTCPeerConnectionState = 'new';
  iceConnectionState: RTCIceConnectionState = 'new';
  iceGatheringState: RTCIceGatheringState = 'new';
  localDescription: RTCSessionDescription | null = null;
  remoteDescription: RTCSessionDescription | null = null;
  dataChannels: FakeRTCDataChannel[] = [];
  senders: FakeRTCRtpSender[] = [];
  attachedStreams: Array<{ track: MediaStreamTrack; stream: MediaStream }> = [];
  candidates: Array<RTCIceCandidateInit | null> = [];
  restartIceCalls = 0;
  closed = false;
  /** Menahan setLocalDescription — dipakai untuk mensimulasikan glare. */
  gate: Promise<void> | null = null;

  constructor(config?: RTCConfiguration) {
    super();
    this.lastConfig = config;
  }

  createDataChannel(label: string): FakeRTCDataChannel {
    const channel = new FakeRTCDataChannel(label);
    this.dataChannels.push(channel);
    queueMicrotask(() => this.fire('negotiationneeded', undefined));
    return channel;
  }

  async createOffer(options?: RTCOfferOptions): Promise<RTCSessionDescriptionInit> {
    return {
      type: 'offer',
      sdp: `v=0\r\nfake-offer${options?.iceRestart === true ? '-restart' : ''}`,
    };
  }

  async setLocalDescription(description?: RTCSessionDescriptionInit): Promise<void> {
    if (this.gate !== null) {
      await this.gate;
    }
    if (this.closed) {
      throw new Error('peer connection tertutup');
    }
    if (description === undefined) {
      if (this.signalingState === 'have-remote-offer') {
        description = { type: 'answer', sdp: 'v=0\r\nfake-answer' };
      } else if (this.signalingState === 'stable' || this.signalingState === 'have-local-offer') {
        description = { type: 'offer', sdp: 'v=0\r\nfake-offer' };
      } else {
        throw new Error(`setLocalDescription dari signalingState ${this.signalingState}`);
      }
    }
    if (description.type === 'offer') {
      if (this.signalingState === 'have-remote-offer') {
        throw new Error('offer saat have-remote-offer (butuh rollback implisit)');
      }
      this.signalingState = 'have-local-offer';
    } else {
      if (this.signalingState !== 'have-remote-offer') {
        throw new Error(`answer dari signalingState ${this.signalingState}`);
      }
      this.signalingState = 'stable';
    }
    this.localDescription = description as RTCSessionDescription;
    this.iceGatheringState = 'complete';
    this.fire('icegatheringstatechange', undefined);
  }

  async setRemoteDescription(description: RTCSessionDescriptionInit): Promise<void> {
    if (this.closed) {
      throw new Error('peer connection tertutup');
    }
    if (description.type === 'offer') {
      // Rollback implisit (sisi polite): dari have-local-offer diperbolehkan.
      if (this.signalingState !== 'stable' && this.signalingState !== 'have-local-offer') {
        throw new Error(`setRemoteDescription offer dari signalingState ${this.signalingState}`);
      }
      this.signalingState = 'have-remote-offer';
    } else {
      if (this.signalingState !== 'have-local-offer') {
        throw new Error(`setRemoteDescription answer dari signalingState ${this.signalingState}`);
      }
      this.signalingState = 'stable';
    }
    this.remoteDescription = description as RTCSessionDescription;
  }

  async addIceCandidate(candidate?: RTCIceCandidateInit | null): Promise<void> {
    if (this.closed) {
      throw new Error('peer connection tertutup');
    }
    if (this.remoteDescription === null) {
      throw new Error('addIceCandidate sebelum remote description');
    }
    this.candidates.push(candidate ?? null);
  }

  restartIce(): void {
    this.restartIceCalls += 1;
  }

  getSenders(): FakeRTCRtpSender[] {
    return [...this.senders];
  }

  addTrack(track: MediaStreamTrack, stream: MediaStream): FakeRTCRtpSender {
    const sender = new FakeRTCRtpSender(track);
    this.senders.push(sender);
    this.attachedStreams.push({ track, stream });
    queueMicrotask(() => this.fire('negotiationneeded', undefined));
    return sender;
  }

  close(): void {
    if (this.closed) {
      return;
    }
    this.closed = true;
    this.signalingState = 'closed';
    this.connectionState = 'closed';
    this.fire('connectionstatechange', undefined);
  }

  /** Mengubah state koneksi + memicu eventnya (untuk test lifecycle). */
  simulateState(patch: {
    connectionState?: RTCPeerConnectionState;
    iceConnectionState?: RTCIceConnectionState;
  }): void {
    if (patch.connectionState !== undefined) {
      this.connectionState = patch.connectionState;
    }
    if (patch.iceConnectionState !== undefined) {
      this.iceConnectionState = patch.iceConnectionState;
    }
    this.fire('connectionstatechange', undefined);
    this.fire('iceconnectionstatechange', undefined);
  }
}

// ============================================================
// Supabase Realtime (channel + client)
// ============================================================

export class FakeRealtimeChannel {
  readonly topic: string;
  readonly presenceKey: string | undefined;
  readonly broadcastHandlers = new Map<string, Array<(payload: unknown) => void>>();
  readonly presenceSyncHandlers = new Set<() => void>();
  readonly presence = new Map<string, SessionInfo>();
  sentSignals: unknown[] = [];
  trackPayloads: unknown[] = [];
  subscribed = false;
  unsubscribed = false;
  untracked = false;
  subscribeStatus: 'SUBSCRIBED' | 'CHANNEL_ERROR' | 'TIMED_OUT' = 'SUBSCRIBED';

  constructor(topic: string, options?: { config?: { presence?: { key?: string } } }) {
    this.topic = topic;
    this.presenceKey = options?.config?.presence?.key;
  }

  on(
    type: 'broadcast' | 'presence',
    filter: { event: string },
    callback: unknown,
  ): RealtimeChannel {
    if (type === 'broadcast') {
      const list = this.broadcastHandlers.get(filter.event) ?? [];
      list.push(callback as (payload: unknown) => void);
      this.broadcastHandlers.set(filter.event, list);
    } else if (type === 'presence' && filter.event === 'sync') {
      this.presenceSyncHandlers.add(callback as () => void);
    }
    return this as unknown as RealtimeChannel;
  }

  subscribe(callback?: (status: string, err?: Error) => void): FakeRealtimeChannel {
    this.subscribed = true;
    if (callback !== undefined) {
      queueMicrotask(() => callback(this.subscribeStatus));
    }
    return this;
  }

  async send(args: { type: string; event: string; payload?: unknown }): Promise<string> {
    if (args.type === 'broadcast') {
      this.sentSignals.push(args.payload);
    }
    return 'ok';
  }

  async track(payload: Record<string, unknown>): Promise<string> {
    this.trackPayloads.push(payload);
    if (this.presenceKey !== undefined) {
      this.presence.set(this.presenceKey, payload as unknown as SessionInfo);
      this.fireSync();
    }
    return 'ok';
  }

  async untrack(): Promise<string> {
    this.untracked = true;
    if (this.presenceKey !== undefined) {
      this.presence.delete(this.presenceKey);
      this.fireSync();
    }
    return 'ok';
  }

  async unsubscribe(): Promise<string> {
    this.unsubscribed = true;
    return 'ok';
  }

  presenceState(): Record<string, unknown[]> {
    const state: Record<string, unknown[]> = {};
    for (const [key, value] of this.presence) {
      state[key] = [value];
    }
    return state;
  }

  fireSync(): void {
    for (const handler of [...this.presenceSyncHandlers]) {
      handler();
    }
  }

  /** Menyerahkan satu payload signaling seolah datang dari jaringan. */
  deliverSignal(payload: unknown): void {
    for (const handler of [...(this.broadcastHandlers.get('signal') ?? [])]) {
      handler({ type: 'broadcast', event: 'signal', payload });
    }
  }

  simulatePresence(session: SessionInfo): void {
    this.presence.set(session.sessionId, session);
    this.fireSync();
  }

  removePresence(sessionId: string): void {
    this.presence.delete(sessionId);
    this.fireSync();
  }
}

export class FakeSupabase {
  readonly channels: FakeRealtimeChannel[] = [];
  readonly removedChannels: FakeRealtimeChannel[] = [];

  channel(topic: string, options?: { config?: { presence?: { key?: string } } }): RealtimeChannel {
    const channel = new FakeRealtimeChannel(topic, options);
    this.channels.push(channel);
    return channel as unknown as RealtimeChannel;
  }

  async removeChannel(channel: RealtimeChannel): Promise<string> {
    this.removedChannels.push(channel as unknown as FakeRealtimeChannel);
    return 'ok';
  }
}

// ============================================================
// Helper
// ============================================================

let sessionCounter = 0;

export function makeSession(overrides: Partial<SessionInfo> = {}): SessionInfo {
  sessionCounter += 1;
  return {
    sessionId: `session-${String(sessionCounter).padStart(4, '0')}-xxxx`,
    userId: `user-${String(sessionCounter)}`,
    displayName: `Tester ${String(sessionCounter)}`,
    avatarColor: '#22aa44',
    ...overrides,
  };
}

export function asChannel(fake: FakeRealtimeChannel): RealtimeChannel {
  return fake as unknown as RealtimeChannel;
}

export function asSupabase(fake: FakeSupabase): SupabaseRealtimeLike {
  return fake as unknown as SupabaseRealtimeLike;
}

export function asPeerConnection(fake: FakeRTCPeerConnection): RTCPeerConnection {
  return fake as unknown as RTCPeerConnection;
}

export function asDataChannel(fake: FakeRTCDataChannel): RTCDataChannel {
  return fake as unknown as RTCDataChannel;
}

/** Menunggu satu putaran macrotask — microtask (async await) ikut selesai. */
export async function flush(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}
