import type { RealtimeChannel } from '@supabase/supabase-js';
import { SIGNAL_EVENT, SignalMessageSchema, type SignalMessage } from './types';

export interface SignalingClientOptions {
  channel: RealtimeChannel;
  selfSessionId: string;
  /** Dipanggil untuk pesan valid yang ditujukan kepada kita. */
  onMessage: (message: SignalMessage) => void;
  /** Dipanggil untuk payload broadcast yang gagal validasi (untuk metrik). */
  onInvalid?: (reason: string) => void;
  /** Dipanggil bila pengiriman broadcast tidak 'ok' (untuk metrik). */
  onSendError?: (response: string) => void;
}

/**
 * Kanal signaling WebRTC di atas Supabase Realtime broadcast (event 'signal').
 *
 * - Semua payload masuk divalidasi Zod; yang gugur dilaporkan ke onInvalid.
 * - Pesan echo diri sendiri dan pesan untuk sessionId lain disaring.
 * - unbind() hanya menetralkan handler (RealtimeChannel tidak punya off());
 *   pembersihan sesungguhnya lewat unsubscribe()/removeChannel() milik channel.
 */
export class SignalingClient {
  private readonly channel: RealtimeChannel;
  private readonly selfSessionId: string;
  private readonly onMessage: (message: SignalMessage) => void;
  private readonly onInvalid?: (reason: string) => void;
  private readonly onSendError?: (response: string) => void;
  private active = false;
  /**
   * Handler hanya boleh terpasang SEKALI per channel — RealtimeChannel tidak
   * punya off(), jadi bind() ulang pasca unbind() tanpa guard ini akan
   * mendaftarkan handler kedua dan setiap pesan diproses GANDA (bug tertangkap
   * test 11-c). unbind() menetralkan lewat `active`, bukan melepas handler.
   */
  private handlerAttached = false;

  constructor(options: SignalingClientOptions) {
    this.channel = options.channel;
    this.selfSessionId = options.selfSessionId;
    this.onMessage = options.onMessage;
    this.onInvalid = options.onInvalid;
    this.onSendError = options.onSendError;
  }

  private readonly handleBroadcast = (payload: unknown): void => {
    if (!this.active) {
      return;
    }
    const wrapper = payload as { payload?: unknown } | null;
    if (wrapper === null || typeof wrapper !== 'object') {
      this.onInvalid?.('payload broadcast bukan objek');
      return;
    }
    const parsed = SignalMessageSchema.safeParse(wrapper.payload);
    if (!parsed.success) {
      this.onInvalid?.(
        parsed.error.issues
          .map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`)
          .join('; '),
      );
      return;
    }
    const message = parsed.data;
    if (message.from === this.selfSessionId) {
      return; // echo pesan sendiri
    }
    if (message.to !== this.selfSessionId && message.to !== '*') {
      return; // bukan untuk kita
    }
    this.onMessage(message);
  };

  /** Mulai mendengarkan broadcast signaling (idempoten, aman dipanggil ulang). */
  bind(): void {
    if (this.active) {
      return;
    }
    this.active = true;
    if (this.handlerAttached) {
      return; // handler masih terpasang dari bind() sebelumnya — cukup aktifkan lagi
    }
    this.handlerAttached = true;
    this.channel.on('broadcast', { event: SIGNAL_EVENT }, (payload) =>
      this.handleBroadcast(payload),
    );
  }

  /** Berhenti memproses pesan masuk. */
  unbind(): void {
    this.active = false;
  }

  /** Mengirim satu pesan signaling (fire-and-forget, error dilaporkan asinkron). */
  send(message: SignalMessage): void {
    if (!this.active) {
      return;
    }
    void this.channel
      .send({ type: 'broadcast', event: SIGNAL_EVENT, payload: message })
      .then((response) => {
        if (response !== 'ok') {
          this.onSendError?.(response);
        }
      })
      .catch((error: unknown) => {
        this.onSendError?.(String(error));
      });
  }
}
