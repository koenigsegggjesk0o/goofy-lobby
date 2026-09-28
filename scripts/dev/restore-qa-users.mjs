#!/usr/bin/env bun
/**
 * scripts/dev/restore-qa-users.mjs — pulihkan QA users setelah reset sandbox.
 *
 * MASALAH BERULANG (insiden #1–#5): reset sandbox menyapu .env yang
 * di-gitignore — termasuk password QA yang nilainya acak dan TIDAK mungkin
 * dipulihkan (ter-hash di server). User ID + email QA stabil di cloud,
 * jadi pemulihannya cukup: reset password via admin API (service_role)
 * lalu tulis ulang baris TEST_USER_* di .env.
 *
 * Jalankan SETELAH .env berisi minimal SUPABASE_SERVICE_ROLE_KEY:
 *   bun scripts/dev/restore-qa-users.mjs
 *
 * Tidak menyentuh baris .env lain; idempoten; password lama yang tersisa
 * di .env ditimpa dengan yang baru.
 */

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dir, '..', '..');
const ENV_PATH = path.join(ROOT, '.env');

/** QA users stabil di cloud (dibuat 27 Sep 2026 via admin API). */
const QA_USERS = [
  {
    role: 'ALPHA',
    email: 'qa.alpha@goofy.example.com',
    id: '7db26a0a-9ce5-4558-bd08-9612e9e9febe',
  },
  {
    role: 'BRAVO',
    email: 'qa.bravo@goofy.example.com',
    id: '6913d097-3811-48e6-93fd-78aadae05f3c',
  },
  {
    role: 'CHARLIE',
    email: 'qa.charlie@goofy.example.com',
    id: '44fc7f03-d44f-4933-9fca-5d9b089e25e2',
  },
];

function parseEnv(text) {
  const out = {};
  for (const line of text.split('\n')) {
    const m = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
    if (m) out[m[1]] = m[2];
  }
  return out;
}

function generatePassword() {
  // 24 hex + suffix memenuhi kebijakan default (≥8, huruf+angka).
  return `${crypto.randomUUID().replace(/-/g, '')}Aa1`;
}

async function main() {
  if (!existsSync(ENV_PATH)) {
    console.error(
      '[restore-qa] .env tidak ditemukan — tulis dulu kredensial inti (lihat .env.example)',
    );
    process.exit(1);
  }
  const envText = readFileSync(ENV_PATH, 'utf8');
  const env = parseEnv(envText);
  const serviceKey = env.SUPABASE_SERVICE_ROLE_KEY;
  const url = env.VITE_SUPABASE_URL;
  if (!serviceKey || !url) {
    console.error('[restore-qa] SUPABASE_SERVICE_ROLE_KEY / VITE_SUPABASE_URL belum ada di .env');
    process.exit(1);
  }

  let text = envText;
  for (const user of QA_USERS) {
    const password = generatePassword();
    const res = await fetch(`${url}/auth/v1/admin/users/${user.id}`, {
      method: 'PUT',
      headers: {
        apikey: serviceKey,
        Authorization: `Bearer ${serviceKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ password, email_confirm: true }),
    });
    if (!res.ok) {
      console.error(`[restore-qa] ${user.role}: HTTP ${res.status} — ${await res.text()}`);
      process.exit(1);
    }
    console.log(
      `[restore-qa] ${user.role} (${user.email}): password di-reset (HTTP ${res.status})`,
    );
    const entries = {
      [`TEST_USER_${user.role}_EMAIL`]: user.email,
      [`TEST_USER_${user.role}_PASSWORD`]: password,
      [`TEST_USER_${user.role}_ID`]: user.id,
    };
    for (const [key, value] of Object.entries(entries)) {
      const re = new RegExp(`^${key}=.*$`, 'm');
      if (re.test(text)) {
        text = text.replace(re, `${key}=${value}`);
      } else {
        text = `${text.trimEnd()}\n${key}=${value}\n`;
      }
    }
  }

  writeFileSync(ENV_PATH, text);
  console.log('[restore-qa] .env diperbarui dengan password baru (3 QA users lengkap).');
  console.log('[restore-qa] selesai — e2e siap dijalankan.');
}

main().catch((error) => {
  console.error('[restore-qa] gagal:', error);
  process.exit(1);
});
