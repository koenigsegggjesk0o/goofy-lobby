import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BitrateAdaptation, type BitrateAdaptationOptions } from './bitrate-adaptation';
import type { AdaptiveRtpParameters } from './types';
import { FakeParamsRtpSender, fakeTrack } from './test-utils';

interface Harness {
  adaptation: BitrateAdaptation;
  store: Map<string, FakeParamsRtpSender[]>;
}

function makeHarness(options?: Partial<BitrateAdaptationOptions>): Harness {
  const store = new Map<string, FakeParamsRtpSender[]>();
  const adaptation = new BitrateAdaptation({
    getSenders: (sessionId) => store.get(sessionId) ?? [],
    ...options,
  });
  return { adaptation, store };
}

function audioSender(parameters?: AdaptiveRtpParameters) {
  return new FakeParamsRtpSender(fakeTrack('audio'), parameters);
}

/** Menunggu microtask (callback .catch setParameters) selesai. */
async function settle(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

describe('BitrateAdaptation — penerapan tier', () => {
  it('connected menerapkan tier high ke sender audio', () => {
    const { adaptation, store } = makeHarness();
    const sender = audioSender();
    store.set('peer-1', [sender]);

    adaptation.observe('peer-1', 'connected');

    expect(sender.setParametersCalls).toHaveLength(1);
    expect(sender.setParametersCalls[0]?.encodings?.[0]?.maxBitrate).toBe(50_000);
    expect(adaptation.currentTier('peer-1')).toBe('high');
  });

  it('sender video dan sender tanpa track tidak disentuh', () => {
    const { adaptation, store } = makeHarness();
    const video = new FakeParamsRtpSender(fakeTrack('video'));
    const detached = new FakeParamsRtpSender(null);
    store.set('peer-1', [video, detached]);

    adaptation.observe('peer-1', 'connected');

    expect(video.getParametersCalls).toBe(0);
    expect(detached.getParametersCalls).toBe(0);
    expect(video.setParametersCalls).toHaveLength(0);
  });

  it('observe untuk session tak dikenal tidak error dan tetap mencatat tier', () => {
    const { adaptation } = makeHarness();

    expect(() => adaptation.observe('peer-hantu', 'connected')).not.toThrow();
    expect(adaptation.currentTier('peer-hantu')).toBe('high');
  });

  it('dedupe: observe connected dua kali hanya menulis parameter sekali', () => {
    const { adaptation, store } = makeHarness();
    const sender = audioSender();
    store.set('peer-1', [sender]);

    adaptation.observe('peer-1', 'connected');
    adaptation.observe('peer-1', 'connected');

    expect(sender.setParametersCalls).toHaveLength(1);
  });

  it('encodings yang belum ada dibuat otomatis', () => {
    const { adaptation, store } = makeHarness();
    const sender = audioSender(); // parameters tanpa encodings
    store.set('peer-1', [sender]);

    adaptation.observe('peer-1', 'connected');

    expect(sender.setParametersCalls[0]?.encodings).toHaveLength(1);
    expect(sender.setParametersCalls[0]?.encodings?.[0]?.maxBitrate).toBe(50_000);
  });

  it('encodings yang sudah ada hanya elemen pertama yang diubah', () => {
    const { adaptation, store } = makeHarness();
    const sender = audioSender({
      codecs: [],
      headerExtensions: [],
      rtcp: { cname: 'fake', reducedSize: false },
      encodings: [{}, { maxBitrate: 999 }],
    });
    store.set('peer-1', [sender]);

    adaptation.observe('peer-1', 'connected');

    const encodings = sender.setParametersCalls[0]?.encodings;
    expect(encodings?.[0]?.maxBitrate).toBe(50_000);
    expect(encodings?.[1]?.maxBitrate).toBe(999);
  });

  it('override nilai tier lewat opsi', () => {
    const { adaptation, store } = makeHarness({ tiers: { high: 30_000 } });
    const sender = audioSender();
    store.set('peer-1', [sender]);

    adaptation.observe('peer-1', 'connected');

    expect(sender.setParametersCalls[0]?.encodings?.[0]?.maxBitrate).toBe(30_000);
  });
});

describe('BitrateAdaptation — mesin state + tenggang (timer palsu)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('disconnected menahan tier high selama tenggang, lalu turun ke medium', () => {
    const { adaptation, store } = makeHarness();
    const sender = audioSender();
    store.set('peer-1', [sender]);

    adaptation.observe('peer-1', 'connected');
    adaptation.observe('peer-1', 'disconnected');
    vi.advanceTimersByTime(4_999);
    expect(sender.setParametersCalls).toHaveLength(1); // masih high

    vi.advanceTimersByTime(1);
    expect(sender.setParametersCalls).toHaveLength(2);
    expect(sender.setParametersCalls[1]?.encodings?.[0]?.maxBitrate).toBe(24_000);
    expect(adaptation.currentTier('peer-1')).toBe('medium');
  });

  it('pulih ke connected dalam tenggang membatalkan penurunan', () => {
    const { adaptation, store } = makeHarness();
    const sender = audioSender();
    store.set('peer-1', [sender]);

    adaptation.observe('peer-1', 'connected');
    adaptation.observe('peer-1', 'disconnected');
    adaptation.observe('peer-1', 'connected');
    vi.advanceTimersByTime(10_000);

    expect(sender.setParametersCalls).toHaveLength(1); // hanya high pertama
    expect(adaptation.currentTier('peer-1')).toBe('high');
  });

  it('failed langsung menurunkan ke low tanpa menunggu', () => {
    const { adaptation, store } = makeHarness();
    const sender = audioSender();
    store.set('peer-1', [sender]);

    adaptation.observe('peer-1', 'failed');

    expect(sender.setParametersCalls).toHaveLength(1);
    expect(sender.setParametersCalls[0]?.encodings?.[0]?.maxBitrate).toBe(12_000);
    expect(adaptation.currentTier('peer-1')).toBe('low');
  });

  it('disconnected setelah failed tidak menaikkan tier', () => {
    const { adaptation, store } = makeHarness();
    const sender = audioSender();
    store.set('peer-1', [sender]);

    adaptation.observe('peer-1', 'failed');
    adaptation.observe('peer-1', 'disconnected');
    vi.advanceTimersByTime(10_000);

    expect(sender.setParametersCalls).toHaveLength(1);
    expect(adaptation.currentTier('peer-1')).toBe('low');
  });

  it('closed membersihkan tenggang yang berjalan', () => {
    const { adaptation, store } = makeHarness();
    const sender = audioSender();
    store.set('peer-1', [sender]);

    adaptation.observe('peer-1', 'connected');
    adaptation.observe('peer-1', 'disconnected');
    adaptation.observe('peer-1', 'closed');
    vi.advanceTimersByTime(10_000);

    expect(sender.setParametersCalls).toHaveLength(1); // high saja, tidak ada medium
  });

  it('pemulihan penuh: connected → failed → connected kembali ke high', () => {
    const { adaptation, store } = makeHarness();
    const sender = audioSender();
    store.set('peer-1', [sender]);

    adaptation.observe('peer-1', 'connected');
    adaptation.observe('peer-1', 'failed');
    adaptation.observe('peer-1', 'connected');

    expect(sender.setParametersCalls).toHaveLength(3);
    expect(sender.setParametersCalls[2]?.encodings?.[0]?.maxBitrate).toBe(50_000);
  });

  it('close(sessionId) menghapus state + tenggang', () => {
    const { adaptation, store } = makeHarness();
    const sender = audioSender();
    store.set('peer-1', [sender]);

    adaptation.observe('peer-1', 'connected');
    adaptation.observe('peer-1', 'disconnected');
    adaptation.close('peer-1');
    vi.advanceTimersByTime(10_000);

    expect(adaptation.currentTier('peer-1')).toBeNull();
    expect(sender.setParametersCalls).toHaveLength(1);
  });

  it('closeAll menghapus seluruh state', () => {
    const { adaptation, store } = makeHarness();
    store.set('peer-1', [audioSender()]);
    store.set('peer-2', [audioSender()]);

    adaptation.observe('peer-1', 'connected');
    adaptation.observe('peer-2', 'failed');
    adaptation.closeAll();

    expect(adaptation.currentTier('peer-1')).toBeNull();
    expect(adaptation.currentTier('peer-2')).toBeNull();
  });

  it('tenggang kustom dari opsi dihormati', () => {
    const { adaptation, store } = makeHarness({ disconnectedGraceMs: 1_000 });
    const sender = audioSender();
    store.set('peer-1', [sender]);

    adaptation.observe('peer-1', 'disconnected');
    vi.advanceTimersByTime(1_000);

    expect(sender.setParametersCalls).toHaveLength(1);
    expect(sender.setParametersCalls[0]?.encodings?.[0]?.maxBitrate).toBe(24_000);
  });
});

describe('BitrateAdaptation — kegagalan & penerapan ulang', () => {
  it('setParameters gagal → onError + tier di-reset agar observe berikutnya retry', async () => {
    const onError = vi.fn();
    const { adaptation, store } = makeHarness({ onError });
    const sender = audioSender();
    sender.failSetParameters = true;
    store.set('peer-1', [sender]);

    adaptation.observe('peer-1', 'connected');
    await settle();

    expect(onError).toHaveBeenCalledWith('peer-1', 'set-parameters', expect.any(Error));
    expect(adaptation.currentTier('peer-1')).toBeNull();

    sender.failSetParameters = false;
    adaptation.observe('peer-1', 'connected');
    await settle();

    expect(sender.setParametersCalls).toHaveLength(2);
    expect(adaptation.currentTier('peer-1')).toBe('high');
  });

  it('applyCurrentTier menerapkan tier tersimpan ke sender baru (mikrofon dipasang belakangan)', async () => {
    const { adaptation, store } = makeHarness();
    const first = audioSender();
    store.set('peer-1', [first]);

    adaptation.observe('peer-1', 'connected');
    const second = audioSender();
    store.set('peer-1', [first, second]);

    adaptation.applyCurrentTier('peer-1');
    await settle();

    expect(second.setParametersCalls).toHaveLength(1);
    expect(second.setParametersCalls[0]?.encodings?.[0]?.maxBitrate).toBe(50_000);
  });

  it('applyCurrentTier tanpa tier tersimpan adalah no-op', () => {
    const { adaptation, store } = makeHarness();
    const sender = audioSender();
    store.set('peer-1', [sender]);

    adaptation.applyCurrentTier('peer-1');

    expect(sender.setParametersCalls).toHaveLength(0);
  });

  it('currentTier untuk session baru adalah null', () => {
    const { adaptation } = makeHarness();
    expect(adaptation.currentTier('peer-baru')).toBeNull();
  });
});
