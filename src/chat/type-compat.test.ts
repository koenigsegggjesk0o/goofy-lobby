import { describe, expect, it } from 'vitest';
import { createClient } from '@supabase/supabase-js';
import { asChatClient } from './types';
import type { SupabaseChatLike } from './types';

const USER_A = '7db26a0a-9ce5-4558-bd08-9612e9e9febe';
const USER_B = '69f3f9b3-0d6f-4c22-98a4-6ad9a15be001';

/**
 * Bukti KOMPATIBILITAS RUNTIME kontrak struktural modul chat terhadap
 * SupabaseClient ASLI (konstruksi klien tidak melakukan permintaan jaringan
 * apa pun; rantai juga TIDAK di-await supaya tidak menembak kueri sungguhan).
 *
 * Cast tunggal ada di asChatClient() — alasan dan dokumentasinya di types.ts
 * (generics GetResult memicu TS2589 pada perbandingan struktural langsung),
 * maka bukti dilakukan dengan menelusuri rantai PERSIS yang dipakai
 * MessageService pada klien asli.
 */
describe('kompatibilitas struktural klien asli (chat)', () => {
  it('rantai gate pertemanan: select().or(and, and).eq().maybeSingle()', () => {
    const client = createClient('https://example.supabase.co', 'anon-key');
    const table = client.from('friendships');

    expect(typeof table.select).toBe('function');
    const gate = table
      .select('*')
      .or(
        `and(requester_id.eq.${USER_A},addressee_id.eq.${USER_B}),and(requester_id.eq.${USER_B},addressee_id.eq.${USER_A})`,
      )
      .eq('status', 'accepted')
      .maybeSingle();
    expect(typeof (gate as unknown as { then?: unknown }).then).toBe('function');
  });

  it('rantai daftar percakapan: select().or(and, and).lt().order().limit()', () => {
    const client = createClient('https://example.supabase.co', 'anon-key');
    const table = client.from('messages');

    const list = table
      .select('*')
      .or(
        `and(sender_id.eq.${USER_A},recipient_id.eq.${USER_B}),and(sender_id.eq.${USER_B},recipient_id.eq.${USER_A})`,
      )
      .lt('created_at', '2026-09-28T10:00:00Z')
      .order('created_at', { ascending: false })
      .limit(50);
    expect(typeof (list as unknown as { then?: unknown }).then).toBe('function');
  });

  it('rantai insert: insert().select().single()', () => {
    const client = createClient('https://example.supabase.co', 'anon-key');
    const table = client.from('messages');

    expect(typeof table.insert).toBe('function');
    const inserted = table
      .insert({ sender_id: USER_A, recipient_id: USER_B, body: 'halo' })
      .select()
      .single();
    expect(typeof (inserted as unknown as { then?: unknown }).then).toBe('function');
  });

  it('asChatClient menghasilkan objek dengan bentuk SupabaseChatLike', () => {
    const client = createClient('https://example.supabase.co', 'anon-key');
    const adapted: SupabaseChatLike = asChatClient(client);
    expect(typeof adapted.from).toBe('function');
    const table = adapted.from('messages');
    expect(typeof table.select).toBe('function');
    expect(typeof table.insert).toBe('function');
  });
});
