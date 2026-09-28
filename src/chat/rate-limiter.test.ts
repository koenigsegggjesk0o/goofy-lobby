import { describe, expect, it } from 'vitest';
import { DEFAULT_SWEEP_EVERY_CALLS, SlidingWindowRateLimiter } from './rate-limiter';

/** Jam ter-inject — deterministik, tanpa timer sungguhan. */
function makeClock(startAt = 0) {
  let t = startAt;
  return {
    now: () => t,
    advance: (ms: number) => {
      t += ms;
    },
  };
}

function makeLimiter(maxEvents = 3, windowMs = 1000, startAt = 0) {
  const clock = makeClock(startAt);
  const limiter = new SlidingWindowRateLimiter({ maxEvents, windowMs }, { now: clock.now });
  return { limiter, clock };
}

describe('SlidingWindowRateLimiter — jendela geser', () => {
  it('mengizinkan tepat maxEvents beruntun lalu menolak ke-N+1', () => {
    const { limiter } = makeLimiter(3, 1000);
    expect(limiter.tryAcquire('a')).toEqual({ allowed: true, remaining: 2, retryAfterMs: 0 });
    expect(limiter.tryAcquire('a')).toEqual({ allowed: true, remaining: 1, retryAfterMs: 0 });
    expect(limiter.tryAcquire('a')).toEqual({ allowed: true, remaining: 0, retryAfterMs: 0 });
    expect(limiter.tryAcquire('a')).toEqual({
      allowed: false,
      remaining: 0,
      retryAfterMs: 1000,
    });
  });

  it('retryAfterMs mengarah ke saat event tertua keluar jendela (mengecil)', () => {
    const { limiter, clock } = makeLimiter(1, 1000);
    expect(limiter.tryAcquire('a').allowed).toBe(true);
    clock.advance(400);
    expect(limiter.tryAcquire('a')).toEqual({ allowed: false, remaining: 0, retryAfterMs: 600 });
    clock.advance(350);
    expect(limiter.tryAcquire('a')).toEqual({ allowed: false, remaining: 0, retryAfterMs: 250 });
  });

  it('pulih tepat saat jendela lewat (batas = inklusif kedaluwarsa)', () => {
    const { limiter, clock } = makeLimiter(2, 1000);
    limiter.tryAcquire('a');
    limiter.tryAcquire('a');
    expect(limiter.tryAcquire('a').allowed).toBe(false);
    clock.advance(1000);
    expect(limiter.tryAcquire('a')).toEqual({ allowed: true, remaining: 1, retryAfterMs: 0 });
    expect(limiter.tryAcquire('a')).toEqual({ allowed: true, remaining: 0, retryAfterMs: 0 });
    expect(limiter.tryAcquire('a').allowed).toBe(false);
  });

  it('jendela benar-benar bergeser: event lama satu per satu keluar jendela', () => {
    const { limiter, clock } = makeLimiter(3, 1000);
    limiter.tryAcquire('a'); // t=0
    clock.advance(200);
    limiter.tryAcquire('a'); // t=200
    clock.advance(200);
    limiter.tryAcquire('a'); // t=400
    clock.advance(600); // t=1000: hanya event t=0 yang kedaluwarsa
    const result = limiter.tryAcquire('a');
    expect(result).toEqual({ allowed: true, remaining: 0, retryAfterMs: 0 });
    // Event tertua kini t=200 → slot bebas pada t=1200.
    expect(limiter.tryAcquire('a')).toEqual({
      allowed: false,
      remaining: 0,
      retryAfterMs: 200,
    });
  });

  it('percobaan yang ditolak tidak memperpanjang jendela hukuman sendiri', () => {
    const { limiter, clock } = makeLimiter(2, 1000);
    limiter.tryAcquire('a');
    limiter.tryAcquire('a');
    // Spam 50 percobaan ditolak di sepanjang jendela — tidak boleh tercatat.
    for (let i = 0; i < 50; i += 1) {
      clock.advance(10);
      expect(limiter.tryAcquire('a').allowed).toBe(false);
    }
    clock.advance(500); // t=1000: kedua event asli (t=0) kedaluwarsa
    expect(limiter.tryAcquire('a').allowed).toBe(true);
  });

  it('kunci saling independen', () => {
    const { limiter } = makeLimiter(1, 1000);
    expect(limiter.tryAcquire('a').allowed).toBe(true);
    expect(limiter.tryAcquire('a').allowed).toBe(false);
    expect(limiter.tryAcquire('b')).toEqual({ allowed: true, remaining: 0, retryAfterMs: 0 });
  });
});

describe('SlidingWindowRateLimiter.reset', () => {
  it('reset(key) hanya menghapus kunci itu', () => {
    const { limiter } = makeLimiter(1, 1000);
    limiter.tryAcquire('a');
    limiter.tryAcquire('b');
    limiter.reset('a');
    expect(limiter.tryAcquire('a').allowed).toBe(true);
    expect(limiter.tryAcquire('b').allowed).toBe(false);
  });

  it('reset() tanpa argumen menghapus seluruh kunci', () => {
    const { limiter } = makeLimiter(1, 1000);
    limiter.tryAcquire('a');
    limiter.tryAcquire('b');
    limiter.reset();
    expect(limiter.tryAcquire('a').allowed).toBe(true);
    expect(limiter.tryAcquire('b').allowed).toBe(true);
  });
});

describe('SlidingWindowRateLimiter — pemangkasan memori', () => {
  it('pemangkasan malas: kunci basi dibuang saat sweep berkala', () => {
    const clock = makeClock(0);
    const limiter = new SlidingWindowRateLimiter(
      { maxEvents: 5, windowMs: 1000 },
      { now: clock.now, sweepEveryCalls: 4 },
    );
    limiter.tryAcquire('stale'); // t=0 → panggilan ke-1
    clock.advance(10_000);
    // Belum dipangkas: pemangkasan malas, belum ada akses apa pun pasca-basi.
    expect(limiter.keyCount()).toBe(1);
    for (let i = 0; i < 2; i += 1) {
      limiter.tryAcquire('fresh'); // panggilan ke-2 dan ke-3
    }
    expect(limiter.keyCount()).toBe(2); // sweep belum giliran (baru 3 panggilan)
    limiter.tryAcquire('fresh'); // panggilan ke-4 → sweep
    expect(limiter.keyCount()).toBe(1); // 'stale' hilang, 'fresh' bertahan
  });

  it('kunci yang masih punya event hidup tidak ikut tersapu', () => {
    const clock = makeClock(0);
    const limiter = new SlidingWindowRateLimiter(
      { maxEvents: 5, windowMs: 1000 },
      { now: clock.now, sweepEveryCalls: 2 },
    );
    limiter.tryAcquire('active'); // t=0
    clock.advance(500);
    limiter.tryAcquire('active'); // t=500 — masih dalam jendela
    clock.advance(200); // t=700
    limiter.tryAcquire('other'); // panggilan ke-3 → sweep sudah lewat sekali
    limiter.tryAcquire('other'); // panggilan ke-4 → sweep lagi
    expect(limiter.keyCount()).toBe(2);
    expect(limiter.tryAcquire('active').allowed).toBe(true);
  });

  it('interval sweep default tersedia dan positif (kontrak konstanta)', () => {
    expect(DEFAULT_SWEEP_EVERY_CALLS).toBeGreaterThan(0);
  });
});

describe('SlidingWindowRateLimiter — konfigurasi tak valid', () => {
  it('maxEvents/windowMs/sweepEveryCalls non-integer atau <= 0 melempar RangeError', () => {
    for (const maxEvents of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => new SlidingWindowRateLimiter({ maxEvents, windowMs: 1000 })).toThrow(RangeError);
    }
    for (const windowMs of [0, -100, 0.5, Number.POSITIVE_INFINITY]) {
      expect(() => new SlidingWindowRateLimiter({ maxEvents: 1, windowMs })).toThrow(RangeError);
    }
    for (const sweepEveryCalls of [0, -1, 2.5]) {
      expect(
        () => new SlidingWindowRateLimiter({ maxEvents: 1, windowMs: 1000 }, { sweepEveryCalls }),
      ).toThrow(RangeError);
    }
  });

  it('bekerja dengan jam asli (default Date.now) tanpa injeksi', () => {
    const limiter = new SlidingWindowRateLimiter({ maxEvents: 1, windowMs: 60_000 });
    expect(limiter.tryAcquire('real-clock').allowed).toBe(true);
    const denied = limiter.tryAcquire('real-clock');
    expect(denied.allowed).toBe(false);
    expect(denied.retryAfterMs).toBeGreaterThan(0);
    expect(denied.retryAfterMs).toBeLessThanOrEqual(60_000);
  });
});
