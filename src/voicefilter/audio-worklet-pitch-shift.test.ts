import { describe, expect, it } from 'vitest';
import {
  BYPASS_SEMITONES_EPSILON,
  PITCH_SHIFT_PROCESSOR_NAME,
  PitchShiftWorkletController,
  defaultPitchShiftProcessorUrl,
} from './audio-worklet-pitch-shift';
import { FakeAudioNode, FakeWorkletContext, FakeWorkletNode } from './test-utils';

interface Harness {
  context: FakeWorkletContext;
  source: FakeAudioNode;
  destination: FakeAudioNode;
  workletNode: FakeWorkletNode;
}

async function createHarness(
  options: { omitSemitonesParam?: boolean; failAddModule?: Error } = {},
): Promise<{ controller: PitchShiftWorkletController } & Harness> {
  const context = new FakeWorkletContext();
  const source = new FakeAudioNode();
  const destination = new FakeAudioNode();
  const workletNode = new FakeWorkletNode({ omitSemitonesParam: options.omitSemitonesParam });
  if (options.failAddModule !== undefined) {
    context.failNextAddModule(options.failAddModule);
  }
  const controller = await PitchShiftWorkletController.create({
    context,
    source,
    destination,
    processorUrl: 'https://test.local/pitch-worklet-processor.js',
    createWorkletNode: () => workletNode,
  });
  return { controller, context, source, destination, workletNode };
}

describe('PitchShiftWorkletController.create', () => {
  it('memuat modul processor lewat addModule dengan URL yang diberikan', async () => {
    const { context } = await createHarness();
    expect(context.addModuleCalls).toEqual(['https://test.local/pitch-worklet-processor.js']);
  });

  it('addModule SEKALI per context — controller kedua pada context sama tidak memuat ulang', async () => {
    const context = new FakeWorkletContext();
    const source = new FakeAudioNode();
    const destination = new FakeAudioNode();
    const deps = {
      context,
      source,
      destination,
      processorUrl: 'https://test.local/pitch-worklet-processor.js',
      createWorkletNode: () => new FakeWorkletNode(),
    };
    await PitchShiftWorkletController.create(deps);
    await PitchShiftWorkletController.create(deps);
    await PitchShiftWorkletController.create(deps);
    expect(context.addModuleCalls).toHaveLength(1);
  });

  it('URL berbeda pada context sama tetap dimuat (rotasi aset)', async () => {
    const context = new FakeWorkletContext();
    const source = new FakeAudioNode();
    const destination = new FakeAudioNode();
    const base = { context, source, destination, createWorkletNode: () => new FakeWorkletNode() };
    await PitchShiftWorkletController.create({ ...base, processorUrl: 'https://a/processor.js' });
    await PitchShiftWorkletController.create({ ...base, processorUrl: 'https://b/processor.js' });
    expect(context.addModuleCalls).toEqual(['https://a/processor.js', 'https://b/processor.js']);
  });

  it('addModule gagal → VoiceFilterError worklet-load-failed + cause', async () => {
    const failure = new Error('module corrupt');
    await expect(createHarness({ failAddModule: failure })).rejects.toMatchObject({
      name: 'VoiceFilterError',
      code: 'worklet-load-failed',
      cause: failure,
    });
  });

  it('defaultPitchShiftProcessorUrl menunjuk file processor di samping modul', () => {
    expect(defaultPitchShiftProcessorUrl()).toContain('pitch-worklet-processor.js');
  });

  it('state awal: create() langsung memasang jalur BYPASS (identitas aman)', async () => {
    const { controller, source, destination, workletNode } = await createHarness();
    expect(controller.getRoute()).toBe('bypass');
    expect(controller.getSemitones()).toBe(0);
    // Tepat satu koneksi langsung; worklet belum tersambung.
    expect(source.activeConnectionsTo(destination)).toBe(1);
    expect(source.activeConnectionsTo(workletNode)).toBe(0);
    expect(workletNode.activeConnectionsTo(destination)).toBe(0);
  });
});

describe('PitchShiftWorkletController.setSemitones', () => {
  it('nilai aktif: jalur lewat worklet + parameter semitones ter-set', async () => {
    const { controller, workletNode } = await createHarness();
    controller.setSemitones(5);
    expect(controller.getSemitones()).toBe(5);
    expect(controller.getRoute()).toBe('worklet');
    expect(workletNode.semitonesValue).toBe(5);
  });

  it('bypass: |s| < eps → sinyal dilewatkan langsung, param tidak disentuh', async () => {
    const { controller, workletNode } = await createHarness();
    controller.setSemitones(0);
    expect(controller.getRoute()).toBe('bypass');
    expect(workletNode.semitonesValue).toBe(0);
    expect(controller.getSemitones()).toBe(0);
  });

  it('clamp ±24 berlaku (100 → 24, -100 → -24)', async () => {
    const { controller } = await createHarness();
    controller.setSemitones(100);
    expect(controller.getSemitones()).toBe(24);
    controller.setSemitones(-100);
    expect(controller.getSemitones()).toBe(-24);
  });

  it('idempoten: setSemitones berulang dengan nilai setara tidak menumpuk koneksi', async () => {
    const { controller, source, destination, workletNode } = await createHarness();
    controller.setSemitones(5);
    controller.setSemitones(5);
    controller.setSemitones(5);
    expect(source.activeConnectionsTo(workletNode)).toBe(1);
    expect(workletNode.activeConnectionsTo(destination)).toBe(1);
    expect(source.activeConnectionsTo(destination)).toBe(0);
  });

  it('transisi bolak-balik worklet ↔ bypass menjaga invariant wiring', async () => {
    const { controller, source, destination, workletNode } = await createHarness();
    for (const value of [5, 5, 0, 0, 3, 0, -2, 0, 0]) {
      controller.setSemitones(value);
    }
    // Deretan di atas berakhir di bypass: tepat SATU koneksi langsung
    // sumber→tujuan dan NOL sambungan worklet tersisa.
    expect(controller.getRoute()).toBe('bypass');
    expect(source.activeConnectionsTo(destination)).toBe(1);
    expect(source.activeConnectionsTo(workletNode)).toBe(0);
    expect(workletNode.activeConnectionsTo(destination)).toBe(0);
  });

  it('jalur aktif: tepat satu koneksi sumber→worklet dan worklet→tujuan', async () => {
    const { controller, source, destination, workletNode } = await createHarness();
    controller.setSemitones(5);
    controller.setSemitones(7);
    expect(source.activeConnectionsTo(workletNode)).toBe(1);
    expect(workletNode.activeConnectionsTo(destination)).toBe(1);
    expect(source.activeConnectionsTo(destination)).toBe(0);
  });

  it('NaN / Infinity → VoiceFilterError invalid-semitones', async () => {
    const { controller } = await createHarness();
    expect(() => controller.setSemitones(Number.NaN)).toThrowError(
      expect.objectContaining({ code: 'invalid-semitones' }),
    );
    expect(() => controller.setSemitones(Number.POSITIVE_INFINITY)).toThrowError(
      expect.objectContaining({ code: 'invalid-semitones' }),
    );
    // @ts-expect-error — jalur defensif pemanggil JS tanpa tipe
    expect(() => controller.setSemitones('lima')).toThrowError(
      expect.objectContaining({ code: 'invalid-semitones' }),
    );
  });
  it('parameter semitones tidak ada → VoiceFilterError missing-parameter', async () => {
    const { controller } = await createHarness({ omitSemitonesParam: true });
    expect(() => controller.setSemitones(5)).toThrowError(
      expect.objectContaining({ code: 'missing-parameter' }),
    );
  });
});

describe('PitchShiftWorkletController.dispose', () => {
  it('melepas semua koneksi dan idempoten', async () => {
    const { controller, source, destination, workletNode } = await createHarness();
    controller.setSemitones(5);
    controller.dispose();
    controller.dispose();
    expect(source.activeConnectionsTo(workletNode)).toBe(0);
    expect(workletNode.activeConnectionsTo(destination)).toBe(0);
    expect(source.activeConnectionsTo(destination)).toBe(0);
    expect(controller.isDisposed).toBe(true);
  });

  it('dispose dari keadaan bypass juga melepas koneksi langsung', async () => {
    const { controller, source, destination } = await createHarness();
    controller.setSemitones(0);
    controller.dispose();
    expect(source.activeConnectionsTo(destination)).toBe(0);
  });

  it('pemakaian pasca-dispose → VoiceFilterError disposed', async () => {
    const { controller } = await createHarness();
    controller.dispose();
    expect(() => controller.setSemitones(5)).toThrowError(
      expect.objectContaining({ code: 'disposed' }),
    );
  });
});

describe('konstanta', () => {
  it('nama processor & epsilon bypass selaras processor (kontrak lintas file)', () => {
    expect(PITCH_SHIFT_PROCESSOR_NAME).toBe('pitch-shift-processor');
    expect(BYPASS_SEMITONES_EPSILON).toBe(0.01);
  });
});
