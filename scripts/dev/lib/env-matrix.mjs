/**
 * Modul bersama untuk doctor.mjs dan verify.mjs — SATU sumber kebenaran
 * untuk parsing .env (NAMA variabel saja, nilai tidak pernah dibaca/dicetak)
 * dan matriks spec e2e mana yang runnable berdasarkan kelengkapan env.
 *
 * Diekstrak dari doctor.mjs (Task 10-d) supaya verify.mjs tidak menduplikasi
 * logika deteksi spec — duplikasi dua tempat akan melayang saat env/spec
 * bertambah. Modul ini TIDAK mengeksekusi apa pun saat diimpor.
 */
import { existsSync, readFileSync } from 'node:fs';

/**
 * Daftar nama variabel .env yang terisi (nilai TIDAK pernah dibaca/dicetak).
 * Baris kosong/komentar diabaikan; `KEY=` (nilai kosong) dianggap TIDAK terisi.
 * @param {string} path
 * @returns {Set<string>}
 */
export function parseEnvFile(path) {
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

/**
 * Matriks spec e2e + pra-syarat env masing-masing (urutan = urutan tampil
 * doctor; no-auth duluan karena selalu runnable).
 */
export const SPECS = [
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

/**
 * Evaluasi grup flag env dari himpunan nama var terisi.
 * @param {Set<string>} env
 * @returns {{ clientEnvReady: boolean, hasSentryDsn: boolean, hasAlpha: boolean, hasBravo: boolean, hasCharlie: boolean }}
 */
export function evaluateEnv(env) {
  return {
    clientEnvReady: env.has('VITE_SUPABASE_URL') && env.has('VITE_SUPABASE_ANON_KEY'),
    hasSentryDsn: env.has('VITE_SENTRY_DSN'),
    hasAlpha:
      env.has('TEST_USER_ALPHA_EMAIL') &&
      env.has('TEST_USER_ALPHA_PASSWORD') &&
      env.has('TEST_USER_ALPHA_ID'),
    hasBravo:
      env.has('TEST_USER_BRAVO_EMAIL') &&
      env.has('TEST_USER_BRAVO_PASSWORD') &&
      env.has('TEST_USER_BRAVO_ID'),
    hasCharlie:
      env.has('TEST_USER_CHARLIE_EMAIL') &&
      env.has('TEST_USER_CHARLIE_PASSWORD') &&
      env.has('TEST_USER_CHARLIE_ID'),
  };
}

/**
 * Spec runnable sekarang? (no-auth selalu ya; sisanya sesuai flag grup)
 * @param {string} need
 * @param {ReturnType<evaluateEnv>} flags
 */
export function specRunnable(need, flags) {
  if (need === 'tidak ada (no-auth)') return true;
  if (!flags.clientEnvReady) return false;
  if (need.includes('SENTRY_DSN')) return flags.hasSentryDsn;
  if (need.includes('alpha+bravo+charlie'))
    return flags.hasAlpha && flags.hasBravo && flags.hasCharlie;
  if (need.includes('alpha+bravo')) return flags.hasAlpha && flags.hasBravo;
  if (need.includes('QA alpha')) return flags.hasAlpha;
  return true;
}

/**
 * Daftar filter spec (tanpa ekstensi — cocok utk filter posisi Playwright)
 * yang runnable berdasarkan .env saat ini.
 * @param {Set<string>} env
 * @returns {string[]}
 */
export function runnableSpecFilters(env) {
  const flags = evaluateEnv(env);
  return SPECS.filter((spec) => specRunnable(spec.need, flags)).map((spec) =>
    spec.file.replace(/\.spec\.ts$/, ''),
  );
}
