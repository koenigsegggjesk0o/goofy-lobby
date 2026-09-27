import { describe, expect, it, vi, type Mock } from 'vitest';
import { PeerConnectionManager, DEFAULT_ICE_SERVERS } from './peer-connection-manager';
import {
  asPeerConnection,
  FakeRTCDataChannel,
  FakeRTCPeerConnection,
  FakeRTCRtpSender,
  flush,
  makeSession,
} from './test-utils';
import type { SignalMessage } from './types';

const sessionA = makeSession({ sessionId: 'aaaa-session-0001' });
const sessionB = makeSession({ sessionId: 'bbbb-session-0002' });

interface Wire {
  manager: PeerConnectionManager;
  pc: FakeRTCPeerConnection;
  signals: SignalMessage[];
}

function makeManager(selfSessionId: string, pc: FakeRTCPeerConnection, onError?: Mock): Wire {
  const signals: SignalMessage[] = [];
  const manager = new PeerConnectionManager({
    selfSessionId,
    createPeerConnection: (config) => {
      pc.lastConfig = config;
      return asPeerConnection(pc);
    },
    onOutgoingSignal: (message) => signals.push(message),
    onTrack: () => undefined,
    onConnectionState: () => undefined,
    onPosition: () => undefined,
    ...(onError !== undefined ? { onError: () => onError() } : {}),
  });
  return { manager, pc, signals };
}

function makeTrack(kind: 'audio' | 'video' = 'audio'): MediaStreamTrack {
  return { kind, id: `track-${kind}` } as unknown as MediaStreamTrack;
}

function makeStream(): MediaStream {
  return { getTracks: () => [makeTrack()] } as unknown as MediaStream;
}

function findSignal(
  signals: SignalMessage[],
  type: SignalMessage['type'],
): SignalMessage | undefined {
  return signals.find((signal) => signal.type === type);
}

/** Mengambil field sdp dari pesan offer/answer (union SignalMessage). */
function sdpOf(message: SignalMessage): string {
  return (message as { sdp?: string }).sdp ?? '';
}

describe('PeerConnectionManager — dasar', () => {
  it('addPeer membuat koneksi dengan iceServers default untuk sisi impolite', async () => {
    const pc = new FakeRTCPeerConnection();
    const wire = makeManager(sessionA.sessionId, pc);

    wire.manager.addPeer(sessionB, false); // impolite → inisiator

    expect(wire.manager.has(sessionB.sessionId)).toBe(true);
    expect(wire.manager.size).toBe(1);
    expect(pc.lastConfig?.iceServers).toEqual(DEFAULT_ICE_SERVERS);
    expect(pc.dataChannels.map((channel) => channel.label)).toEqual(['position']);
  });

  it('sisi polite tidak membuat DataChannel dan tidak menawar', async () => {
    const pc = new FakeRTCPeerConnection();
    const wire = makeManager(sessionA.sessionId, pc);

    wire.manager.addPeer(sessionB, true);
    await flush();
    await flush();

    expect(pc.dataChannels).toHaveLength(0);
    expect(findSignal(wire.signals, 'offer')).toBeUndefined();
  });

  it('addPeer ganda untuk session yang sama melempar error', () => {
    const pc = new FakeRTCPeerConnection();
    const wire = makeManager(sessionA.sessionId, pc);
    wire.manager.addPeer(sessionB, true);

    expect(() => wire.manager.addPeer(sessionB, true)).toThrow(/sudah terdaftar/);
  });

  it('kapasitas maksimum 7 remote peer', () => {
    const pc = new FakeRTCPeerConnection();
    const wire = makeManager(sessionA.sessionId, pc);
    for (let index = 0; index < 7; index += 1) {
      wire.manager.addPeer(
        makeSession({ sessionId: `peer-${String(index).padStart(4, '0')}-xxxx` }),
        true,
      );
    }
    expect(wire.manager.size).toBe(7);

    expect(() => wire.manager.addPeer(makeSession({ sessionId: 'peer-0008-xxxx' }), true)).toThrow(
      /kapasitas mesh tercapai/,
    );
  });

  it('removePeer menutup koneksi dan bersifat idempoten', () => {
    const pc = new FakeRTCPeerConnection();
    const wire = makeManager(sessionA.sessionId, pc);
    wire.manager.addPeer(sessionB, true);

    wire.manager.removePeer(sessionB.sessionId);
    wire.manager.removePeer(sessionB.sessionId); // kedua kali tidak error

    expect(pc.closed).toBe(true);
    expect(wire.manager.has(sessionB.sessionId)).toBe(false);
  });

  it('getSendersOf mengembalikan sender peer (salinan) dan [] untuk yang tak dikenal', () => {
    const pc = new FakeRTCPeerConnection();
    const wire = makeManager(sessionA.sessionId, pc);
    wire.manager.addPeer(sessionB, true);
    const sender = new FakeRTCRtpSender(makeTrack());
    pc.senders.push(sender);

    const senders = wire.manager.getSendersOf(sessionB.sessionId);

    expect(senders).toHaveLength(1);
    expect(senders[0]).toBe(sender);
    expect(wire.manager.getSendersOf('peer-tidak-ada')).toEqual([]);
    // salinan: memutasi array hasil tidak mengubah internal manager
    senders.length = 0;
    expect(wire.manager.getSendersOf(sessionB.sessionId)).toHaveLength(1);
  });

  it('closeAll menutup semua peer', () => {
    const pcs = [new FakeRTCPeerConnection(), new FakeRTCPeerConnection()];
    let call = 0;
    const signals: SignalMessage[] = [];
    const manager = new PeerConnectionManager({
      selfSessionId: sessionA.sessionId,
      createPeerConnection: () => asPeerConnection(pcs[call++] ?? new FakeRTCPeerConnection()),
      onOutgoingSignal: (message) => signals.push(message),
      onTrack: () => undefined,
      onConnectionState: () => undefined,
      onPosition: () => undefined,
    });
    manager.addPeer(makeSession({ sessionId: 'peer-0001-xxxx' }), true);
    manager.addPeer(makeSession({ sessionId: 'peer-0002-xxxx' }), true);

    manager.closeAll();

    expect(manager.size).toBe(0);
    expect(pcs.every((peer) => peer.closed)).toBe(true);
  });
});

describe('PeerConnectionManager — negosiasi dua sisi (wire)', () => {
  it('inisiator mengirim offer, penerima menjawab answer, keduanya stabil', async () => {
    const pcA = new FakeRTCPeerConnection();
    const pcB = new FakeRTCPeerConnection();
    const wireA = makeManager(sessionA.sessionId, pcA);
    const wireB = makeManager(sessionB.sessionId, pcB);

    wireA.manager.addPeer(sessionB, false); // A inisiator (impolite)
    wireB.manager.addPeer(sessionA, true); // B polite

    await vi.waitFor(() => expect(findSignal(wireA.signals, 'offer')).toBeDefined());
    const offer = findSignal(wireA.signals, 'offer');

    wireB.manager.handleSignal(offer as SignalMessage);
    await vi.waitFor(() => expect(findSignal(wireB.signals, 'answer')).toBeDefined());
    const answer = findSignal(wireB.signals, 'answer');

    wireA.manager.handleSignal(answer as SignalMessage);
    await flush();

    expect(pcA.signalingState).toBe('stable');
    expect(pcB.signalingState).toBe('stable');
    expect(pcA.remoteDescription?.type).toBe('answer');
    expect(pcB.remoteDescription?.type).toBe('offer');
  });

  it('sisi penerima mendapat DataChannel lewat event datachannel', async () => {
    const pcA = new FakeRTCPeerConnection();
    const pcB = new FakeRTCPeerConnection();
    const wireA = makeManager(sessionA.sessionId, pcA);
    const wireB = makeManager(sessionB.sessionId, pcB);

    wireA.manager.addPeer(sessionB, false);
    wireB.manager.addPeer(sessionA, true);

    await vi.waitFor(() => expect(findSignal(wireA.signals, 'offer')).toBeDefined());
    const offer = findSignal(wireA.signals, 'offer') as SignalMessage;

    // Simulasi: channel B hadir saat offer diterapkan.
    const channelB = new FakeRTCDataChannel('position');
    wireB.manager.handleSignal(offer);
    pcB.fire('datachannel', { channel: channelB });

    // Kirim posisi dari B → harus mengalir lewat channel B.
    wireB.manager.sendPositionToAll({ x: 5, y: 5 });
    expect(channelB.sent).toEqual([JSON.stringify({ x: 5, y: 5 })]);
  });

  it('glare: kedua sisi menawar — impolite mengabaikan, polite rollback lalu menjawab', async () => {
    const pcA = new FakeRTCPeerConnection();
    const pcB = new FakeRTCPeerConnection();
    let releaseGate!: () => void;
    const gate = new Promise<void>((resolve) => {
      releaseGate = resolve;
    });
    pcA.gate = gate;
    pcB.gate = gate;

    const wireA = makeManager(sessionA.sessionId, pcA); // A impolite (id lebih kecil)
    const wireB = makeManager(sessionB.sessionId, pcB); // B polite

    wireA.manager.addPeer(sessionB, false); // → membuat DC → negotiationneeded → offer (tertahan gate)
    wireB.manager.addPeer(sessionA, true);
    wireB.manager.attachLocalStream(makeStream()); // → addTrack → negotiationneeded → offer B (tertahan gate)

    releaseGate();
    await vi.waitFor(() => {
      expect(findSignal(wireA.signals, 'offer')).toBeDefined();
      expect(findSignal(wireB.signals, 'offer')).toBeDefined();
    });
    const offerFromB = findSignal(wireB.signals, 'offer') as SignalMessage;
    const offerFromA = findSignal(wireA.signals, 'offer') as SignalMessage;

    // Tukar-menukar offer bersamaan (glare).
    wireA.manager.handleSignal(offerFromB);
    await flush();
    wireB.manager.handleSignal(offerFromA);
    await vi.waitFor(() => expect(findSignal(wireB.signals, 'answer')).toBeDefined());
    const answerFromB = findSignal(wireB.signals, 'answer') as SignalMessage;

    wireA.manager.handleSignal(answerFromB);
    await flush();

    // A mengabaikan offer B (impolite + collision) — remoteDescription A hanya answer.
    expect(pcA.remoteDescription?.type).toBe('answer');
    expect(pcA.remoteDescription?.sdp).not.toBe(sdpOf(offerFromB));
    // B me-rollback offer-nya dan menerima offer A.
    expect(pcB.remoteDescription?.type).toBe('offer');
    expect(pcB.remoteDescription?.sdp).toBe(sdpOf(offerFromA));
    expect(pcA.signalingState).toBe('stable');
    expect(pcB.signalingState).toBe('stable');
  });

  it('kandidat ICE terlambat di-trickle hanya setelah deskripsi terkirim', async () => {
    const pcA = new FakeRTCPeerConnection();
    const wire = makeManager(sessionA.sessionId, pcA);

    wire.manager.addPeer(sessionB, false);
    await vi.waitFor(() => expect(findSignal(wire.signals, 'offer')).toBeDefined());

    pcA.fire('icecandidate', {
      candidate: {
        candidate: 'candidate:1 1 UDP 2130706431 10.0.0.1 8998 typ host',
        sdpMid: '0',
        sdpMLineIndex: 0,
        usernameFragment: 'frag',
      },
    });
    await flush();

    const ice = findSignal(wire.signals, 'ice');
    expect(ice).toMatchObject({ type: 'ice', from: sessionA.sessionId, to: sessionB.sessionId });

    // End-of-candidates (null) tidak dikirim.
    pcA.fire('icecandidate', { candidate: null });
    expect(wire.signals.filter((signal) => signal.type === 'ice')).toHaveLength(1);
  });

  it('answer tanpa offer sebelumnya tercatat sebagai error, tidak crash', async () => {
    const pc = new FakeRTCPeerConnection();
    const onError = vi.fn();
    const wire = makeManager(sessionA.sessionId, pc, onError);
    wire.manager.addPeer(sessionB, true);

    wire.manager.handleSignal({
      v: 1,
      type: 'answer',
      from: sessionB.sessionId,
      to: sessionA.sessionId,
      sdp: 'v=0\r\nfake-answer',
    });
    await flush();

    expect(onError).toHaveBeenCalledTimes(1);
    expect(wire.manager.has(sessionB.sessionId)).toBe(true); // peer tetap hidup
  });
});

describe('PeerConnectionManager — media & posisi', () => {
  it('attachLocalStream memasang track ke peer baru maupun lama', async () => {
    const pc = new FakeRTCPeerConnection();
    const wire = makeManager(sessionA.sessionId, pc);
    const stream = makeStream();

    wire.manager.attachLocalStream(stream);
    wire.manager.addPeer(sessionB, true);

    expect(pc.senders).toHaveLength(1);
    expect(pc.attachedStreams[0]?.track.kind).toBe('audio');

    const stream2 = makeStream();
    wire.manager.attachLocalStream(stream2);
    await flush();

    // Track diganti (replaceTrack), sender tidak bertambah.
    expect(pc.senders).toHaveLength(1);
    expect(pc.senders[0]?.replaced).toHaveLength(1);
  });

  it('detachLocalStream melepas track (replaceTrack null)', async () => {
    const pc = new FakeRTCPeerConnection();
    const wire = makeManager(sessionA.sessionId, pc);
    wire.manager.attachLocalStream(makeStream());
    wire.manager.addPeer(sessionB, true);

    wire.manager.detachLocalStream();
    await flush();

    expect(pc.senders[0]?.track).toBeNull();
  });

  it('track remote diteruskan ke onTrack', () => {
    const pc = new FakeRTCPeerConnection();
    const onTrack = vi.fn();
    const signals: SignalMessage[] = [];
    const manager = new PeerConnectionManager({
      selfSessionId: sessionA.sessionId,
      createPeerConnection: () => asPeerConnection(pc),
      onOutgoingSignal: (message) => signals.push(message),
      onTrack: (sessionId, track, stream) => onTrack(sessionId, track, stream),
      onConnectionState: () => undefined,
      onPosition: () => undefined,
    });
    manager.addPeer(sessionB, true);

    const track = makeTrack();
    const stream = makeStream();
    pc.fire('track', { track, streams: [stream] });

    expect(onTrack).toHaveBeenCalledWith(sessionB.sessionId, track, stream);
  });

  it('posisi masuk dari DataChannel diteruskan ke onPosition + validasi', () => {
    const pc = new FakeRTCPeerConnection();
    const onPosition = vi.fn();
    const onInvalidPosition = vi.fn();
    const signals: SignalMessage[] = [];
    const manager = new PeerConnectionManager({
      selfSessionId: sessionA.sessionId,
      createPeerConnection: () => asPeerConnection(pc),
      onOutgoingSignal: (message) => signals.push(message),
      onTrack: () => undefined,
      onConnectionState: () => undefined,
      onPosition: (sessionId, position) => onPosition(sessionId, position),
      onInvalidPosition: (sessionId, reason) => onInvalidPosition(sessionId, reason),
    });
    manager.addPeer(sessionB, true);

    const channel = new FakeRTCDataChannel('position');
    pc.fire('datachannel', { channel });

    channel.deliver(JSON.stringify({ x: 1, y: 2 }));
    expect(onPosition).toHaveBeenCalledWith(sessionB.sessionId, { x: 1, y: 2 });

    channel.deliver('rusak');
    expect(onInvalidPosition).toHaveBeenCalledWith(sessionB.sessionId, 'payload bukan JSON valid');
  });
});
