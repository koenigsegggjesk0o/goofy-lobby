import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { IceRestartHandler, type IceRestartHandlerOptions } from './ice-restart-handler';

function setup(
  overrides: Omit<
    Partial<IceRestartHandlerOptions>,
    'getConnectionState' | 'getIceConnectionState' | 'onRestart' | 'onGiveUp'
  > = {},
) {
  const states = {
    connection: 'new' as RTCPeerConnectionState,
    ice: 'new' as RTCIceConnectionState,
  };
  const onRestart = vi.fn();
  const onGiveUp = vi.fn();
  const handler = new IceRestartHandler({
    getConnectionState: () => states.connection,
    getIceConnectionState: () => states.ice,
    onRestart,
    onGiveUp,
    ...overrides,
  });
  return { states, handler, onRestart, onGiveUp };
}

describe('IceRestartHandler', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('state sehat tidak memicu apa pun', () => {
    const { states, handler, onRestart } = setup();
    states.connection = 'connected';
    handler.observe();
    expect(onRestart).not.toHaveBeenCalled();
  });

  it("'failed' memicu restart pertama tanpa delay", async () => {
    const { states, handler, onRestart } = setup();
    states.connection = 'failed';
    handler.observe();

    await vi.advanceTimersByTimeAsync(0);

    expect(onRestart).toHaveBeenCalledTimes(1);
    expect(onRestart).toHaveBeenCalledWith(1);
  });

  it('backoff eksponensial antar percobaan (0 → 2s → 4s)', async () => {
    const { states, handler, onRestart } = setup({ baseDelayMs: 2_000, maxAttempts: 3 });
    states.ice = 'failed';
    handler.observe();
    await vi.advanceTimersByTimeAsync(0);
    expect(onRestart).toHaveBeenCalledTimes(1);

    handler.observe(); // masih gagal → attempt 2, delay 2s
    await vi.advanceTimersByTimeAsync(1_999);
    expect(onRestart).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(onRestart).toHaveBeenCalledTimes(2);
    expect(onRestart).toHaveBeenLastCalledWith(2);

    handler.observe(); // attempt 3, delay 4s
    await vi.advanceTimersByTimeAsync(3_999);
    expect(onRestart).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(onRestart).toHaveBeenCalledTimes(3);
    expect(onRestart).toHaveBeenLastCalledWith(3);
  });

  it('menyerah setelah maxAttempts tanpa perbaikan', async () => {
    const { states, handler, onRestart, onGiveUp } = setup({ maxAttempts: 2 });
    states.connection = 'failed';

    handler.observe();
    await vi.advanceTimersByTimeAsync(0);
    handler.observe();
    await vi.advanceTimersByTimeAsync(2_000);
    expect(onRestart).toHaveBeenCalledTimes(2);
    expect(onGiveUp).not.toHaveBeenCalled();

    handler.observe(); // percobaan habis
    expect(onGiveUp).toHaveBeenCalledWith(2);
    expect(onRestart).toHaveBeenCalledTimes(2);

    handler.observe(); // setelah menyerah, tidak ada efek lagi
    expect(onGiveUp).toHaveBeenCalledTimes(1);
  });

  it("pulih ke 'connected' mereset hitungan percobaan", async () => {
    const { states, handler, onRestart } = setup();
    states.connection = 'failed';
    handler.observe();
    await vi.advanceTimersByTimeAsync(0);
    expect(onRestart).toHaveBeenCalledTimes(1);

    states.connection = 'connected';
    handler.observe();

    states.connection = 'failed';
    handler.observe();
    await vi.advanceTimersByTimeAsync(0);
    expect(onRestart).toHaveBeenCalledTimes(2);
    expect(onRestart).toHaveBeenLastCalledWith(1); // hitungan mulai dari 1 lagi
  });

  it("'disconnected' diberi masa tenggang sebelum restart", async () => {
    const { states, handler, onRestart } = setup({ disconnectedGraceMs: 5_000 });
    states.connection = 'disconnected';
    handler.observe();

    await vi.advanceTimersByTimeAsync(4_999);
    expect(onRestart).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1); // tenggang habis, masih buruk
    await vi.advanceTimersByTimeAsync(1); // restart attempt-1 (delay 0) butuh satu putaran lagi
    expect(onRestart).toHaveBeenCalledTimes(1);
    expect(onRestart).toHaveBeenCalledWith(1);
  });

  it("'disconnected' yang pulih sebelum tenggang habis tidak restart", async () => {
    const { states, handler, onRestart } = setup({ disconnectedGraceMs: 5_000 });
    states.connection = 'disconnected';
    handler.observe();

    await vi.advanceTimersByTimeAsync(3_000);
    states.connection = 'connected';
    handler.observe(); // reset timer disconnected
    await vi.advanceTimersByTimeAsync(5_000);

    expect(onRestart).not.toHaveBeenCalled();
  });

  it('close() menghentikan seluruh pemantauan', async () => {
    const { states, handler, onRestart, onGiveUp } = setup();
    handler.close();

    states.connection = 'failed';
    handler.observe();
    await vi.advanceTimersByTimeAsync(10_000);

    expect(onRestart).not.toHaveBeenCalled();
    expect(onGiveUp).not.toHaveBeenCalled();
  });
});

describe('IceRestartHandler — watchdog establishment', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("arm() + tertahan di 'connecting' melewati timeout → restart attempt 1", async () => {
    const { states, handler, onRestart } = setup({ establishmentTimeoutMs: 100 });
    states.connection = 'connecting';
    handler.arm();

    await vi.advanceTimersByTimeAsync(99);
    expect(onRestart).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1); // timeout tercapai → scheduleRestart
    await vi.advanceTimersByTimeAsync(1); // restart attempt-1 (delay 0) satu putaran lagi
    expect(onRestart).toHaveBeenCalledTimes(1);
    expect(onRestart).toHaveBeenCalledWith(1);
  });

  it("arm() + tertahan di 'new' melewati timeout → restart", async () => {
    const { states, handler, onRestart } = setup({ establishmentTimeoutMs: 100 });
    states.connection = 'new';
    handler.arm();

    await vi.advanceTimersByTimeAsync(100);
    await vi.advanceTimersByTimeAsync(1);
    expect(onRestart).toHaveBeenCalledTimes(1);
    expect(onRestart).toHaveBeenCalledWith(1);
  });

  it("mencapai 'connected' sebelum timeout → tidak restart & watchdog dilucuti", async () => {
    const { states, handler, onRestart } = setup({ establishmentTimeoutMs: 100 });
    states.connection = 'connecting';
    handler.arm();

    states.connection = 'connected';
    handler.observe(); // sukses → clear establishment timer

    await vi.advanceTimersByTimeAsync(10_000); // jauh melewati timeout — tetap diam
    expect(onRestart).not.toHaveBeenCalled();
  });

  it('timeout → restart → arm ulang otomatis → attempt 2 setelah backoff', async () => {
    const { states, handler, onRestart } = setup({ establishmentTimeoutMs: 100, baseDelayMs: 500 });
    states.connection = 'connecting';
    handler.arm();

    await vi.advanceTimersByTimeAsync(100); // t=100: watchdog fires → restart attempt 1 (delay 0)
    await vi.advanceTimersByTimeAsync(1); // delay-0 butuh satu putaran lagi → onRestart(1) + re-arm T2
    expect(onRestart).toHaveBeenCalledTimes(1);
    expect(onRestart).toHaveBeenLastCalledWith(1);

    await vi.advanceTimersByTimeAsync(99); // t=200: T2 (due t=201) belum menyala
    expect(onRestart).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1); // t=201: T2 fires → attempt 2 dijadwalkan (backoff 500)
    expect(onRestart).toHaveBeenCalledTimes(1); // backoff belum habis
    await vi.advanceTimersByTimeAsync(499); // t=700
    expect(onRestart).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1); // t=701: restart attempt 2
    expect(onRestart).toHaveBeenCalledTimes(2);
    expect(onRestart).toHaveBeenLastCalledWith(2);
  });

  it("state 'disconnected' saat timeout → watchdog diam (jalur grace yang punya)", async () => {
    const { states, handler, onRestart } = setup({ establishmentTimeoutMs: 100 });
    states.connection = 'connecting';
    handler.arm();
    states.connection = 'disconnected'; // TANPA observe — timer membaca state saat fires

    await vi.advanceTimersByTimeAsync(10_000);
    expect(onRestart).not.toHaveBeenCalled(); // murni dari establishment timer: tidak ada

    // Jalur disconnected-grace tetap bekerja dan tetap pemilik kasus ini:
    handler.observe();
    await vi.advanceTimersByTimeAsync(5_000); // masa tenggang habis
    await vi.advanceTimersByTimeAsync(1); // restart attempt-1 (delay 0)
    expect(onRestart).toHaveBeenCalledTimes(1);
    expect(onRestart).toHaveBeenCalledWith(1);
  });

  it('establishmentTimeoutMs ≤ 0 → arm() no-op permanen', async () => {
    const { states, handler, onRestart, onGiveUp } = setup({ establishmentTimeoutMs: 0 });
    states.connection = 'connecting';
    handler.arm();
    handler.arm();

    await vi.advanceTimersByTimeAsync(60_000);
    expect(onRestart).not.toHaveBeenCalled();
    expect(onGiveUp).not.toHaveBeenCalled();
  });

  it('arm() ganda → satu timer saja (tidak dobel-fire)', async () => {
    const { states, handler, onRestart } = setup({ establishmentTimeoutMs: 100 });
    states.connection = 'connecting';
    handler.arm();
    handler.arm();
    handler.arm();

    expect(vi.getTimerCount()).toBe(1); // dedupe di level timer

    await vi.advanceTimersByTimeAsync(100);
    await vi.advanceTimersByTimeAsync(1);
    expect(onRestart).toHaveBeenCalledTimes(1); // satu siklus, bukan tiga
  });

  it('close() saat timer establishment pending → tidak ada restart', async () => {
    const { states, handler, onRestart, onGiveUp } = setup({ establishmentTimeoutMs: 100 });
    states.connection = 'connecting';
    handler.arm();
    handler.close();

    await vi.advanceTimersByTimeAsync(10_000);
    expect(onRestart).not.toHaveBeenCalled();
    expect(onGiveUp).not.toHaveBeenCalled();
  });

  it('timeout establishment berulang → onGiveUp setelah maxAttempts', async () => {
    const { states, handler, onRestart, onGiveUp } = setup({
      establishmentTimeoutMs: 100,
      baseDelayMs: 50,
      maxAttempts: 2,
    });
    states.connection = 'connecting';
    handler.arm();

    await vi.advanceTimersByTimeAsync(100); // t=100: T1 → restart attempt 1 (delay 0)
    await vi.advanceTimersByTimeAsync(1); // → onRestart(1) + re-arm T2 (due t=201)
    expect(onRestart).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(99); // t=200
    await vi.advanceTimersByTimeAsync(1); // t=201: T2 fires → attempt 2 (backoff 50 → t=251)
    expect(onRestart).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(50); // t=251: restart attempt 2 → re-arm T3
    expect(onRestart).toHaveBeenCalledTimes(2);
    expect(onRestart).toHaveBeenLastCalledWith(2);
    expect(onGiveUp).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(100); // t=351: T3 fires → percobaan habis
    expect(onGiveUp).toHaveBeenCalledWith(2);
    expect(onRestart).toHaveBeenCalledTimes(2);
  });

  it("'failed' via observe saat armed → tetap satu restart (dedupe jalur)", async () => {
    const { states, handler, onRestart, onGiveUp } = setup({ establishmentTimeoutMs: 100 });
    states.connection = 'connecting';
    handler.arm(); // T1 terpasang

    states.connection = 'failed';
    handler.observe(); // jalur reaktif menang → scheduleRestart (T1 digantikan)
    await vi.advanceTimersByTimeAsync(0);
    expect(onRestart).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(10_000); // watchdog re-arm fires, state 'failed' → diam
    expect(onRestart).toHaveBeenCalledTimes(1);
    expect(onRestart).toHaveBeenCalledWith(1);
    expect(onGiveUp).not.toHaveBeenCalled();
  });
});
