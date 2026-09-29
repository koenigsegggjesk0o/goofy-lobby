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
  /**
   * Batas waktu pembentukan koneksi setelah arm() — bila setelah sekian ms
   * koneksi masih 'new'/'connecting' (tidak pernah selesai terbentuk),
   * restart dieksekusi lewat jalur backoff yang sama (default 15_000 ms).
   * Nilai ≤ 0 mematikan watchdog establishment sepenuhnya.
   */
  establishmentTimeoutMs?: number;
}

type Timer = ReturnType<typeof setTimeout>;

/**
 * Pemantau kesehatan koneksi ICE untuk satu peer:
 * - 'failed' → restart segera (attempt pertama tanpa delay);
 * - 'disconnected' yang bertahan melewati masa tenggang → restart;
 * - watchdog establishment (proaktif): arm() memasang timer — bila setelah
 *   establishmentTimeoutMs (default 15 dtk) koneksi MASIH 'new'/'connecting'
 *   (belum pernah mencapai hasil), restart dieksekusi lewat jalur backoff
 *   yang sama. Menutup celah handler reaktif murni: koneksi yang nyangkut
 *   selamanya tanpa perubahan state tidak memicu apa pun (bukti e2e: outlier
 *   pembentukan koneksi 35,6 dtk). Tiap restart memasang watchdog baru
 *   (percobaan establishment segar); 'connected' melucutinya;
 *   establishmentTimeoutMs ≤ 0 mematikan fitur;
 * - backoff eksponensial antar percobaan (0 → base → 2×base → …);
 * - setelah maxAttempts tanpa perbaikan → onGiveUp (peer dianggap mati).
 *
 * observe() dipanggil setiap connectionstatechange/iceconnectionstatechange.
 * arm() dipanggil pemilik peer saat percobaan pembentukan koneksi dimulai
 * (sisi inisiator saja — lihat PeerConnectionManager.addPeer).
 */
export class IceRestartHandler {
  private readonly options: IceRestartHandlerOptions;
  private readonly disconnectedGraceMs: number;
  private readonly baseDelayMs: number;
  private readonly maxDelayMs: number;
  private readonly maxAttempts: number;
  private readonly establishmentTimeoutMs: number;
  private attempts = 0;
  private disconnectedTimer: Timer | null = null;
  private restartTimer: Timer | null = null;
  private establishmentTimer: Timer | null = null;
  private finished = false;

  constructor(options: IceRestartHandlerOptions) {
    this.options = options;
    this.disconnectedGraceMs = options.disconnectedGraceMs ?? 5_000;
    this.baseDelayMs = options.baseDelayMs ?? 2_000;
    this.maxDelayMs = options.maxDelayMs ?? 30_000;
    this.maxAttempts = options.maxAttempts ?? 3;
    this.establishmentTimeoutMs = options.establishmentTimeoutMs ?? 15_000;
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
      this.clearEstablishmentTimer(); // sukses → watchdog establishment dilucuti
      this.clearRestartTimer(); // audit 23-b M5: pulih cepat → restart terjadwal DIBATALKAN
      this.attempts = 0; // pulih → reset hitungan backoff
      return;
    }
    if (connection === 'closed') {
      this.close();
    }
  }

  /**
   * Memasang watchdog pembentukan koneksi (establishment): bila setelah
   * establishmentTimeoutMs koneksi masih 'new'/'connecting', restart
   * dieksekusi lewat jalur backoff/give-up yang sama. No-op bila handler
   * sudah selesai (finished), timer sedang berjalan, atau watchdog
   * dinonaktifkan (establishmentTimeoutMs ≤ 0).
   */
  arm(): void {
    if (this.finished || this.establishmentTimer !== null || this.establishmentTimeoutMs <= 0) {
      return;
    }
    this.establishmentTimer = setTimeout(() => {
      this.establishmentTimer = null;
      if (this.finished) {
        return;
      }
      const connection = this.options.getConnectionState();
      // Hanya pembentukan yang nyangkut yang dieskalasi. 'connected' = sukses,
      // 'disconnected' punya jalur masa tenggangnya sendiri, 'failed'/'closed'
      // punya jalur reaktifnya — semuanya TIDAK boleh direstart oleh timer ini.
      if (connection === 'new' || connection === 'connecting') {
        // establishment belum selesai
        this.scheduleRestart();
      }
    }, this.establishmentTimeoutMs);
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
    // Restart menggantikan pengawasan establishment yang mungkin masih
    // pending (mis. pemicu reaktif 'failed'/'disconnected' saat armed) —
    // timer segar dipasang ulang di bawah saat onRestart benar-benar menyala.
    this.clearEstablishmentTimer();
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
      // Restart = awal percobaan establishment baru → pasang watchdog kembali
      // (no-op bila finished / masih berjalan / dinonaktifkan).
      this.arm();
    }, delay);
  }

  private clearDisconnectedTimer(): void {
    if (this.disconnectedTimer !== null) {
      clearTimeout(this.disconnectedTimer);
      this.disconnectedTimer = null;
    }
  }

  private clearEstablishmentTimer(): void {
    if (this.establishmentTimer !== null) {
      clearTimeout(this.establishmentTimer);
      this.establishmentTimer = null;
    }
  }

  /** Audit 23-b M5: pulih ke 'connected' harus membatalkan restart yang
   * sudah terjadwal — tanpa ini makeOffer({iceRestart}) menyobek koneksi
   * yang justru baru sehat (gap audio terdengar + renegosiasi sia-sia). */
  private clearRestartTimer(): void {
    if (this.restartTimer !== null) {
      clearTimeout(this.restartTimer);
      this.restartTimer = null;
    }
  }

  /** Hentikan pemantauan (peer ditutup normal). */
  close(): void {
    this.finished = true;
    this.clearDisconnectedTimer();
    this.clearEstablishmentTimer();
    this.clearRestartTimer();
  }
}
