/**
 * Gerbang verifikasi lengkap SATU perintah (bukan produk — alat workflow,
 * Task 10-d): typecheck → lint → format:check → unit → build → e2e (subset
 * yang runnable saat ini, dideteksi dari .env lewat modul env-matrix bersama).
 *
 * Motivasi (insiden nyata 10-b): exit code pipa `cmd | tail` menelan kegagalan
 * script sehingga lint sempat "lolos palsu". Semua langkah di sini dieksekusi
 * via spawnSync TANPA pipa shell — exit code dibaca langsung dari status
 * proses, tidak bisa ditelan.
 *
 * Jalankan: bun run verify
 * Exit code: 0 = semua langkah lulus; 1 = minimal satu langkah gagal.
 *
 * Catatan kejujuran: langkah e2e hanya menjalankan spec yang pra-syaratnya
 * terpenuhi (mis. saat env ter-stripped: turn-config + mesh-trail no-auth).
 * Jumlah spec yang dijalankan SELALU dilaporkan — subset tidak pernah
 * dipalsukan menjadi "semua". Detail pra-syarat: bun run doctor.
 */
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseEnvFile, runnableSpecFilters, SPECS } from './lib/env-matrix.mjs';

const ROOT = resolve(import.meta.dirname, '../..');
const ENV_PATH = resolve(ROOT, '.env');

const RED = '\x1b[31m';
const GREEN = '\x1b[32m';
const YELLOW = '\x1b[33m';
const DIM = '\x1b[2m';
const RESET = '\x1b[0m';

const FAIL_TAIL_LINES = 30;

/** Eksekusi runner HANYA bila dijalankan langsung sebagai CLI — import modul bebas efek samping. */
const isMain = import.meta.url === pathToFileURL(process.argv[1] ?? '').href;

/**
 * Jalankan satu langkah, tangkap output (stdout+stderr digabung) dan exit
 * code-nya. Tanpa pipa shell: exit code TIDAK BISA tertelan (pelajaran 10-b).
 */
function runStep(name, cmd, args) {
  const start = Date.now();
  const result = spawnSync(cmd, args, {
    cwd: ROOT,
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024,
    env: process.env,
  });
  const duration = Date.now() - start;
  const output = `${result.stdout ?? ''}${result.stderr ?? ''}`;
  const failed =
    result.error !== undefined ||
    result.status === null ||
    (typeof result.status === 'number' && result.status !== 0);
  return { name, duration, output, failed, spawnError: result.error?.message ?? null };
}

function sec(ms) {
  return `${(ms / 1000).toFixed(1)}s`;
}

/** Baris ringkas utk langkah yang lulus: utamakan baris RINGKASAN alat (Test Files/built in/N passed) — fallback baris terakhir yang bermakna (echo `$ cmd` bun, noise Node, dan baris kosong disaring). Digest jujur dari output nyata, bukan klaim. */
function digest(output) {
  const lines = output
    .split('\n')
    .map((line) => line.trimEnd())
    .filter(
      (line) =>
        line.trim() !== '' &&
        !line.startsWith('$ ') &&
        !line.startsWith('(Use ') &&
        !line.startsWith('(node:'),
    );
  if (lines.length === 0) return 'ok (tanpa output — exit 0)';
  const summaryLines = lines.filter((line) => /Test Files|built in|\d+ passed/.test(line));
  return (summaryLines[summaryLines.length - 1] ?? lines[lines.length - 1]).slice(0, 120);
}

function printStepResult(step, index, total) {
  const label = `[${index + 1}/${total}] ${step.name}`;
  if (!step.failed) {
    console.log(
      `${GREEN}✓${RESET} ${label} — ${sec(step.duration)} ${DIM}${digest(step.output)}${RESET}`,
    );
    return;
  }
  const reason = step.spawnError ? `gagal spawn: ${step.spawnError}` : `exit ≠ 0`;
  console.log(`${RED}✗${RESET} ${label} — ${sec(step.duration)} ${RED}${reason}${RESET}`);
  const lines = step.output.split('\n').filter((line) => line.trim() !== '');
  const tail = lines.slice(-FAIL_TAIL_LINES);
  if (tail.length > 0) {
    console.log(`    ${DIM}${RED}── ${tail.length} baris terakhir output ──${RESET}`);
    for (const line of tail) console.log(`    ${line}`);
    console.log(`    ${DIM}${RED}── akhir output ──${RESET}`);
  } else {
    console.log(`    ${DIM}(tidak ada output)${RESET}`);
  }
}

async function main() {
  console.log('== verify: gerbang lengkap (typecheck → lint → format → unit → build → e2e) ==');

  const steps = [
    { name: 'typecheck', cmd: 'bun', args: ['run', 'typecheck'] },
    { name: 'lint', cmd: 'bun', args: ['run', 'lint'] },
    { name: 'format:check', cmd: 'bun', args: ['run', 'format:check'] },
    { name: 'unit', cmd: 'bun', args: ['run', 'test'] },
    { name: 'build', cmd: 'bun', args: ['run', 'build'] },
  ];

  // Langkah e2e: subset spec yang runnable berdasarkan .env SAAT INI (deteksi
  // sama dengan doctor — modul bersama, tidak ada duplikasi logika).
  const env = parseEnvFile(ENV_PATH);
  const specFilters = runnableSpecFilters(env);
  const binPath = fileURLToPath(new URL('../../node_modules/.bin/playwright', import.meta.url));
  if (specFilters.length > 0) {
    steps.push({
      name: `e2e (${specFilters.length}/${SPECS.length} spec)`,
      cmd: binPath,
      args: ['test', ...specFilters, '--reporter=line'],
    });
  }

  const results = [];
  for (let i = 0; i < steps.length; i += 1) {
    const result = runStep(steps[i].name, steps[i].cmd, steps[i].args);
    results.push(result);
    printStepResult(result, i, steps.length);
  }

  console.log('\n== ringkasan verify ==');
  for (const result of results) {
    const mark = result.failed ? `${RED}✗${RESET}` : `${GREEN}✓${RESET}`;
    console.log(`  ${mark} ${result.name.padEnd(24)} ${sec(result.duration)}`);
  }
  if (specFilters.length === 0) {
    console.log(
      `  ${YELLOW}⚠${RESET} langkah e2e DILEWATI — tidak ada spec runnable (e2e/*.spec.ts hilang?)`,
    );
  } else if (specFilters.length < SPECS.length) {
    console.log(
      `  ${DIM}e2e menjalankan ${specFilters.length}/${SPECS.length} spec — sisanya menunggu env (lihat bun run doctor)${RESET}`,
    );
  }

  const failedSteps = results.filter((result) => result.failed);
  if (failedSteps.length === 0) {
    console.log(`${GREEN}SEMUA ${results.length} LANGKAH LULUS — gerbang hijau (exit 0)${RESET}`);
    process.exit(0);
  }
  console.log(
    `${RED}${failedSteps.length}/${results.length} langkah GAGAL: ${failedSteps.map((s) => s.name).join(', ')} (exit 1)${RESET}`,
  );
  process.exit(1);
}

if (isMain) {
  await main();
}
