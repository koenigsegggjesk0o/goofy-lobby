import {
  POSITION_MAX_BUFFERED_AMOUNT,
  POSITION_SEND_INTERVAL_MS,
  PositionSchema,
  type Position,
} from './types';

/** Batas ukuran pesan inbound (karakter) — default remediasi 25-c (LOW/INFO). */
export const INBOUND_MAX_MESSAGE_CHARS = 16_384;

/** Batas laju pesan inbound per peer (pesan/detik, sliding window 1 s). */
export const INBOUND_RATE_LIMIT_PER_SECOND = 100;

/** Lebar jendela sliding-window throttle inbound (ms). */
const INBOUND_RATE_WINDOW_MS = 1_000;

export interface DataChannelSyncOptions {
  /** Dipanggil untuk setiap payload posisi valid dari remote peer. */
  onPosition: (position: Position) => void;
  /** Dipanggil untuk payload yang gagal diparse/divalidasi (untuk metrik). */
  onInvalid?: (reason: string) => void;
  sendIntervalMs?: number;
  maxBufferedAmount?: number;
  /** Jam injeksi untuk test. */
  now?: () => number;
  /**
   * Batas ukuran pesan inbound dalam KARAKTER (default
   * INBOUND_MAX_MESSAGE_CHARS). Pesan yang melebihi di-DROP + counter —
   * payload posisi sah selalu < 100 karakter, jadi 16 KiB sangat longgar.
   * Di-inject supaya test burst bisa memakai nilai berbeda.
   */
  maxInboundMessageChars?: number;
  /**
   * Batas laju pesan inbound per peer per detik (default
   * INBOUND_RATE_LIMIT_PER_SECOND, sliding window 1 s). Kelebihan di-DROP
   * + counter. Di-inject supaya test burst bisa memakai nilai tinggi.
   */
  inboundRateLimitPerSecond?: number;
  /** Label peer untuk pesan warn sekali-per-peer (mis. sessionId remote). */
  peerLabel?: string;
}

/** Counter pesan inbound yang di-drop (remediasi 25-c — untuk stats/trail). */
export interface InboundDropCounts {
  /** Pesan di-drop karena melebihi maxInboundMessageChars. */
  oversize: number;
  /** Pesan di-drop karena melebihi inboundRateLimitPerSecond. */
  overrate: number;
}

/**
 * Sinkronisasi posisi ~15 kali/detik lewat satu RTCDataChannel per peer.
 *
 * Sifat pengiriman:
 * - di-throttle per interval (default 66 ms ≈ 15 Hz);
 * - dibatalkan bila buffer DataChannel penuh (posisi basi tidak berguna);
 * - hanya dikirim saat channel 'open'.
 *
 * Payload masuk selalu divalidasi Zod — yang gugur dilaporkan ke onInvalid,
 * tidak pernah diteruskan. Hardening inbound (remediasi audit 25-c LOW/INFO):
 * - pesan > maxInboundMessageChars karakter di-DROP sebelum JSON.parse
 *   (biaya parse tidak dibayar untuk payload sampah) + counter + warn
 *   sekali per peer;
 * - laju inbound di-throttle sliding-window per detik (default 100 pesan/s
 *   — ~6,7x laju kirim sah 15 Hz) + counter. Kelebihan di-drop, bukan
 *   di-antre: posisi basi tidak ada gunanya.
 */
export class DataChannelSync {
  private readonly dc: RTCDataChannel;
  private readonly onPosition: (position: Position) => void;
  private readonly onInvalid?: (reason: string) => void;
  private readonly intervalMs: number;
  private readonly maxBufferedAmount: number;
  private readonly now: () => number;
  private readonly maxInboundMessageChars: number;
  private readonly inboundRateLimitPerSecond: number;
  private readonly peerLabel: string;
  /** Counter drop inbound — dibaca lewat getInboundDropCounts(). */
  private readonly inboundDrops: InboundDropCounts = { oversize: 0, overrate: 0 };
  /** Timestamp pesan inbound yang masuk jendela 1 s (sliding window). */
  private readonly inboundWindow: number[] = [];
  /** Warn per-jenis hanya sekali per peer (hindari spam console saat flood). */
  private warnedOversize = false;
  private warnedOverrate = false;
  private lastSentAt = Number.NEGATIVE_INFINITY;
  private closed = false;

  constructor(dc: RTCDataChannel, options: DataChannelSyncOptions) {
    this.dc = dc;
    this.onPosition = options.onPosition;
    this.onInvalid = options.onInvalid;
    this.intervalMs = options.sendIntervalMs ?? POSITION_SEND_INTERVAL_MS;
    this.maxBufferedAmount = options.maxBufferedAmount ?? POSITION_MAX_BUFFERED_AMOUNT;
    this.now = options.now ?? Date.now;
    this.maxInboundMessageChars = options.maxInboundMessageChars ?? INBOUND_MAX_MESSAGE_CHARS;
    this.inboundRateLimitPerSecond =
      options.inboundRateLimitPerSecond ?? INBOUND_RATE_LIMIT_PER_SECOND;
    this.peerLabel = options.peerLabel ?? 'peer-tak-dikenal';
    // Kontrak opsi numerik (konvensi stats.ts): nilai tak masuk akal
    // GAGAL KERAS saat konstruksi, bukan diam-diam mengubah perilaku
    // (interval NaN membuat throttle selalu lolos; batas negatif selalu
    // memblokir backpressure).
    if (!Number.isFinite(this.intervalMs) || this.intervalMs <= 0) {
      throw new RangeError(`sendIntervalMs harus angka > 0 (dapat: ${options.sendIntervalMs})`);
    }
    if (!Number.isFinite(this.maxBufferedAmount) || this.maxBufferedAmount < 0) {
      throw new RangeError(
        `maxBufferedAmount harus angka >= 0 (dapat: ${options.maxBufferedAmount})`,
      );
    }
    if (!Number.isFinite(this.maxInboundMessageChars) || this.maxInboundMessageChars <= 0) {
      throw new RangeError(
        `maxInboundMessageChars harus angka > 0 (dapat: ${options.maxInboundMessageChars})`,
      );
    }
    if (!Number.isFinite(this.inboundRateLimitPerSecond) || this.inboundRateLimitPerSecond <= 0) {
      throw new RangeError(
        `inboundRateLimitPerSecond harus angka > 0 (dapat: ${options.inboundRateLimitPerSecond})`,
      );
    }
    dc.addEventListener('message', this.handleMessage);
  }

  /** Snapshot counter drop inbound (untuk stats/trail pemanggil). */
  getInboundDropCounts(): InboundDropCounts {
    return { ...this.inboundDrops };
  }

  private readonly handleMessage = (event: MessageEvent<string>): void => {
    if (this.closed) {
      return;
    }
    if (typeof event.data !== 'string') {
      this.onInvalid?.('payload bukan string');
      return;
    }
    // Hardening 25-c (a): ukuran dulu — pesan raksasa di-drop SEBELUM parse
    // (biaya JSON.parse tidak dibayar untuk payload sampah).
    if (event.data.length > this.maxInboundMessageChars) {
      this.inboundDrops.oversize += 1;
      if (!this.warnedOversize) {
        this.warnedOversize = true;
        console.warn(
          `[data-channel-sync] pesan inbound dari ${this.peerLabel} di-drop: ` +
            `${event.data.length} karakter > batas ${this.maxInboundMessageChars} (selanjutnya diam, lihat counter)`,
        );
      }
      this.onInvalid?.(
        `payload terlalu besar: ${event.data.length} karakter (maksimum ${this.maxInboundMessageChars})`,
      );
      return;
    }
    // Hardening 25-c (b): sliding window 1 s — kelebihan laju di-drop.
    if (!this.admitInboundRate()) {
      this.inboundDrops.overrate += 1;
      if (!this.warnedOverrate) {
        this.warnedOverrate = true;
        console.warn(
          `[data-channel-sync] pesan inbound dari ${this.peerLabel} di-drop: ` +
            `laju melebihi ${this.inboundRateLimitPerSecond}/detik (selanjutnya diam, lihat counter)`,
        );
      }
      this.onInvalid?.(`laju pesan inbound melebihi batas ${this.inboundRateLimitPerSecond}/detik`);
      return;
    }
    let raw: unknown;
    try {
      raw = JSON.parse(event.data);
    } catch {
      this.onInvalid?.('payload bukan JSON valid');
      return;
    }
    const parsed = PositionSchema.safeParse(raw);
    if (parsed.success) {
      this.onPosition(parsed.data);
    } else {
      this.onInvalid?.(
        parsed.error.issues
          .map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`)
          .join('; '),
      );
    }
  };

  /**
   * Sliding window 1 s: catat timestamp pesan ini bila kuota jendela masih
   * tersisa, kembalikan false bila sudah penuh (pesan di-drop).
   * `window.length` selalu ≤ inboundRateLimitPerSecond — memori terikat.
   */
  private admitInboundRate(): boolean {
    const timestamp = this.now();
    const cutoff = timestamp - INBOUND_RATE_WINDOW_MS;
    while (this.inboundWindow.length > 0) {
      const head = this.inboundWindow[0];
      if (head === undefined || head > cutoff) {
        break;
      }
      this.inboundWindow.shift();
    }
    if (this.inboundWindow.length >= this.inboundRateLimitPerSecond) {
      return false;
    }
    this.inboundWindow.push(timestamp);
    return true;
  }

  /**
   * Mengirim posisi (best effort). Mengembalikan true bila benar-benar terkirim.
   * Pemanggil bebas memanggil sesering apa pun — throttle internal yang mengatur.
   */
  sendPosition(position: Position): boolean {
    if (this.closed) {
      return false;
    }
    if (this.dc.readyState !== 'open') {
      return false;
    }
    if (this.dc.bufferedAmount > this.maxBufferedAmount) {
      return false;
    }
    const timestamp = this.now();
    if (timestamp - this.lastSentAt < this.intervalMs) {
      return false;
    }
    this.lastSentAt = timestamp;
    try {
      this.dc.send(JSON.stringify(position));
    } catch {
      // Batas API eksternal: JSON.stringify (BigInt/sirkular dari
      // pemanggil nakal saat runtime) dan dc.send (kontrak RTCDataChannel
      // melempar InvalidStateError) — kegagalan best-effort posisi TIDAK
      // boleh menjatuhkan loop broadcast pemanggil: tanpa try ini, satu
      // peer yang melempar membatalkan pengiriman ke peer sisanya
      // (dibuktikan test regresi 15-a di level PeerConnectionManager).
      return false;
    }
    return true;
  }

  /** Berhenti mendengarkan pesan masuk (channel ditutup pemiliknya). */
  close(): void {
    if (this.closed) {
      return;
    }
    this.closed = true;
    this.dc.removeEventListener('message', this.handleMessage);
  }
}
