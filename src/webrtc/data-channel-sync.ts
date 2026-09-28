import {
  POSITION_MAX_BUFFERED_AMOUNT,
  POSITION_SEND_INTERVAL_MS,
  PositionSchema,
  type Position,
} from './types';

export interface DataChannelSyncOptions {
  /** Dipanggil untuk setiap payload posisi valid dari remote peer. */
  onPosition: (position: Position) => void;
  /** Dipanggil untuk payload yang gagal diparse/divalidasi (untuk metrik). */
  onInvalid?: (reason: string) => void;
  sendIntervalMs?: number;
  maxBufferedAmount?: number;
  /** Jam injeksi untuk test. */
  now?: () => number;
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
 * tidak pernah diteruskan.
 */
export class DataChannelSync {
  private readonly dc: RTCDataChannel;
  private readonly onPosition: (position: Position) => void;
  private readonly onInvalid?: (reason: string) => void;
  private readonly intervalMs: number;
  private readonly maxBufferedAmount: number;
  private readonly now: () => number;
  private lastSentAt = Number.NEGATIVE_INFINITY;
  private closed = false;

  constructor(dc: RTCDataChannel, options: DataChannelSyncOptions) {
    this.dc = dc;
    this.onPosition = options.onPosition;
    this.onInvalid = options.onInvalid;
    this.intervalMs = options.sendIntervalMs ?? POSITION_SEND_INTERVAL_MS;
    this.maxBufferedAmount = options.maxBufferedAmount ?? POSITION_MAX_BUFFERED_AMOUNT;
    this.now = options.now ?? Date.now;
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
    dc.addEventListener('message', this.handleMessage);
  }

  private readonly handleMessage = (event: MessageEvent<string>): void => {
    if (this.closed) {
      return;
    }
    if (typeof event.data !== 'string') {
      this.onInvalid?.('payload bukan string');
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
