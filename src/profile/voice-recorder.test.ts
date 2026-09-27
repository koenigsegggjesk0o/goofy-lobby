import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { VoiceRecorder, type MediaRecorderLike } from './voice-recorder';
import { FakeMediaRecorder, FakeRecorderStream } from './test-utils';

interface Harness {
  recorder: VoiceRecorder;
  created: FakeMediaRecorder[];
  stream: FakeRecorderStream;
  events: {
    started: Array<{ mimeType: string }>;
    stopped: Array<{ blob: Blob; durationMs: number; autoStopped: string | null }>;
    cancelled: Array<{ durationMs: number }>;
    errors: Array<{ message: string; code: string }>;
  };
  setClock: (ms: number) => void;
}

function setup(overrides: { maxDurationMs?: number; maxBytes?: number } = {}): Harness {
  const created: FakeMediaRecorder[] = [];
  const stream = new FakeRecorderStream();
  let clock = 1_000;
  const recorder = new VoiceRecorder({
    getUserMedia: () => Promise.resolve(stream),
    createRecorder: (_stream, mimeType) => {
      const fake = new FakeMediaRecorder(_stream, { mimeType });
      created.push(fake);
      return fake as unknown as MediaRecorderLike;
    },
    isTypeSupported: (m) => ['audio/webm', 'audio/webm;codecs=opus'].includes(m),
    now: () => clock,
    ...overrides,
  });
  const events: Harness['events'] = {
    started: [],
    stopped: [],
    cancelled: [],
    errors: [],
  };
  recorder.on('recording-started', (p) => events.started.push(p));
  recorder.on('recording-stopped', (p) => events.stopped.push(p));
  recorder.on('recording-cancelled', (p) => events.cancelled.push(p));
  recorder.on('error', (p) => events.errors.push(p));
  return { recorder, created, stream, events, setClock: (ms) => (clock = ms) };
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('VoiceRecorder', () => {
  it('start membuka mikrofon, memilih MIME pertama yang didukung, dan emit event', async () => {
    const h = setup();
    await h.recorder.start();
    expect(h.recorder.state).toBe('recording');
    expect(h.created).toHaveLength(1);
    expect(h.created[0]?.mimeType).toBe('audio/webm');
    expect(h.created[0]?.lastStartTimeslice).toBe(500);
    expect(h.events.started).toEqual([{ mimeType: 'audio/webm' }]);
    expect(h.stream.getTracks()[0]?.stopped).toBe(false);
  });

  it('start kedua ditolak dengan kode busy', async () => {
    const h = setup();
    await h.recorder.start();
    await expect(h.recorder.start()).rejects.toMatchObject({ code: 'busy' });
  });

  it('melempar unsupported-mime bila tidak ada kandidat MIME yang didukung', async () => {
    const unsupported = new VoiceRecorder({
      getUserMedia: () => Promise.resolve(new FakeRecorderStream()),
      createRecorder: () => {
        throw new Error('tidak boleh terpanggil');
      },
      isTypeSupported: () => false,
    });
    await expect(unsupported.start()).rejects.toMatchObject({ code: 'unsupported-mime' });
  });

  it('kegagalan getUserMedia jadi error mic-denied + event error', async () => {
    const clock = () => 0;
    const recorder = new VoiceRecorder({
      getUserMedia: () => Promise.reject(new Error('NotAllowedError')),
      createRecorder: () => {
        throw new Error('tidak boleh terpanggil');
      },
      isTypeSupported: () => true,
      now: clock,
    });
    const errors: Array<{ code: string }> = [];
    recorder.on('error', (p) => errors.push({ code: p.code }));
    await expect(recorder.start()).rejects.toMatchObject({ code: 'mic-denied' });
    expect(errors).toEqual([{ code: 'mic-denied' }]);
  });

  it('stop mengembalikan blob gabungan chunk + durasi + menghentikan track', async () => {
    const h = setup();
    await h.recorder.start();
    const fake = h.created[0];
    fake?.emitChunk(10);
    h.setClock(2_500);
    fake?.emitChunk(20);
    const promise = h.recorder.stop();
    const result = await promise;
    expect(result.blob.size).toBe(30);
    expect(result.blob.type).toBe('audio/webm');
    expect(result.durationMs).toBe(1_500);
    expect(result.autoStopped).toBeNull();
    expect(h.stream.getTracks()[0]?.stopped).toBe(true);
    expect(h.recorder.state).toBe('idle');
    expect(h.events.stopped).toHaveLength(1);
    expect(h.events.stopped[0]?.blob.size).toBe(30);
  });

  it('stop saat idle ditolak', async () => {
    const h = setup();
    await expect(h.recorder.stop()).rejects.toMatchObject({ code: 'empty-recording' });
  });

  it('auto-stop pada durasi maksimum dengan penanda duration', async () => {
    const h = setup({ maxDurationMs: 5_000 });
    await h.recorder.start();
    h.created[0]?.emitChunk(10);
    const stopped = vi.fn();
    h.recorder.on('recording-stopped', stopped);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(h.recorder.state).toBe('idle');
    expect(stopped).toHaveBeenCalledTimes(1);
    const payload = stopped.mock.calls[0]?.[0];
    expect(payload.autoStopped).toBe('duration');
    expect(payload.blob.size).toBe(10);
    expect(h.created[0]?.stopCalls).toBe(1);
  });

  it('auto-stop saat budget byte terlampaui dengan penanda byte-cap', async () => {
    const h = setup({ maxBytes: 100 });
    await h.recorder.start();
    h.created[0]?.emitChunk(60);
    h.created[0]?.emitChunk(60); // total 120 >= 100
    await vi.advanceTimersByTimeAsync(0);
    expect(h.recorder.state).toBe('idle');
    const payload = h.events.stopped[h.events.stopped.length - 1];
    expect(payload?.autoStopped).toBe('byte-cap');
    expect(payload?.blob.size).toBe(120);
  });

  it('timer durasi dibersihkan setelah stop manual (tidak ada auto-stop ganda)', async () => {
    const h = setup({ maxDurationMs: 5_000 });
    await h.recorder.start();
    await h.recorder.stop();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(h.events.stopped).toHaveLength(1);
    expect(h.recorder.state).toBe('idle');
  });

  it('cancel membuang hasil, menghentikan track, dan menolak stop yang tertunda', async () => {
    const h = setup();
    await h.recorder.start();
    h.created[0]?.emitChunk(10);
    const pending = h.recorder.stop();
    await h.recorder.cancel();
    await expect(pending).rejects.toMatchObject({ code: 'empty-recording' });
    expect(h.stream.getTracks()[0]?.stopped).toBe(true);
    expect(h.events.stopped).toHaveLength(0);
    expect(h.events.cancelled).toHaveLength(1);
    expect(h.recorder.state).toBe('idle');
  });

  it('cancel saat idle tidak melakukan apa pun (idempoten)', async () => {
    const h = setup();
    await expect(h.recorder.cancel()).resolves.toBeUndefined();
    expect(h.events.cancelled).toHaveLength(0);
  });

  it('kegagalan recorder (onerror) menolak stop yang tertunda + emit error', async () => {
    // Bespoke: error tiba SEBELUM event stop (urutan mikro-tugas dikontrol)
    // — mensimulasikan encoder gagal di tengah proses berhenti.
    class ExplodingRecorder implements MediaRecorderLike {
      mimeType = 'audio/webm';
      state: 'inactive' | 'recording' | 'paused' = 'recording';
      ondataavailable: ((event: { data: Blob }) => void) | null = null;
      onstop: ((event: unknown) => void) | null = null;
      onerror: ((event: unknown) => void) | null = null;
      start(): void {}
      stop(): void {
        this.state = 'inactive';
        queueMicrotask(() => {
          this.onerror?.({ error: { message: 'encoder meledak' } });
          this.onstop?.({});
        });
      }
    }
    const stream = new FakeRecorderStream();
    const exploding = new ExplodingRecorder();
    const recorder = new VoiceRecorder({
      getUserMedia: () => Promise.resolve(stream),
      createRecorder: () => exploding,
      isTypeSupported: () => true,
      now: () => 1_000,
    });
    const errors: Array<{ message: string; code: string }> = [];
    recorder.on('error', (p) => errors.push(p));
    await recorder.start();
    const pending = recorder.stop();
    await expect(pending).rejects.toMatchObject({ code: 'recorder-error' });
    expect(errors).toContainEqual({ message: 'encoder meledak', code: 'recorder-error' });
    expect(stream.getTracks()[0]?.stopped).toBe(true);
    expect(recorder.state).toBe('idle');
  });

  it('error saat merekam (tanpa stop tertunda) tetap membersihkan semuanya', async () => {
    const h = setup();
    await h.recorder.start();
    h.created[0]?.emitError('encoder meledak');
    await vi.advanceTimersByTimeAsync(0);
    expect(h.events.errors.map((e) => e.code)).toContain('recorder-error');
    expect(h.stream.getTracks()[0]?.stopped).toBe(true);
    expect(h.recorder.state).toBe('idle');
    await expect(h.recorder.stop()).rejects.toMatchObject({ code: 'empty-recording' });
  });

  it('elapsedMs mengikuti jam dan 0 saat idle', async () => {
    const h = setup();
    expect(h.recorder.elapsedMs()).toBe(0);
    await h.recorder.start();
    h.setClock(4_000);
    expect(h.recorder.elapsedMs()).toBe(3_000);
    await h.recorder.cancel();
    expect(h.recorder.elapsedMs()).toBe(0);
  });
});
