#!/usr/bin/env bun
/**
 * scripts/dev/restore-ci.mjs — pulihkan .github/ setelah reset sandbox.
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
 * SOLUSI: salinan kanonik DILACAK GIT di ci/ (kebal reset), dan script ini
 * menyalinnya ke .github/ — idempoten, hanya menulis bila isinya beda:
 *   - ci/workflows/*.yml        → .github/workflows/  (dinamis per isi dir)
 *   - ci/github/{dependabot.yml,CODEOWNERS,SECURITY.md} → .github/
 *     (whitelist eksplisit — Task 26-e: file .github/ non-workflow ikut
 *     pola rumah yang sama)
 * Jalankan setiap kali setelah reset sandbox:
 *   bun scripts/dev/restore-ci.mjs
 *
 * Saat PAT sudah diberi scope Workflows read/write: hapus baris `.github/`
 * dari .git/info/exclude, git add -f .github, push — lalu script ini boleh
 * dipensiunkan.
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
const GITHUB_CANONICAL_DIR = path.join(ROOT, 'ci', 'github');
const GITHUB_TARGET_DIR = path.join(ROOT, '.github');

// Whitelist EKSPLISIT file .github/ non-workflow yang dikelola kanonik di
// ci/github/ (Task 26-e). Sengaja tidak dinamis per isi direktori — beda
// dengan ci/workflows/: file .github/ lain (FUNDING, ISSUE_TEMPLATE/, dsb.)
// bentuknya bermacam-macam dan belum tentu mau kita kelola; salin buta
// rawan menimpa file lokal yang bukan milik pola ini.
const GITHUB_FILES = ['CODEOWNERS', 'SECURITY.md', 'dependabot.yml'];

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
 * Sinkronkan salinan kanonik ci/github/ → .github/ (file non-workflow:
 * dependabot.yml, CODEOWNERS, SECURITY.md — Task 26-e).
 *
 * Hanya file dalam whitelist GITHUB_FILES yang disalin; file lain di
 * ci/github/ diabaikan. File whitelist yang belum ada di direktori kanonik
 * dilewati (tidak error) — subset kanonik tetap sah. Idempoten seperti
 * restoreWorkflows: hanya menulis bila isinya beda.
 *
 * @param {{ canonicalDir?: string, targetDir?: string }} [options]
 * @returns {{ copied: string[], skipped: string[] }} nama file yang ditulis
 *   (isinya beda / belum ada) dan yang dilewati karena sudah identik.
 */
export function restoreGitHubFiles(options = {}) {
  const { canonicalDir = GITHUB_CANONICAL_DIR, targetDir = GITHUB_TARGET_DIR } = options;

  if (!existsSync(canonicalDir)) {
    throw new Error(`direktori kanonik tidak ada: ${canonicalDir}`);
  }

  const copied = [];
  const skipped = [];

  mkdirSync(targetDir, { recursive: true });

  for (const name of GITHUB_FILES) {
    const source = path.join(canonicalDir, name);
    if (!existsSync(source)) continue;
    const content = readFileSync(source, 'utf8');
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
  console.log(`restore-ci: ${copied.length} workflow disalin, ${skipped.length} sudah identik.`);
  for (const name of copied) console.log(`  + workflows/${name}`);
  for (const name of skipped) console.log(`  = workflows/${name} (identik, dilewati)`);

  const gh = restoreGitHubFiles();
  console.log(
    `restore-ci: ${gh.copied.length} file .github/ disalin, ${gh.skipped.length} sudah identik.`,
  );
  for (const name of gh.copied) console.log(`  + .github/${name}`);
  for (const name of gh.skipped) console.log(`  = .github/${name} (identik, dilewati)`);

  const excludePath = path.join(ROOT, '.git', 'info', 'exclude');
  if (existsSync(excludePath) && !excludeGuardPresent(readFileSync(excludePath, 'utf8'))) {
    console.warn(
      '⚠ .github/ TIDAK ditemukan di .git/info/exclude — JANGAN commit file ' +
        '.github/ sebelum PAT punya scope workflow ' +
        '(push akan ditolak menyeluruh). Tambahkan baris `.github/` kembali.',
    );
  }
}
