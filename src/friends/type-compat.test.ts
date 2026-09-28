import { describe, expect, it } from 'vitest';
import { createClient } from '@supabase/supabase-js';
import {
  BLOCKS_LIST_MAX,
  FRIENDSHIP_PROFILE_COLUMNS,
  FRIENDS_LIST_MAX,
  REQUESTS_LIST_MAX,
  asFriendsClient,
  canonicalPairFilter,
  participantFilter,
} from './types';
import type { SupabaseFriendsLike } from './types';

const ALPHA = '11111111-1111-4111-8111-111111111111';
const BRAVO = '22222222-2222-4222-8222-222222222222';
const REQUEST_ID = '00000000-0000-4000-8000-000000000001';

/**
 * Bukti kompatibilitas kontrak struktural modul friends terhadap
 * SupabaseClient ASLI (konstruksi klien tidak melakukan permintaan jaringan
 * apa pun; penelusuran rantai hanya membangun builder, tanpa await).
 *
 * Generics postgrest-js (GetResult atas schema `any`) memicu TS2589 pada
 * perbandingan struktural langsung, jadi dibuktikan RUNTIME — menelusuri
 * rantai PERSIS yang dipakai FriendshipService/BlockService pada klien
 * asli. Cast tunggal ada di asFriendsClient() (terdokumentasi di types.ts).
 */

/** Builder dianggap await-able bila bertipe PromiseLike (punya .then). */
function assertAwaitable(value: unknown): void {
  expect(typeof (value as { then?: unknown }).then).toBe('function');
}

describe('kompatibilitas struktural klien asli', () => {
  it('rantai baca friendships tersedia (pra-cek kanonik + daftar + permintaan)', () => {
    const client = createClient('https://example.supabase.co', 'anon-key');
    const table = client.from('friendships');
    expect(typeof table.select).toBe('function');

    // Pra-cek pasangan kanonik (sendFriendRequest / getFriendshipState):
    // select().or('and(...),and(...)').maybeSingle()
    assertAwaitable(table.select('*').or(canonicalPairFilter(ALPHA, BRAVO)).maybeSingle());

    // Daftar teman (listFriends):
    // select().or(peserta).eq().order().limit()
    assertAwaitable(
      table
        .select('*')
        .or(participantFilter(ALPHA))
        .eq('status', 'accepted')
        .order('updated_at', { ascending: true })
        .limit(FRIENDS_LIST_MAX),
    );

    // Daftar permintaan masuk/keluar (#listRequests):
    // select().eq().eq().order().limit()
    assertAwaitable(
      table
        .select('*')
        .eq('addressee_id', ALPHA)
        .eq('status', 'pending')
        .order('created_at', { ascending: false })
        .limit(REQUESTS_LIST_MAX),
    );
  });

  it('rantai tulis friendships tersedia (insert/update/delete)', () => {
    const client = createClient('https://example.supabase.co', 'anon-key');
    const table = client.from('friendships');
    expect(typeof table.insert).toBe('function');
    expect(typeof table.update).toBe('function');
    expect(typeof table.delete).toBe('function');

    // sendFriendRequest: insert().select().single()
    assertAwaitable(
      table
        .insert({ requester_id: ALPHA, addressee_id: BRAVO, status: 'pending' })
        .select('*')
        .single(),
    );

    // acceptFriendRequest: update().eq().eq().eq().select().single()
    assertAwaitable(
      table
        .update({ status: 'accepted' })
        .eq('id', REQUEST_ID)
        .eq('addressee_id', BRAVO)
        .eq('status', 'pending')
        .select('*')
        .single(),
    );

    // removeFriend (peran 'either'): delete().eq().eq().or().select()
    assertAwaitable(
      table
        .delete()
        .eq('id', REQUEST_ID)
        .eq('status', 'accepted')
        .or(participantFilter(ALPHA))
        .select('id'),
    );

    // decline/cancel (peran spesifik): delete().eq().eq().eq().select()
    assertAwaitable(
      table
        .delete()
        .eq('id', REQUEST_ID)
        .eq('status', 'pending')
        .eq('addressee_id', BRAVO)
        .select('id'),
    );
  });

  it('rantai blocks & profil ringkas tersedia', () => {
    const client = createClient('https://example.supabase.co', 'anon-key');
    const blocks = client.from('blocks');
    expect(typeof blocks.upsert).toBe('function');

    // blockUser (idempaten): upsert(values, { ignoreDuplicates: true })
    assertAwaitable(
      blocks.upsert({ blocker_id: ALPHA, blocked_id: BRAVO }, { ignoreDuplicates: true }),
    );

    // unblockUser: delete().eq().eq().select()
    assertAwaitable(
      blocks.delete().eq('blocker_id', ALPHA).eq('blocked_id', BRAVO).select('blocked_id'),
    );

    // listBlockedProfiles: select().eq().order().limit()
    assertAwaitable(
      blocks
        .select('*')
        .eq('blocker_id', ALPHA)
        .order('created_at', { ascending: false })
        .limit(BLOCKS_LIST_MAX),
    );

    // getBlockedUserIds: select(kolom).eq()
    assertAwaitable(blocks.select('blocked_id').eq('blocker_id', ALPHA));

    // fetchProfileSummaries (batch profil lawan): select(kolom).in('id', [...])
    assertAwaitable(
      client.from('profiles').select(FRIENDSHIP_PROFILE_COLUMNS).in('id', [ALPHA, BRAVO]),
    );
  });

  it('asFriendsClient menghasilkan objek dengan bentuk SupabaseFriendsLike', () => {
    const client = createClient('https://example.supabase.co', 'anon-key');
    const adapted: SupabaseFriendsLike = asFriendsClient(client);
    expect(typeof adapted.from).toBe('function');
    const table = adapted.from('friendships');
    expect(typeof table.select).toBe('function');
    expect(typeof table.insert).toBe('function');
    expect(typeof table.update).toBe('function');
    expect(typeof table.delete).toBe('function');
    expect(typeof table.upsert).toBe('function');
    // Rantai baca lengkap tersedia lewat tipe struktural modul ini.
    const chain = table.select('*').or(canonicalPairFilter(ALPHA, BRAVO));
    expect(typeof chain.eq).toBe('function');
    expect(typeof chain.in).toBe('function');
    expect(typeof chain.order).toBe('function');
    expect(typeof chain.limit).toBe('function');
    expect(typeof chain.maybeSingle).toBe('function');
  });
});
