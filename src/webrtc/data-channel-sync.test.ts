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
