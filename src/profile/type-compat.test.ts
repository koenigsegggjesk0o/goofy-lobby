import { describe, expect, it } from 'vitest';
import { createClient } from '@supabase/supabase-js';
import { asProfileClient } from './types';
import type { SupabaseProfileLike, SupabaseStorageLike } from './types';

/**
 * Bukti kompatibilitas kontrak struktural modul ini terhadap SupabaseClient
 * ASLI (konstruksi klien tidak melakukan permintaan jaringan apa pun):
 *
 * - Sisi STORAGE: dibuktikan level-TYPE — klien asli assignable ke
 *   SupabaseStorageLike tanpa cast.
 * - Sisi PostgREST: generics postgrest-js (GetResult atas schema `any`)
 *   memicu TS2589 pada perbandingan struktural, jadi dibuktikan RUNTIME —
 *   menelusuri rantai persis yang dipakai ProfileService pada klien asli.
 *   Cast tunggal ada di asProfileClient() (terdokumentasi di types.ts).
 */
describe('kompatibilitas struktural klien asli', () => {
  it('SupabaseClient asli assignable ke SupabaseStorageLike tanpa cast', () => {
    const client = createClient('https://example.supabase.co', 'anon-key');
    const asStorage: SupabaseStorageLike = client;
    expect(typeof asStorage.storage.from).toBe('function');
  });

  it('rantai PostgREST yang dipakai ProfileService tersedia di klien asli', () => {
    const client = createClient('https://example.supabase.co', 'anon-key');
    const table = client.from('profiles');

    expect(typeof table.select).toBe('function');
    expect(typeof table.update).toBe('function');

    // Rantai baca: from().select().eq().maybeSingle() → await-able.
    const selectChain = table.select('*');
    expect(typeof selectChain.eq).toBe('function');
    const maybeSingle = selectChain.eq('id', '00000000-0000-0000-0000-000000000000').maybeSingle();
    expect(typeof (maybeSingle as unknown as { then?: unknown }).then).toBe('function');

    // Rantai tulis: from().update().eq().select().single() → await-able.
    const updateChain = table.update({});
    expect(typeof updateChain.eq).toBe('function');
    const withReturn = updateChain.eq('id', '00000000-0000-0000-0000-000000000000').select();
    const single = withReturn.single();
    expect(typeof (single as unknown as { then?: unknown }).then).toBe('function');
  });

  it('asProfileClient menghasilkan objek dengan bentuk SupabaseProfileLike', () => {
    const client = createClient('https://example.supabase.co', 'anon-key');
    const adapted: SupabaseProfileLike = asProfileClient(client);
    expect(typeof adapted.from).toBe('function');
    const table = adapted.from('profiles');
    expect(typeof table.select).toBe('function');
    expect(typeof table.update).toBe('function');
  });
});
