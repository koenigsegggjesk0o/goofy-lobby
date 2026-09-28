import { describe, expect, it } from 'vitest';

/**
 * Test LANGSUNG summarizeStressRuns (utang 13-a, dibayar 15-c).
 *
 * Modul e2e-stress.mjs aman diimpor di vitest: efek samping (spawn
 * playwright) di-guard isMain — di lingkungan test hanya konstanta argv
 * yang dievaluasi. Tipe hasil dideklarasikan lokal (cast eksplisit, tanpa
 * file deklarasi duplikatif) supaya kontrak bentuk laporan JSON Playwright
 * terdokumentasi di satu tempat bersama test-nya.
 */

/** Bentuk entri yang dibaca summarizeStressRuns (subset laporan JSON Playwright). */
interface StressReportLike {
  suites?: SuiteLike[];
}

interface SuiteLike {
  title?: string;
  specs?: SpecLike[];
  suites?: SuiteLike[];
}

interface SpecLike {
  title: string;
  file?: string;
  tests?: TestLike[];
}

interface TestLike {
  results?: ResultLike[];
}

interface ResultLike {
  status: string;
  duration?: number;
}

interface DurationStatsLike {
  n: number;
  min: number;
  max: number;
  mean: number;
  median: number;
  p95: number;
}

interface SummaryLike {
  specs: Array<{
    title: string;
    file: string;
    passed: number;
    failed: number;
    durations: number[];
    durationStats: DurationStatsLike | null;
  }>;
  totalPassed: number;
  totalFailed: number;
}

const { summarizeStressRuns } = (await import('./e2e-stress.mjs')) as {
  summarizeStressRuns: (report: StressReportLike) => SummaryLike;
};

function result(status: string, duration?: number): ResultLike {
  return duration === undefined ? { status } : { status, duration };
}

describe('summarizeStressRuns — agregasi laporan JSON playwright', () => {
  it('laporan kosong → nol spec, nol total', () => {
    const summary = summarizeStressRuns({});
    expect(summary.specs).toEqual([]);
    expect(summary.totalPassed).toBe(0);
    expect(summary.totalFailed).toBe(0);
  });

  it('field opsional hilang semua (suites/specs/tests/results undefined) tidak melempar', () => {
    const summary = summarizeStressRuns({ suites: [{}, { specs: [{}] }] });
    // Spec tanpa judul → kunci '(tanpa judul suite) › undefined' tetap tercatat.
    expect(summary.specs.length).toBeGreaterThanOrEqual(1);
    expect(summary.totalPassed).toBe(0);
    expect(summary.totalFailed).toBe(0);
  });

  it('suite datar: lulus dan gagal dihitung; durasi HANYA dari run lulus', () => {
    const summary = summarizeStressRuns({
      suites: [
        {
          title: 'mesh',
          specs: [
            {
              title: 'dua konteks',
              file: 'e2e/mesh.spec.ts',
              tests: [{ results: [result('passed', 100), result('passed', 200)] }],
            },
            {
              title: 'tiga konteks',
              file: 'e2e/mesh-three-peers.spec.ts',
              tests: [{ results: [result('failed', 9999), result('passed', 300)] }],
            },
          ],
        },
      ],
    });
    expect(summary.totalPassed).toBe(3);
    expect(summary.totalFailed).toBe(1);
    const dua = summary.specs.find((s) => s.title.includes('dua'));
    const tiga = summary.specs.find((s) => s.title.includes('tiga'));
    expect(dua?.durations).toEqual([100, 200]);
    // Run gagal durasinya 9999 — TIDAK boleh mencemari distribusi.
    expect(tiga?.durations).toEqual([300]);
    expect(tiga?.failed).toBe(1);
  });

  it('suite bersarang (describe dalam describe) di-walk rekursif', () => {
    const summary = summarizeStressRuns({
      suites: [
        {
          title: 'luar',
          suites: [
            {
              title: 'dalam',
              specs: [{ title: 'spesies dalam', tests: [{ results: [result('passed', 10)] }] }],
            },
          ],
          specs: [{ title: 'spesies luar', tests: [{ results: [result('passed', 20)] }] }],
        },
      ],
    });
    expect(summary.totalPassed).toBe(2);
    expect(summary.specs.map((s) => s.title)).toEqual(
      expect.arrayContaining(['luar › spesies luar', 'dalam › spesies dalam']),
    );
  });

  it('repeat-each: spec yang sama lintas suite berbeda file tetap baris terpisah per kunci judul', () => {
    // Kunci = `${suite.title} › ${spec.title}` — spec identik di DUA suite
    // berbeda judul = dua entri (bukan digabung), sesuai kontrak agregasi.
    const summary = summarizeStressRuns({
      suites: [
        {
          title: 'a',
          specs: [{ title: 'sama', tests: [{ results: [result('passed', 5)] }] }],
        },
        {
          title: 'b',
          specs: [{ title: 'sama', tests: [{ results: [result('passed', 15)] }] }],
        },
      ],
    });
    expect(summary.specs).toHaveLength(2);
    expect(summary.totalPassed).toBe(2);
  });

  it('durationStats memakai summarizeNumbers (type-7) — nilai referensi 1..10', () => {
    const durations = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
    const summary = summarizeStressRuns({
      suites: [
        {
          title: 's',
          specs: [
            {
              title: 'd',
              tests: [{ results: durations.map((ms) => result('passed', ms)) }],
            },
          ],
        },
      ],
    });
    const stats = summary.specs[0]?.durationStats;
    if (stats === null || stats === undefined) {
      throw new Error('durationStats tidak boleh kosong saat ada run lulus');
    }
    // Nilai referensi 13-a (hand-calculated, type-7): p50=5.5, p95=9.55.
    // toBeCloseTo presisi 10 — konvensi stats.test.ts (float interpolasi).
    expect(stats.n).toBe(10);
    expect(stats.min).toBe(1);
    expect(stats.max).toBe(10);
    expect(stats.median).toBeCloseTo(5.5, 10);
    expect(stats.p95).toBeCloseTo(9.55, 10);
  });

  it('semua run gagal → durationStats null (jujur tanpa distribusi)', () => {
    const summary = summarizeStressRuns({
      suites: [
        {
          title: 's',
          specs: [{ title: 'd', tests: [{ results: [result('failed')] }] }],
        },
      ],
    });
    expect(summary.specs[0]?.durationStats).toBeNull();
    expect(summary.specs[0]?.durations).toEqual([]);
    expect(summary.totalFailed).toBe(1);
  });

  it('duration non-number diabaikan (kontrak typeof guard)', () => {
    const summary = summarizeStressRuns({
      suites: [
        {
          title: 's',
          specs: [
            {
              title: 'd',
              tests: [
                {
                  results: [
                    result('passed', 50),
                    { status: 'passed', duration: 'bukan angka' as unknown as number },
                  ],
                },
              ],
            },
          ],
        },
      ],
    });
    expect(summary.specs[0]?.durations).toEqual([50]);
  });
});
