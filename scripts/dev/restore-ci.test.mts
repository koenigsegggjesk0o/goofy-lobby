import { describe, expect, it } from 'vitest';
import { access, mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * Test LANGSUNG restore-ci (Task 17) — pemulih .github/workflows dari salinan
 * kanonik ci/workflows/ (kebal reset sandbox; file di .github/ tidak bisa
 * di-commit karena PAT tanpa scope workflow).
 *
 * Task 26-e: restore-ci diperluas — file .github/ non-workflow
 * (dependabot.yml, CODEOWNERS, SECURITY.md) kini kanonik di ci/github/
 * dan disinkronkan restoreGitHubFiles (whitelist eksplisit).
 *
 * Modul restore-ci.mjs aman diimpor di vitest: efek samping (console/exit)
 * di-guard isMain. Semua test memakai direktori semaunya + fs SUNGGUHAN
 * (mkdtemp) — tanpa mock.
 */

interface RestoreResultLike {
  copied: string[];
  skipped: string[];
}

const { restoreWorkflows, restoreGitHubFiles, excludeGuardPresent } =
  (await import('./restore-ci.mjs')) as {
    restoreWorkflows: (options?: {
      canonicalDir?: string;
      targetDir?: string;
    }) => RestoreResultLike;
    restoreGitHubFiles: (options?: {
      canonicalDir?: string;
      targetDir?: string;
    }) => RestoreResultLike;
    excludeGuardPresent: (excludeText: string) => boolean;
  };

async function makeTempDirs() {
  const base = await mkdtemp(join(tmpdir(), 'restore-ci-'));
  return {
    base,
    canonicalDir: join(base, 'canonical'),
    targetDir: join(base, 'nested', 'target'),
  };
}

describe('restoreWorkflows — sinkron ci/workflows → .github/workflows', () => {
  it('target kosong: semua .yml disalin, isi identik byte-per-byte', async () => {
    const { canonicalDir, targetDir, base } = await makeTempDirs();
    try {
      await mkdir(canonicalDir, { recursive: true });
      await writeFile(join(canonicalDir, 'a.yml'), 'name: A\n');
      await writeFile(join(canonicalDir, 'b.yml'), 'name: B\n');

      const result = restoreWorkflows({ canonicalDir, targetDir });

      expect(result.copied).toEqual(['a.yml', 'b.yml']);
      expect(result.skipped).toEqual([]);
      expect(await readFile(join(targetDir, 'a.yml'), 'utf8')).toBe('name: A\n');
      expect(await readFile(join(targetDir, 'b.yml'), 'utf8')).toBe('name: B\n');
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  });

  it('idempoten: run kedua semua dilewati (tidak menulis ulang)', async () => {
    const { canonicalDir, targetDir, base } = await makeTempDirs();
    try {
      await mkdir(canonicalDir, { recursive: true });
      await writeFile(join(canonicalDir, 'ci.yml'), 'name: CI\n');

      restoreWorkflows({ canonicalDir, targetDir });
      const second = restoreWorkflows({ canonicalDir, targetDir });

      expect(second.copied).toEqual([]);
      expect(second.skipped).toEqual(['ci.yml']);
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  });

  it('target yang dimodifikasi ditimpa kembali ke isi kanonik', async () => {
    const { canonicalDir, targetDir, base } = await makeTempDirs();
    try {
      await mkdir(canonicalDir, { recursive: true });
      await writeFile(join(canonicalDir, 'keep.yml'), 'name: BENAR\n');
      await mkdir(targetDir, { recursive: true });
      await writeFile(join(targetDir, 'keep.yml'), 'name: DIRUSAK\n');

      const result = restoreWorkflows({ canonicalDir, targetDir });

      expect(result.copied).toEqual(['keep.yml']);
      expect(await readFile(join(targetDir, 'keep.yml'), 'utf8')).toBe('name: BENAR\n');
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  });

  it('file non-.yml di direktori kanonik diabaikan', async () => {
    const { canonicalDir, targetDir, base } = await makeTempDirs();
    try {
      await mkdir(canonicalDir, { recursive: true });
      await writeFile(join(canonicalDir, 'ok.yml'), 'name: OK\n');
      await writeFile(join(canonicalDir, 'README.md'), '# catatan\n');

      const result = restoreWorkflows({ canonicalDir, targetDir });

      expect(result.copied).toEqual(['ok.yml']);
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  });

  it('direktori kanonik kosong = no-op jujur (0 disalin, 0 dilewati)', async () => {
    const { canonicalDir, targetDir, base } = await makeTempDirs();
    try {
      await mkdir(canonicalDir, { recursive: true });

      const result = restoreWorkflows({ canonicalDir, targetDir });

      expect(result.copied).toEqual([]);
      expect(result.skipped).toEqual([]);
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  });

  it('direktori kanonik tidak ada → throw dengan pesan jelas', async () => {
    const { base } = await makeTempDirs();
    try {
      expect(() =>
        restoreWorkflows({
          canonicalDir: join(base, 'tidak-ada'),
          targetDir: join(base, 't'),
        }),
      ).toThrow(/direktori kanonik tidak ada/);
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  });

  it('targetDir bersarang dalam-dalam tetap dibuat otomatis', async () => {
    const { canonicalDir, base } = await makeTempDirs();
    const deepTarget = join(base, 'a', 'b', 'c', 'd');
    try {
      await mkdir(canonicalDir, { recursive: true });
      await writeFile(join(canonicalDir, 'x.yml'), 'x: 1\n');

      const result = restoreWorkflows({
        canonicalDir,
        targetDir: deepTarget,
      });

      expect(result.copied).toEqual(['x.yml']);
      expect(await readFile(join(deepTarget, 'x.yml'), 'utf8')).toBe('x: 1\n');
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  });
});

describe('restoreGitHubFiles — sinkron ci/github → .github (non-workflow)', () => {
  it('target kosong: semua file whitelist disalin, isi identik byte-per-byte', async () => {
    const base = await mkdtemp(join(tmpdir(), 'restore-gh-'));
    const canonicalDir = join(base, 'canonical');
    const targetDir = join(base, 'nested', 'target');
    try {
      await mkdir(canonicalDir, { recursive: true });
      await writeFile(join(canonicalDir, 'dependabot.yml'), 'version: 2\n');
      await writeFile(join(canonicalDir, 'CODEOWNERS'), '* @owner\n');
      await writeFile(join(canonicalDir, 'SECURITY.md'), '# Keamanan\n');

      const result = restoreGitHubFiles({ canonicalDir, targetDir });

      expect(result.copied.sort()).toEqual(['CODEOWNERS', 'SECURITY.md', 'dependabot.yml']);
      expect(result.skipped).toEqual([]);
      expect(await readFile(join(targetDir, 'dependabot.yml'), 'utf8')).toBe('version: 2\n');
      expect(await readFile(join(targetDir, 'CODEOWNERS'), 'utf8')).toBe('* @owner\n');
      expect(await readFile(join(targetDir, 'SECURITY.md'), 'utf8')).toBe('# Keamanan\n');
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  });

  it('idempoten: run kedua semua dilewati (tidak menulis ulang)', async () => {
    const base = await mkdtemp(join(tmpdir(), 'restore-gh-'));
    const canonicalDir = join(base, 'canonical');
    const targetDir = join(base, 'target');
    try {
      await mkdir(canonicalDir, { recursive: true });
      await writeFile(join(canonicalDir, 'CODEOWNERS'), '* @owner\n');

      restoreGitHubFiles({ canonicalDir, targetDir });
      const second = restoreGitHubFiles({ canonicalDir, targetDir });

      expect(second.copied).toEqual([]);
      expect(second.skipped).toEqual(['CODEOWNERS']);
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  });

  it('target yang dimodifikasi ditimpa kembali ke isi kanonik', async () => {
    const base = await mkdtemp(join(tmpdir(), 'restore-gh-'));
    const canonicalDir = join(base, 'canonical');
    const targetDir = join(base, 'target');
    try {
      await mkdir(canonicalDir, { recursive: true });
      await writeFile(join(canonicalDir, 'SECURITY.md'), '# BENAR\n');
      await mkdir(targetDir, { recursive: true });
      await writeFile(join(targetDir, 'SECURITY.md'), '# DIRUSAK\n');

      const result = restoreGitHubFiles({ canonicalDir, targetDir });

      expect(result.copied).toEqual(['SECURITY.md']);
      expect(await readFile(join(targetDir, 'SECURITY.md'), 'utf8')).toBe('# BENAR\n');
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  });

  it('file di luar whitelist di direktori kanonik diabaikan (tidak disalin)', async () => {
    const base = await mkdtemp(join(tmpdir(), 'restore-gh-'));
    const canonicalDir = join(base, 'canonical');
    const targetDir = join(base, 'target');
    try {
      await mkdir(canonicalDir, { recursive: true });
      await writeFile(join(canonicalDir, 'dependabot.yml'), 'version: 2\n');
      await writeFile(join(canonicalDir, 'FUNDING.yml'), 'github: owner\n');

      const result = restoreGitHubFiles({ canonicalDir, targetDir });

      expect(result.copied).toEqual(['dependabot.yml']);
      // FUNDING.yml TIDAK ikut — whitelist eksplisit, bukan salin-buta isi dir.
      await expect(access(join(targetDir, 'FUNDING.yml'))).rejects.toThrow();
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  });

  it('file whitelist yang belum ada di kanonik dilewati tanpa error (subset sah)', async () => {
    const base = await mkdtemp(join(tmpdir(), 'restore-gh-'));
    const canonicalDir = join(base, 'canonical');
    const targetDir = join(base, 'target');
    try {
      await mkdir(canonicalDir, { recursive: true });
      // Hanya 1 dari 3 file whitelist yang ada.
      await writeFile(join(canonicalDir, 'CODEOWNERS'), '* @owner\n');

      const result = restoreGitHubFiles({ canonicalDir, targetDir });

      expect(result.copied).toEqual(['CODEOWNERS']);
      expect(result.skipped).toEqual([]);
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  });

  it('direktori kanonik tidak ada → throw dengan pesan jelas', async () => {
    const base = await mkdtemp(join(tmpdir(), 'restore-gh-'));
    try {
      expect(() =>
        restoreGitHubFiles({
          canonicalDir: join(base, 'tidak-ada'),
          targetDir: join(base, 't'),
        }),
      ).toThrow(/direktori kanonik tidak ada/);
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  });
});

describe('excludeGuardPresent — pengaman .git/info/exclude', () => {
  it('teks berisi baris `.github/` → true', () => {
    expect(excludeGuardPresent('# komentar\n.github/\n')).toBe(true);
  });

  it('teks berisi `.github` tanpa garis miring → tetap true', () => {
    expect(excludeGuardPresent('.github')).toBe(true);
  });

  it('baris yang hanya mengandung .github sebagai substring → false (bukan exclude penuh)', () => {
    expect(excludeGuardPresent('# lihat .github/workflows\nfoo/\n')).toBe(false);
  });

  it('tanpa entri .github sama sekali → false', () => {
    expect(excludeGuardPresent('# *~\ndist/\n')).toBe(false);
    expect(excludeGuardPresent('')).toBe(false);
  });
});
