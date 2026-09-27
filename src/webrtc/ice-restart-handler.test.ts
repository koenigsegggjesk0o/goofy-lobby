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
