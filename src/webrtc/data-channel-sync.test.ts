import { describe, expect, it, vi } from 'vitest';
import { DataChannelSync, type DataChannelSyncOptions } from './data-channel-sync';
import { asDataChannel, FakeRTCDataChannel } from './test-utils';

function setup(overrides: Omit<Partial<DataChannelSyncOptions>, 'onPosition' | 'onInvalid'> = {}) {
  const dc = new FakeRTCDataChannel('position');
  const onPosition = vi.fn();
  const onInvalid = vi.fn();
  let clock = 1_000;
  const sync = new DataChannelSync(asDataChannel(dc), {
    onPosition,
    onInvalid,
    now: () => clock,
    ...overrides,
  });
  return { dc, sync, onPosition, onInvalid, setClock: (ms: number) => (clock = ms) };
}

describe('DataChannelSync', () => {
  it('mengirim posisi pertama langsung lalu men-throttle sesuai interval', () => {
    const { dc, sync, setClock } = setup({ sendIntervalMs: 66 });

    expect(sync.sendPosition({ x: 1, y: 1 })).toBe(true);
    setClock(1_050); // baru 50 ms sejak terakhir → di-throttle
    expect(sync.sendPosition({ x: 2, y: 2 })).toBe(false);
    setClock(1_066); // tepat 66 ms → lolos
    expect(sync.sendPosition({ x: 3, y: 3 })).toBe(true);
    setClock(1_400);
    expect(sync.sendPosition({ x: 4, y: 4 })).toBe(true);

    expect(dc.sent).toEqual([
      JSON.stringify({ x: 1, y: 1 }),
      JSON.stringify({ x: 3, y: 3 }),
      JSON.stringify({ x: 4, y: 4 }),
    ]);
  });

  it('tidak mengirim saat channel belum open', () => {
    const { dc, sync } = setup();
    dc.readyState = 'connecting';
    expect(sync.sendPosition({ x: 0, y: 0 })).toBe(false);
    expect(dc.sent).toHaveLength(0);
  });

  it('tidak mengirim saat buffer penuh (backpressure)', () => {
    const { dc, sync } = setup({ maxBufferedAmount: 1024 });
    dc.bufferedAmount = 2_048;
    expect(sync.sendPosition({ x: 0, y: 0 })).toBe(false);
    expect(dc.sent).toHaveLength(0);
  });

  it('meneruskan payload posisi valid ke onPosition', () => {
    const { dc, onPosition } = setup();
    dc.deliver(JSON.stringify({ x: 1.5, y: -2 }));
    expect(onPosition).toHaveBeenCalledWith({ x: 1.5, y: -2 });
  });

  it('melaporkan payload non-string ke onInvalid', () => {
    const { dc, onPosition, onInvalid } = setup();
    dc.deliver(12345);
    expect(onPosition).not.toHaveBeenCalled();
    expect(onInvalid).toHaveBeenCalledWith('payload bukan string');
  });

  it('melaporkan JSON rusak ke onInvalid', () => {
    const { dc, onInvalid } = setup();
    dc.deliver('{bukan json');
    expect(onInvalid).toHaveBeenCalledWith('payload bukan JSON valid');
  });

  it('melaporkan payload yang gagal validasi Zod', () => {
    const { dc, onPosition, onInvalid } = setup();
    dc.deliver(JSON.stringify({ x: 'kiri', y: 2 }));
    expect(onPosition).not.toHaveBeenCalled();
    expect(onInvalid).toHaveBeenCalledTimes(1);
    expect(onInvalid.mock.calls[0]?.[0]).toContain('x');
  });

  it('setelah close() pesan masuk diabaikan dan pengiriman ditolak', () => {
    const { dc, sync, onPosition } = setup();
    sync.close();

    dc.deliver(JSON.stringify({ x: 9, y: 9 }));
    expect(onPosition).not.toHaveBeenCalled();
    expect(sync.sendPosition({ x: 0, y: 0 })).toBe(false);
  });

  it('listener message dilepas saat close (removeEventListener dipanggil)', () => {
    const dc = new FakeRTCDataChannel('position');
    const removeSpy = vi.spyOn(dc, 'removeEventListener');
    const sync = new DataChannelSync(asDataChannel(dc), { onPosition: () => undefined });
    sync.close();
    expect(removeSpy).toHaveBeenCalledWith('message', expect.any(Function));
  });
});
describe('DataChannelSync — ketangguhan batas API (15-a)', () => {
  it('dc.send() melempar → sendPosition mengembalikan false, eksepsi tidak lolos', () => {
    const dc = new FakeRTCDataChannel('position');
    const sync = new DataChannelSync(asDataChannel(dc), { onPosition: () => undefined });
    // Kontrak RTCDataChannel.send: melempar InvalidStateError bila channel
    // menutup — guard readyState sempat lolos lalu channel mati di tangan
    // pemiliknya. Tanpa try/catch, eksepsi ini menjatuhkan pemanggil loop.
    dc.send = () => {
      throw new DOMException('channel sedang menutup', 'InvalidStateError');
    };
    expect(() => sync.sendPosition({ x: 1, y: 2 })).not.toThrow();
    expect(sync.sendPosition({ x: 1, y: 2 })).toBe(false);
    expect(dc.sent).toHaveLength(0);
  });

  it('posisi runtime eksotis (BigInt) → stringify melempar → false tanpa lempar keluar', () => {
    const dc = new FakeRTCDataChannel('position');
    const sync = new DataChannelSync(asDataChannel(dc), { onPosition: () => undefined });
    // Pemanggil nakal melewati tipe saat runtime: JSON.stringify(BigInt)
    // melempar TypeError. Kontrak best-effort: false, bukan crash.
    const nakal = { x: 1n, y: 2n } as unknown as { x: number; y: number };
    expect(() => sync.sendPosition(nakal)).not.toThrow();
    expect(sync.sendPosition(nakal)).toBe(false);
  });

  it('sendIntervalMs tak valid → RangeError saat konstruksi (konvensi stats.ts)', () => {
    const dc = new FakeRTCDataChannel('position');
    for (const bad of [0, -5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(
        () =>
          new DataChannelSync(asDataChannel(dc), {
            onPosition: () => undefined,
            sendIntervalMs: bad,
          }),
      ).toThrow(RangeError);
    }
  });

  it('maxBufferedAmount tak valid → RangeError saat konstruksi', () => {
    const dc = new FakeRTCDataChannel('position');
    for (const bad of [-1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(
        () =>
          new DataChannelSync(asDataChannel(dc), {
            onPosition: () => undefined,
            maxBufferedAmount: bad,
          }),
      ).toThrow(RangeError);
    }
  });

  it('nilai tepat batas valid diterima (0 untuk maxBufferedAmount, 1 untuk interval)', () => {
    const dc = new FakeRTCDataChannel('position');
    expect(
      () =>
        new DataChannelSync(asDataChannel(dc), {
          onPosition: () => undefined,
          maxBufferedAmount: 0,
          sendIntervalMs: 1,
        }),
    ).not.toThrow();
  });
});

// ============================================================
// Hardening inbound (remediasi audit 25-c, LOW/INFO)
// ============================================================

describe('DataChannelSync — hardening inbound 25-c', () => {
  it('pesan inbound melebihi batas ukuran → di-drop SEBELUM parse + counter + alasan', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      const { dc, onPosition, onInvalid } = setup({ maxInboundMessageChars: 64 });
      const giant = `{"x":1,"y":2,"pad":"${'x'.repeat(200)}"}`;

      dc.deliver(giant);

      expect(onPosition).not.toHaveBeenCalled();
      expect(onInvalid).toHaveBeenCalledTimes(1);
      expect(onInvalid.mock.calls[0]?.[0]).toContain('terlalu besar');
      expect(onInvalid.mock.calls[0]?.[0]).toContain('64');
    } finally {
      warnSpy.mockRestore();
    }
  });

  it('pesan tepat di batas ukuran tetap diproses', () => {
    const dc = new FakeRTCDataChannel('position');
    const onPosition = vi.fn();
    const payload = JSON.stringify({ x: 1, y: 2 }); // 13 karakter
    const sync = new DataChannelSync(asDataChannel(dc), {
      onPosition,
      maxInboundMessageChars: payload.length, // tepat sama dengan panjang pesan
    });

    dc.deliver(payload);

    expect(onPosition).toHaveBeenCalledTimes(1); // > batas = drop, == batas = lolos
    expect(sync.getInboundDropCounts()).toEqual({ oversize: 0, overrate: 0 });
  });

  it('counter oversize bertambah per pesan dan warn hanya sekali per peer', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      const dc = new FakeRTCDataChannel('position');
      const onInvalid = vi.fn();
      const sync = new DataChannelSync(asDataChannel(dc), {
        onPosition: () => undefined,
        onInvalid,
        peerLabel: 'peer-abc',
        maxInboundMessageChars: 10,
      });
      const giant = 'x'.repeat(11);

      dc.deliver(giant);
      dc.deliver(giant);
      dc.deliver(giant);

      expect(sync.getInboundDropCounts()).toEqual({ oversize: 3, overrate: 0 });
      expect(onInvalid).toHaveBeenCalledTimes(3); // trail/alasan tetap per pesan
      expect(warnSpy).toHaveBeenCalledTimes(1); // console hanya sekali per peer
      expect(String(warnSpy.mock.calls[0])).toContain('peer-abc');
    } finally {
      warnSpy.mockRestore();
    }
  });

  it('rate limit default: 100 pesan dalam 1 detik → pesan 101 di-drop', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      const dc = new FakeRTCDataChannel('position');
      const onPosition = vi.fn();
      const onInvalid = vi.fn();
      let clock = 5_000;
      const sync = new DataChannelSync(asDataChannel(dc), {
        onPosition,
        onInvalid,
        now: () => clock,
      });
      const payload = JSON.stringify({ x: 1, y: 2 });

      for (let index = 0; index < 100; index += 1) {
        dc.deliver(payload); // semua di clock yang sama — jendela 1 s
      }
      expect(onPosition).toHaveBeenCalledTimes(100);
      expect(sync.getInboundDropCounts().overrate).toBe(0);

      dc.deliver(payload); // pesan 101 — kuota jendela habis
      expect(onPosition).toHaveBeenCalledTimes(100);
      expect(sync.getInboundDropCounts().overrate).toBe(1);
      expect(onInvalid).toHaveBeenCalledTimes(1);
      expect(onInvalid.mock.calls[0]?.[0]).toContain('laju');

      // Jendela bergeser 1 detik → kuota tersedia kembali (sliding window).
      clock = 6_001;
      dc.deliver(payload);
      expect(onPosition).toHaveBeenCalledTimes(101);
      expect(sync.getInboundDropCounts().overrate).toBe(1);
    } finally {
      warnSpy.mockRestore();
    }
  });

  it('limit injeksi tinggi: burst 500 pesan semua diproses (test eksisting tak boleh pecah)', () => {
    const dc = new FakeRTCDataChannel('position');
    const onPosition = vi.fn();
    const clock = 5_000;
    new DataChannelSync(asDataChannel(dc), {
      onPosition,
      now: () => clock,
      inboundRateLimitPerSecond: 1_000,
    });
    const payload = JSON.stringify({ x: 1, y: 2 });

    for (let index = 0; index < 500; index += 1) {
      dc.deliver(payload);
    }

    expect(onPosition).toHaveBeenCalledTimes(500);
  });

  it('pesan di luar jendela lama tidak memakan kuota baru (window benar-benar sliding)', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      const dc = new FakeRTCDataChannel('position');
      const onPosition = vi.fn();
      let clock = 10_000;
      new DataChannelSync(asDataChannel(dc), {
        onPosition,
        now: () => clock,
        inboundRateLimitPerSecond: 3,
      });
      const payload = JSON.stringify({ x: 1, y: 2 });

      clock = 10_000;
      dc.deliver(payload);
      dc.deliver(payload);
      clock = 10_999; // 999 ms kemudian — masih jendela yang sama
      dc.deliver(payload);
      dc.deliver(payload); // ke-4 dalam jendela → drop
      expect(onPosition).toHaveBeenCalledTimes(3);

      clock = 11_000; // pesan pertama (10.000) tepat 1 s lama → keluar jendela
      dc.deliver(payload);
      expect(onPosition).toHaveBeenCalledTimes(4);
    } finally {
      warnSpy.mockRestore();
    }
  });

  it('getInboundDropCounts mengembalikan snapshot (mutasi hasil tidak mengubah internal)', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      const dc = new FakeRTCDataChannel('position');
      const sync = new DataChannelSync(asDataChannel(dc), {
        onPosition: () => undefined,
        maxInboundMessageChars: 4,
      });
      dc.deliver('panjang sekali');

      const snapshot = sync.getInboundDropCounts();
      snapshot.oversize = 999;
      expect(sync.getInboundDropCounts().oversize).toBe(1);
    } finally {
      warnSpy.mockRestore();
    }
  });

  it('maxInboundMessageChars / inboundRateLimitPerSecond tak valid → RangeError konstruksi', () => {
    const dc = new FakeRTCDataChannel('position');
    for (const bad of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(
        () =>
          new DataChannelSync(asDataChannel(dc), {
            onPosition: () => undefined,
            maxInboundMessageChars: bad,
          }),
      ).toThrow(RangeError);
      expect(
        () =>
          new DataChannelSync(asDataChannel(dc), {
            onPosition: () => undefined,
            inboundRateLimitPerSecond: bad,
          }),
      ).toThrow(RangeError);
    }
  });
});
