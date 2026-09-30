import { describe, expect, it } from 'vitest';
import {
  RoomGate,
  RoomGateError,
  type RoomGateRpcResult,
  type RoomGateSupabaseLike,
} from './room-gate';

/**
 * Unit test RoomGate (P0-1) — gerbang registri room server-side.
 * Klien Supabase di-fake di level rpc() (structural typing — bentuk
 * { data, error } persis PostgREST). Verifikasi SQL-nya sendiri
 * (rate-limit, RLS, otorisasi realtime) ada di src/db/migrations.test.ts
 * (PGlite = Postgres asli in-process).
 */

interface FakeRpcCall {
  fn: string;
  args?: Record<string, unknown>;
}

class FakeRpcSupabase {
  readonly calls: FakeRpcCall[] = [];
  #handler: (fn: string, args?: Record<string, unknown>) => RoomGateRpcResult;

  constructor(
    handler: (fn: string, args?: Record<string, unknown>) => RoomGateRpcResult = () => ({
      data: null,
      error: null,
    }),
  ) {
    this.#handler = handler;
  }

  rpc(fn: string, args?: Record<string, unknown>): Promise<RoomGateRpcResult> {
    this.calls.push({ fn, args });
    return Promise.resolve(this.#handler(fn, args));
  }
}

/** Timer fake: interval tidak jalan otomatis — dipicu manual dari test. */
class FakeTimers {
  handle: unknown = null;
  readonly fired: Array<() => void> = [];
  readonly cleared: unknown[] = [];

  setInterval = (fn: () => void): unknown => {
    this.handle = { fn };
    return this.handle;
  };

  clearInterval = (handle: unknown): void => {
    this.cleared.push(handle);
  };

  tick(): void {
    for (const entry of this.fired.splice(0)) {
      entry();
    }
    if (this.handle !== null && typeof this.handle === 'object' && 'fn' in this.handle) {
      (this.handle as { fn: () => void }).fn();
    }
  }
}

function ok(data: unknown): RoomGateRpcResult {
  return { data, error: null };
}

function err(message: string): RoomGateRpcResult {
  return { data: null, error: { message } };
}

describe('RoomGate.createRoom', () => {
  it('memanggil rpc create_room, mengembalikan kode server, memulai heartbeat', async () => {
    const timers = new FakeTimers();
    const fake = new FakeRpcSupabase(() => ok('7Q2M9XK4'));
    const gate = new RoomGate({
      supabase: fake as unknown as RoomGateSupabaseLike,
      setIntervalFn: timers.setInterval,
      clearIntervalFn: timers.clearInterval,
    });

    await expect(gate.createRoom()).resolves.toBe('7Q2M9XK4');
    expect(fake.calls).toEqual([{ fn: 'create_room' }]);
    expect(gate.currentCode).toBe('7Q2M9XK4');

    // heartbeat terjadwal — tick memicu rpc heartbeat_room dengan kode.
    timers.tick();
    await Promise.resolve(); // flush microtask #beat
    expect(fake.calls.some((c) => c.fn === 'heartbeat_room' && c.args?.p_code === '7Q2M9XK4')).toBe(
      true,
    );
  });

  it('menolak kode server di luar kontrak (bukan string 8 char)', async () => {
    const fake = new FakeRpcSupabase(() => ok('kodeservertidakvalid'));
    const gate = new RoomGate({ supabase: fake as unknown as RoomGateSupabaseLike });
    await expect(gate.createRoom()).rejects.toMatchObject({ code: 'UNKNOWN' });
    expect(gate.currentCode).toBeNull(); // tidak ada heartbeat menggantung
  });

  it('memetakan token DATA dari server (kontrak 0016: return, bukan raise — supaya catatan attempt commit)', async () => {
    const fake = new FakeRpcSupabase(() => ok('ROOM_CREATE_LIMIT'));
    const gate = new RoomGate({ supabase: fake as unknown as RoomGateSupabaseLike });
    await expect(gate.createRoom()).rejects.toMatchObject({ code: 'ROOM_CREATE_LIMIT' });
  });

  it('respons data tak dikenal → UNKNOWN', async () => {
    const fake = new FakeRpcSupabase(() => ok(42));
    const gate = new RoomGate({ supabase: fake as unknown as RoomGateSupabaseLike });
    await expect(gate.createRoom()).rejects.toMatchObject({ code: 'UNKNOWN' });
  });
});

describe('RoomGate.joinRoom', () => {
  it('normalisasi input sebelum rpc (paritas aturan SQL 0016)', async () => {
    const fake = new FakeRpcSupabase(() => ok('OK'));
    const gate = new RoomGate({ supabase: fake as unknown as RoomGateSupabaseLike });
    await expect(gate.joinRoom(' 7q2o-9xki ')).resolves.toBe('7Q209XK1');
    expect(fake.calls).toEqual([{ fn: 'join_room', args: { p_code: '7Q209XK1' } }]);
    expect(gate.currentCode).toBe('7Q209XK1');
  });

  it('gagal cepat lokal untuk format tidak valid — rpc TIDAK dipanggil (kuota rate-limit tidak terpakai)', async () => {
    const fake = new FakeRpcSupabase(() => ok(null));
    const gate = new RoomGate({ supabase: fake as unknown as RoomGateSupabaseLike });
    await expect(gate.joinRoom('pendek')).rejects.toBeInstanceOf(RoomGateError);
    await expect(gate.joinRoom('pendek')).rejects.toMatchObject({ code: 'INVALID_ROOM_CODE' });
    expect(fake.calls).toHaveLength(0);
  });

  it.each([
    ['ROOM_NOT_FOUND', 'ROOM_NOT_FOUND'],
    ['RATE_LIMITED', 'RATE_LIMITED'],
    ['ROOM_FULL', 'ROOM_FULL'],
    ['NOT_AUTHENTICATED', 'NOT_AUTHENTICATED'],
    ['INVALID_ROOM_CODE', 'INVALID_ROOM_CODE'],
  ])(
    'memetakan token DATA %s dari server (kontrak return 0016)',
    async (serverData, expectedCode) => {
      const fake = new FakeRpcSupabase(() => ok(serverData));
      const gate = new RoomGate({ supabase: fake as unknown as RoomGateSupabaseLike });
      await expect(gate.joinRoom('7Q2M9XK4')).rejects.toMatchObject({ code: expectedCode });
      expect(gate.currentCode).toBeNull(); // gagal join = tidak ada heartbeat
    },
  );

  it('join sukses: data "OK" + heartbeat jalan', async () => {
    const fake = new FakeRpcSupabase(() => ok('OK'));
    const gate = new RoomGate({ supabase: fake as unknown as RoomGateSupabaseLike });
    await expect(gate.joinRoom('7Q2M9XK4')).resolves.toBe('7Q2M9XK4');
    expect(gate.currentCode).toBe('7Q2M9XK4');
  });

  it('data selain OK/token → UNKNOWN dengan respons asli di serverMessage (bukan di .message)', async () => {
    const fake = new FakeRpcSupabase(() => ok('WEIRD_RESPONSE'));
    const gate = new RoomGate({ supabase: fake as unknown as RoomGateSupabaseLike });
    const failure = gate.joinRoom('7Q2M9XK4');
    await expect(failure).rejects.toMatchObject({ code: 'UNKNOWN' });
    await expect(failure).rejects.toMatchObject({
      serverMessage: expect.stringContaining('WEIRD_RESPONSE'),
    });
    // .message TIDAK membawa respons mentah (remediasi audit 25-a LOW-5)
    const error = await failure.catch((e: unknown) => e);
    expect((error as Error).message).not.toContain('WEIRD_RESPONSE');
  });

  it('error tak dikenal → UNKNOWN dengan pesan asli di serverMessage', async () => {
    const fake = new FakeRpcSupabase(() => err('network blip 500'));
    const gate = new RoomGate({ supabase: fake as unknown as RoomGateSupabaseLike });
    const failure = gate.joinRoom('7Q2M9XK4');
    await expect(failure).rejects.toMatchObject({ code: 'UNKNOWN' });
    await expect(failure).rejects.toMatchObject({
      serverMessage: expect.stringContaining('network blip 500'),
    });
    const error = await failure.catch((e: unknown) => e);
    expect((error as Error).message).not.toContain('network blip 500');
  });

  it("exception BLOCKED_FROM_ROOM dari join_room → kode 'BLOCKED_FROM_ROOM' (0019)", async () => {
    const fake = new FakeRpcSupabase(() =>
      err('P0001: pemilik room memblokir kamu: BLOCKED_FROM_ROOM'),
    );
    const gate = new RoomGate({ supabase: fake as unknown as RoomGateSupabaseLike });
    const failure = gate.joinRoom('7Q2M9XK4');
    await expect(failure).rejects.toMatchObject({ code: 'BLOCKED_FROM_ROOM' });
    const error = await failure.catch((e: unknown) => e);
    expect((error as Error).message).toContain('diblokir pemilik');
  });

  it('pesan JWT kedaluwarsa → NOT_AUTHENTICATED', async () => {
    const fake = new FakeRpcSupabase(() => err('Invalid JWT token'));
    const gate = new RoomGate({ supabase: fake as unknown as RoomGateSupabaseLike });
    await expect(gate.joinRoom('7Q2M9XK4')).rejects.toMatchObject({ code: 'NOT_AUTHENTICATED' });
  });
});

describe('RoomGate.leaveRoom & dispose', () => {
  it('leaveRoom menghentikan heartbeat + memanggil rpc leave_room dengan kode', async () => {
    const timers = new FakeTimers();
    const fake = new FakeRpcSupabase(() => ok('OK'));
    const gate = new RoomGate({
      supabase: fake as unknown as RoomGateSupabaseLike,
      setIntervalFn: timers.setInterval,
      clearIntervalFn: timers.clearInterval,
    });
    await gate.joinRoom('7Q2M9XK4');
    await gate.leaveRoom();
    expect(fake.calls.some((c) => c.fn === 'leave_room' && c.args?.p_code === '7Q2M9XK4')).toBe(
      true,
    );
    expect(gate.currentCode).toBeNull();
    expect(timers.cleared).toContain(timers.handle);
  });

  it('leaveRoom tanpa join = no-op rpc', async () => {
    const fake = new FakeRpcSupabase(() => ok('OK'));
    const gate = new RoomGate({ supabase: fake as unknown as RoomGateSupabaseLike });
    await expect(gate.leaveRoom()).resolves.toBeUndefined();
    expect(fake.calls).toHaveLength(0);
  });

  it('heartbeat gagal → dilaporkan ke onHeartbeatError, tidak melempar', async () => {
    let heartbeatError: unknown = null;
    let call = 0;
    const fake = new FakeRpcSupabase(() => {
      call += 1;
      return call === 1 ? ok('OK') : err('RATE_LIMITED'); // join ok, heartbeat gagal (raise kontrak lama utk void fn)
    });
    const timers = new FakeTimers();
    const gate = new RoomGate({
      supabase: fake as unknown as RoomGateSupabaseLike,
      onHeartbeatError: (error) => {
        heartbeatError = error;
      },
      setIntervalFn: timers.setInterval,
      clearIntervalFn: timers.clearInterval,
    });
    await gate.joinRoom('7Q2M9XK4');
    timers.tick();
    await Promise.resolve(); // flush microtask #beat
    expect(heartbeatError).toBeInstanceOf(RoomGateError);
    expect((heartbeatError as RoomGateError).code).toBe('RATE_LIMITED');
    expect(gate.currentCode).toBe('7Q2M9XK4'); // tetap hidup — heartbeat bukan siklus hidup
  });

  it('dispose menghentikan heartbeat tanpa rpc (untuk cleanup tab ditutup)', async () => {
    const timers = new FakeTimers();
    const fake = new FakeRpcSupabase(() => ok('OK'));
    const gate = new RoomGate({
      supabase: fake as unknown as RoomGateSupabaseLike,
      setIntervalFn: timers.setInterval,
      clearIntervalFn: timers.clearInterval,
    });
    await gate.joinRoom('7Q2M9XK4');
    gate.dispose();
    expect(gate.currentCode).toBeNull();
    expect(fake.calls.some((c) => c.fn === 'leave_room')).toBe(false);
  });
});

describe('RoomGateError', () => {
  it('membawa kode machine-readable + pesan human Indonesia', () => {
    const error = new RoomGateError('ROOM_FULL');
    expect(error.code).toBe('ROOM_FULL');
    expect(error.message).toBe('room penuh');
    expect(error.name).toBe('RoomGateError');
  });
});
