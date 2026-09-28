/**
 * API publik lapisan audio spasial (Fase 1 — tanpa UI).
 * Dipakai test harness (F1.6) dan nanti UI ruang suara (Fase 3).
 */
export { AudioListenerSync, type AudioListenerSyncOptions } from './audio-listener-sync';
export { BitrateAdaptation, type BitrateAdaptationOptions } from './bitrate-adaptation';
export {
  assertValidStatsSample,
  decideBitrateTier,
  MIN_STATS_SAMPLES,
  STATS_JITTER_MEDIUM_MS,
  STATS_LOSS_LOW,
  STATS_LOSS_MEDIUM,
  type BitrateStatsSample,
} from './bitrate-decision';
export {
  SpatialAudioEngine,
  defaultAudioContextFactory,
  type AudioContextFactory,
  type SpatialAudioEngineOptions,
} from './spatial-audio-engine';
export {
  BITRATE_HIGH_BPS,
  BITRATE_LOW_BPS,
  BITRATE_MEDIUM_BPS,
  DEFAULT_BITRATE_TIERS,
  DISCONNECTED_GRACE_MS,
  PANNER_DISTANCE_MODEL,
  PANNER_MAX_DISTANCE,
  PANNER_PANNING_MODEL,
  PANNER_REF_DISTANCE,
  PANNER_ROLLOFF_FACTOR,
  applySpatialOrientation,
  applySpatialPosition,
  orientationFromYaw,
  sanitizePosition,
  worldToAudioXYZ,
  type AdaptiveRtpParameters,
  type AdaptiveRtpSenderLike,
  type AudioXYZ,
  type BitrateTier,
  type OrientationVectors,
  type SpatialApplyResult,
  type SpatialAudioParamLike,
  type SpatialListenerLike,
  type SpatialOrientationNode,
  type SpatialPositionNode,
} from './types';
