import { describe, expect, it, vi } from 'vitest';
import { AudioListenerSync } from './audio-listener-sync';
import { FakeAudioListener } from './test-utils';

describe('AudioListenerSync — jalur modern', () => {
  it('update menerapkan posisi pada bidang x-z dan orientasi dari yaw', () => {
    const listener = new FakeAudioListener();
    const sync = new AudioListenerSync(listener);

    sync.update({ x: 3, y: 4 }, Math.PI / 2);

    expect(listener.positionX?.value).toBe(3);
    expect(listener.positionY?.value).toBe(0);
    expect(listener.positionZ?.value).toBe(-4);
    expect(listener.forwardX?.value).toBeCloseTo(1);
    expect(listener.forwardY?.value).toBe(0);
    expect(listener.forwardZ?.value).toBeCloseTo(0);
    expect(listener.upX?.value).toBe(0);
    expect(listener.upY?.value).toBe(1);
    expect(listener.upZ?.value).toBe(0);
  });

  it('update tanpa yaw tidak menyentuh orientasi', () => {
    const listener = new FakeAudioListener();
    const sync = new AudioListenerSync(listener);

    sync.update({ x: 1, y: 1 });

    expect(listener.positionX?.value).toBe(1);
    expect(listener.forwardX?.value).toBe(0);
    expect(listener.forwardZ?.value).toBe(0);
  });

  it('setYaw hanya mengubah orientasi, bukan posisi', () => {
    const listener = new FakeAudioListener();
    const sync = new AudioListenerSync(listener);
    sync.update({ x: 7, y: -2 }, 0);

    sync.setYaw(Math.PI);

    expect(listener.positionX?.value).toBe(7);
    expect(listener.positionZ?.value).toBe(2);
    expect(listener.forwardZ?.value).toBeCloseTo(1);
  });

  it('posisi di luar batas dunia dikunci sebelum diterapkan', () => {
    const listener = new FakeAudioListener();
    const sync = new AudioListenerSync(listener);

    sync.update({ x: 1e9, y: 0 });

    expect(listener.positionX?.value).toBe(10_000);
  });

  it('getLastPosition mengembalikan salinan (mutasi aman)', () => {
    const listener = new FakeAudioListener();
    const sync = new AudioListenerSync(listener);

    sync.update({ x: 1.5, y: 2.5 });
    const snapshot = sync.getLastPosition();
    if (snapshot === null) {
      throw new Error('posisi hilang setelah update');
    }
    snapshot.x = 999;

    expect(sync.getLastPosition()).toEqual({ x: 1.5, y: 2.5 });
    expect(sync.getLastPosition()).not.toBe(snapshot);
  });

  it('getLastPosition/getLastYaw null sebelum ada pemanggilan', () => {
    const sync = new AudioListenerSync(new FakeAudioListener());

    expect(sync.getLastPosition()).toBeNull();
    expect(sync.getLastYaw()).toBeNull();
  });

  it('pemanggilan berulang bersifat idempoten', () => {
    const listener = new FakeAudioListener();
    const sync = new AudioListenerSync(listener);

    sync.update({ x: 1, y: 1 }, 0.5);
    sync.update({ x: 1, y: 1 }, 0.5);

    expect(listener.positionX?.value).toBe(1);
    expect(listener.forwardX?.value).toBeCloseTo(Math.sin(0.5));
  });

  it('onApplyResult melaporkan jalur yang dipakai', () => {
    const listener = new FakeAudioListener();
    const onApplyResult = vi.fn();
    const sync = new AudioListenerSync(listener, { onApplyResult });

    sync.update({ x: 0, y: 0 }, 1);

    expect(onApplyResult).toHaveBeenCalledWith('position', 'modern');
    expect(onApplyResult).toHaveBeenCalledWith('orientation', 'modern');
  });
});

describe('AudioListenerSync — tahan-NaN (13-b)', () => {
  it('setYaw NaN dilewati: orientasi + lastYaw terakhir yang valid dipertahankan', () => {
    const listener = new FakeAudioListener();
    const sync = new AudioListenerSync(listener);
    sync.update({ x: 1, y: 1 }, Math.PI / 2); // menghadap timur

    sync.setYaw(Number.NaN);

    expect(sync.getLastYaw()).toBe(Math.PI / 2);
    expect(listener.forwardX?.value).toBeCloseTo(1); // masih timur
  });

  it('setYaw ±Infinity juga dilewati', () => {
    const listener = new FakeAudioListener();
    const sync = new AudioListenerSync(listener);
    sync.setYaw(0.5);

    sync.setYaw(Number.POSITIVE_INFINITY);
    sync.setYaw(Number.NEGATIVE_INFINITY);

    expect(sync.getLastYaw()).toBe(0.5);
    expect(listener.forwardX?.value).toBeCloseTo(Math.sin(0.5));
  });

  it('update dengan yaw NaN tetap menerapkan posisi (orientasi dipertahankan)', () => {
    const listener = new FakeAudioListener();
    const sync = new AudioListenerSync(listener);
    sync.update({ x: 1, y: 1 }, 1);

    sync.update({ x: 5, y: 6 }, Number.NaN);

    expect(listener.positionX?.value).toBe(5);
    expect(listener.positionZ?.value).toBe(-6);
    expect(sync.getLastYaw()).toBe(1);
  });

  it('update dengan posisi NaN → komponen NaN jadi 0 (via sanitizePosition tahan-NaN)', () => {
    const listener = new FakeAudioListener();
    const sync = new AudioListenerSync(listener);

    sync.update({ x: Number.NaN, y: 2 });

    expect(listener.positionX?.value).toBe(0);
    expect(listener.positionZ?.value).toBe(-2);
  });

  it('yaw valid pertama tetap diterapkan normal setelah beberapa sampah dilewati', () => {
    const listener = new FakeAudioListener();
    const sync = new AudioListenerSync(listener);
    sync.setYaw(Number.NaN);

    sync.setYaw(Math.PI);

    expect(sync.getLastYaw()).toBe(Math.PI);
    expect(listener.forwardZ?.value).toBeCloseTo(1); // selatan
  });
});

describe('AudioListenerSync — jalur legacy (browser lama)', () => {
  it('memakai setPosition + setOrientation', () => {
    const listener = new FakeAudioListener({ legacy: true });
    const sync = new AudioListenerSync(listener);

    sync.update({ x: 3, y: 4 }, Math.PI / 2);

    expect(listener.setPositionCalls).toEqual([[3, 0, -4]]);
    expect(listener.setOrientationCalls).toHaveLength(1);
    const orientation = listener.setOrientationCalls[0];
    expect(orientation?.[0]).toBeCloseTo(1); // forwardX: timur
    expect(orientation?.[2]).toBeCloseTo(0); // forwardZ
    expect(orientation?.[4]).toBe(1); // upY
  });

  it('onApplyResult melaporkan legacy', () => {
    const listener = new FakeAudioListener({ legacy: true });
    const onApplyResult = vi.fn();
    const sync = new AudioListenerSync(listener, { onApplyResult });

    sync.update({ x: 0, y: 0 });

    expect(onApplyResult).toHaveBeenCalledWith('position', 'legacy');
  });
});
