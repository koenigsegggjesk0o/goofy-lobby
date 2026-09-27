export interface IceRestartHandlerOptions {
  getConnectionState(): RTCPeerConnectionState;
  getIceConnectionState(): RTCIceConnectionState;
  /**
   * Dipanggil saat ICE restart perlu dijalankan (attempt mulai dari 1).
   * Pemanggil bertanggung jawab memfilter sisi inisiator (hindari glare).
   */
  onRestart: (attempt: number) => void | Promise<void>;
  /** Dipanggil setelah seluruh percobaan restart habis tanpa perbaikan. */
  onGiveUp: (attempts: number) => void;
  /** Lama menunggu 'disconnected' membaik sebelum restart (default 5000 ms). */
  disconnectedGraceMs?: number;
  /** Delay dasar backoff antar restart (default 2000 ms). */
  baseDelayMs?: number;
  /** Batas atas delay backoff (default 30_000 ms). */
  maxDelayMs?: number;
  /** Percobaan restart maksimum sebelum menyerah (default 3). */
  maxAttempts?: number;
}

type Timer = ReturnType<typeof setTimeout>;

/**
 * Pemantau kesehatan koneksi ICE untuk satu peer:
 * - 'failed' → restart segera (attempt pertama tanpa delay);
 * - 'disconnected' yang bertahan melewati masa tenggang → restart;
 * - backoff eksponensial antar percobaan (0 → base → 2×base → …);
 * - setelah maxAttempts tanpa perbaikan → onGiveUp (peer dianggap mati).
 *
 * observe() dipanggil setiap connectionstatechange/iceconnectionstatechange.
 */
export class IceRestartHandler {
  private readonly options: IceRestartHandlerOptions;
  private readonly disconnectedGraceMs: number;
  private readonly baseDelayMs: number;
  private readonly maxDelayMs: number;
  private readonly maxAttempts: number;
  private attempts = 0;
  private disconnectedTimer: Timer | null = null;
  private restartTimer: Timer | null = null;
  private finished = false;

  constructor(options: IceRestartHandlerOptions) {
    this.options = options;
    this.disconnectedGraceMs = options.disconnectedGraceMs ?? 5_000;
    this.baseDelayMs = options.baseDelayMs ?? 2_000;
    this.maxDelayMs = options.maxDelayMs ?? 30_000;
    this.maxAttempts = options.maxAttempts ?? 3;
  }

  /** Dipanggil pemilik peer setiap ada perubahan state koneksi. */
  observe(): void {
    if (this.finished) {
      return;
    }
    const connection = this.options.getConnectionState();
    const ice = this.options.getIceConnectionState();
    if (connection === 'failed' || ice === 'failed') {
      this.clearDisconnectedTimer();
      this.scheduleRestart();
      return;
    }
    if (connection === 'disconnected' || ice === 'disconnected') {
      this.scheduleDisconnectedCheck();
      return;
    }
    if (connection === 'connected') {
      this.clearDisconnectedTimer();
      this.attempts = 0; // pulih → reset hitungan backoff
      return;
    }
    if (connection === 'closed') {
      this.close();
    }
  }

  private isBad(): boolean {
    const connection = this.options.getConnectionState();
    const ice = this.options.getIceConnectionState();
    return (
      connection === 'failed' ||
      ice === 'failed' ||
      connection === 'disconnected' ||
      ice === 'disconnected'
    );
  }

  private scheduleDisconnectedCheck(): void {
    if (this.disconnectedTimer !== null || this.finished) {
      return;
    }
    this.disconnectedTimer = setTimeout(() => {
      this.disconnectedTimer = null;
      if (this.isBad()) {
        this.scheduleRestart();
      }
    }, this.disconnectedGraceMs);
  }

  private scheduleRestart(): void {
    if (this.restartTimer !== null || this.finished) {
      return;
    }
    if (this.attempts >= this.maxAttempts) {
      this.finished = true;
      this.clearDisconnectedTimer();
      this.options.onGiveUp(this.attempts);
      return;
    }
    this.attempts += 1;
    const attempt = this.attempts;
    // Attempt pertama langsung; berikutnya backoff eksponensial.
    const delay =
      attempt === 1 ? 0 : Math.min(this.baseDelayMs * 2 ** (attempt - 2), this.maxDelayMs);
    this.restartTimer = setTimeout(() => {
      this.restartTimer = null;
      // Error dari onRestart ditelan di sini — pemiliknya sudah mencatat
      // kegagalan make-offer lewat jalur onError-nya sendiri.
      void Promise.resolve(this.options.onRestart(attempt)).catch(() => undefined);
    }, delay);
  }

  private clearDisconnectedTimer(): void {
    if (this.disconnectedTimer !== null) {
      clearTimeout(this.disconnectedTimer);
      this.disconnectedTimer = null;
    }
  }

  /** Hentikan pemantauan (peer ditutup normal). */
  close(): void {
    this.finished = true;
    this.clearDisconnectedTimer();
    if (this.restartTimer !== null) {
      clearTimeout(this.restartTimer);
      this.restartTimer = null;
    }
  }
}
