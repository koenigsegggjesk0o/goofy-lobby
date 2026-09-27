import { describe, expect, it, vi } from 'vitest';
import { SpatialAudioEngine, type SpatialAudioEngineOptions } from './spatial-audio-engine';
import {
  asAudioContext,
  fakeMediaStream,
  FakeAudioContext,
  FakeGainNode,
  FakeMediaStreamAudioSourceNode,
  FakePannerNode,
} from './test-utils';

function makeEngine(
  contextOptions?: ConstructorParameters<typeof FakeAudioContext>[0],
  engineOptions?: Omit<SpatialAudioEngineOptions, 'createAudioContext'>,
): { engine: SpatialAudioEngine; ctx: FakeAudioContext } {
  const ctx = new FakeAudioContext(contextOptions);
  const engine = new SpatialAudioEngine({
    ...engineOptions,
    createAudioContext: () => asAudioContext(ctx),
  });
  return { engine, ctx };
}

function voiceOf(
  ctx: FakeAudioContext,
  index: number,
): {
  source: FakeMediaStreamAudioSourceNode;
  panner: FakePannerNode;
  gain: FakeGainNode;
} {
  const source = ctx.createdSources[index];
  const panner = ctx.createdPanners[index];
  const gain = ctx.createdGains[0];
  if (source === undefined || panner === undefined || gain === undefined) {
    throw new Error(`node ke-${String(index)} tidak dibuat`);
  }
  return { source, panner, gain };
}

function masterGainOf(ctx: FakeAudioContext): FakeGainNode {
  const gain = ctx.createdGains[0];
  if (gain === undefined) {
    throw new Error('masterGain tidak dibuat');
  }
  return gain;
}

describe('SpatialAudioEngine — konstruksi', () => {
  it('membuat masterGain yang terhubung ke destination', () => {
    const { engine: _engine, ctx } = makeEngine();
    void _engine;

    expect(ctx.createdGains).toHaveLength(1);
    expect(ctx.createdGains[0]?.connectedTo).toContain(ctx.destination);
  });

  it('getter listener tersambung ke listener milik context', () => {
    const { engine, ctx } = makeEngine();

    engine.listener.update({ x: 1, y: 2 }, 0);

    expect(ctx.listener.positionX?.value).toBe(1);
    expect(ctx.listener.positionZ?.value).toBe(-2);
  });

  it('contextState mencerminkan state context', () => {
    const { engine } = makeEngine();
    expect(engine.contextState).toBe('suspended');
  });
});

describe('SpatialAudioEngine — addPeerVoice', () => {
  it('membangun rantai source → panner → masterGain dengan konfigurasi HRTF', () => {
    const { engine, ctx } = makeEngine();
    const stream = fakeMediaStream();

    engine.addPeerVoice('peer-1', stream);

    const { source, panner, gain } = voiceOf(ctx, 0);
    expect(source.mediaStream).toBe(stream);
    expect(source.connectedTo).toContain(panner);
    expect(panner.connectedTo).toContain(gain);
    expect(panner.panningModel).toBe('HRTF');
    expect(panner.distanceModel).toBe('inverse');
    expect(panner.refDistance).toBe(1);
    expect(panner.maxDistance).toBe(10_000);
    expect(panner.rolloffFactor).toBe(1);
    expect(engine.hasPeerVoice('peer-1')).toBe(true);
    expect(engine.peerVoiceIds).toEqual(['peer-1']);
  });

  it('opsi panner kustom menimpa default', () => {
    const { engine, ctx } = makeEngine(undefined, {
      panningModel: 'equalpower',
      refDistance: 5,
      rolloffFactor: 0.5,
    });

    engine.addPeerVoice('peer-1', fakeMediaStream());

    const { panner } = voiceOf(ctx, 0);
    expect(panner.panningModel).toBe('equalpower');
    expect(panner.refDistance).toBe(5);
    expect(panner.rolloffFactor).toBe(0.5);
  });

  it('addPeerVoice ganda untuk session sama melempar error', () => {
    const { engine } = makeEngine();
    engine.addPeerVoice('peer-1', fakeMediaStream());

    expect(() => engine.addPeerVoice('peer-1', fakeMediaStream())).toThrow(/sudah terdaftar/);
  });

  it('addPeerVoice setelah dispose melempar error', async () => {
    const { engine } = makeEngine();
    await engine.dispose();

    expect(() => engine.addPeerVoice('peer-1', fakeMediaStream())).toThrow(/di-dispose/);
  });
});

describe('SpatialAudioEngine — posisi peer', () => {
  it('setPeerPosition setelah suara terdaftar menulis panner pada bidang x-z', () => {
    const { engine, ctx } = makeEngine();
    engine.addPeerVoice('peer-1', fakeMediaStream());

    engine.setPeerPosition('peer-1', { x: 3, y: 4 });

    const { panner } = voiceOf(ctx, 0);
    expect(panner.positionX?.value).toBe(3);
    expect(panner.positionY?.value).toBe(0);
    expect(panner.positionZ?.value).toBe(-4);
  });

  it('posisi yang datang SEBELUM suara disimpan lalu diterapkan saat addPeerVoice', () => {
    const { engine, ctx } = makeEngine();

    engine.setPeerPosition('peer-1', { x: -6, y: 8 });
    engine.addPeerVoice('peer-1', fakeMediaStream());

    const { panner } = voiceOf(ctx, 0);
    expect(panner.positionX?.value).toBe(-6);
    expect(panner.positionZ?.value).toBe(-8);
  });

  it('posisi peer remote di luar batas dunia di-clamp (pertahanan kedua)', () => {
    const { engine, ctx } = makeEngine();
    engine.addPeerVoice('peer-1', fakeMediaStream());

    engine.setPeerPosition('peer-1', { x: 1e9, y: -1e9 });

    const { panner } = voiceOf(ctx, 0);
    expect(panner.positionX?.value).toBe(10_000);
    expect(panner.positionZ?.value).toBe(10_000); // -(-10.000)
  });

  it('getPeerPosition mengembalikan salinan yang di-clamp', () => {
    const { engine } = makeEngine();

    engine.setPeerPosition('peer-1', { x: 1.23456, y: 1e9 });
    const snapshot = engine.getPeerPosition('peer-1');
    if (snapshot === null) {
      throw new Error('posisi hilang setelah setPeerPosition');
    }
    snapshot.x = 999;

    expect(engine.getPeerPosition('peer-1')).toEqual({ x: 1.23, y: 10_000 });
    expect(engine.getPeerPosition('peer-tak-ada')).toBeNull();
  });

  it('setPeerPosition untuk peer tanpa suara hanya menyimpan (tanpa error)', () => {
    const { engine } = makeEngine();

    expect(() => engine.setPeerPosition('peer-2', { x: 1, y: 1 })).not.toThrow();
    expect(engine.getPeerPosition('peer-2')).toEqual({ x: 1, y: 1 });
  });

  it('setPeerPosition setelah dispose melempar error', async () => {
    const { engine } = makeEngine();
    await engine.dispose();

    expect(() => engine.setPeerPosition('peer-1', { x: 1, y: 1 })).toThrow(/di-dispose/);
  });

  it('panner legacy memakai setPosition', () => {
    const { engine, ctx } = makeEngine({ legacyPanner: true });
    engine.addPeerVoice('peer-1', fakeMediaStream());

    engine.setPeerPosition('peer-1', { x: 3, y: 4 });

    const { panner } = voiceOf(ctx, 0);
    expect(panner.setPositionCalls).toEqual([[3, 0, -4]]);
  });
});

describe('SpatialAudioEngine — removePeerVoice', () => {
  it('melepas rantai node dan membersihkan posisi', () => {
    const { engine, ctx } = makeEngine();
    engine.addPeerVoice('peer-1', fakeMediaStream());
    engine.setPeerPosition('peer-1', { x: 1, y: 1 });
    const { source, panner } = voiceOf(ctx, 0);

    engine.removePeerVoice('peer-1');

    expect(source.disconnectCalls).toBe(1);
    expect(panner.disconnectCalls).toBe(1);
    expect(engine.hasPeerVoice('peer-1')).toBe(false);
    expect(engine.getPeerPosition('peer-1')).toBeNull();
  });

  it('idempoten untuk session tak dikenal', () => {
    const { engine } = makeEngine();

    expect(() => engine.removePeerVoice('peer-tak-ada')).not.toThrow();
  });

  it('tetap aman dipanggil setelah dispose (jalur cleanup)', async () => {
    const { engine } = makeEngine();
    engine.addPeerVoice('peer-1', fakeMediaStream());
    await engine.dispose();

    expect(() => engine.removePeerVoice('peer-1')).not.toThrow();
  });
});

describe('SpatialAudioEngine — volume & mute', () => {
  it('setMasterVolume mengubah gain master (di-clamp 0..1)', () => {
    const { engine, ctx } = makeEngine();
    const gain = masterGainOf(ctx);

    engine.setMasterVolume(0.5);
    expect(gain.gain.value).toBe(0.5);

    engine.setMasterVolume(7);
    expect(gain.gain.value).toBe(1);

    engine.setMasterVolume(-2);
    expect(gain.gain.value).toBe(0);
  });

  it('setMuted menyanikan tanpa membongkar volume tersimpan', () => {
    const { engine, ctx } = makeEngine();
    const gain = masterGainOf(ctx);
    engine.setMasterVolume(0.4);

    engine.setMuted(true);
    expect(engine.isMuted).toBe(true);
    expect(gain.gain.value).toBe(0);

    engine.setMuted(false);
    expect(engine.isMuted).toBe(false);
    expect(gain.gain.value).toBe(0.4);
  });

  it('setMasterVolume saat muted tidak terdengar sampai unmute', () => {
    const { engine, ctx } = makeEngine();
    const gain = masterGainOf(ctx);
    engine.setMuted(true);

    engine.setMasterVolume(0.8);
    expect(gain.gain.value).toBe(0);

    engine.setMuted(false);
    expect(gain.gain.value).toBe(0.8);
  });
});

describe('SpatialAudioEngine — lifecycle context', () => {
  it('resume/suspend diteruskan ke context', async () => {
    const { engine, ctx } = makeEngine();

    await engine.resume();
    expect(ctx.resumeCalls).toBe(1);
    expect(engine.contextState).toBe('running');

    await engine.suspend();
    expect(ctx.suspendCalls).toBe(1);
    expect(engine.contextState).toBe('suspended');
  });

  it('resume setelah dispose melempar error', async () => {
    const { engine } = makeEngine();
    await engine.dispose();

    await expect(engine.resume()).rejects.toThrow(/di-dispose/);
  });

  it('dispose memutus semua suara, masterGain, dan menutup context sekali', async () => {
    const onError = vi.fn();
    const { engine, ctx } = makeEngine(undefined, { onError });
    engine.addPeerVoice('peer-1', fakeMediaStream());
    engine.addPeerVoice('peer-2', fakeMediaStream());
    const first = voiceOf(ctx, 0);
    const second = voiceOf(ctx, 1);

    await engine.dispose();
    await engine.dispose(); // idempoten

    expect(engine.isDisposed).toBe(true);
    expect(first.source.disconnectCalls).toBe(1);
    expect(second.source.disconnectCalls).toBe(1);
    expect(first.panner.disconnectCalls).toBe(1);
    expect(ctx.createdGains[0]?.disconnectCalls).toBe(1);
    expect(ctx.closeCalls).toBe(1);
    expect(engine.peerVoiceIds).toEqual([]);
  });

  it('dispose saat context sudah closed tidak memanggil close lagi', async () => {
    const { engine, ctx } = makeEngine();
    await ctx.close(); // context ditutup dari luar

    await engine.dispose();

    expect(ctx.closeCalls).toBe(1);
  });
});
