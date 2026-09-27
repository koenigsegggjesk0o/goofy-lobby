/**
 * Runner stress e2e (PREP 8-f): playwright test --repeat-each=N dengan
 * reporter JSON ke file sementara, lalu agregasi DURASI per spec
 * (min/median/mean/max dari run yang lulus) — distribusi waktu, bukan
 * sekadar hitungan lulus/gagal. Melengkapi dual-metrik probe-webrtc (ICE
 * level, tanpa Supabase): ini mengukur siklus PENUH signin→mesh→leave di
 * atas signaling Supabase Realtime sungguhan.
 *
 * Jalankan:
 *   bun run test:e2e:stress                       # filter 'mesh', 10x
 *   bun run test:e2e:stress turn-config --runs 3  # filter lain + 3x
 *   bun run test:e2e:stress mesh auth --runs 5    # beberapa filter
 *
 * Catatan kejujuran: spec yang butuh kredensial (TEST_USER_* / env klien)
 * akan gagal cepat selama env ter-stripped — runner tetap mengagregasi
 * kegagalan itu apa adanya (tidak ada yang ditelan).
 */
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const runsArg = process.argv.find((arg) => arg.startsWith('--runs='));
const runsFlagIndex = process.argv.indexOf('--runs');
const RUNS = Math.max(
  1,
  Number.parseInt(
    runsArg !== undefined
      ? runsArg.slice('--runs='.length)
      : runsFlagIndex !== -1
        ? process.argv[runsFlagIndex + 1]
        : '10',
    10,
  ) || 1,
);

const argv = process.argv.slice(2);
const filters = argv.filter((arg, index) => {
  if (arg.startsWith('--')) return false;
  // nilai N setelah flag --runs bukan filter
  if (index > 0 && argv[index - 1] === '--runs') return false;
  return true;
});
const FILTERS = filters.length > 0 ? filters : ['mesh'];

function sec(ms) {
  return `${(ms / 1000).toFixed(1)}s`;
}

function stats(durations) {
  const sorted = [...durations].sort((a, b) => a - b);
  const n = sorted.length;
  const median = n % 2 === 1 ? sorted[(n - 1) / 2] : (sorted[n / 2 - 1] + sorted[n / 2]) / 2;
  const mean = sorted.reduce((sum, t) => sum + t, 0) / n;
  return { n, min: sorted[0], median, mean, max: sorted[n - 1] };
}

/**
 * Agregasi laporan JSON playwright → ringkasan per spec (judul, jumlah
 * lulus/gagal, distribusi durasi run lulus). Suite di-walk rekursif (spec
 * dalam describe bersarang pun terhitung). Diekspor agar logika agregasi
 * bisa diverifikasi terpisah dari proses spawn.
 */
export function summarizeStressRuns(report) {
  const bySpec = new Map();
  const collectSuite = (suite) => {
    for (const spec of suite.specs ?? []) {
      const key = `${suite.title ?? '(tanpa judul suite)'} › ${spec.title}`;
      const entry = bySpec.get(key) ?? {
        title: key,
        file: spec.file ?? '',
        passed: 0,
        failed: 0,
        durations: [],
      };
      for (const test of spec.tests ?? []) {
        for (const result of test.results ?? []) {
          if (result.status === 'passed') {
            entry.passed += 1;
            if (typeof result.duration === 'number') entry.durations.push(result.duration);
          } else {
            entry.failed += 1;
          }
        }
      }
      bySpec.set(key, entry);
    }
    for (const child of suite.suites ?? []) collectSuite(child);
  };
  for (const suite of report.suites ?? []) collectSuite(suite);

  const specs = [...bySpec.values()].map((entry) => ({
    ...entry,
    durationStats: entry.durations.length > 0 ? stats(entry.durations) : null,
  }));
  return {
    specs,
    totalPassed: specs.reduce((sum, spec) => sum + spec.passed, 0),
    totalFailed: specs.reduce((sum, spec) => sum + spec.failed, 0),
  };
}

const binPath = fileURLToPath(new URL('../../node_modules/.bin/playwright', import.meta.url));

/** Eksekusi runner HANYA bila dijalankan langsung sebagai CLI — import modul (mis. verifikasi agregasi) bebas efek samping. */
const isMain = import.meta.url === pathToFileURL(process.argv[1] ?? '').href;

if (isMain) {
  await main();
}

async function main() {
  const outDir = await mkdtemp(join(tmpdir(), 'e2e-stress-'));
  const outFile = join(outDir, 'result.json');

  console.log(
    `stress e2e: playwright test ${FILTERS.join(' ')} --repeat-each ${RUNS} (JSON → file sementara)`,
  );

  const child = spawn(
    binPath,
    ['test', ...FILTERS, '--repeat-each', String(RUNS), '--reporter=json'],
    {
      stdio: 'inherit',
      env: { ...process.env, PLAYWRIGHT_JSON_OUTPUT_NAME: outFile },
    },
  );

  const exitCode = await new Promise((resolve) => {
    child.on('close', (code) => resolve(code ?? 1));
    child.on('error', (error) => {
      console.error(`gagal menjalankan playwright (${error.message}) — jalankan dari root proyek.`);
      resolve(1);
    });
  });

  console.log('\n== ringkasan stress ==');
  try {
    const raw = await readFile(outFile, 'utf8');
    const summary = summarizeStressRuns(JSON.parse(raw));
    for (const spec of summary.specs) {
      const total = spec.passed + spec.failed;
      console.log(`\n${spec.title}`);
      if (spec.durationStats !== null) {
        const s = spec.durationStats;
        console.log(
          `  lulus ${spec.passed}/${total} — durasi lulus: n=${s.n} min=${sec(s.min)} median=${sec(s.median)} mean=${sec(s.mean)} max=${sec(s.max)}`,
        );
      } else {
        console.log(
          `  lulus ${spec.passed}/${total} — tidak ada durasi (semua run gagal/dilewati)`,
        );
      }
      if (spec.failed > 0) {
        console.log(`  ⚠ ${spec.failed} run gagal — periksa detail di atas.`);
      }
    }
    console.log(
      `\ntotal: ${summary.totalPassed} lulus / ${summary.totalFailed} gagal dari ${summary.totalPassed + summary.totalFailed} run.`,
    );
  } catch (error) {
    console.error(`tidak bisa membaca laporan JSON (${error.message}) — agregasi dilewati.`);
  }
  await rm(outDir, { recursive: true, force: true });

  process.exit(exitCode);
}
