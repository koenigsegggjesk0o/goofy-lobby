/**
 * Fake objek Web Audio untuk unit test voicefilter (lingkungan Node, tanpa
 * browser). Hanya diimpor dari file *.test.ts — tidak pernah masuk bundle
 * produksi. Bentuk mengikuti tipe struktural audio-worklet-pitch-shift.ts.
 */
import type {
  AudioNodeLike,
  AudioWorkletContextLike,
  AudioWorkletNodeLike,
} from './audio-worklet-pitch-shift';

/** Node umum — mencatat urutan connect/disconnect. */
export class FakeAudioNode implements AudioNodeLike {
  readonly connectCalls: FakeAudioNode[] = [];
  readonly disconnectCalls: Array<FakeAudioNode | undefined> = [];

  connect(destination: FakeAudioNode): FakeAudioNode {
    this.connectCalls.push(destination);
    return destination;
  }

  disconnect(destination?: FakeAudioNode): void {
    this.disconnectCalls.push(destination);
  }

  /** Jumlah koneksi AKTIF ke target (parallel duplicate = masalah wiring). */
  activeConnectionsTo(target: FakeAudioNode): number {
    let count = 0;
    for (const connected of this.connectCalls) {
      if (connected === target) {
        count += 1;
      }
    }
    for (const disconnected of this.disconnectCalls) {
      if (disconnected === target) {
        count -= 1;
      }
    }
    return count;
  }
}

/** Node worklet — ditambah parameters.get('semitones'). */
export class FakeWorkletNode extends FakeAudioNode implements AudioWorkletNodeLike {
  readonly parameters: { get(name: string): { value: number } | undefined };

  constructor(options: { omitSemitonesParam?: boolean } = {}) {
    super();
    const semitoneParam = { value: 0 };
    this.parameters = {
      get: (name: string) => {
        if (name === 'semitones' && options.omitSemitonesParam !== true) {
          return semitoneParam;
        }
        return undefined;
      },
    };
  }

  /** Nilai terakhir parameter semitones (undefined bila param tak ada). */
  get semitonesValue(): number | undefined {
    return this.parameters.get('semitones')?.value;
  }
}

/** Konteks dengan audioWorklet.addModule yang bisa dipasangi kegagalan. */
export class FakeWorkletContext implements AudioWorkletContextLike {
  readonly addModuleCalls: string[] = [];
  #failWith?: Error;

  audioWorklet = {
    addModule: async (moduleUrl: string): Promise<void> => {
      this.addModuleCalls.push(moduleUrl);
      if (this.#failWith !== undefined) {
        throw this.#failWith;
      }
    },
  };

  failNextAddModule(error: Error): void {
    this.#failWith = error;
  }
}
