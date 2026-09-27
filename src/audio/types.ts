import { clampPosition, type Position } from '../webrtc/types';

// ============================================================
// Konstanta spasial (PannerNode)
// ============================================================

/** Model panning binaural — inti dari spatial audio (headphone). */
export const PANNER_PANNING_MODEL: PanningModelType = 'HRTF';

/** Model atenuasi jarak: 1/refDistance pada jarak dekat, meluruh makin jauh. */
export const PANNER_DISTANCE_MODEL: DistanceModelType = 'inverse';

/** Jarak (satuan dunia) tempat gain masih penuh. */
export const PANNER_REF_DISTANCE = 1;

/** Jarak maksimum yang dianggap; di luar ini gain dihitung pada maxDistance. */
export const PANNER_MAX_DISTANCE = 10_000;

/** Laju peluruhan gain terhadap jarak. */
export const PANNER_ROLLOFF_FACTOR = 1;

// ============================================================
// Adaptasi bitrate Opus (sender)
// ============================================================

/** Tier bitrate saat koneksi sehat — Opus 50 kbps cukup untuk musik ringan. */
export const BITRATE_HIGH_BPS = 50_000;

/** Tier setelah tenggang disconnected habis — suara tetap jernih. */
export const BITRATE_MEDIUM_BPS = 24_000;

/** Tier darurat saat koneksi buruk — prioritas keberlanjutan suara. */
export const BITRATE_LOW_BPS = 12_000;

export type BitrateTier = 'high' | 'medium' | 'low';

export const DEFAULT_BITRATE_TIERS: Readonly<Record<BitrateTier, number>> = {
  high: BITRATE_HIGH_BPS,
  medium: BITRATE_MEDIUM_BPS,
  low: BITRATE_LOW_BPS,
};

/** Tenggang sebelum tier turun ke 'medium' saat state disconnected. */
export const DISCONNECTED_GRACE_MS = 5_000;

// ============================================================
// Konvensi ruang: dunia 2D (x, y) → audio 3D (x, y, z)
// ============================================================

/**
 * Dunia permainan datar (x ke kanan/timur, y ke atas/utara pada peta).
 * Web Audio memakai sistem tangan kanan: x kanan, y ke atas langit-langit,
 * z ke arah listener default. Pemetaan yang dipilih menaruh "lantai" dunia
 * pada bidang x-z: utara (y+) menjadi -z (depan listener yaw 0).
 */
export interface AudioXYZ {
  x: number;
  y: number;
  z: number;
}

export function worldToAudioXYZ(position: Position): AudioXYZ {
  return { x: position.x, y: 0, z: -position.y };
}

/** Vektor arah pandang dari sudut yaw (radian, 0 = utara, searah jarum jam). */
export interface OrientationVectors {
  forwardX: number;
  forwardY: number;
  forwardZ: number;
  upX: number;
  upY: number;
  upZ: number;
}

export function orientationFromYaw(yawRadians: number): OrientationVectors {
  return {
    forwardX: Math.sin(yawRadians),
    forwardY: 0,
    forwardZ: -Math.cos(yawRadians),
    upX: 0,
    upY: 1,
    upZ: 0,
  };
}

// ============================================================
// Helper posisi/orientasi node spasial (jalur modern + legacy)
// ============================================================

/** Bentuk struktural AudioParam yang dipakai helper spasial — cukup `value`. */
export interface SpatialAudioParamLike {
  value: number;
}

/**
 * Bentuk struktural anggota posisi yang dimiliki PannerNode maupun
 * AudioListener. AudioParam modern (positionX/Y/Z) dipakai bila ada;
 * bila tidak (Safari lama), fallback ke setPosition yang deprecated
 * tapi masih didukung semua browser besar.
 */
export interface SpatialPositionNode {
  positionX?: SpatialAudioParamLike;
  positionY?: SpatialAudioParamLike;
  positionZ?: SpatialAudioParamLike;
  setPosition?(x: number, y: number, z: number): void;
}

/** Hasil penerapan posisi/orientasi: jalur AudioParam modern, legacy, atau tidak tersedia. */
export type SpatialApplyResult = 'modern' | 'legacy' | 'none';

/**
 * Mengatur posisi node spasial — jalur AudioParam modern dipakai bila lengkap,
 * fallback ke setPosition bila tidak.
 */
export function applySpatialPosition(
  node: SpatialPositionNode,
  x: number,
  y: number,
  z: number,
): SpatialApplyResult {
  const { positionX, positionY, positionZ } = node;
  if (positionX !== undefined && positionY !== undefined && positionZ !== undefined) {
    positionX.value = x;
    positionY.value = y;
    positionZ.value = z;
    return 'modern';
  }
  if (typeof node.setPosition === 'function') {
    node.setPosition(x, y, z);
    return 'legacy';
  }
  return 'none';
}

/**
 * Bentuk struktural anggota orientasi — hanya relevan untuk AudioListener
 * (voice peer bersifat omnidirectional, tanpa cone arah).
 */
export interface SpatialOrientationNode {
  forwardX?: SpatialAudioParamLike;
  forwardY?: SpatialAudioParamLike;
  forwardZ?: SpatialAudioParamLike;
  upX?: SpatialAudioParamLike;
  upY?: SpatialAudioParamLike;
  upZ?: SpatialAudioParamLike;
  setOrientation?(
    forwardX: number,
    forwardY: number,
    forwardZ: number,
    upX: number,
    upY: number,
    upZ: number,
  ): void;
}

/** Gabungan kemampuan listener yang dibutuhkan AudioListenerSync. */
export interface SpatialListenerLike extends SpatialPositionNode, SpatialOrientationNode {}

/**
 * Mengatur orientasi listener — jalur modern atau fallback setOrientation.
 */
export function applySpatialOrientation(
  node: SpatialOrientationNode,
  vectors: OrientationVectors,
): SpatialApplyResult {
  const { forwardX, forwardY, forwardZ, upX, upY, upZ } = node;
  if (
    forwardX !== undefined &&
    forwardY !== undefined &&
    forwardZ !== undefined &&
    upX !== undefined &&
    upY !== undefined &&
    upZ !== undefined
  ) {
    forwardX.value = vectors.forwardX;
    forwardY.value = vectors.forwardY;
    forwardZ.value = vectors.forwardZ;
    upX.value = vectors.upX;
    upY.value = vectors.upY;
    upZ.value = vectors.upZ;
    return 'modern';
  }
  if (typeof node.setOrientation === 'function') {
    node.setOrientation(
      vectors.forwardX,
      vectors.forwardY,
      vectors.forwardZ,
      vectors.upX,
      vectors.upY,
      vectors.upZ,
    );
    return 'legacy';
  }
  return 'none';
}

/** Posisi dunia yang sudah dikunci batas — dipakai lapisan audio sebagai pertahanan kedua. */
export function sanitizePosition(position: Position): Position {
  return clampPosition(position);
}

// ============================================================
// Bentuk longgar parameter sender RTP (untuk adaptasi bitrate)
// ============================================================

/**
 * Typing DOM memisahkan RTCRtpParameters (hasil getParameters, TANPA
 * encodings di tipe) dari RTCRtpSendParameters (input setParameters).
 * Objek yang diputar balik dari getParameters() ke setParameters() di
 * praktik membawa encodings — bentuk longgar ini mengakui kenyataan itu
 * sekaligus membuat fake test assignable tanpa cast.
 */
export interface AdaptiveRtpParameters {
  encodings?: Array<{ maxBitrate?: number }>;
  transactionId?: string;
  codecs?: unknown;
  headerExtensions?: unknown;
  rtcp?: unknown;
}

/** Kemampuan sender yang dibutuhkan BitrateAdaptation (structural). */
export interface AdaptiveRtpSenderLike {
  readonly track: MediaStreamTrack | null;
  getParameters(): AdaptiveRtpParameters;
  setParameters(params: AdaptiveRtpParameters): Promise<void>;
}
