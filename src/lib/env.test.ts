import { afterEach, describe, expect, it, vi } from 'vitest';

import { MissingClientEnvError, readClientEnv, type ClientEnv } from './env';

/**
 * Unit test untuk readClientEnv (Task 10-b — menutup celah unit-coverage
 * modul lib terakhir yang belum teruji, bersama supabase.test.ts).
 *
 * Dua lapis (pola turn-config.test.ts):
 * 1. Source injeksi — parsing murni: wajib/opsional/trim/error contract.
 * 2. Default source = import.meta.env — diverifikasi lewat vi.stubEnv.
 */

const SOURCE_LENGKAP: Record<string, string | undefined> = {
  VITE_SUPABASE_URL: 'https://unit-test.supabase.co',
  VITE_SUPABASE_ANON_KEY: 'anon-key-unit-test',
  VITE_TURNSTILE_SITE_KEY: '0x4AAAAAAA-unit-test',
  VITE_SENTRY_DSN: 'https://abc123@example.test/2',
};

describe('readClientEnv — source injeksi', () => {
  it('source lengkap → ClientEnv utuh (nilai persis)', () => {
    const env = readClientEnv(SOURCE_LENGKAP);

    expect(env).toEqual({
      supabaseUrl: 'https://unit-test.supabase.co',
      supabaseAnonKey: 'anon-key-unit-test',
      turnstileSiteKey: '0x4AAAAAAA-unit-test',
      sentryDsn: 'https://abc123@example.test/2',
    } satisfies ClientEnv);
  });

  it('VITE_SUPABASE_URL kosong → MissingClientEnvError, missing hanya itu', () => {
    const source = { ...SOURCE_LENGKAP, VITE_SUPABASE_URL: undefined };

    const error = capture(() => readClientEnv(source));
    expect(error).toBeInstanceOf(MissingClientEnvError);
    expect(error?.missing).toEqual(['VITE_SUPABASE_URL']);
  });

  it('kedua wajib kosong → missing berisi keduanya, urutan stabil', () => {
    const source: Record<string, string | undefined> = {
      ...SOURCE_LENGKAP,
      VITE_SUPABASE_URL: undefined,
      VITE_SUPABASE_ANON_KEY: undefined,
    };

    const error = capture(() => readClientEnv(source));
    expect(error?.missing).toEqual(['VITE_SUPABASE_URL', 'VITE_SUPABASE_ANON_KEY']);
  });

  it('nilai whitespace-only dianggap kosong (trim dulu, lalu validasi)', () => {
    const source = { ...SOURCE_LENGKAP, VITE_SUPABASE_ANON_KEY: '   ' };

    const error = capture(() => readClientEnv(source));
    expect(error?.missing).toEqual(['VITE_SUPABASE_ANON_KEY']);
  });

  it('nilai ter-trim: spasi di tepi dibuang dari hasil', () => {
    const source = {
      ...SOURCE_LENGKAP,
      VITE_SUPABASE_URL: '  https://unit-test.supabase.co  ',
    };

    expect(readClientEnv(source).supabaseUrl).toBe('https://unit-test.supabase.co');
  });

  it('opsional hilang → undefined (bukan string kosong)', () => {
    const source: Record<string, string | undefined> = {
      VITE_SUPABASE_URL: 'https://unit-test.supabase.co',
      VITE_SUPABASE_ANON_KEY: 'anon-key-unit-test',
    };

    const env = readClientEnv(source);
    expect(env.turnstileSiteKey).toBeUndefined();
    expect(env.sentryDsn).toBeUndefined();
  });

  it('opsional whitespace-only → undefined', () => {
    const source = { ...SOURCE_LENGKAP, VITE_SENTRY_DSN: ' \t ' };

    expect(readClientEnv(source).sentryDsn).toBeUndefined();
  });

  it('opsional terisi → nilai ter-trim', () => {
    const source = { ...SOURCE_LENGKAP, VITE_TURNSTILE_SITE_KEY: ' 0x4AAA ' };

    expect(readClientEnv(source).turnstileSiteKey).toBe('0x4AAA');
  });

  it('kontrak error: name, instanceof Error, pesan memandu .env.example', () => {
    const error = capture(() => readClientEnv({}));

    expect(error).toBeInstanceOf(Error);
    expect(error?.name).toBe('MissingClientEnvError');
    expect(error?.message).toContain('VITE_SUPABASE_URL');
    expect(error?.message).toContain('.env.example');
  });
});

describe('readClientEnv — default source (import.meta.env)', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('membaca import.meta.env yang di-stub (jalur default tanpa injeksi)', () => {
    vi.stubEnv('VITE_SUPABASE_URL', 'https://stub-test.supabase.co');
    vi.stubEnv('VITE_SUPABASE_ANON_KEY', 'anon-stub-key');

    const env = readClientEnv();
    expect(env.supabaseUrl).toBe('https://stub-test.supabase.co');
    expect(env.supabaseAnonKey).toBe('anon-stub-key');
  });

  it('import.meta.env wajib kosong → MissingClientEnvError via jalur default', () => {
    vi.stubEnv('VITE_SUPABASE_URL', '');
    vi.stubEnv('VITE_SUPABASE_ANON_KEY', '');

    const error = capture(() => readClientEnv());
    expect(error).toBeInstanceOf(MissingClientEnvError);
    expect(error?.missing).toEqual(['VITE_SUPABASE_URL', 'VITE_SUPABASE_ANON_KEY']);
  });
});

function capture(fn: () => unknown): MissingClientEnvError | undefined {
  try {
    fn();
  } catch (error) {
    return error as MissingClientEnvError;
  }
  return undefined;
}
