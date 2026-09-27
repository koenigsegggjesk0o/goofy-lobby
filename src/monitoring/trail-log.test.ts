import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { meshTrail } from './mesh-trail';
import { __setSdkForTests, addTrail, type SentrySdkLike } from './sentry';
import { __resetTrailLogForTests, getTrailLog, pushTrailLog, TRAIL_LOG_LIMIT } from './trail-log';

/**
 * Trail-log (Task 10-a): ring lokal breadcrumb — jejak addTrail teramati
 * TANPA DSN. Dua lapis: (1) perilaku ring murni (bound/copy/reset);
 * (2) integrasi addTrail → ring (termasuk saat SDK melempar).
 */

class FakeSentry implements SentrySdkLike {
  initialized = false;
  enabled = false;
  breadcrumbs: unknown[] = [];
  failBreadcrumb = false;

  init(): unknown {
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

  captureException(): string {
    return 'evt-1';
  }

  addBreadcrumb(breadcrumb: unknown): void {
    if (this.failBreadcrumb) {
      throw new Error('sdk meledak');
    }
    this.breadcrumbs.push(breadcrumb);
  }

  withScope(): void {
    /* tidak dipakai di sini */
  }

  async flush(): Promise<boolean> {
    return true;
  }
}

let fake: FakeSentry;
let restoreSdk: () => void;

beforeEach(() => {
  __resetTrailLogForTests();
  fake = new FakeSentry();
  restoreSdk = __setSdkForTests(fake);
});

afterEach(() => {
  restoreSdk();
  __resetTrailLogForTests();
});

describe('trail-log ring murni', () => {
  it('pushTrailLog mencatat entri lengkap dengan timestamp ISO', () => {
    const entry = pushTrailLog('tes pesan', { a: 1 }, 'mesh', 'info');

    expect(entry.message).toBe('tes pesan');
    expect(entry.category).toBe('mesh');
    expect(entry.level).toBe('info');
    expect(entry.data).toEqual({ a: 1 });
    expect(new Date(entry.at).toString()).not.toBe('Invalid Date');

    const log = getTrailLog();
    expect(log).toHaveLength(1);
    // Konten identik, referensi TIDAK (getTrailLog meng-clone — snapshot).
    expect(log[0]).toEqual(entry);
    expect(log[0]).not.toBe(entry);
  });

  it('data undefined → entri tanpa kunci data (bukan objek kosong)', () => {
    const entry = pushTrailLog('tanpa data', undefined, 'app', 'info');

    expect(entry.data).toBeUndefined();
    expect('data' in entry).toBe(false);
  });

  it(`ring FIFO: ${TRAIL_LOG_LIMIT + 10} push → tetap ${TRAIL_LOG_LIMIT}, terlama terbuang`, () => {
    for (let i = 0; i < TRAIL_LOG_LIMIT + 10; i++) {
      pushTrailLog(`m-${i}`, { i }, 'app', 'info');
    }

    const log = getTrailLog();
    expect(log).toHaveLength(TRAIL_LOG_LIMIT);
    expect(log[0]?.message).toBe(`m-${10}`);
    expect(log[log.length - 1]?.message).toBe(`m-${TRAIL_LOG_LIMIT + 9}`);
  });

  it('getTrailLog mengembalikan snapshot — mutasi hasil tidak mengubah ring', () => {
    pushTrailLog('m', { a: 1 }, 'app', 'info');
    const snapshot = getTrailLog();

    snapshot.push({
      at: 'x',
      message: 'disuntik',
      category: 'app',
      level: 'info',
    });
    (snapshot[0] as { message: string }).message = 'dimutasi';

    const logBaru = getTrailLog();
    expect(logBaru).toHaveLength(1);
    expect(logBaru[0]?.message).toBe('m');
  });

  it('__resetTrailLogForTests mengosongkan ring', () => {
    pushTrailLog('m', undefined, 'app', 'info');
    expect(getTrailLog()).toHaveLength(1);

    __resetTrailLogForTests();
    expect(getTrailLog()).toEqual([]);
  });
});

describe('addTrail → ring (integrasi)', () => {
  it('addTrail tercatat di ring dengan default category/level', () => {
    addTrail('halo dunia');

    const log = getTrailLog();
    expect(log).toHaveLength(1);
    expect(log[0]).toMatchObject({
      message: 'halo dunia',
      category: 'app',
      level: 'info',
    });
    expect('data' in (log[0] ?? {})).toBe(false);
  });

  it('addTrail tercatat dengan data + category + level eksplisit', () => {
    addTrail('join room', { code: 'abc' }, 'mesh', 'error');

    expect(getTrailLog()[0]).toMatchObject({
      message: 'join room',
      category: 'mesh',
      level: 'error',
      data: { code: 'abc' },
    });
  });

  it('pemetaan meshTrail tercatat utuh (error → level error, category mesh)', () => {
    const trail = meshTrail('error', { message: 'peer putus', sessionId: 's1' });
    addTrail(trail.message, trail.data, trail.category, trail.level);

    expect(getTrailLog()[0]).toMatchObject({
      message: 'mesh error',
      category: 'mesh',
      level: 'error',
      data: {
        event: 'error',
        detail: { message: 'peer putus', sessionId: 's1' },
      },
    });
  });

  it('SDK melempar → trail TETAP tercatat dan addTrail tidak melempar', () => {
    fake.failBreadcrumb = true;

    expect(() => addTrail('saat sdk mati', { x: 1 }, 'mesh')).not.toThrow();

    expect(getTrailLog()).toHaveLength(1);
    expect(getTrailLog()[0]?.message).toBe('saat sdk mati');
  });

  it('ring dan SDK menerima konten yang sama (satu sumber kebenaran)', () => {
    addTrail('ganda', { n: 7 }, 'mesh');

    expect(fake.breadcrumbs).toHaveLength(1);
    expect(getTrailLog()).toHaveLength(1);
    expect(fake.breadcrumbs[0]).toMatchObject({ message: 'ganda', category: 'mesh' });
    expect(getTrailLog()[0]?.data).toEqual({ n: 7 });
  });

  it('mutasi objek data pemanggil setelah addTrail tidak mengubah entri ring', () => {
    const data: Record<string, unknown> = { room: 'r1' };
    addTrail('decoupled', data, 'mesh');
    data.room = 'MUTASI-SETELAH-CALL';

    expect(getTrailLog()[0]?.data).toEqual({ room: 'r1' });
  });
});
