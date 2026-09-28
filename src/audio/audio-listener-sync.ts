import type { Position } from '../webrtc/types';
import {
  applySpatialOrientation,
  applySpatialPosition,
  orientationFromYaw,
  sanitizePosition,
  worldToAudioXYZ,
  type SpatialApplyResult,
  type SpatialListenerLike,
} from './types';

export interface AudioListenerSyncOptions {
  /** Laporan metrik per penerapan: jalur mana yang dipakai listener. */
  onApplyResult?: (what: 'position' | 'orientation', result: SpatialApplyResult) => void;
}

/**
 * Sinkronisasi posisi + orientasi "telinga" lokal (AudioListener tunggal milik
 * AudioContext) dari koordinat dunia 2D + sudut yaw.
 *
 * - posisi dunia (x, y) dipetakan ke bidang x-z (lihat konvensi di types.ts);
 * - yaw 0 = menghadap utara, bertambah searah jarum jam;
 * - memakai AudioParam modern bila ada, fallback setPosition/setOrientation.
 *
 * Kelas ini tidak punya timer — host (harness F1.6 / UI Fase 3) memanggil
 * update() setiap posisi lokal berubah (frekuensi yang sama dengan posisi
 * yang dikirim ke peer).
 */
export class AudioListenerSync {
  private readonly listener: SpatialListenerLike;
  private readonly onApplyResult?: AudioListenerSyncOptions['onApplyResult'];
  private lastPosition: Position | null = null;
  private lastYaw: number | null = null;

  constructor(listener: SpatialListenerLike, options: AudioListenerSyncOptions = {}) {
    this.listener = listener;
    this.onApplyResult = options.onApplyResult;
  }

  /** Posisi lokal terakhir yang diterapkan (sudah dikunci batas dunia). */
  getLastPosition(): Position | null {
    return this.lastPosition === null ? null : { ...this.lastPosition };
  }

  /** Yaw terakhir (radian) yang diterapkan, null bila belum pernah diatur. */
  getLastYaw(): number | null {
    return this.lastYaw;
  }

  /**
   * Memperbarui posisi listener; bila yaw diberikan, orientasi juga diperbarui.
   * Pemanggilan berulang aman — penulisan param AudioParam bersifat idempoten.
   */
  update(position: Position, yawRadians?: number): void {
    const sanitized = sanitizePosition(position);
    this.lastPosition = sanitized;
    const xyz = worldToAudioXYZ(sanitized);
    // PENTING: hasil diterapkan dulu, callback opsional belakangan —
    // `onApplyResult?.(…, f())` akan melewatkan evaluasi f() saat callback
    // tidak ada (short-circuit optional chaining).
    const result = applySpatialPosition(this.listener, xyz.x, xyz.y, xyz.z);
    this.onApplyResult?.('position', result);
    if (yawRadians !== undefined) {
      this.setYaw(yawRadians);
    }
  }

  /**
   * Memperbarui orientasi saja (posisi tidak disentuh).
   *
   * Tahan-NaN (Task 13-b): yaw non-finite (NaN/±Infinity dari bug host)
   * DILEWATI sepenuhnya — tidak ada substitusi netral yang berarti untuk
   * orientasi (snap ke utara = lompatan audible), jadi orientasi terakhir
   * yang valid dipertahankan dan `lastYaw` tidak dicemari. Di Chromium
   * penulisan AudioParam non-finite melempar TypeError keras (probe
   * empiris 13-b) — skip juga mencegah crash itu. Posisi tetap diproses
   * normal oleh `update()` lewat `sanitizePosition` yang tahan-NaN.
   */
  setYaw(yawRadians: number): void {
    if (!Number.isFinite(yawRadians)) {
      return;
    }
    this.lastYaw = yawRadians;
    const result = applySpatialOrientation(this.listener, orientationFromYaw(yawRadians));
    this.onApplyResult?.('orientation', result);
  }
}
