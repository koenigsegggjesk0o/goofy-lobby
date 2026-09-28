import { describe, expect, it } from 'vitest';
import { createClient } from '@supabase/supabase-js';
import { asPremiumClient } from './types';
import type { SupabasePremiumLike } from './types';

/**
 * Bukti kompatibilitas kontrak struktural modul payment terhadap
 * SupabaseClient ASLI (konstruksi klien tidak melakukan permintaan
 * jaringan apa pun).
 *
 * PostgREST: generics postgrest-js (GetResult atas schema `any`) memicu
 * TS2589 pada perbandingan struktural langsung, jadi dibuktikan RUNTIME —
 * menelusuri rantai persis yang dipakai PremiumStatusService pada klien
 * asli. Cast tunggal ada di asPremiumClient() (terdokumentasi di types.ts).
 */
describe('kompatibilitas struktural klien asli', () => {
  it('rantai PostgREST yang dipakai PremiumStatusService tersedia di klien asli', () => {
    const client = createClient('https://example.supabase.co', 'anon-key');
    const table = client.from('profiles');

    expect(typeof table.select).toBe('function');

    // Rantai baca: from().select('id,is_premium').eq().maybeSingle() → await-able.
    const selectChain = table.select('id,is_premium');
    expect(typeof selectChain.eq).toBe('function');
    const maybeSingle = selectChain.eq('id', '00000000-0000-0000-0000-000000000000').maybeSingle();
    expect(typeof (maybeSingle as unknown as { then?: unknown }).then).toBe('function');
  });

  it('asPremiumClient menghasilkan objek dengan bentuk SupabasePremiumLike', () => {
    const client = createClient('https://example.supabase.co', 'anon-key');
    const adapted: SupabasePremiumLike = asPremiumClient(client);
    expect(typeof adapted.from).toBe('function');
    const table = adapted.from('profiles');
    expect(typeof table.select).toBe('function');
  });
});
