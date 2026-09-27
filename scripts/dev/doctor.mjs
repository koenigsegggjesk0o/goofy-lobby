/**
 * Doctor lingkungan dev (bukan produk) — triage cepat pasca-insiden/sesaat
 * sebelum siklus kerja: kelengkapan .env (NAMA variabel saja, nilai TIDAK
 * pernah dicetak), dev server :3000, autentikasi push git, dan matriks
 * spec e2e mana yang bisa dijalankan sekarang.
 *
 * Jalankan: bun scripts/dev/doctor.mjs
 * Exit code: 0 = tidak ada bloker; 1 = ada bloker (lihat ringkasan akhir).
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const ROOT = resolve(import.meta.dirname, '../..');
const ENV_PATH = resolve(ROOT, '.env');

const RED = '\x1b[31m';
const GREEN = '\x1b[32m';
const YELLOW = '\x1b[33m';
const DIM = '\x1b[2m';
const RESET = '\x1b[0m';

function parseEnvFile(path) {
  const values = new Set();
  if (!existsSync(path)) return values;
  for (const rawLine of readFileSync(path, 'utf8').split('\n')) {
    const line = rawLine.trim();
    if (line === '' || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq <= 0) continue;
    if (line.slice(eq + 1).trim() !== '') values.add(line.slice(0, eq).trim());
  }
  return values;
}

const env = parseEnvFile(ENV_PATH);
const blockers = [];

// --- 1. Kelengkapan .env (nama saja — nilai tidak pernah dibaca/dicetak) ---
console.log('\n== .env (nama variabel saja, nilai tidak pernah dicetak) ==');
const groups = [
  {
    label: 'klien inti (harness "siap")',
    required: ['VITE_SUPABASE_URL', 'VITE_SUPABASE_ANON_KEY'],
    critical: true,
  },
  {
    label: 'server-side (runner migrasi, admin API)',
    required: ['SUPABASE_SERVICE_ROLE_KEY', 'SUPABASE_ACCESS_TOKEN'],
    critical: false,
  },
  {
    label: 'fungsional opsional',
    required: ['VITE_TURNSTILE_SITE_KEY', 'VITE_SENTRY_DSN'],
    critical: false,
  },
  {
    label: 'e2e QA users (alpha/bravo/charlie)',
    required: [
      'TEST_USER_ALPHA_EMAIL',
      'TEST_USER_ALPHA_PASSWORD',
      'TEST_USER_ALPHA_ID',
      'TEST_USER_BRAVO_EMAIL',
      'TEST_USER_BRAVO_PASSWORD',
      'TEST_USER_BRAVO_ID',
      'TEST_USER_CHARLIE_EMAIL',
      'TEST_USER_CHARLIE_PASSWORD',
      'TEST_USER_CHARLIE_ID',
    ],
    critical: false,
  },
  {
    label: 'TURN Fase 2 (opsional — fallback STUN-only bila kosong)',
    required: ['VITE_TURN_URL', 'VITE_TURN_USERNAME', 'VITE_TURN_CREDENTIAL'],
    critical: false,
  },
];
for (const group of groups) {
  const missing = group.required.filter((name) => !env.has(name));
  if (missing.length === 0) {
    console.log(`  ${GREEN}✓${RESET} ${group.label}: lengkap (${group.required.length})`);
  } else {
    const color = group.critical ? RED : YELLOW;
    console.log(
      `  ${color}✗${RESET} ${group.label}: kurang ${missing.length}/${group.required.length}`,
    );
    for (const name of missing) console.log(`      - ${name}`);
    if (group.critical) blockers.push(`env klien inti kurang: ${missing.join(', ')}`);
  }
}
if (!existsSync(ENV_PATH)) blockers.push('.env tidak ada sama sekali');

const clientEnvReady = env.has('VITE_SUPABASE_URL') && env.has('VITE_SUPABASE_ANON_KEY');
const hasSentryDsn = env.has('VITE_SENTRY_DSN');
const hasAlpha =
  env.has('TEST_USER_ALPHA_EMAIL') &&
  env.has('TEST_USER_ALPHA_PASSWORD') &&
  env.has('TEST_USER_ALPHA_ID');
const hasBravo =
  env.has('TEST_USER_BRAVO_EMAIL') &&
  env.has('TEST_USER_BRAVO_PASSWORD') &&
  env.has('TEST_USER_BRAVO_ID');
const hasCharlie =
  env.has('TEST_USER_CHARLIE_EMAIL') &&
  env.has('TEST_USER_CHARLIE_PASSWORD') &&
  env.has('TEST_USER_CHARLIE_ID');

// --- 2. Dev server Vite :3000 ---
console.log('\n== dev server (port 3000) ==');
async function probeServer() {
  for (const path of ['/', '/test-harness/']) {
    try {
      const response = await fetch(`http://localhost:3000${path}`, {
        signal: AbortSignal.timeout(5000),
      });
      console.log(`  ${response.ok ? GREEN : YELLOW}${response.status}${RESET} GET ${path}`);
    } catch {
      console.log(`  ${RED}MATI${RESET} GET ${path} — dev server tidak merespons`);
      blockers.push(`dev server mati (GET ${path} gagal)`);
      return;
    }
  }
}
await probeServer();

// --- 3. Git: sinkron remote + autentikasi push ---
console.log('\n== git ==');
function git(args) {
  try {
    return {
      ok: true,
      out: execFileSync('git', args, {
        cwd: ROOT,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      }),
    };
  } catch (error) {
    return { ok: false, out: `${error.stdout ?? ''}${error.stderr ?? ''}` };
  }
}
const head = git(['rev-parse', 'HEAD']);
const remote = git(['ls-remote', 'origin', 'main']);
if (head.ok && remote.ok) {
  const local = head.out.trim().split('\n')[0];
  const remoteMain = remote.out.trim().split('\t')[0];
  if (local === remoteMain) {
    console.log(`  ${GREEN}✓${RESET} HEAD ${local.slice(0, 8)} = origin/main (sinkron)`);
  } else {
    console.log(
      `  ${YELLOW}~${RESET} HEAD ${local.slice(0, 8)} ≠ origin/main ${remoteMain.slice(0, 8)} — commit lokal belum ter-push`,
    );
    blockers.push(
      `origin/main tertinggal (${local.slice(0, 8)} lokal vs ${remoteMain.slice(0, 8)} remote)`,
    );
  }
} else {
  console.log(`  ${RED}✗${RESET} git/ls-remote gagal — remote tidak terjangkau`);
  blockers.push('git ls-remote gagal');
}
const push = git(['push', '--dry-run', 'origin', 'main']);
if (push.ok) {
  console.log(`  ${GREEN}✓${RESET} autentikasi push: BISA (dry-run ok)`);
} else {
  const noAuth =
    push.out.includes('could not read Username') || push.out.includes('Authentication failed');
  console.log(
    `  ${RED}✗${RESET} autentikasi push: TIDAK BISA${noAuth ? ' (kredensial hilang/belum dipasang)' : ` — ${push.out.trim().split('\n')[0]}`}`,
  );
  blockers.push('git push tidak berautentikasi (PAT hilang/belum dipasang)');
}

// --- 4. Matriks spec e2e yang bisa dijalankan sekarang ---
console.log('\n== spec e2e runnable ==');
const specs = [
  { file: 'turn-config.spec.ts', need: 'tidak ada (no-auth)' },
  { file: 'mesh-trail.spec.ts', need: 'tidak ada (no-auth)' },
  { file: 'audio-smoke.spec.ts', need: 'env klien inti' },
  { file: 'monitoring.spec.ts', need: 'env klien inti + VITE_SENTRY_DSN' },
  { file: 'auth.spec.ts', need: 'env klien inti + QA alpha' },
  { file: 'mesh.spec.ts', need: 'env klien inti + QA alpha+bravo' },
  { file: 'mesh-three-peers.spec.ts', need: 'env klien inti + QA alpha+bravo+charlie' },
  { file: 'profiles-rls.spec.ts', need: 'env klien inti + QA alpha+bravo' },
  { file: 'snippet.spec.ts', need: 'env klien inti + QA alpha+bravo' },
];
function specRunnable(need) {
  if (need === 'tidak ada (no-auth)') return true;
  if (!clientEnvReady) return false;
  if (need.includes('SENTRY_DSN')) return hasSentryDsn;
  if (need.includes('alpha+bravo+charlie')) return hasAlpha && hasBravo && hasCharlie;
  if (need.includes('alpha+bravo')) return hasAlpha && hasBravo;
  if (need.includes('QA alpha')) return hasAlpha;
  return true;
}
for (const spec of specs) {
  const runnable = specRunnable(spec.need);
  console.log(
    `  ${runnable ? GREEN : YELLOW}${runnable ? '✓' : '✗'}${RESET} ${spec.file} — butuh: ${spec.need}`,
  );
}
console.log(
  `  ${DIM}(unit test / typecheck / lint / build tidak butuh kredensial — selalu runnable)${RESET}`,
);

// --- Ringkasan ---
console.log('\n== ringkasan ==');
if (blockers.length === 0) {
  console.log(`${GREEN}STATUS: SEHAT — tidak ada bloker.${RESET}`);
  process.exit(0);
}
console.log(`${RED}STATUS: TERDEGRADI — ${blockers.length} bloker:${RESET}`);
for (const blocker of blockers) console.log(`  - ${blocker}`);
process.exit(1);
