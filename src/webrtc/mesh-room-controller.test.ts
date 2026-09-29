import { describe, expect, it, vi } from 'vitest';
import { MeshRoomController } from './mesh-room-controller';
import {
  asPeerConnection,
  asSupabase,
  FakeRTCDataChannel,
  FakeRealtimeChannel,
  FakeRTCPeerConnection,
  FakeSupabase,
  flush,
  makeSession,
} from './test-utils';
import type { MeshRoomEventMap, PeerState, SessionInfo } from './types';

type RecordedEvents = {
  [K in keyof MeshRoomEventMap]: Array<MeshRoomEventMap[K]>;
};

function recordEvents(controller: MeshRoomController): RecordedEvents {
  const events = {
    'peer-joined': [],
    'peer-left': [],
    'peer-state': [],
    'remote-stream': [],
    'remote-position': [],
    'invalid-signal': [],
    'invalid-position': [],
    'room-full': [],
    'selected-pair': [],
    error: [],
  } as RecordedEvents;
  for (const key of Object.keys(events) as Array<keyof MeshRoomEventMap>) {
    controller.on(key, (payload) => {
      events[key].push(payload as never);
    });
  }
  return events;
}

function makePeerSession(sessionId: string): SessionInfo {
  return makeSession({ sessionId });
}

function setup(roomCode = 'X8BBY001', selfId = 'aaaa-self-0001') {
  const fakeSupabase = new FakeSupabase();
  const self = makeSession({ sessionId: selfId, displayName: 'Diri Sendiri' });
  const pcs: FakeRTCPeerConnection[] = [];
  const controller = new MeshRoomController({
    supabase: asSupabase(fakeSupabase),
    roomCode,
    self,
    createPeerConnection: (config) => {
      const pc = new FakeRTCPeerConnection(config);
      pcs.push(pc);
      return asPeerConnection(pc);
    },
  });
  const events = recordEvents(controller);
  const channel = (): FakeRealtimeChannel => {
    const created = fakeSupabase.channels[0];
    if (created === undefined) {
      throw new Error('channel belum dibuat oleh controller');
    }
    return created;
  };
  const pc = (index = 0): FakeRTCPeerConnection => {
    const created = pcs[index];
    if (created === undefined) {
      throw new Error(`peer connection #${String(index)} belum ada`);
    }
    return created;
  };
  return { supabase: fakeSupabase, self, pcs, controller, events, channel, pc };
}

interface SignalLike {
  type: string;
}

function countSignals(channel: FakeRealtimeChannel, type: string): number {
  return channel.sentSignals.filter((signal) => (signal as SignalLike).type === type).length;
}

describe('MeshRoomController — validasi konstruktor', () => {
  it('menolak room code di luar pola', () => {
    const supabase = new FakeSupabase();
    expect(
      () =>
        new MeshRoomController({
          supabase,
          roomCode: 'BAD!',
          self: makeSession(),
          createPeerConnection: () => asPeerConnection(new FakeRTCPeerConnection()),
        }),
    ).toThrow(/room code tidak valid/);
  });

  it('menolak metadata sesi cacat', () => {
    const supabase = new FakeSupabase();
    expect(
      () =>
        new MeshRoomController({
          supabase,
          roomCode: 'X8BBY001',
          self: { ...makeSession(), displayName: '' },
          createPeerConnection: () => asPeerConnection(new FakeRTCPeerConnection()),
        }),
    ).toThrow(/metadata sesi tidak valid/);
  });
});

describe('MeshRoomController — join', () => {
  it('join: channel PRIVATE dibuat dengan presence key = sessionId, lalu track', async () => {
    const { self, controller, channel } = setup();

    await controller.join();

    expect(channel().topic).toBe('room:X8BBY001');
    expect(channel().isPrivate).toBe(true); // P0-1: wajib private (RLS realtime)
    expect(channel().presenceKey).toBe(self.sessionId);
    expect(channel().subscribed).toBe(true);
    expect(channel().trackPayloads).toEqual([{ ...self }]);
  });

  it('P0-1: room code dinormalisasi sebelum jadi topic channel (paritas SQL 0016)', async () => {
    const { controller, channel } = setup(' x8bby-001 ');

    await controller.join();

    expect(channel().topic).toBe('room:X8BBY001');
  });

  it('join gagal bila channel error → error jelas, tidak ada track', async () => {
    const { controller, channel } = setup();
    channel().subscribeStatus = 'CHANNEL_ERROR';

    await expect(controller.join()).rejects.toThrow(/CHANNEL_ERROR/);
    expect(channel().trackPayloads).toHaveLength(0);
  });

  it('regresi audit 23-b M1: status CLOSED saat join → REJECT (bukan menggantung selamanya)', async () => {
    const { controller, channel } = setup();
    channel().subscribeStatus = 'CLOSED';

    // Tanpa fix, Promise subscribe tidak pernah settle untuk CLOSED — test
    // ini akan TIMEOUT (bukan reject) sebagai bukti regresi.
    await expect(controller.join()).rejects.toThrow(/CLOSED/);
    expect(channel().trackPayloads).toHaveLength(0);
  });

  it('regresi audit 23-b M2: join gagal → channel DIBUANG + unsubscribe (tidak bocor di client bersama)', async () => {
    const { controller, channel, supabase } = setup();
    channel().subscribeStatus = 'CHANNEL_ERROR';

    await expect(controller.join()).rejects.toThrow(/CHANNEL_ERROR/);
    expect(channel().unsubscribed).toBe(true);
    expect(supabase.removedChannels).toHaveLength(1);
    expect(supabase.removedChannels[0]).toBe(channel());
    // Handler presence tidak lagi akan menyala untuk channel mati — bukti
    // tambahan: tidak ada punya efek samping saat fireSync dipanggil.
    expect(() => channel().fireSync()).not.toThrow();
  });

  it('join kedua kali melempar error', async () => {
    const { controller } = setup();
    await controller.join();
    await expect(controller.join()).rejects.toThrow(/sudah join/);
  });
});

describe('MeshRoomController — penemuan peer', () => {
  it('peer dengan id lebih besar → kita jadi inisiator: offer terkirim', async () => {
    const { controller, events, pcs, channel } = setup('X8BBY001', 'aaaa-self-0001');
    await controller.join();

    const peer = makePeerSession('zzzz-peer-0002');
    channel().simulatePresence(peer);

    expect(events['peer-joined']).toHaveLength(1);
    const joined = events['peer-joined'][0] as { peer: PeerState };
    expect(joined.peer.sessionId).toBe(peer.sessionId);
    expect(joined.peer.connectionState).toBe('new');
    expect(pcs).toHaveLength(1);

    await vi.waitFor(() => expect(countSignals(channel(), 'offer')).toBe(1));
    expect(controller.getPeers()).toHaveLength(1);
    expect(controller.roomSize).toBe(2);
  });

  it('peer dengan id lebih kecil → kita menunggu, tidak menawar', async () => {
    const { controller, pcs, pc, channel } = setup('X8BBY001', 'zzzz-self-9999');
    await controller.join();

    channel().simulatePresence(makePeerSession('aaaa-peer-0001'));
    await flush();
    await flush();

    expect(pcs).toHaveLength(1);
    expect(pc(0).dataChannels).toHaveLength(0);
    expect(countSignals(channel(), 'offer')).toBe(0);
  });

  it('peer hilang dari presence → koneksi ditutup + event peer-left', async () => {
    const { controller, events, pcs, pc, channel } = setup();
    await controller.join();
    const peer = makePeerSession('zzzz-peer-0002');
    channel().simulatePresence(peer);
    expect(pcs).toHaveLength(1);

    channel().removePresence(peer.sessionId);

    expect(events['peer-left']).toEqual([{ sessionId: peer.sessionId }]);
    expect(pc(0).closed).toBe(true);
    expect(controller.getPeers()).toHaveLength(0);
  });

  it('sinyal bye → peer ditutup + event peer-left', async () => {
    const { controller, events, pc, channel } = setup();
    await controller.join();
    const peer = makePeerSession('zzzz-peer-0002');
    channel().simulatePresence(peer);

    channel().deliverSignal({ v: 1, type: 'bye', from: peer.sessionId, to: '*' });

    expect(events['peer-left']).toEqual([{ sessionId: peer.sessionId }]);
    expect(pc(0).closed).toBe(true);
  });

  it('self-heal: offer dari peer yang belum sempat ter-sync tetap diproses', async () => {
    const { controller, events, pcs, pc, channel } = setup();
    await controller.join();
    const peer = makePeerSession('zzzz-peer-0002');

    // Peer ada di presence TAPI sync belum menyala (simulasi race).
    channel().presence.set(peer.sessionId, peer);
    channel().deliverSignal({
      v: 1,
      type: 'offer',
      from: peer.sessionId,
      to: 'aaaa-self-0001',
      sdp: 'v=0\r\nfake-offer',
    });
    await flush();

    expect(events['peer-joined']).toHaveLength(1);
    expect(pcs).toHaveLength(1);
    expect(pc(0).remoteDescription?.type).toBe('offer');
  });

  it('payload presence tidak valid diabaikan (tidak jadi peer)', async () => {
    const { controller, pcs, channel } = setup();
    await controller.join();

    channel().presence.set('buruk-session-1', { sesuatu: 'bukan sesi' } as unknown as SessionInfo);
    channel().fireSync();

    expect(pcs).toHaveLength(0);
    expect(controller.getPeers()).toHaveLength(0);
  });
});

describe('MeshRoomController — kapasitas room', () => {
  it('room penuh dan diri sendiri di luar cap → event room-full + auto-leave', async () => {
    const { controller, events, channel, supabase } = setup('X8BBY001', 'zzzz-self-9999');
    await controller.join();

    for (let index = 0; index < 8; index += 1) {
      const id = `peer-${String(index).padStart(4, '0')}-xxxx`;
      channel().presence.set(id, makePeerSession(id));
    }
    channel().fireSync();

    expect(events['room-full']).toEqual([{ size: 9, max: 8 }]);
    await vi.waitFor(() => expect(channel().unsubscribed).toBe(true));
    expect(channel().untracked).toBe(true);
    expect(supabase.removedChannels).toHaveLength(1);
    // bye tetap dikirim sebagai sopan santun walau kita yang keluar
    expect(countSignals(channel(), 'bye')).toBe(1);
  });

  it('room melebihi cap tapi diri sendiri masuk → hanya 7 peer terpilih deterministik', async () => {
    const { controller, events, pcs, channel } = setup('X8BBY001', 'aaaa-self-0001');
    await controller.join();

    // 8 peer lain + diri = 9 sesi; cap 8 → 'iiii-p8' tersingkir.
    const ids = [
      'bbbb-p1',
      'cccc-p2',
      'dddd-p3',
      'eeee-p4',
      'ffff-p5',
      'gggg-p6',
      'hhhh-p7',
      'iiii-p8',
    ];
    for (const id of ids) {
      channel().presence.set(`${id}-xxxx`, makePeerSession(`${id}-xxxx`));
    }
    channel().fireSync();

    expect(events['room-full']).toHaveLength(0);
    expect(pcs).toHaveLength(7);
    expect(controller.getPeers().map((peer) => peer.sessionId)).not.toContain('iiii-p8-xxxx');
  });

  it('regresi audit 23-b M3: room-full auto-leave di sela track() → join() REJECT (bukan sukses palsu)', async () => {
    // Diri 'zzzz-self-9999' urut paling akhir → saat 8 peer lain masuk
    // presence, diri berada DI LUAR set kapasitas deterministik.
    const { controller, events, channel, supabase } = setup('X8BBY001', 'zzzz-self-9999');

    // Presence 8 peer DIPRA-SIAPKAN sebelum join — fake track() memicu
    // fireSync saat melacak diri: inilah jendela race M3 (auto-leave
    // berjalan DI SELA await track()). Tanpa fix, join() resolve SUKSES
    // padahal controller sudah 'left' + channel dibuang.
    for (let index = 0; index < 8; index += 1) {
      const id = `peer-${String(index).padStart(4, '0')}-xxxx`;
      channel().presence.set(id, makePeerSession(id));
    }

    await expect(controller.join()).rejects.toThrow(/room penuh|keluar otomatis/);
    expect(events['room-full']).toEqual([{ size: 9, max: 8 }]);
    await vi.waitFor(() => expect(supabase.removedChannels).toHaveLength(1));
  });

  it('regresi audit 23-b M6: self-heal di kapasitas penuh TIDAK melempar + tidak menambah peer', async () => {
    const { controller, pcs, channel } = setup('X8BBY001', 'aaaa-self-0001');
    await controller.join();

    // 7 peer remote = kapasitas penuh (MAX_ROOM_SIZE 8 termasuk diri).
    const ids = ['bbbb-p1', 'cccc-p2', 'dddd-p3', 'eeee-p4', 'ffff-p5', 'gggg-p6', 'hhhh-p7'];
    for (const id of ids) {
      channel().presence.set(`${id}-xxxx`, makePeerSession(`${id}-xxxx`));
    }
    channel().fireSync();
    expect(pcs).toHaveLength(7);

    // Peer ke-8 valid di presence mengirim offer lewat jalur self-heal
    // (belum terdaftar oleh sync). Tanpa fix: addPeer MELEMPAR "kapasitas
    // mesh tercapai" dan exception menyebar keluar handler broadcast.
    const extra = 'zzzz-peer-0008';
    channel().presence.set(extra, makePeerSession(extra));
    expect(() =>
      channel().deliverSignal({
        v: 1,
        type: 'offer',
        from: extra,
        to: 'aaaa-self-0001',
        sdp: 'v=0\r\nfake-offer',
      }),
    ).not.toThrow();
    await flush();

    expect(pcs).toHaveLength(7); // peer ke-8 TIDAK ditambahkan
    expect(controller.getPeers().map((peer) => peer.sessionId)).not.toContain(extra);
  });
});

describe('MeshRoomController — posisi & media', () => {
  it('setLocalPosition di-clamp + throttle 15 Hz per peer', async () => {
    const { controller, pc, channel } = setup('X8BBY001', 'aaaa-self-0001');
    await controller.join();
    channel().simulatePresence(makePeerSession('zzzz-peer-0002'));
    const dc = pc(0).dataChannels[0];
    if (dc === undefined) {
      throw new Error('data channel posisi belum dibuat');
    }

    controller.setLocalPosition({ x: 99_999, y: -0.12999 });
    expect(dc.sent).toEqual([JSON.stringify({ x: 10_000, y: -0.13 })]);

    // Panggilan kedua seketika → di-throttle.
    controller.setLocalPosition({ x: 1, y: 1 });
    expect(dc.sent).toHaveLength(1);
  });

  it('posisi remote → event remote-position + tercatat di getPeers', async () => {
    const { controller, events, pc, channel } = setup('X8BBY001', 'zzzz-self-9999');
    await controller.join();
    const peer = makePeerSession('aaaa-peer-0001');
    channel().simulatePresence(peer);

    // Sisi polite menerima channel lewat event datachannel.
    const dc = new FakeRTCDataChannel('position');
    pc(0).fire('datachannel', { channel: dc });

    dc.deliver(JSON.stringify({ x: 3.5, y: -7 }));

    expect(events['remote-position']).toHaveLength(1);
    expect(events['remote-position'][0]).toMatchObject({
      sessionId: peer.sessionId,
      position: { x: 3.5, y: -7 },
    });
    expect(controller.getPeers()[0]?.lastPosition).toEqual({ x: 3.5, y: -7 });
    expect(controller.getPeers()[0]?.lastPositionAt).toBeGreaterThan(0);
  });

  it('posisi remote tidak valid → event invalid-position, tidak diteruskan', async () => {
    const { controller, events, pc, channel } = setup('X8BBY001', 'zzzz-self-9999');
    await controller.join();
    channel().simulatePresence(makePeerSession('aaaa-peer-0001'));

    const dc = new FakeRTCDataChannel('position');
    pc(0).fire('datachannel', { channel: dc });

    dc.deliver('bukan-json');

    expect(events['invalid-position']).toHaveLength(1);
    expect(events['remote-position']).toHaveLength(0);
  });

  it('peer-left membersihkan cache posisi — rejoin tidak mewarisi posisi basi (Task 11-d)', async () => {
    const { controller, events, pc, channel } = setup('X8BBY001', 'zzzz-self-9999');
    await controller.join();
    const peer = makePeerSession('aaaa-peer-0001');
    channel().simulatePresence(peer);

    const dc = new FakeRTCDataChannel('position');
    pc(0).fire('datachannel', { channel: dc });
    dc.deliver(JSON.stringify({ x: 3.5, y: -7 }));
    expect(controller.getPeers()[0]?.lastPosition).toEqual({ x: 3.5, y: -7 });

    // Peer pergi (presence hilang) → dropPeer harus ikut membuang posisinya.
    channel().removePresence(peer.sessionId);
    expect(events['peer-left']).toHaveLength(1);

    // Peer yang sama bergabung lagi — posisi lama TIDAK boleh terbawa.
    channel().simulatePresence(peer);
    expect(events['peer-joined']).toHaveLength(2);
    const rejoined = controller.getPeers()[0];
    expect(rejoined?.lastPosition).toBeNull();
    expect(rejoined?.lastPositionAt).toBeNull();
  });

  it('attachLocalStream memasang track ke semua peer', async () => {
    const { controller, pc, channel } = setup('X8BBY001', 'zzzz-self-9999');
    await controller.join();
    channel().simulatePresence(makePeerSession('aaaa-peer-0001'));

    const stream = { getTracks: () => [{ kind: 'audio', id: 'mic-1' }] } as unknown as MediaStream;
    controller.attachLocalStream(stream);

    expect(pc(0).senders).toHaveLength(1);
    expect(pc(0).senders[0]?.track).toEqual({ kind: 'audio', id: 'mic-1' });
  });

  it('track remote masuk → event remote-stream', async () => {
    const { controller, events, pc, channel } = setup('X8BBY001', 'zzzz-self-9999');
    await controller.join();
    channel().simulatePresence(makePeerSession('aaaa-peer-0001'));

    const track = { kind: 'audio', id: 'remote-mic' } as unknown as MediaStreamTrack;
    const stream = { getTracks: () => [] } as unknown as MediaStream;
    pc(0).fire('track', { track, streams: [stream] });

    expect(events['remote-stream']).toEqual([{ sessionId: 'aaaa-peer-0001', track, stream }]);
  });

  it('perubahan state koneksi → event peer-state', async () => {
    const { controller, events, pc, channel } = setup('X8BBY001', 'zzzz-self-9999');
    await controller.join();
    channel().simulatePresence(makePeerSession('aaaa-peer-0001'));

    pc(0).simulateState({ connectionState: 'connected', iceConnectionState: 'connected' });

    expect(events['peer-state']).toHaveLength(1);
    expect((events['peer-state'][0] as { peer: PeerState }).peer.connectionState).toBe('connected');
  });
});

describe('MeshRoomController — sinyal tidak valid & error', () => {
  it('payload signaling rusak → event invalid-signal', async () => {
    const { controller, events, channel } = setup();
    await controller.join();

    channel().deliverSignal({ type: 'offer' }); // field wajib hilang

    expect(events['invalid-signal']).toHaveLength(1);
    expect(typeof events['invalid-signal'][0]?.reason).toBe('string');
  });

  it('sinyal dari session asing (tidak ada di presence) diabaikan', async () => {
    const { controller, pcs, channel } = setup();
    await controller.join();

    channel().deliverSignal({
      v: 1,
      type: 'offer',
      from: 'asing-session-9999',
      to: 'aaaa-self-0001',
      sdp: 'v=0',
    });
    await flush();

    expect(pcs).toHaveLength(0);
  });
});

describe('MeshRoomController — leave', () => {
  it('leave: bye terkirim, semua peer ditutup, presence dilepas, channel dibuang', async () => {
    const { controller, events, pcs, channel, supabase } = setup();
    await controller.join();
    channel().simulatePresence(makePeerSession('zzzz-peer-0002'));
    channel().simulatePresence(makePeerSession('yyyy-peer-0003'));
    expect(pcs).toHaveLength(2);

    await controller.leave();

    expect(countSignals(channel(), 'bye')).toBe(1);
    expect(events['peer-left']).toHaveLength(2);
    expect(pcs.every((peer) => peer.closed)).toBe(true);
    expect(channel().untracked).toBe(true);
    expect(channel().unsubscribed).toBe(true);
    expect(supabase.removedChannels).toHaveLength(1);
  });

  it('leave dua kali aman (idempoten)', async () => {
    const { controller, channel } = setup();
    await controller.join();

    await controller.leave();
    await controller.leave();

    expect(countSignals(channel(), 'bye')).toBe(1);
  });

  it('setelah leave, join lagi ditolak', async () => {
    const { controller } = setup();
    await controller.join();
    await controller.leave();

    await expect(controller.join()).rejects.toThrow(/sudah leave/);
  });
});

// ============================================================
// Observabilitas pasangan terpilih (Task 11-b)
// ============================================================

describe('MeshRoomController — pasangan terpilih (selected pair)', () => {
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

  /** Event selected-pair pertama — melempar bila belum terpancar (narrowing). */
  function firstSelectedPair(events: RecordedEvents): RecordedEvents['selected-pair'][number] {
    const first = events['selected-pair'][0];
    if (first === undefined) {
      throw new Error('event selected-pair belum terpancar');
    }
    return first;
  }

  it('peer connected dengan pasangan host/host → event selected-pair viaRelay=false + snapshot getPeers', async () => {
    const { controller, events, pc, channel } = setup('X8BBY001', 'aaaa-self-0001');
    await controller.join();
    const peer = makePeerSession('zzzz-peer-0002');
    channel().simulatePresence(peer);

    pc(0).statsEntries = pairEntries('host', 'host');
    pc(0).simulateState({ connectionState: 'connected', iceConnectionState: 'connected' });

    await vi.waitFor(() => expect(events['selected-pair']).toHaveLength(1));
    const emitted = firstSelectedPair(events);
    expect(emitted.sessionId).toBe(peer.sessionId);
    expect(emitted.viaRelay).toBe(false);
    expect(emitted.pair.localType).toBe('host');
    expect(emitted.pair.remoteType).toBe('host');

    // Snapshot getPeers() ikut membawa cache pasangan terpilih.
    const snapshot = controller.getPeers().find((p) => p.sessionId === peer.sessionId);
    expect(snapshot?.selectedPair?.localType).toBe('host');
    expect(snapshot?.selectedPair?.state).toBe('succeeded');

    await controller.leave();
  });

  it('pasangan relay/relay → viaRelay=true (bukti TURN aktif di jalur nyata)', async () => {
    const { controller, events, pc, channel } = setup('X8BBY001', 'aaaa-self-0001');
    await controller.join();
    const peer = makePeerSession('zzzz-peer-0002');
    channel().simulatePresence(peer);

    pc(0).statsEntries = pairEntries('relay', 'relay');
    pc(0).simulateState({ connectionState: 'connected', iceConnectionState: 'connected' });

    await vi.waitFor(() => expect(events['selected-pair']).toHaveLength(1));
    const relayed = firstSelectedPair(events);
    expect(relayed.viaRelay).toBe(true);
    expect(relayed.pair.localType).toBe('relay');

    await controller.leave();
  });

  it('belum pernah connected → snapshot selectedPair null (bukan undefined)', async () => {
    const { controller, channel } = setup('X8BBY001', 'aaaa-self-0001');
    await controller.join();
    const peer = makePeerSession('zzzz-peer-0002');
    channel().simulatePresence(peer);
    await flush();

    const snapshot = controller.getPeers().find((p) => p.sessionId === peer.sessionId);
    expect(snapshot?.selectedPair).toBeNull();

    await controller.leave();
  });

  it('peer-left membersihkan cache — peer yang sama bergabung lagi mulai dari null', async () => {
    const { controller, events, pc, channel } = setup('X8BBY001', 'aaaa-self-0001');
    await controller.join();
    const peer = makePeerSession('zzzz-peer-0002');
    channel().simulatePresence(peer);

    pc(0).statsEntries = pairEntries('host', 'host');
    pc(0).simulateState({ connectionState: 'connected', iceConnectionState: 'connected' });
    await vi.waitFor(() => expect(events['selected-pair']).toHaveLength(1));
    expect(
      controller.getPeers().find((p) => p.sessionId === peer.sessionId)?.selectedPair?.localType,
    ).toBe('host');

    // Peer pergi → cache terhapus.
    channel().removePresence(peer.sessionId);
    await vi.waitFor(() => expect(events['peer-left']).toHaveLength(1));

    // Peer yang sama datang lagi — pasangan lama TIDAK boleh bocor.
    channel().simulatePresence(peer);
    await flush();
    const rejoined = controller.getPeers().find((p) => p.sessionId === peer.sessionId);
    expect(rejoined?.selectedPair).toBeNull();

    await controller.leave();
  });
});
