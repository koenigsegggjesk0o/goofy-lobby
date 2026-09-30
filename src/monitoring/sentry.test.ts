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

describe('beforeSend deep-scrub (remediasi 25-a)', () => {
  /** init sekali per test (fake baru tiap test) → ambil beforeSend-nya. */
  function getBeforeSend(): (e: unknown) => unknown {
    initMonitoring(DSN);
    return (fake.initCalls[0] as { beforeSend: (e: unknown) => unknown }).beforeSend;
  }

  it('extra nested 3 level: kunci sensitif di semua kedalaman difilter', () => {
    const beforeSend = getBeforeSend();
    const scrubbed = beforeSend({
      extra: {
        room: 'abc123',
        layer1: {
          session: 'jwt-abc',
          layer2: {
            api_key: 'nested',
            layer3: { password: 'jauh', keep: 'utuh' },
          },
        },
      },
    }) as { extra: Record<string, unknown> };
    expect(scrubbed.extra.room).toBe('abc123');
    const layer1 = scrubbed.extra.layer1 as Record<string, unknown>;
    expect(layer1.session).toBe('[difilter]');
    const layer2 = layer1.layer2 as Record<string, unknown>;
    expect(layer2.api_key).toBe('[difilter]');
    const layer3 = layer2.layer3 as Record<string, unknown>;
    expect(layer3.password).toBe('[difilter]');
    expect(layer3.keep).toBe('utuh');
  });

  it('breadcrumbs[i].data nested: kunci sensitif disikat, field lain utuh', () => {
    const beforeSend = getBeforeSend();
    const scrubbed = beforeSend({
      breadcrumbs: [
        { message: 'join room', category: 'mesh', level: 'info', data: { cand: { secret: 'x' } } },
        { message: 'tanpa data' },
        { message: 'data array', data: [{ api_key: 'y' }, 'plain'] },
      ],
    }) as { breadcrumbs: Array<{ message: string; data?: unknown }> };
    const first = scrubbed.breadcrumbs[0];
    expect(first?.message).toBe('join room');
    const data = first?.data as { cand: { secret: unknown } };
    expect(data.cand.secret).toBe('[difilter]');
    expect(scrubbed.breadcrumbs[1]).toEqual({ message: 'tanpa data' });
    expect(scrubbed.breadcrumbs[2]?.data).toEqual([{ api_key: '[difilter]' }, 'plain']);
  });

  it('contexts nested: context terdalam dibersihkan', () => {
    const beforeSend = getBeforeSend();
    const scrubbed = beforeSend({
      contexts: {
        'voice-recorder': { state: 'recording', meta: { credential: 'abc', durasi: 12 } },
      },
    }) as { contexts: Record<string, unknown> };
    const ctx = scrubbed.contexts['voice-recorder'] as Record<string, unknown>;
    expect(ctx.state).toBe('recording');
    expect((ctx.meta as Record<string, unknown>).credential).toBe('[difilter]');
    expect((ctx.meta as Record<string, unknown>).durasi).toBe(12);
  });

  it('string > 2048 char dipotong + sufiks [truncated] (setelah redaksi)', () => {
    const beforeSend = getBeforeSend();
    const secretTail = 'rahasia'.repeat(10);
    const scrubbed = beforeSend({
      extra: { blob: `x`.repeat(3000) + `?token=${secretTail}` },
    }) as { extra: Record<string, unknown> };
    const blob = scrubbed.extra.blob as string;
    expect(blob.length).toBe(2048 + '…[truncated]'.length);
    expect(blob.endsWith('…[truncated]')).toBe(true);
    expect(blob).not.toContain(secretTail);
  });

  it('URL userinfo (user:pass@) di nilai string di-redaksi, host tetap terlihat', () => {
    const beforeSend = getBeforeSend();
    const scrubbed = beforeSend({
      extra: { turn: 'turn://user:rahasia@turn.example.com:3478?transport=tcp' },
      contexts: { net: { url: 'https://alice:s3cret@relay.example.com/path' } },
    }) as { extra: Record<string, unknown>; contexts: Record<string, unknown> };
    expect(scrubbed.extra.turn).toBe('turn://***:***@turn.example.com:3478?transport=tcp');
    expect(scrubbed.contexts.net).toEqual({ url: 'https://***:***@relay.example.com/path' });
  });

  it('query param sensitif dalam string di-redaksi, param lain tetap', () => {
    const beforeSend = getBeforeSend();
    const scrubbed = beforeSend({
      extra: { link: 'https://x.example.com/a?token=abc&room=abc123&api_key=zzz' },
    }) as { extra: Record<string, unknown> };
    expect(scrubbed.extra.link).toBe(
      'https://x.example.com/a?token=[difilter]&room=abc123&api_key=[difilter]',
    );
  });

  it('nilai sirkular tidak meledak — ditandai [circular]', () => {
    const beforeSend = getBeforeSend();
    const nested: Record<string, unknown> = { keep: 'ok' };
    nested.self = nested;
    const scrubbed = beforeSend({
      extra: { nested },
    }) as { extra: Record<string, unknown> };
    const out = scrubbed.extra.nested as Record<string, unknown>;
    expect(out.keep).toBe('ok');
    expect(out.self).toBe('[circular]');
  });

  it('request.url dengan userinfo: query dibuang DAN userinfo di-redaksi', () => {
    const beforeSend = getBeforeSend();
    const scrubbed = beforeSend({
      request: { url: 'https://user:pass@app.example.com/room?token=rahasia' },
    }) as { request: { url: string } };
    expect(scrubbed.request.url).toBe('https://***:***@app.example.com/room');
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

  it('parameter level (8-g) diteruskan — default tetap info (kompatibilitas)', () => {
    addTrail('mesh error', { event: 'error' }, 'mesh', 'error');
    addTrail('biasa');
    expect(fake.breadcrumbs).toEqual([
      { message: 'mesh error', category: 'mesh', level: 'error', data: { event: 'error' } },
      { message: 'biasa', category: 'app', level: 'info' },
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
