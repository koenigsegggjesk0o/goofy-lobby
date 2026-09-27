/**
 * Fake objek Web Audio + RTCRtpSender untuk unit test audio (lingkungan Node,
 * tanpa browser). Hanya diimpor dari file *.test.ts — tidak pernah masuk
 * bundle produksi.
 */
import type { AdaptiveRtpParameters } from './types';

// ============================================================
// AudioParam & AudioNode
// ============================================================

export class FakeAudioParam {
  value = 0;
}

export class FakeAudioNode {
  connectedTo: FakeAudioNode[] = [];
  disconnectCalls = 0;

  connect(destination: FakeAudioNode): FakeAudioNode {
    this.connectedTo.push(destination);
    return destination;
  }

  disconnect(): void {
    this.disconnectCalls += 1;
    this.connectedTo = [];
  }
}

// ============================================================
// MediaStreamAudioSourceNode / GainNode / PannerNode
// ============================================================

export class FakeMediaStreamAudioSourceNode extends FakeAudioNode {
  readonly mediaStream: MediaStream;

  constructor(mediaStream: MediaStream) {
    super();
    this.mediaStream = mediaStream;
  }
}

export class FakeGainNode extends FakeAudioNode {
  readonly gain = new FakeAudioParam();
}

export interface LegacyNodeOptions {
  /** true = simulasi browser lama: AudioParam posisi tidak tersedia. */
  legacy?: boolean;
}

export class FakePannerNode extends FakeAudioNode {
  panningModel: PanningModelType = 'equalpower';
  distanceModel: DistanceModelType = 'linear';
  refDistance = 1;
  maxDistance = 10_000;
  rolloffFactor = 1;
  positionX?: FakeAudioParam;
  positionY?: FakeAudioParam;
  positionZ?: FakeAudioParam;
  setPositionCalls: Array<[number, number, number]> = [];

  constructor(options: LegacyNodeOptions = {}) {
    super();
    if (!options.legacy) {
      this.positionX = new FakeAudioParam();
      this.positionY = new FakeAudioParam();
      this.positionZ = new FakeAudioParam();
    }
  }

  setPosition(x: number, y: number, z: number): void {
    this.setPositionCalls.push([x, y, z]);
  }
}

// ============================================================
// AudioListener
// ============================================================

export class FakeAudioListener {
  positionX?: FakeAudioParam;
  positionY?: FakeAudioParam;
  positionZ?: FakeAudioParam;
  forwardX?: FakeAudioParam;
  forwardY?: FakeAudioParam;
  forwardZ?: FakeAudioParam;
  upX?: FakeAudioParam;
  upY?: FakeAudioParam;
  upZ?: FakeAudioParam;
  setPositionCalls: Array<[number, number, number]> = [];
  setOrientationCalls: Array<[number, number, number, number, number, number]> = [];

  constructor(options: LegacyNodeOptions = {}) {
    if (!options.legacy) {
      this.positionX = new FakeAudioParam();
      this.positionY = new FakeAudioParam();
      this.positionZ = new FakeAudioParam();
      this.forwardX = new FakeAudioParam();
      this.forwardY = new FakeAudioParam();
      this.forwardZ = new FakeAudioParam();
      this.upX = new FakeAudioParam();
      this.upY = new FakeAudioParam();
      this.upZ = new FakeAudioParam();
    }
  }

  setPosition(x: number, y: number, z: number): void {
    this.setPositionCalls.push([x, y, z]);
  }

  setOrientation(fx: number, fy: number, fz: number, ux: number, uy: number, uz: number): void {
    this.setOrientationCalls.push([fx, fy, fz, ux, uy, uz]);
  }
}

// ============================================================
// AudioContext
// ============================================================

export interface FakeAudioContextOptions {
  /** Semua panner yang dibuat context ini memakai jalur legacy. */
  legacyPanner?: boolean;
  /** Listener context ini memakai jalur legacy. */
  legacyListener?: boolean;
}

export class FakeAudioContext {
  state: AudioContextState = 'suspended';
  readonly destination: FakeAudioNode;
  readonly listener: FakeAudioListener;
  readonly createdSources: FakeMediaStreamAudioSourceNode[] = [];
  readonly createdPanners: FakePannerNode[] = [];
  readonly createdGains: FakeGainNode[] = [];
  resumeCalls = 0;
  suspendCalls = 0;
  closeCalls = 0;
  private readonly legacyPanner: boolean;

  constructor(options: FakeAudioContextOptions = {}) {
    this.legacyPanner = options.legacyPanner ?? false;
    this.destination = new FakeAudioNode();
    this.listener = new FakeAudioListener({ legacy: options.legacyListener });
  }

  createMediaStreamSource(stream: MediaStream): FakeMediaStreamAudioSourceNode {
    const source = new FakeMediaStreamAudioSourceNode(stream);
    this.createdSources.push(source);
    return source;
  }

  createPanner(): FakePannerNode {
    const panner = new FakePannerNode({ legacy: this.legacyPanner });
    this.createdPanners.push(panner);
    return panner;
  }

  createGain(): FakeGainNode {
    const gain = new FakeGainNode();
    this.createdGains.push(gain);
    return gain;
  }

  async resume(): Promise<void> {
    this.resumeCalls += 1;
    this.state = 'running';
  }

  async suspend(): Promise<void> {
    this.suspendCalls += 1;
    this.state = 'suspended';
  }

  async close(): Promise<void> {
    this.closeCalls += 1;
    this.state = 'closed';
  }
}

// ============================================================
// RTCRtpSender (dengan getParameters/setParameters)
// ============================================================

export class FakeParamsRtpSender {
  track: MediaStreamTrack | null;
  getParametersCalls = 0;
  setParametersCalls: AdaptiveRtpParameters[] = [];
  /** Set true untuk mensimulasikan kegagalan setParameters pada pemanggilan berikutnya. */
  failSetParameters = false;
  #parameters: AdaptiveRtpParameters;

  constructor(track: MediaStreamTrack | null, parameters?: AdaptiveRtpParameters) {
    this.track = track;
    this.#parameters = parameters ?? {};
  }

  getParameters(): AdaptiveRtpParameters {
    this.getParametersCalls += 1;
    return structuredClone(this.#parameters);
  }

  setParameters(parameters: AdaptiveRtpParameters): Promise<void> {
    this.setParametersCalls.push(structuredClone(parameters));
    if (this.failSetParameters) {
      return Promise.reject(new Error('setParameters gagal (simulasi)'));
    }
    this.#parameters = structuredClone(parameters);
    return Promise.resolve();
  }
}

// ============================================================
// Helper
// ============================================================

export function asAudioContext(fake: FakeAudioContext): AudioContext {
  return fake as unknown as AudioContext;
}

export function fakeMediaStream(): MediaStream {
  return { getTracks: () => [], id: 'fake-stream' } as unknown as MediaStream;
}

export function fakeTrack(kind: 'audio' | 'video'): MediaStreamTrack {
  return { kind, id: `fake-${kind}-track` } as unknown as MediaStreamTrack;
}

/** Menunggu satu putaran macrotask — promise setParameters sempat settle. */
export async function flush(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}
