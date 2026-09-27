import {
  DEFAULT_BITRATE_TIERS,
  DISCONNECTED_GRACE_MS,
  type AdaptiveRtpParameters,
  type AdaptiveRtpSenderLike,
  type BitrateTier,
} from './types';

type Timer = ReturnType<typeof setTimeout>;

export interface BitrateAdaptationOptions {
  /**
   * Sumber sender milik sebuah peer (biasanya dibungkus dari
   * PeerConnectionManager.getSendersOf — RTCRtpSender asli assignable ke
   * bentuk longgar ini). Mengembalikan array kosong bila peer tidak dikenal.
   */
  getSenders: (sessionId: string) => AdaptiveRtpSenderLike[];
  /** Override nilai bps per tier (untuk eksperimen harness). */
  tiers?: Partial<Record<BitrateTier, number>>;
  /** Tenggang disconnected sebelum turun ke medium (default 5 detik). */
  disconnectedGraceMs?: number;
  /** Laporan kegagalan setParameters (tidak fatal — tier akan di-reset agar retry). */
  onError?: (sessionId: string, context: string, error: unknown) => void;
}

interface SessionAdaptation {
  tier: BitrateTier | null;
  graceTimer: Timer | null;
}

/**
 * Adaptasi bitrate Opus per peer berdasar state koneksi:
 *
 *   connected              → high (50 kbps)
 *   disconnected 5 detik   → medium (24 kbps) — kecuali sedang low
 *   failed                 → low (12 kbps)
 *   pulih ke connected     → high kembali
 *
 * - hanya menyentuh sender audio (sender.track?.kind === 'audio');
 * - setParameters dipanggil hanya saat tier BERUBAH (dedupe — Chrome tidak
 *   suka parameter yang di-set berulang kali);
 * - kegagalan setParameters me-reset tier sehingga observe berikutnya retry;
 * - grace timer 5 detik selaras dengan tenggang disconnected IceRestartHandler.
 *
 * Sumber state: event connectionState dari PeerConnectionManager/host —
 * kelas ini sendiri tidak berlangganan ke apa pun (murni reaktif via observe).
 */
export class BitrateAdaptation {
  private readonly getSenders: BitrateAdaptationOptions['getSenders'];
  private readonly tiers: Readonly<Record<BitrateTier, number>>;
  private readonly graceMs: number;
  private readonly onError?: BitrateAdaptationOptions['onError'];
  private readonly sessions = new Map<string, SessionAdaptation>();

  constructor(options: BitrateAdaptationOptions) {
    this.getSenders = options.getSenders;
    this.tiers = { ...DEFAULT_BITRATE_TIERS, ...options.tiers };
    this.graceMs = options.disconnectedGraceMs ?? DISCONNECTED_GRACE_MS;
    this.onError = options.onError;
  }

  /** Tier yang sedang aktif untuk peer (null = belum pernah diterapkan). */
  currentTier(sessionId: string): BitrateTier | null {
    return this.sessions.get(sessionId)?.tier ?? null;
  }

  /**
   * Memberi tahu perubahan state koneksi peer (RTCPeerConnectionState).
   * Aman dipanggil untuk sessionId tak dikenal — tidak ada sender, tidak ada efek.
   */
  observe(sessionId: string, connectionState: RTCPeerConnectionState): void {
    switch (connectionState) {
      case 'connected':
        this.clearGrace(sessionId);
        this.setTier(sessionId, 'high');
        break;
      case 'disconnected':
        this.startGrace(sessionId);
        break;
      case 'failed':
        this.clearGrace(sessionId);
        this.setTier(sessionId, 'low');
        break;
      case 'closed':
        // Peer mati — tier dipertahankan untuk query; host memanggil close().
        this.clearGrace(sessionId);
        break;
      default:
        // 'new' | 'connecting' — tunggu hasil akhirnya.
        this.clearGrace(sessionId);
        break;
    }
  }

  /**
   * Menerapkan ulang tier yang tersimpan ke sender peer — panggil setelah
   * track mikrofon baru dipasang (sender baru tidak otomatis dapat maxBitrate).
   */
  applyCurrentTier(sessionId: string): void {
    const tier = this.sessions.get(sessionId)?.tier;
    if (tier !== null && tier !== undefined) {
      this.applyTierTo(sessionId, tier);
    }
  }

  /** Menghentikan timer + menghapus state satu peer (dipanggil saat peer-left). */
  close(sessionId: string): void {
    this.clearGrace(sessionId);
    this.sessions.delete(sessionId);
  }

  /** Menghentikan semua timer + menghapus seluruh state. */
  closeAll(): void {
    for (const sessionId of [...this.sessions.keys()]) {
      this.close(sessionId);
    }
  }

  // ============================================================
  // Internal
  // ============================================================

  private ensureSession(sessionId: string): SessionAdaptation {
    let session = this.sessions.get(sessionId);
    if (session === undefined) {
      session = { tier: null, graceTimer: null };
      this.sessions.set(sessionId, session);
    }
    return session;
  }

  private clearGrace(sessionId: string): void {
    const session = this.sessions.get(sessionId);
    if (session?.graceTimer !== null && session?.graceTimer !== undefined) {
      clearTimeout(session.graceTimer);
      session.graceTimer = null;
    }
  }

  private startGrace(sessionId: string): void {
    const session = this.ensureSession(sessionId);
    if (session.graceTimer !== null) {
      return; // tenggang sudah berjalan — jangan restart
    }
    session.graceTimer = setTimeout(() => {
      const current = this.sessions.get(sessionId);
      if (current === undefined) {
        return;
      }
      current.graceTimer = null;
      // Jangan naikkan tier: bila sedang low (pernah failed), tetap low.
      if (current.tier !== 'low') {
        this.setTier(sessionId, 'medium');
      }
    }, this.graceMs);
  }

  private setTier(sessionId: string, tier: BitrateTier): void {
    const session = this.ensureSession(sessionId);
    if (session.tier === tier) {
      return; // dedupe: hanya tulis parameter saat tier berubah
    }
    session.tier = tier;
    this.applyTierTo(sessionId, tier);
  }

  private applyTierTo(sessionId: string, tier: BitrateTier): void {
    const maxBitrate = this.tiers[tier];
    for (const sender of this.getSenders(sessionId)) {
      if (sender.track?.kind !== 'audio') {
        continue; // video/null-track tidak disentuh
      }
      const parameters: AdaptiveRtpParameters = sender.getParameters();
      if (parameters.encodings === undefined || parameters.encodings.length === 0) {
        parameters.encodings = [{}];
      }
      const encoding = parameters.encodings[0];
      if (encoding !== undefined) {
        encoding.maxBitrate = maxBitrate;
      }
      sender.setParameters(parameters).catch((error: unknown) => {
        // Gagal (mis. negotiation sedang berjalan) — reset tier supaya
        // observe berikutnya mencoba lagi.
        const session = this.sessions.get(sessionId);
        if (session !== undefined && session.tier === tier) {
          session.tier = null;
        }
        this.onError?.(sessionId, 'set-parameters', error);
      });
    }
  }
}
