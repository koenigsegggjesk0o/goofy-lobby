import { describe, expect, it, vi, type Mock } from 'vitest';
import { IceRestartHandler } from './ice-restart-handler';
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

describe('PeerConnectionManager — watchdog establishment', () => {
  it('impolite ter-arm → pc nyangkut connecting → offer iceRestart terkirim; polite tidak ter-arm', async () => {
    // Spy pada prototipe tetap menjalankan implementasi asli (timer sungguhan
    // tetap terpasang) — hanya mencatat pemanggilan arm().
    const armSpy = vi.spyOn(IceRestartHandler.prototype, 'arm');
    try {
      const pcPolite = new FakeRTCPeerConnection();
      const polite = new PeerConnectionManager({
        selfSessionId: sessionA.sessionId,
        createPeerConnection: () => asPeerConnection(pcPolite),
        establishmentTimeoutMs: 10,
        onOutgoingSignal: () => undefined,
        onTrack: () => undefined,
        onConnectionState: () => undefined,
        onPosition: () => undefined,
      });
      polite.addPeer(sessionB, true); // polite → TIDAK meng-arm watchdog
      expect(armSpy).not.toHaveBeenCalled();

      const pc = new FakeRTCPeerConnection();
      const signals: SignalMessage[] = [];
      const manager = new PeerConnectionManager({
        selfSessionId: sessionA.sessionId,
        createPeerConnection: () => asPeerConnection(pc),
        establishmentTimeoutMs: 10,
        onOutgoingSignal: (message) => signals.push(message),
        onTrack: () => undefined,
        onConnectionState: () => undefined,
        onPosition: () => undefined,
      });
      manager.addPeer(sessionB, false); // impolite → arm() dari addPeer
      expect(armSpy).toHaveBeenCalledTimes(1);

      pc.simulateState({ connectionState: 'connecting' }); // nyangkut, tidak pernah membaik

      await vi.waitFor(() => {
        expect(
          signals.some((signal) => signal.type === 'offer' && sdpOf(signal).includes('restart')),
        ).toBe(true);
      });
      // Restart menyala → handler meng-arm ulang (percobaan establishment baru).
      expect(armSpy.mock.calls.length).toBeGreaterThanOrEqual(2);

      manager.closeAll();
      polite.closeAll();
    } finally {
      armSpy.mockRestore();
    }
  });
});

// ============================================================
// Observabilitas pasangan terpilih (Task 11-b)
// ============================================================

describe('PeerConnectionManager — pasangan terpilih (selected pair)', () => {
  /** Entri stats pasangan terpilih + kandidatnya (bentuk RTCStats ringkas). */
  function pairEntries(localType: string, remoteType: string): Array<Record<string, unknown>> {
    return [
      { id: 'L1', type: 'local-candidate', candidateType: localType },
      { id: 'R1', type: 'remote-candidate', candidateType: remoteType },
      {
        id: 'P1',
        type: 'candidate-pair',
        localCandidateId: 'L1',
        remoteCandidateId: 'R1',
        state: 'succeeded',
        nominated: true,
        selected: true,
      },
    ];
  }

  interface PairWire {
    manager: PeerConnectionManager;
    pc: FakeRTCPeerConnection;
    pairs: Array<{ sessionId: string; localType: string; remoteType: string }>;
  }

  function makePairManager(resampleMs = 20): PairWire {
    const pc = new FakeRTCPeerConnection();
    const pairs: PairWire['pairs'] = [];
    const manager = new PeerConnectionManager({
      selfSessionId: sessionA.sessionId,
      createPeerConnection: () => asPeerConnection(pc),
      selectedPairResampleMs: resampleMs,
      onOutgoingSignal: () => undefined,
      onTrack: () => undefined,
      onConnectionState: () => undefined,
      onPosition: () => undefined,
      onSelectedPair: (sessionId, pair) => {
        pairs.push({ sessionId, localType: pair.localType, remoteType: pair.remoteType });
      },
    });
    return { manager, pc, pairs };
  }

  it('report maplike ASLI (forEach value-first, iterator [key,value]) → onSelectedPair tetap terbaca (regresi 14-b)', async () => {
    const wire = makePairManager();
    wire.manager.addPeer(sessionB, false);
    // Bukti empiris 28 Sep 2026: RTCStatsReport asli adalah maplike —
    // [...report] menghasilkan pasangan [key, value] sehingga parser lama
    // diam-null di browser nyata (mesh live 2-tab: 10 entri semua type
    // undefined). readSelectedPair kini mengumpulkan via forEach dan parser
    // menormalisasi kedua bentuk. Test ini mengunci jalur maplike di level
    // manager — fake default (array-of-object) TIDAK menutup bentuk ini.
    const entries = pairEntries('host', 'host');
    const maplike = {
      forEach(cb: (value: Record<string, unknown>) => void): void {
        for (const entry of entries) cb(entry);
      },
      *[Symbol.iterator](): Iterator<[string, Record<string, unknown>]> {
        for (const entry of entries) yield [String(entry.id ?? 'x'), entry];
      },
    };
    wire.pc.getStats = async () => maplike as unknown as Array<Record<string, unknown>>;
    wire.pc.simulateState({ connectionState: 'connected', iceConnectionState: 'connected' });

    await vi.waitFor(() => {
      expect(wire.pairs).toHaveLength(1);
    });
    expect(wire.pairs[0]).toEqual({
      sessionId: sessionB.sessionId,
      localType: 'host',
      remoteType: 'host',
    });
    wire.manager.closeAll();
  });

  it('memasuki connected → sampel segera → onSelectedPair dengan tipe pasangan', async () => {
    const wire = makePairManager();
    wire.manager.addPeer(sessionB, false);
    wire.pc.statsEntries = pairEntries('host', 'host');
    wire.pc.simulateState({ connectionState: 'connected', iceConnectionState: 'connected' });

    await vi.waitFor(() => {
      expect(wire.pairs).toHaveLength(1);
    });
    expect(wire.pairs[0]).toEqual({
      sessionId: sessionB.sessionId,
      localType: 'host',
      remoteType: 'host',
    });
    wire.manager.closeAll();
  });

  it('regresi audit 23-b M4: getStats resolve SETELAH removePeer → TIDAK ada emisi pasangan basi', async () => {
    const wire = makePairManager();
    wire.manager.addPeer(sessionB, false);
    // getStats "menggantung" — resolve dikendalikan test (meniru stats lambat
    // yang baru selesai SETELAH peer dilepas). Tanpa guard liveness, callback
    // men-SET ULANG entri pasangan untuk sesi yang sudah pergi.
    let releaseStats!: (entries: Array<Record<string, unknown>>) => void;
    wire.pc.getStats = () =>
      new Promise<Array<Record<string, unknown>>>((resolve) => {
        releaseStats = resolve;
      });
    wire.pc.simulateState({ connectionState: 'connected', iceConnectionState: 'connected' });

    // Peer dilepas SEBELUM stats resolve.
    wire.manager.removePeer(sessionB.sessionId);
    releaseStats(pairEntries('relay', 'relay'));
    await flush();
    await flush();

    expect(wire.pairs).toHaveLength(0); // tidak ada emisi untuk sesi yang sudah pergi
    wire.manager.closeAll();
  });

  it('double-event transisi yang sama (connection+ice) → SATU sampel per episode', async () => {
    const wire = makePairManager();
    wire.manager.addPeer(sessionB, false);
    wire.pc.statsEntries = pairEntries('host', 'host');
    // simulateState memicu connectionstatechange DAN iceconnectionstatechange.
    wire.pc.simulateState({ connectionState: 'connected', iceConnectionState: 'connected' });
    // Event tambahan tanpa perubahan state (event ganda nyata di browser).
    wire.pc.fire('connectionstatechange', undefined);
    wire.pc.fire('iceconnectionstatechange', undefined);

    await vi.waitFor(() => {
      expect(wire.pairs).toHaveLength(1);
    });
    // Tunggu jendela re-sample lewat — pasangan tidak berubah → tidak ada emisi baru.
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(wire.pairs).toHaveLength(1);
    wire.manager.closeAll();
  });

  it('re-sample tertunda menangkap perubahan pasangan (host → relay, nominasi terlambat)', async () => {
    // Jendela re-sample panjang (200ms) — bebas race dengan assertion test:
    // mutasi stats HARUS terjadi sebelum timer menyala.
    const wire = makePairManager(200);
    wire.manager.addPeer(sessionB, false);
    wire.pc.statsEntries = pairEntries('host', 'host');
    wire.pc.simulateState({ connectionState: 'connected', iceConnectionState: 'connected' });

    // Sampel segera = rantai microtask murni — deterministik selesai setelah flush().
    await flush();
    expect(wire.pairs).toHaveLength(1);

    // Pasangan berganti ke relay SETELAH connected menyala (nominasi TURN lambat).
    wire.pc.statsEntries = pairEntries('relay', 'relay');
    await vi.waitFor(
      () => {
        expect(wire.pairs).toHaveLength(2);
      },
      { timeout: 2_000 },
    );
    expect(wire.pairs[1]).toEqual({
      sessionId: sessionB.sessionId,
      localType: 'relay',
      remoteType: 'relay',
    });
    wire.manager.closeAll();
  });

  it('sampul null di awal (belum ada pasangan) → emisi pertama saat re-sample menemukannya', async () => {
    const wire = makePairManager(20);
    wire.manager.addPeer(sessionB, false);
    wire.pc.statsEntries = []; // belum ada pasangan sukses saat connected menyala
    wire.pc.simulateState({ connectionState: 'connected', iceConnectionState: 'connected' });
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(wire.pairs).toHaveLength(0); // null tidak dipancarkan

    wire.pc.statsEntries = pairEntries('srflx', 'host');
    await vi.waitFor(() => {
      expect(wire.pairs).toHaveLength(1);
    });
    expect(wire.pairs[0]?.localType).toBe('srflx');
    wire.manager.closeAll();
  });

  it('episode baru setelah blip disconnected → pasangan sama tidak di-emit ulang, pasangan berubah di-emit', async () => {
    const wire = makePairManager(20);
    wire.manager.addPeer(sessionB, false);
    wire.pc.statsEntries = pairEntries('host', 'host');
    wire.pc.simulateState({ connectionState: 'connected', iceConnectionState: 'connected' });
    await vi.waitFor(() => {
      expect(wire.pairs).toHaveLength(1);
    });

    // Blip singkat → episode berakhir; kembali connected dengan pasangan SAMA.
    wire.pc.simulateState({ connectionState: 'disconnected', iceConnectionState: 'disconnected' });
    wire.pc.simulateState({ connectionState: 'connected', iceConnectionState: 'connected' });
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(wire.pairs).toHaveLength(1); // dedupe signature — tidak ada info baru

    // Episode berikutnya dengan pasangan BERUBAH (mis. jatuh ke relay) → emit.
    wire.pc.simulateState({ connectionState: 'disconnected', iceConnectionState: 'disconnected' });
    wire.pc.statsEntries = pairEntries('relay', 'host');
    wire.pc.simulateState({ connectionState: 'connected', iceConnectionState: 'connected' });
    await vi.waitFor(() => {
      expect(wire.pairs).toHaveLength(2);
    });
    expect(wire.pairs[1]?.localType).toBe('relay');
    wire.manager.closeAll();
  });

  it('removePeer sebelum re-sample → timer dibersihkan, tidak ada emisi terlambat', async () => {
    const wire = makePairManager(20);
    wire.manager.addPeer(sessionB, false);
    wire.pc.statsEntries = pairEntries('host', 'host');
    wire.pc.simulateState({ connectionState: 'connected', iceConnectionState: 'connected' });
    await vi.waitFor(() => {
      expect(wire.pairs).toHaveLength(1);
    });

    wire.pc.statsEntries = pairEntries('relay', 'relay'); // akan terbaca bila re-sample jalan
    wire.manager.removePeer(sessionB.sessionId);
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(wire.pairs).toHaveLength(1); // re-sample tidak pernah menyala
    wire.manager.closeAll();
  });

  it('getStats gagal → diam (tidak ada emisi, tidak melempar)', async () => {
    const wire = makePairManager(20);
    wire.manager.addPeer(sessionB, false);
    wire.pc.statsFailure = true;
    wire.pc.simulateState({ connectionState: 'connected', iceConnectionState: 'connected' });
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(wire.pairs).toHaveLength(0);
    wire.manager.closeAll();
  });

  it('tanpa callback onSelectedPair → getStats tidak pernah dipanggil (nol biaya)', async () => {
    const pc = new FakeRTCPeerConnection();
    const manager = new PeerConnectionManager({
      selfSessionId: sessionA.sessionId,
      createPeerConnection: () => asPeerConnection(pc),
      onOutgoingSignal: () => undefined,
      onTrack: () => undefined,
      onConnectionState: () => undefined,
      onPosition: () => undefined,
    });
    manager.addPeer(sessionB, false);
    pc.statsEntries = pairEntries('host', 'host');
    pc.simulateState({ connectionState: 'connected', iceConnectionState: 'connected' });
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(pc.getStatsCalls).toBe(0);
    manager.closeAll();
  });
});

describe('PeerConnectionManager — ketangguhan buffer & timer (Task 11-d)', () => {
  it('antrean kandidat remote sebelum remoteDescription dibatasi 50 (drop terlama)', async () => {
    const pc = new FakeRTCPeerConnection();
    const wire = makeManager(sessionA.sessionId, pc);
    wire.manager.addPeer(sessionB, true); // polite — menunggu offer, tanpa deskripsi lokal

    // Peer jaringan mengirim 60 kandidat TANPA pernah mengirim deskripsi —
    // semua tertahan di antrean (remoteDescription masih null).
    for (let index = 1; index <= 60; index += 1) {
      wire.manager.handleSignal({
        v: 1,
        type: 'ice',
        from: sessionB.sessionId,
        to: sessionA.sessionId,
        candidate: `candidate:${String(index)} udp 2122265983 typ host`,
        sdpMid: '0',
        sdpMLineIndex: 0,
        usernameFragment: null,
      });
    }

    // Offer akhirnya tiba → remoteDescription terpasang → antrean di-flush.
    wire.manager.handleSignal({
      v: 1,
      type: 'offer',
      from: sessionB.sessionId,
      to: sessionA.sessionId,
      sdp: 'v=0\r\nfake-offer',
    });
    await flush();
    await flush();

    // Terbatas 50: 10 terlama dibuang, urutan sisanya terjaga (#11..#60).
    expect(pc.candidates).toHaveLength(50);
    expect((pc.candidates[0] as { candidate?: string }).candidate).toBe(
      'candidate:11 udp 2122265983 typ host',
    );
    expect((pc.candidates[49] as { candidate?: string }).candidate).toBe(
      'candidate:60 udp 2122265983 typ host',
    );
    wire.manager.closeAll();
  });

  it('flapping cepat tidak menumpuk timer re-sample — episode berakhir melepas timer', async () => {
    // Jendela re-sample panjang (200ms): seluruh rangkaian blip selesai
    // sinkron SEBELUM timer mana pun sempat menyala — deterministik.
    const pc = new FakeRTCPeerConnection();
    const pairs: Array<{ sessionId: string; localType: string; remoteType: string }> = [];
    const manager = new PeerConnectionManager({
      selfSessionId: sessionA.sessionId,
      createPeerConnection: () => asPeerConnection(pc),
      selectedPairResampleMs: 200,
      onOutgoingSignal: () => undefined,
      onTrack: () => undefined,
      onConnectionState: () => undefined,
      onPosition: () => undefined,
      onSelectedPair: (sessionId, pair) => {
        pairs.push({ sessionId, localType: pair.localType, remoteType: pair.remoteType });
      },
    });
    manager.addPeer(sessionB, false);
    pc.statsEntries = [
      { id: 'L1', type: 'local-candidate', candidateType: 'host' },
      { id: 'R1', type: 'remote-candidate', candidateType: 'host' },
      {
        id: 'P1',
        type: 'candidate-pair',
        localCandidateId: 'L1',
        remoteCandidateId: 'R1',
        state: 'succeeded',
        nominated: true,
        selected: true,
      },
    ];

    // 6 episode 'connected' dipisah blip 'disconnected', semua sinkron.
    for (let episode = 0; episode < 6; episode += 1) {
      pc.simulateState({ connectionState: 'connected', iceConnectionState: 'connected' });
      if (episode < 5) {
        pc.simulateState({ connectionState: 'disconnected', iceConnectionState: 'disconnected' });
      }
    }

    await flush(); // sampel segera tiap episode = rantai microtask murni
    await new Promise((resolve) => setTimeout(resolve, 260)); // jendela re-sample terlewati
    // 6 sampel segera + HANYA timer episode terakhir yang selamat = 7.
    // Tanpa pembersihan saat episode berakhir: 6 timer usang ikut menyala = 12.
    expect(pc.getStatsCalls).toBe(7);
    // Pasangan tidak berubah sepanjang flapping → dedupe signature tetap bekerja.
    expect(pairs).toHaveLength(1);
    manager.closeAll();
  });
});

describe('PeerConnectionManager — ketangguhan broadcast posisi (15-a)', () => {
  it('channel peer pertama melempar saat send → peer berikutnya TETAP menerima posisi', () => {
    const pcs = [new FakeRTCPeerConnection(), new FakeRTCPeerConnection()];
    let idx = 0;
    const manager = new PeerConnectionManager({
      selfSessionId: sessionA.sessionId,
      createPeerConnection: () => {
        const pc = pcs[idx];
        idx += 1;
        if (pc === undefined) throw new Error('factory pc habis');
        return asPeerConnection(pc);
      },
      onOutgoingSignal: () => undefined,
      onTrack: () => undefined,
      onConnectionState: () => undefined,
      onPosition: () => undefined,
    });

    // Dua peer, manager sebagai INISIATOR keduanya → createDataChannel
    // dipanggil manager sendiri (attachDataChannel jalur internal).
    manager.addPeer(makeSession({ sessionId: 'peer-bad-01' }), false);
    manager.addPeer(makeSession({ sessionId: 'peer-good-2' }), false);

    const [badPc, goodPc] = pcs;
    const badChannel = badPc?.dataChannels[0];
    const goodChannel = goodPc?.dataChannels[0];
    if (badChannel === undefined || goodChannel === undefined) {
      throw new Error('data channel tidak tercipta oleh addPeer impolite');
    }
    // Sabotase: channel peer pertama melempar (kontrak InvalidStateError).
    badChannel.send = () => {
      throw new DOMException('channel sedang menutup', 'InvalidStateError');
    };

    // SEBELUM 15-a: lemparan ini menjatuhkan loop → goodChannel kosong.
    expect(() => manager.sendPositionToAll({ x: 7, y: -7 })).not.toThrow();
    expect(goodChannel.sent).toEqual([JSON.stringify({ x: 7, y: -7 })]);

    manager.closeAll();
  });
});
