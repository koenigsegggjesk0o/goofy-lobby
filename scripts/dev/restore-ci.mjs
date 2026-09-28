#!/usr/bin/env bun
/**
 * scripts/dev/restore-ci.mjs — pulihkan .github/workflows setelah reset sandbox.
 *
 * MASALAH (insiden reset #3; terkonfirmasi ulang 28 Sep 2026): file workflow
 * CI TIDAK pernah bisa di-commit — PAT GitHub tanpa scope `workflow` menolak
 * push yang menyentuh .github/workflows. Bukti empiris segar (Task 17):
 * remote rejected "refusing to allow a Personal Access Token to create or
 * update workflow `.github/workflows/ci.yml` without `workflow` scope".
 * Karena itu .github/ di-exclude lokal (.git/info/exclude) supaya push repo
 * TIDAK ikut terblokir — akibatnya file di sana untracked dan TERSAPU reset
 * sandbox (2 file era F1.7 sempat hilang permanen).
 *
 * SOLUSI: salinan kanonik DILACAK GIT di ci/workflows/ (kebal reset), dan
 * script ini menyalinnya ke .github/workflows/ — idempoten, hanya menulis
 * bila isinya beda. Jalankan setiap kali setelah reset sandbox:
 *   bun scripts/dev/restore-ci.mjs
 *
 * Saat PAT sudah diberi scope Workflows read/write: hapus baris `.github/`
 * dari .git/info/exclude, git add -f .github/workflows, push — lalu script
 * ini boleh dipensiunkan.
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

// fileURLToPath(import.meta.url) — standar Node/Bun. (JANGAN import.meta.dir:
// properti itu hanya ada di runtime Bun; modul ini diimpor vitest berbasis
// Node, dan path.resolve(undefined) melempar TypeError — tertangkap test.)
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const CANONICAL_DIR = path.join(ROOT, 'ci', 'workflows');
const TARGET_DIR = path.join(ROOT, '.github', 'workflows');

/**
 * Sinkronkan salinan kanonik → .github/workflows.
 *
 * Daftar file dibaca dari isi direktori kanonik (bukan hardcode) — workflow
 * baru cukup ditambahkan ke ci/workflows/ dan otomatis ikut dipulihkan.
 * Hanya file *.yml yang disinkronkan; berkas lain di ci/workflows/ diabaikan.
 *
 * @param {{ canonicalDir?: string, targetDir?: string }} [options]
 * @returns {{ copied: string[], skipped: string[] }} nama file yang ditulis
 *   (isinya beda / belum ada) dan yang dilewati karena sudah identik.
 */
export function restoreWorkflows(options = {}) {
  const { canonicalDir = CANONICAL_DIR, targetDir = TARGET_DIR } = options;

  if (!existsSync(canonicalDir)) {
    throw new Error(`direktori kanonik tidak ada: ${canonicalDir}`);
  }

  const files = readdirSync(canonicalDir)
    .filter((name) => name.endsWith('.yml'))
    .sort();
  const copied = [];
  const skipped = [];

  mkdirSync(targetDir, { recursive: true });

  for (const name of files) {
    const content = readFileSync(path.join(canonicalDir, name), 'utf8');
    const target = path.join(targetDir, name);
    const identical = existsSync(target) && readFileSync(target, 'utf8') === content;
    if (identical) {
      skipped.push(name);
    } else {
      writeFileSync(target, content);
      copied.push(name);
    }
  }

  return { copied, skipped };
}

/**
 * Guard keamanan push: `.github/` harus tetap ada di .git/info/exclude
 * selama PAT belum punya scope workflow — kalau baris itu hilang, `git add .`
 * bisa ikut men-stage file workflow dan MEMBLOKIR push berikutnya
 * (GitHub menolak seluruh push, bukan hanya file workflow-nya).
 *
 * @param {string} excludeText isi .git/info/exclude
 * @returns {boolean} true bila ada entri yang meng-exclude .github
 */
export function excludeGuardPresent(excludeText) {
  return excludeText
    .split('\n')
    .map((line) => line.trim())
    .some((line) => line === '.github/' || line === '.github');
}

const isMain = import.meta.url === pathToFileURL(process.argv[1] ?? '').href;

if (isMain) {
  const { copied, skipped } = restoreWorkflows();
  console.log(`restore-ci: ${copied.length} disalin, ${skipped.length} sudah identik.`);
  for (const name of copied) console.log(`  + ${name}`);
  for (const name of skipped) console.log(`  = ${name} (identik, dilewati)`);

  const excludePath = path.join(ROOT, '.git', 'info', 'exclude');
  if (existsSync(excludePath) && !excludeGuardPresent(readFileSync(excludePath, 'utf8'))) {
    console.warn(
      '⚠ .github/ TIDAK ditemukan di .git/info/exclude — JANGAN commit file ' +
        '.github/workflows sebelum PAT punya scope workflow ' +
        '(push akan ditolak menyeluruh). Tambahkan baris `.github/` kembali.',
    );
  }
}
