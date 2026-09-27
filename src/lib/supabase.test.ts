import { afterEach, describe, expect, it, vi } from 'vitest';

/**
 * Unit test untuk getAppSupabase (Task 10-b — menutup celah unit-coverage
 * modul lib terakhir yang belum teruji, bersama env.test.ts).
 *
 * Kontrak yang diuji (bukan internals SDK):
 * 1. Env wajib kosong → melempar MissingClientEnvError yang jelas —
 *    TIDAK pernah membuat client parsial dari nilai kosong.
 * 2. Env terisi → client benar-benar dibuat (createClient konstruksi
 *    offline — tanpa permintaan jaringan).
 * 3. Memoisasi singleton: panggilan kedua mengembalikan instance SAMA.
 *
 * Singleton di-cache di level modul → tiap test mengimpor modul SEGAR
 * via vi.resetModules() + dynamic import (isolasi antar-test). Catatan:
 * class error juga harus diambil dari graf modul yang SAMA — instanceof
 * lintas dua instance modul selalu false (tertangkap live di bawah).
 */

async function freshModules(): Promise<{
  supabase: typeof import('./supabase');
  env: typeof import('./env');
}> {
  vi.resetModules();
  const supabase = await import('./supabase');
  const env = await import('./env');
  return { supabase, env };
}

/** Tipe class error dari modul env (tanpa binding runtime). */
type MissingClientEnvErrorClass = (typeof import('./env'))['MissingClientEnvError'];

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

describe('getAppSupabase', () => {
  it('env wajib kosong → MissingClientEnvError, tanpa client parsial', async () => {
    vi.stubEnv('VITE_SUPABASE_URL', '');
    vi.stubEnv('VITE_SUPABASE_ANON_KEY', '');
    const { supabase, env } = await freshModules();

    expect(() => supabase.getAppSupabase()).toThrow(env.MissingClientEnvError);
  });

  it('error membawa daftar missing yang jelas (bukan pesan generik)', async () => {
    vi.stubEnv('VITE_SUPABASE_URL', '');
    vi.stubEnv('VITE_SUPABASE_ANON_KEY', '');
    const { supabase } = await freshModules();

    let caught: InstanceType<MissingClientEnvErrorClass> | undefined;
    try {
      supabase.getAppSupabase();
    } catch (error) {
      caught = error as InstanceType<MissingClientEnvErrorClass>;
    }
    expect(caught?.missing).toEqual(['VITE_SUPABASE_URL', 'VITE_SUPABASE_ANON_KEY']);
  });

  it('env terisi → client dibuat (offline, tanpa jaringan)', async () => {
    vi.stubEnv('VITE_SUPABASE_URL', 'https://unit-test.supabase.co');
    vi.stubEnv('VITE_SUPABASE_ANON_KEY', 'anon-key-unit-test');
    const { supabase } = await freshModules();

    const client = supabase.getAppSupabase();
    expect(client).toBeDefined();
    expect(typeof client.from).toBe('function');
    expect(typeof client.channel).toBe('function');
  });

  it('memoisasi: panggilan kedua instance SAMA (singleton)', async () => {
    vi.stubEnv('VITE_SUPABASE_URL', 'https://unit-test.supabase.co');
    vi.stubEnv('VITE_SUPABASE_ANON_KEY', 'anon-key-unit-test');
    const { supabase } = await freshModules();

    const first = supabase.getAppSupabase();
    const second = supabase.getAppSupabase();
    expect(second).toBe(first);
  });

  it('setelah env berubah pun cache modul tetap dipakai (cache di level modul)', async () => {
    vi.stubEnv('VITE_SUPABASE_URL', 'https://unit-test.supabase.co');
    vi.stubEnv('VITE_SUPABASE_ANON_KEY', 'anon-key-unit-test');
    const { supabase } = await freshModules();

    const first = supabase.getAppSupabase();

    // Ganti stub SETELAH client ter-cache — panggilan berikutnya tetap
    // instance lama (kontrak singleton; pergantian env hanya lewat modul baru).
    vi.stubEnv('VITE_SUPABASE_URL', 'https://changed.supabase.co');
    expect(supabase.getAppSupabase()).toBe(first);
  });
});
