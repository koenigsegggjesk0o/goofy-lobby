import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  __setSdkForTests,
  addTrail,
  captureError,
  flushMonitoring,
  initMonitoring,
  monitoringStatus,
  type SentryScopeLike,
  type SentrySdkLike,
} from './sentry';

class FakeSentry implements SentrySdkLike {
  initialized = false;
  enabled = false;
  initCalls: unknown[] = [];
  captured: Array<{ error: unknown }> = [];
  breadcrumbs: unknown[] = [];
  flushCalls: Array<number | undefined> = [];
  contexts: Array<{ name: string; context: Record<string, unknown> | null }> = [];
  failOn: 'capture' | 'breadcrumb' | 'flush' | null = null;
  lastEventId = 'evt-123';

  init(options?: unknown): unknown {
    this.initCalls.push(options);
    this.initialized = true;
    this.enabled = true;
    return {};
  }

  isInitialized(): boolean {
    return this.initialized;
  }

  isEnabled(): boolean {
    return this.enabled;
  }

  captureException(exception: unknown): string {
    if (this.failOn === 'capture') {
      throw new Error('sdk meledak');
    }
    this.captured.push({ error: exception });
    return this.lastEventId;
  }

  addBreadcrumb(breadcrumb: unknown): void {
    if (this.failOn === 'breadcrumb') {
      throw new Error('sdk meledak');
    }
    this.breadcrumbs.push(breadcrumb);
  }

  withScope(callback: (scope: SentryScopeLike) => void): void {
    callback({
      setContext: (name, context) => {
        this.contexts.push({ name, context });
        return {};
      },
      setTag: () => ({}),
    });
  }

  flush(timeout?: number): Promise<boolean> {
    if (this.failOn === 'flush') {
      return Promise.reject(new Error('sdk meledak'));
    }
    this.flushCalls.push(timeout);
    return Promise.resolve(true);
  }
}

const DSN = 'https://abc123@example.sentry.io/4500000000000000';

let fake: FakeSentry;
let restore: () => void;

beforeEach(() => {
  fake = new FakeSentry();
  restore = __setSdkForTests(fake);
});

afterEach(() => {
  restore();
});

describe('initMonitoring', () => {
  it('init dengan DSN valid: opsi benar + hasil initialized', () => {
    const result = initMonitoring(DSN, { environment: 'preview', release: 'v1' });
    expect(result).toEqual({ initialized: true, skipped: null });
    expect(fake.initCalls).toHaveLength(1);
    const options = fake.initCalls[0] as Record<string, unknown>;
    expect(options.dsn).toBe(DSN);
    expect(options.environment).toBe('preview');
    expect(options.release).toBe('v1');
    expect(options.tracesSampleRate).toBe(0);
    expect(typeof options.beforeSend).toBe('function');
  });

  it('DSN kosong/undefined → no-op terdokumentasi', () => {
    expect(initMonitoring(undefined)).toEqual({ initialized: false, skipped: 'empty-dsn' });
    expect(initMonitoring('   ')).toEqual({ initialized: false, skipped: 'empty-dsn' });
    expect(fake.initCalls).toHaveLength(0);
  });

  it('idempoten — init kedua dilewati dengan alasan', () => {
    initMonitoring(DSN);
    const second = initMonitoring(DSN);
    expect(second).toEqual({ initialized: false, skipped: 'already-initialized' });
    expect(fake.initCalls).toHaveLength(1);
  });

  it('DSN dipangkas spasi sebelum dipakai', () => {
    initMonitoring(`  ${DSN}  `);
    expect((fake.initCalls[0] as Record<string, unknown>).dsn).toBe(DSN);
  });

  it('beforeSend memangkas query URL dan kunci sensitif extra', () => {
    initMonitoring(DSN);
    const options = fake.initCalls[0] as { beforeSend: (e: unknown) => unknown };
    const scrubbed = options.beforeSend({
      request: { url: 'https://app.example.com/room?token=rahasia' },
      extra: { api_key: 'abc', roomId: 'abc123' },
    }) as { request: { url: string }; extra: Record<string, unknown> };
    expect(scrubbed.request.url).toBe('https://app.example.com/room');
    expect(scrubbed.extra.api_key).toBe('[difilter]');
    expect(scrubbed.extra.roomId).toBe('abc123');
  });

  it('breadcrumbs=false mematikan default integrations', () => {
    initMonitoring(DSN, { breadcrumbs: false });
    const options = fake.initCalls[0] as Record<string, unknown>;
    expect(options.defaultIntegrations).toBe(false);
  });
});

describe('captureError', () => {
  it('tanpa detail → captureException langsung + event id', () => {
    const error = new Error('uji');
    expect(captureError(error)).toBe('evt-123');
    expect(fake.captured).toEqual([{ error }]);
    expect(fake.contexts).toHaveLength(0);
  });

  it('dengan context + data → menempel via withScope', () => {
    captureError(new Error('uji'), {
      context: 'voice-recorder',
      data: { state: 'recording' },
    });
    expect(fake.contexts).toEqual([{ name: 'voice-recorder', context: { state: 'recording' } }]);
    expect(fake.captured).toHaveLength(1);
  });

  it('data tanpa context → nama context "detail"', () => {
    captureError(new Error('uji'), { data: { durasi: 12 } });
    expect(fake.contexts).toEqual([{ name: 'detail', context: { durasi: 12 } }]);
  });

  it('SDK meledak → mengembalikan string kosong TANPA melempar', () => {
    fake.failOn = 'capture';
    expect(captureError(new Error('uji'))).toBe('');
  });
});

describe('addTrail', () => {
  it('mencatat breadcrumb dengan kategori dan data opsional', () => {
    addTrail('join room', { code: 'abc123' });
    addTrail('leave room', undefined, 'mesh');
    expect(fake.breadcrumbs).toEqual([
      { message: 'join room', category: 'app', level: 'info', data: { code: 'abc123' } },
      { message: 'leave room', category: 'mesh', level: 'info' },
    ]);
  });

  it('SDK meledak → diam (tidak pernah melempar)', () => {
    fake.failOn = 'breadcrumb';
    expect(() => addTrail('aman')).not.toThrow();
  });
});

describe('flushMonitoring & monitoringStatus', () => {
  it('flush meneruskan timeout dan mengembalikan hasil SDK', async () => {
    await expect(flushMonitoring(500)).resolves.toBe(true);
    expect(fake.flushCalls).toEqual([500]);
  });

  it('flush default 2000ms', async () => {
    await flushMonitoring();
    expect(fake.flushCalls).toEqual([2_000]);
  });

  it('flush gagal → false, bukan throw', async () => {
    fake.failOn = 'flush';
    await expect(flushMonitoring()).resolves.toBe(false);
  });

  it('status mencerminkan SDK', () => {
    expect(monitoringStatus()).toEqual({ initialized: false, enabled: false });
    initMonitoring(DSN);
    expect(monitoringStatus()).toEqual({ initialized: true, enabled: true });
  });
});
