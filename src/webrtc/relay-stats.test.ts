import { describe, expect, it } from 'vitest';
import { isSelectedPairRelay, pickSelectedPair } from './relay-stats';
import type { SelectedPairInfo, StatsEntryLike } from './relay-stats';

/** Helper narrow tanpa non-null assertion (konvensi proyek — helper yang throw). */
function mustPair(result: SelectedPairInfo | null): SelectedPairInfo {
  if (result === null) throw new Error('pasangan terpilih tidak boleh null di test ini');
  return result;
}

/** Fixture bentuk Chrome: kandidat + pasangan selected eksplisit. */
const chromeLike = (): StatsEntryLike[] => [
  {
    id: 'C1',
    type: 'local-candidate',
    candidateType: 'relay',
    address: '1.2.3.4',
    port: 40000,
    relayProtocol: 'udp',
  },
  {
    id: 'C2',
    type: 'local-candidate',
    candidateType: 'host',
    address: '192.168.1.10',
    port: 50000,
  },
  { id: 'C3', type: 'remote-candidate', candidateType: 'relay', address: '5.6.7.8', port: 40001 },
  { id: 'C4', type: 'remote-candidate', candidateType: 'srflx', address: '9.9.9.9', port: 60000 },
  {
    id: 'P1',
    type: 'candidate-pair',
    localCandidateId: 'C1',
    remoteCandidateId: 'C3',
    state: 'succeeded',
    nominated: true,
    selected: true,
  },
  {
    id: 'P2',
    type: 'candidate-pair',
    localCandidateId: 'C2',
    remoteCandidateId: 'C4',
    state: 'succeeded',
    nominated: false,
    selected: false,
  },
];

describe('pickSelectedPair', () => {
  it('null pada laporan kosong', () => {
    expect(pickSelectedPair([])).toBeNull();
  });

  it('null bila tidak ada entri candidate-pair sama sekali', () => {
    const report: StatsEntryLike[] = [
      { id: 'C1', type: 'local-candidate', candidateType: 'host' },
      { type: 'transport', dtlsState: 'connected' },
    ];
    expect(pickSelectedPair(report)).toBeNull();
  });

  it('null bila ada pasangan tapi belum ada yang succeeded/selected', () => {
    const report: StatsEntryLike[] = [
      { id: 'C1', type: 'local-candidate', candidateType: 'host' },
      { id: 'C2', type: 'remote-candidate', candidateType: 'host' },
      {
        id: 'P1',
        type: 'candidate-pair',
        localCandidateId: 'C1',
        remoteCandidateId: 'C2',
        state: 'in-progress',
        nominated: false,
      },
    ];
    expect(pickSelectedPair(report)).toBeNull();
  });

  it('selected === true menang atas pasangan lain yang succeeded+nominated', () => {
    const pair = pickSelectedPair(chromeLike());
    // P2 juga succeeded, tapi P1 punya penanda eksplisit selected.
    expect(pair).not.toBeNull();
    expect(pair?.selected).toBe(true);
    expect(pair?.localCandidateId).toBe('C1');
    expect(pair?.remoteCandidateId).toBe('C3');
  });

  it('menggabungkan tipe kandidat lokal/relay dan remote/relay dari id pasangan', () => {
    const pair = mustPair(pickSelectedPair(chromeLike()));
    expect(pair.localType).toBe('relay');
    expect(pair.remoteType).toBe('relay');
    expect(pair.state).toBe('succeeded');
    expect(pair.nominated).toBe(true);
    expect(isSelectedPairRelay(pair)).toBe(true);
  });

  it('fallback succeeded+nominated saat browser tanpa penanda selected (jalur Firefox)', () => {
    const report: StatsEntryLike[] = [
      { id: 'C1', type: 'local-candidate', candidateType: 'srflx' },
      { id: 'C2', type: 'remote-candidate', candidateType: 'prflx' },
      {
        id: 'P1',
        type: 'candidate-pair',
        localCandidateId: 'C1',
        remoteCandidateId: 'C2',
        state: 'succeeded',
        nominated: true,
        // tidak ada field selected
      },
      {
        id: 'P0',
        type: 'candidate-pair',
        localCandidateId: 'C2',
        remoteCandidateId: 'C1',
        state: 'failed',
        nominated: true,
      },
    ];
    const pair = pickSelectedPair(report);
    expect(pair?.selected).toBeNull();
    expect(pair?.state).toBe('succeeded');
    expect(pair?.localType).toBe('srflx');
    expect(pair?.remoteType).toBe('prflx');
  });

  it('fallback terakhir: pasangan succeeded pertama bila tak ada yang nominated', () => {
    const report: StatsEntryLike[] = [
      { id: 'C1', type: 'local-candidate', candidateType: 'host' },
      { id: 'C2', type: 'remote-candidate', candidateType: 'host' },
      {
        id: 'P1',
        type: 'candidate-pair',
        localCandidateId: 'C1',
        remoteCandidateId: 'C2',
        state: 'succeeded',
        nominated: false,
      },
    ];
    const pair = pickSelectedPair(report);
    expect(pair?.state).toBe('succeeded');
    expect(pair?.nominated).toBe(false);
  });

  it('dangling candidateId → tipe unknown, tidak melempar', () => {
    const report: StatsEntryLike[] = [
      {
        id: 'P1',
        type: 'candidate-pair',
        localCandidateId: 'TIDAK-ADA',
        remoteCandidateId: undefined,
        state: 'succeeded',
        nominated: true,
        selected: true,
      },
    ];
    const pair = pickSelectedPair(report);
    expect(pair?.localType).toBe('unknown');
    expect(pair?.remoteType).toBe('unknown');
    expect(pair?.remoteCandidateId).toBeNull();
  });

  it('kandidat tanpa id diabaikan (tidak masuk pemetaan)', () => {
    const report: StatsEntryLike[] = [
      { type: 'local-candidate', candidateType: 'relay' }, // tanpa id
      { id: 'C2', type: 'remote-candidate', candidateType: 'relay' },
      {
        id: 'P1',
        type: 'candidate-pair',
        localCandidateId: 'C2',
        remoteCandidateId: 'C2',
        state: 'succeeded',
        nominated: true,
      },
    ];
    const pair = pickSelectedPair(report);
    expect(pair?.localType).toBe('relay'); // C2 dipetakan (remote tapi id sama)
    expect(pair?.localCandidateId).toBe('C2');
  });

  it('candidateType tak dikenal → unknown', () => {
    const report: StatsEntryLike[] = [
      { id: 'C1', type: 'local-candidate', candidateType: 'aneh' },
      { id: 'C2', type: 'remote-candidate' },
      {
        id: 'P1',
        type: 'candidate-pair',
        localCandidateId: 'C1',
        remoteCandidateId: 'C2',
        state: 'succeeded',
        nominated: true,
      },
    ];
    const pair = pickSelectedPair(report);
    expect(pair?.localType).toBe('unknown');
    expect(pair?.remoteType).toBe('unknown');
  });

  it('isSelectedPairRelay false untuk pasangan host-host', () => {
    const report: StatsEntryLike[] = [
      { id: 'C1', type: 'local-candidate', candidateType: 'host' },
      { id: 'C2', type: 'remote-candidate', candidateType: 'host' },
      {
        id: 'P1',
        type: 'candidate-pair',
        localCandidateId: 'C1',
        remoteCandidateId: 'C2',
        state: 'succeeded',
        nominated: true,
        selected: true,
      },
    ];
    const pair = mustPair(pickSelectedPair(report));
    expect(isSelectedPairRelay(pair)).toBe(false);
  });
});

describe('pickSelectedPair — bentuk iterator maplike RTCStatsReport (regresi 14-b)', () => {
  /**
   * Bukti empiris 28 Sep 2026: [...report] di Chromium ASLI menghasilkan
   * pasangan [key, value], bukan objek stats — pemanggil lama men-spread
   * langsung sehingga entry.type undefined semua dan parser diam-null
   * (mesh live: 10 entri, 0 kandidat terbaca). Parser kini menormalisasi
   * kedua bentuk; test ini MENGUNCI perilaku itu.
   */
  it('menerima entri pasangan [key, value] hasil spread maplike — membaca value-nya', () => {
    const report = chromeLike().map((entry) => [
      entry.id ?? 'x',
      entry,
    ]) as unknown as StatsEntryLike[];
    const pair = mustPair(pickSelectedPair(report));
    expect(pair.localType).toBe('relay');
    expect(pair.remoteType).toBe('relay');
    expect(pair.selected).toBe(true);
    expect(pair.nominated).toBe(true);
    expect(pair.state).toBe('succeeded');
  });

  it('campuran bentuk objek dan pair [key, value] tetap konsisten', () => {
    const base = chromeLike();
    // Helper narrow tanpa non-null assertion (konvensi proyek).
    function at(i: number): StatsEntryLike {
      const entry = base[i];
      if (entry === undefined) throw new Error(`fixture chromeLike indeks ${i} hilang`);
      return entry;
    }
    const mixed: StatsEntryLike[] = [
      at(0),
      [at(1).id ?? 'x', at(1)] as unknown as StatsEntryLike,
      at(2),
      [at(3).id ?? 'x', at(3)] as unknown as StatsEntryLike,
      at(4),
      at(5),
    ];
    const pair = mustPair(pickSelectedPair(mixed));
    expect(pair.localType).toBe('relay');
    expect(pair.selected).toBe(true);
  });

  it('pair [key, value] yang value-nya bukan objek diabaikan tanpa melempar', () => {
    const report = [
      ['junk', 42],
      ['junk2', null],
    ] as unknown as StatsEntryLike[];
    expect(pickSelectedPair(report)).toBeNull();
  });

  it('array 2-elemen yang TIDAK berasal dari maplike (array stats asli) tidak salah dinormalisasi', () => {
    // Entri objek dengan hanya type 'unknown-shape' dari pair rusak → null.
    expect(pickSelectedPair([{ type: 'unknown-shape' }])).toBeNull();
  });
});
