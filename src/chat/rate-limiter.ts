// ============================================================
// Kontrak hasil & dependensi
// ============================================================

/** Hasil satu percobaan akuisisi slot rate limit. */
export interface RateLimitResult {
  allowed: boolean;
  /** Slot tersisa di jendela saat ini (0 bila ditolak). */
  remaining: number;
  /**
   * Sisa milidetik sampai event TERTUA keluar jendela — yaitu saat satu
   * slot bebas. Selalu 0 bila allowed.
   */
  retryAfterMs: number;
}

/** Sub-kemampuan rate limiter yang dibutuhkan MessageService (injeksi fake). */
export interface RateLimiterLike {
  tryAcquire(key: string): RateLimitResult;
}

export interface SlidingWindowRateLimiterConfig {
  maxEvents: number;
  windowMs: number;
}

export interface SlidingWindowRateLimiterDeps {
  /** Jam ter-inject — test deterministik (default Date.now). */
  now?: () => number;
  /**
   * Pemangkasan lintas-kunci dijalankan setiap N pemanggilan tryAcquire
   * (default 1024). Disuntikkan kecil oleh test supaya sweep teramati.
   */
  sweepEveryCalls?: number;
}

/** Interval sweep default (dipakai bila deps tidak menyuntikkan). */
export const DEFAULT_SWEEP_EVERY_CALLS = 1024;

/**
 * Rate limiter jendela geser per-kunci berbasis stempel waktu event.
 *
 * Pilihan desain (semua sadar & minimal):
 * - MURNI, TANPA timer aktif: stempel waktu kedaluwarsa dipangkas MALAS
 *   saat kunci itu diakses lagi — tidak ada setTimeout/setInterval apa pun,
 *   aman dipakai di lingkungan apa pun dan tidak perlu dispose.
 * - Percobaan yang DITOLAK tidak dicatat sebagai event — spam yang terus
 *   ditolak tidak memperpanjang jendela hukumannya sendiri.
 * - Pemangkasan lintas-kunci MURAH: setiap `sweepEveryCalls` pemanggilan,
 *   kunci yang SELURUH event-nya kedaluwarsa dibuang. Biaya amortisasi
 *   O(1) per panggilan; kunci basi bertahan paling lama `sweepEveryCalls`
 *   panggilan. Tidak dipasang mekanisme umur/timer tambahan apa pun
 *   (itu over-engineering untuk MVP chat) — memori praktis dibatasi oleh
 *   jumlah kunci AKTIF ditambah sisa kunci basi < sweepEveryCalls.
 */
export class SlidingWindowRateLimiter implements RateLimiterLike {
  readonly #maxEvents: number;
  readonly #windowMs: number;
  readonly #now: () => number;
  readonly #sweepEveryCalls: number;
  /** Stempel waktu event per kunci, selalu terurut naik (push berurutan). */
  readonly #events = new Map<string, number[]>();
  #callsSinceSweep = 0;

  constructor(config: SlidingWindowRateLimiterConfig, deps: SlidingWindowRateLimiterDeps = {}) {
    if (!Number.isInteger(config.maxEvents) || config.maxEvents <= 0) {
      throw new RangeError(`maxEvents harus integer > 0, diterima: ${config.maxEvents}`);
    }
    if (!Number.isInteger(config.windowMs) || config.windowMs <= 0) {
      throw new RangeError(`windowMs harus integer > 0, diterima: ${config.windowMs}`);
    }
    const sweepEveryCalls = deps.sweepEveryCalls ?? DEFAULT_SWEEP_EVERY_CALLS;
    if (!Number.isInteger(sweepEveryCalls) || sweepEveryCalls <= 0) {
      throw new RangeError(`sweepEveryCalls harus integer > 0, diterima: ${sweepEveryCalls}`);
    }
    this.#maxEvents = config.maxEvents;
    this.#windowMs = config.windowMs;
    this.#now = deps.now ?? Date.now;
    this.#sweepEveryCalls = sweepEveryCalls;
  }

  /**
   * Mencoba mengambil satu slot untuk `key`. Bila jendela penuh, kembalikan
   * allowed=false + retryAfterMs (saat slot pertama bebas) TANPA mencatat
   * percobaan ini sebagai event.
   */
  tryAcquire(key: string): RateLimitResult {
    const now = this.#now();
    this.#maybeSweep(now);
    const events = this.#pruneKey(key, now);
    if (events.length >= this.#maxEvents) {
      const oldest = events[0];
      if (oldest === undefined) {
        // Tidak terjadi pada antrean terurut tak-kosong — guard invariant.
        throw new Error('invariant rusak: antrean event kosong saat jendela penuh');
      }
      // Event t berlaku selama now - t < windowMs → slot bebas di t + windowMs.
      return {
        allowed: false,
        remaining: 0,
        retryAfterMs: Math.max(oldest + this.#windowMs - now, 0),
      };
    }
    events.push(now);
    this.#events.set(key, events);
    return {
      allowed: true,
      remaining: this.#maxEvents - events.length,
      retryAfterMs: 0,
    };
  }

  /** Mereset satu kunci (tanpa argumen: seluruh kunci). */
  reset(key?: string): void {
    if (key === undefined) {
      this.#events.clear();
      return;
    }
    this.#events.delete(key);
  }

  /**
   * Jumlah kunci yang masih menyimpan stempel waktu — introspeksi untuk
   * test/diagnostik (membuktikan pemangkasan memori tanpa membocorkan isi).
   */
  keyCount(): number {
    return this.#events.size;
  }

  /** Buang stempel kedaluwarsa milik SATU kunci; kembalikan yang masih hidup. */
  #pruneKey(key: string, now: number): number[] {
    const events = this.#events.get(key);
    if (events === undefined) {
      return [];
    }
    const fresh = events.filter((t) => now - t < this.#windowMs);
    if (fresh.length === 0) {
      this.#events.delete(key);
      return [];
    }
    if (fresh.length !== events.length) {
      this.#events.set(key, fresh);
    }
    return fresh;
  }

  /** Pemangkasan lintas-kunci berkala — hapus kunci yang seluruhnya basi. */
  #maybeSweep(now: number): void {
    this.#callsSinceSweep += 1;
    if (this.#callsSinceSweep < this.#sweepEveryCalls) {
      return;
    }
    this.#callsSinceSweep = 0;
    for (const [key, events] of this.#events) {
      const newest = events[events.length - 1];
      if (newest === undefined || now - newest >= this.#windowMs) {
        this.#events.delete(key);
      }
    }
  }
}
