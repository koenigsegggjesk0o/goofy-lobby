#!/usr/bin/env bun
/**
 * scripts/db/apply-migrations.mjs — runner migrasi Supabase via Management API.
 *
 * Membaca SUPABASE_ACCESS_TOKEN + SUPABASE_PROJECT_REF dari .env (lokal,
 * gitignored), membandingkan file supabase/migrations/*.sql dengan history
 * migrasi di server, lalu meng-apply yang belum ada (urut nama file).
 *
 * Jalankan: bun scripts/db/apply-migrations.mjs [--dry-run]
 *
 * Catatan: token HARUS punya permission database_migrations_write
 * (token read-only akan ditolak 403).
 */

import { readdir, readFile } from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dir, '..', '..');
const MIGRATIONS_DIR = path.join(ROOT, 'supabase', 'migrations');
const DRY_RUN = process.argv.includes('--dry-run');

function parseEnv() {
  const file = path.join(ROOT, '.env');
  const out = {};
  if (!existsSync(file)) return out;
  for (const line of readFileSync(file, 'utf-8').split('\n')) {
    if (line.trim().startsWith('#')) continue;
    const m = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
    if (m) out[m[1]] = m[2];
  }
  return out;
}

const env = parseEnv();
// Proses env diutamakan di atas .env (12-factor): token bisa diberikan inline
// lewat `SUPABASE_ACCESS_TOKEN=... bun scripts/db/apply-migrations.mjs`
// tanpa pernah menulis kredensial ke disk.
const TOKEN = process.env['SUPABASE_ACCESS_TOKEN'] ?? env['SUPABASE_ACCESS_TOKEN'];
const REF = process.env['SUPABASE_PROJECT_REF'] ?? env['SUPABASE_PROJECT_REF'];

if (!TOKEN || !REF) {
  console.error(
    '[apply-migrations] SUPABASE_ACCESS_TOKEN / SUPABASE_PROJECT_REF tidak ada di .env',
  );
  process.exit(1);
}

const API = 'https://api.supabase.com';

async function api(method, urlPath, body) {
  const res = await fetch(`${API}${urlPath}`, {
    method,
    headers: {
      Authorization: `Bearer ${TOKEN}`,
      'Content-Type': 'application/json',
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    json = text;
  }
  return { status: res.status, json };
}

const list = await api('GET', `/v1/projects/${REF}/database/migrations`);
if (list.status !== 200) {
  console.error(`[apply-migrations] gagal list history: HTTP ${list.status}`, list.json);
  process.exit(1);
}
const applied = new Set(
  (Array.isArray(list.json) ? list.json : []).map((m) => m.name ?? m.version).filter(Boolean),
);

const files = (await readdir(MIGRATIONS_DIR)).filter((f) => f.endsWith('.sql')).sort();
const pending = files.filter((f) => !applied.has(path.basename(f, '.sql')));

console.log(
  `[apply-migrations] server: ${applied.size} applied | lokal: ${files.length} file | pending: ${pending.length}`,
);

if (pending.length === 0) {
  console.log('[apply-migrations] tidak ada migrasi baru. Selesai.');
  process.exit(0);
}

if (DRY_RUN) {
  for (const f of pending) console.log(`  (dry-run) akan apply: ${f}`);
  process.exit(0);
}

let failed = false;
for (const f of pending) {
  const name = path.basename(f, '.sql');
  const query = await readFile(path.join(MIGRATIONS_DIR, f), 'utf-8');
  const res = await api('POST', `/v1/projects/${REF}/database/migrations`, { query, name });
  if (res.status === 200 || res.status === 201) {
    console.log(`  ✅ ${f}: applied`);
  } else {
    console.error(`  ❌ ${f}: HTTP ${res.status}`, res.json);
    failed = true;
    break;
  }
}

process.exit(failed ? 1 : 0);
