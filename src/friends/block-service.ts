import {
  BLOCKS_LIST_MAX,
  BLOCKS_TABLE,
  BlockRowSchema,
  BlockedIdRowSchema,
  FriendsError,
  assertUuid,
  formatIssues,
} from './types';
import { fetchProfileSummaries } from './friendship-service';
import type { BlockedEntry, FriendProfileSummary, SupabaseFriendsLike } from './types';

export interface BlockServiceDeps {
  /** Klien Supabase (hanya sub-kemampuan PostgREST yang dipakai). */
  supabase: SupabaseFriendsLike;
}

/**
 * Layanan tabel `blocks` (migrasi 0007/0008) — daftar blokir PRIBADI user
 * (RLS blocker-only: pihak yang diblokir tidak bisa mengetahui statusnya
 * lewat DB).
 *
 * Penolakan friend request akibat blokir TIDAK dicek di sini — ditegakkan
 * trigger `friendships_block_guard` (0007) di sisi DB dan dipetakan
 * FriendshipService menjadi kode 'blocked'.
 */
export class BlockService {
  readonly #supabase: SupabaseFriendsLike;

  constructor(deps: BlockServiceDeps) {
    this.#supabase = deps.supabase;
  }

  /**
   * Memblokir user — IDEMPATEN. PK komposit (blocker_id, blocked_id)
   * membuat blok kedua kali konflik; dipanggil sebagai upsert dengan
   * ignoreDuplicates yang menerjemahkannya menjadi
   * `INSERT ... ON CONFLICT DO NOTHING` (bentuk opsi diverifikasi pada
   * @supabase/postgrest-js 2.117.2: `ignoreDuplicates` adalah opsi UPSERT,
   * bukan opsi insert biasa — catatan Task 12-b).
   */
  async blockUser(blockerId: string, blockedId: string): Promise<void> {
    const blocker = assertUuid(blockerId, 'blockerId');
    const blocked = assertUuid(blockedId, 'blockedId');
    if (blocker === blocked) {
      throw new FriendsError('self-block', 'tidak bisa memblokir diri sendiri');
    }
    const response = await this.#supabase
      .from(BLOCKS_TABLE)
      .upsert({ blocker_id: blocker, blocked_id: blocked }, { ignoreDuplicates: true });
    if (response.error !== null) {
      throw new FriendsError(
        'db-error',
        `memblokir user gagal: ${response.error.message}`,
        response.error,
      );
    }
  }

  /** Menghapus blokir — 'not-found' bila pasangan blokir tidak ada. */
  async unblockUser(blockerId: string, blockedId: string): Promise<void> {
    const blocker = assertUuid(blockerId, 'blockerId');
    const blocked = assertUuid(blockedId, 'blockedId');
    const response = await this.#supabase
      .from(BLOCKS_TABLE)
      .delete()
      .eq('blocker_id', blocker)
      .eq('blocked_id', blocked)
      .select('blocked_id');
    if (response.error !== null) {
      throw new FriendsError(
        'db-error',
        `menghapus blokir gagal: ${response.error.message}`,
        response.error,
      );
    }
    if (!Array.isArray(response.data) || response.data.length === 0) {
      throw new FriendsError('not-found', 'blokir tidak ditemukan');
    }
  }

  /**
   * Daftar profil user yang diblokir (join profil ringkas), terbaru dulu,
   * maksimum BLOCKS_LIST_MAX baris (payload guard).
   */
  async listBlockedProfiles(blockerId: string): Promise<BlockedEntry[]> {
    const blocker = assertUuid(blockerId, 'blockerId');
    const response = await this.#supabase
      .from(BLOCKS_TABLE)
      .select('*')
      .eq('blocker_id', blocker)
      .order('created_at', { ascending: false })
      .limit(BLOCKS_LIST_MAX);
    if (response.error !== null) {
      throw new FriendsError(
        'db-error',
        `mengambil daftar blokir gagal: ${response.error.message}`,
        response.error,
      );
    }
    const rows = response.data.map((raw) => parseBlockRow(raw));
    if (rows.length === 0) {
      return [];
    }
    const profilesById = await fetchProfileSummaries(
      this.#supabase,
      rows.map((row) => row.blockedId),
    );
    return rows.map((row) => ({
      blockedId: row.blockedId,
      since: row.createdAt,
      profile: requireBlockedProfile(row.blockedId, profilesById),
    }));
  }

  /**
   * Kumpulan id user yang diblokir — bentuk paling ringkas untuk filter
   * sisi client (mis. menyembunyikan DM/undangan dari user terblokir).
   */
  async getBlockedUserIds(blockerId: string): Promise<string[]> {
    const blocker = assertUuid(blockerId, 'blockerId');
    const response = await this.#supabase
      .from(BLOCKS_TABLE)
      .select('blocked_id')
      .eq('blocker_id', blocker);
    if (response.error !== null) {
      throw new FriendsError(
        'db-error',
        `mengambil id blokir gagal: ${response.error.message}`,
        response.error,
      );
    }
    return response.data.map((raw) => parseBlockedIdRow(raw));
  }
}

/** Validasi baris mentah → bentuk camelCase. */
function parseBlockRow(raw: unknown): { blockerId: string; blockedId: string; createdAt: string } {
  const parsed = BlockRowSchema.safeParse(raw);
  if (!parsed.success) {
    throw new FriendsError(
      'invalid-row',
      `baris blokir tidak lolos validasi: ${formatIssues(parsed.error.issues)}`,
      parsed.error.issues,
    );
  }
  return {
    blockerId: parsed.data.blocker_id,
    blockedId: parsed.data.blocked_id,
    createdAt: parsed.data.created_at,
  };
}

/** Validasi baris proyeksi `select('blocked_id')` → id. */
function parseBlockedIdRow(raw: unknown): string {
  const parsed = BlockedIdRowSchema.safeParse(raw);
  if (!parsed.success) {
    throw new FriendsError(
      'invalid-row',
      `baris id blokir tidak lolos validasi: ${formatIssues(parsed.error.issues)}`,
      parsed.error.issues,
    );
  }
  return parsed.data.blocked_id;
}

/** Profil dari peta hasil batch — melempar 'invalid-row' bila hilang. */
function requireBlockedProfile(
  userId: string,
  profilesById: ReadonlyMap<string, FriendProfileSummary>,
): FriendProfileSummary {
  const profile = profilesById.get(userId);
  if (profile === undefined) {
    throw new FriendsError(
      'invalid-row',
      `profil user terblokir ${userId} tidak ditemukan — FK + ON DELETE CASCADE seharusnya mencegah ini`,
    );
  }
  return profile;
}
