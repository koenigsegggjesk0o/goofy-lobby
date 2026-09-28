import { describe, expect, it } from 'vitest';
import { WORLD_BOUND } from '../webrtc/types';
import {
  DEFAULT_BITRATE_TIERS,
  applySpatialOrientation,
  applySpatialPosition,
  orientationFromYaw,
  sanitizePosition,
  worldToAudioXYZ,
} from './types';
import { FakeAudioListener, FakeAudioParam, FakePannerNode } from './test-utils';

describe('audio/types — pemetaan dunia → audio 3D', () => {
  it('worldToAudioXYZ menaruh lantai dunia pada bidang x-z', () => {
    expect(worldToAudioXYZ({ x: 5, y: 10 })).toEqual({ x: 5, y: 0, z: -10 });
    expect(worldToAudioXYZ({ x: -3, y: -7 })).toEqual({ x: -3, y: 0, z: 7 });
  });

  it('orientationFromYaw: yaw 0 menghadap utara (-z), naik searah jarum jam', () => {
    expect(orientationFromYaw(0)).toEqual({
      forwardX: 0,
      forwardY: 0,
      forwardZ: -1,
      upX: 0,
      upY: 1,
      upZ: 0,
    });
  });

  it('orientationFromYaw: timur, selatan, barat', () => {
    const east = orientationFromYaw(Math.PI / 2);
    expect(east.forwardX).toBeCloseTo(1);
    expect(east.forwardZ).toBeCloseTo(0);
    const south = orientationFromYaw(Math.PI);
    expect(south.forwardX).toBeCloseTo(0);
    expect(south.forwardZ).toBeCloseTo(1);
    const west = orientationFromYaw(-Math.PI / 2);
    expect(west.forwardX).toBeCloseTo(-1);
    expect(west.forwardZ).toBeCloseTo(0);
  });

  it('orientationFromYaw: vektor up selalu (0,1,0)', () => {
    for (const yaw of [0, 1, 2.5, -3.9]) {
      const vectors = orientationFromYaw(yaw);
      expect(vectors.upX).toBe(0);
      expect(vectors.upY).toBe(1);
      expect(vectors.upZ).toBe(0);
    }
  });
});

describe('audio/types — sanitizePosition (pertahanan kedua)', () => {
  it('mengunci ke batas dunia dan membulatkan 2 desimal', () => {
    expect(sanitizePosition({ x: 1e9, y: -1e9 })).toEqual({ x: WORLD_BOUND, y: -WORLD_BOUND });
    expect(sanitizePosition({ x: 3.14159265, y: 2.718281828 })).toEqual({ x: 3.14, y: 2.72 });
  });

  it('posisi dalam batas tidak berubah nilai', () => {
    expect(sanitizePosition({ x: -12.5, y: 900 })).toEqual({ x: -12.5, y: 900 });
  });

  it('tahan-NaN (13-b): komponen NaN diganti 0, komponen sehat dipertahankan', () => {
    expect(sanitizePosition({ x: Number.NaN, y: 5 })).toEqual({ x: 0, y: 5 });
    expect(sanitizePosition({ x: -3, y: Number.NaN })).toEqual({ x: -3, y: 0 });
    expect(sanitizePosition({ x: Number.NaN, y: Number.NaN })).toEqual({ x: 0, y: 0 });
  });

  it('tahan-NaN (13-b): ±Infinity tetap di-clamp ke batas (bukan 0)', () => {
    expect(sanitizePosition({ x: Number.POSITIVE_INFINITY, y: 2 })).toEqual({
      x: WORLD_BOUND,
      y: 2,
    });
    expect(sanitizePosition({ x: 1, y: Number.NEGATIVE_INFINITY })).toEqual({
      x: 1,
      y: -WORLD_BOUND,
    });
  });
});

describe('audio/types — applySpatialPosition', () => {
  it('jalur modern: menulis AudioParam dan mengembalikan modern', () => {
    const panner = new FakePannerNode();

    const result = applySpatialPosition(panner, 3, 0, -4);

    expect(result).toBe('modern');
    expect(panner.positionX?.value).toBe(3);
    expect(panner.positionY?.value).toBe(0);
    expect(panner.positionZ?.value).toBe(-4);
    expect(panner.setPositionCalls).toHaveLength(0);
  });

  it('jalur legacy: memanggil setPosition dan mengembalikan legacy', () => {
    const panner = new FakePannerNode({ legacy: true });

    const result = applySpatialPosition(panner, 3, 0, -4);

    expect(result).toBe('legacy');
    expect(panner.setPositionCalls).toEqual([[3, 0, -4]]);
  });

  it('node tanpa kedua jalur mengembalikan none tanpa error', () => {
    const broken = { positionX: new FakeAudioParam() }; // positionY/Z hilang, setPosition hilang

    expect(applySpatialPosition(broken, 1, 2, 3)).toBe('none');
  });
});

describe('audio/types — applySpatialOrientation', () => {
  it('jalur modern pada AudioListener', () => {
    const listener = new FakeAudioListener();
    const vectors = orientationFromYaw(Math.PI / 2);

    const result = applySpatialOrientation(listener, vectors);

    expect(result).toBe('modern');
    expect(listener.forwardX?.value).toBeCloseTo(1);
    expect(listener.forwardZ?.value).toBeCloseTo(0);
    expect(listener.upY?.value).toBe(1);
    expect(listener.setOrientationCalls).toHaveLength(0);
  });

  it('jalur legacy pada AudioListener', () => {
    const listener = new FakeAudioListener({ legacy: true });
    const vectors = orientationFromYaw(0);

    const result = applySpatialOrientation(listener, vectors);

    expect(result).toBe('legacy');
    expect(listener.setOrientationCalls).toEqual([[0, 0, -1, 0, 1, 0]]);
  });

  it('node tanpa kedua jalur mengembalikan none', () => {
    expect(applySpatialOrientation({}, orientationFromYaw(0))).toBe('none');
  });
});

describe('audio/types — tier bitrate', () => {
  it('nilai default berurutan high > medium > low', () => {
    expect(DEFAULT_BITRATE_TIERS.high).toBeGreaterThan(DEFAULT_BITRATE_TIERS.medium);
    expect(DEFAULT_BITRATE_TIERS.medium).toBeGreaterThan(DEFAULT_BITRATE_TIERS.low);
    expect(DEFAULT_BITRATE_TIERS).toEqual({ high: 24_000, medium: 20_000, low: 16_000 });
  });

  it('seluruh tier berada dalam rentang main prompt Opus 16–24 kbps (Task 13-b)', () => {
    expect(DEFAULT_BITRATE_TIERS.low).toBeGreaterThanOrEqual(16_000);
    expect(DEFAULT_BITRATE_TIERS.high).toBeLessThanOrEqual(24_000);
  });
});
