import {
  BLOCK_GUARD_MESSAGE,
  FRIENDSHIP_PROFILE_COLUMNS,
  FRIENDSHIP_STATUS_ACCEPTED,
  FRIENDSHIP_STATUS_PENDING,
  FRIENDSHIPS_TABLE,
  FRIENDS_LIST_MAX,
  FriendshipProfileSummarySchema,
  FriendshipRowSchema,
  FriendsError,
  PROFILES_TABLE,
  REQUESTS_LIST_MAX,
  assertUuid,
  canonicalPairFilter,
  formatIssues,
  participantFilter,
  type FriendEntry,
  type FriendProfileSummary,
  type FriendRequestEntry,
  type Friendship,
  type FriendshipRow,
  type FriendshipState,
  type SupabaseErrorLike,
  type SupabaseFriendsLike,
} from './types';

export interface FriendshipServiceDeps {
  /** Klien Supabase (hanya sub-kemampuan PostgREST yang dipakai). */
  supabase: SupabaseFriendsLike;
}

/**
 * Layanan tabel `friendships` (migrasi 0007/0008).
 *
 * - Semua id divalidasi uuid SEBELUM kueri — string tidak pernah
 *   diinterpolasi ke filter `.or(...)` tanpa lolos guard injection.
 * - Baris hasil PostgREST selalu divalidasi ulang dengan Zod sebelum
 *   dikembalikan (pertahanan di sisi terima).
 * - decline/cancel/unfriend = DELETE baris (MVP tanpa histori status).
 * - RLS 0008 (UPDATE addressee-only, DELETE kedua pihak) TIDAK diandalkan
 *   untuk logika — filter kueri sudah membatasi peran secara eksplisit;
 *   RLS tetap lapisan keamanan terakhir di sisi DB.
 */
export class FriendshipService {
  readonly #supabase: SupabaseFriendsLike;

  constructor(deps: FriendshipServiceDeps) {
    this.#supabase = deps.supabase;
  }

  /**
   * Mengirim permintaan pertemanan requester → addressee.
   * - Self-request ditolak lokal (juga dijaga CHECK 0007 di DB).
   * - Pra-cek pasangan kanonik (A→B / B→A adalah pasangan SAMA): accepted
   *   → 'already-friends'; pending → 'request-exists' dengan arah pada
   *   pesan (incoming/outgoing) supaya UI bisa mengarahkan ke daftar yang
   *   tepat.
   * - Error insert dipetakan: trigger block guard → 'blocked', unique
   *     index kanonik (balapan) → 'request-exists', CHECK no_self →
   *     'self-request'.
   */
  async sendFriendRequest(requesterId: string, addresseeId: string): Promise<Friendship> {
    const requester = assertUuid(requesterId, 'requesterId');
    const addressee = assertUuid(addresseeId, 'addresseeId');
    if (requester === addressee) {
      throw new FriendsError('self-request', 'tidak bisa mengirim permintaan ke diri sendiri');
    }
    const existingResponse = await this.#supabase
      .from(FRIENDSHIPS_TABLE)
      .select('*')
      .or(canonicalPairFilter(requester, addressee))
      .maybeSingle();
    if (existingResponse.error !== null) {
      throw new FriendsError(
        'db-error',
        `memeriksa pasangan pertemanan gagal: ${existingResponse.error.message}`,
        existingResponse.error,
      );
    }
    if (existingResponse.data !== null) {
      const existing = parseFriendshipRow(existingResponse.data);
      if (existing.status === FRIENDSHIP_STATUS_ACCEPTED) {
        throw new FriendsError('already-friends', 'kalian sudah berteman');
      }
      if (existing.requesterId === requester) {
        throw new FriendsError(
          'request-exists',
          'permintaan pertemanan sudah ada — arah outgoing (menunggu jawaban lawan)',
        );
      }
      throw new FriendsError(
        'request-exists',
        'permintaan pertemanan sudah ada — arah incoming (menunggu jawabanmu)',
      );
    }
    const insertResponse = await this.#supabase
      .from(FRIENDSHIPS_TABLE)
      .insert({
        requester_id: requester,
        addressee_id: addressee,
        status: FRIENDSHIP_STATUS_PENDING,
      })
      .select('*')
      .single();
    if (insertResponse.error !== null) {
      throw mapFriendshipInsertError(insertResponse.error);
    }
    if (insertResponse.data === null) {
      throw new FriendsError('db-error', 'insert friendship mengembalikan null tanpa error');
    }
    return parseFriendshipRow(insertResponse.data);
  }

  /**
   * Menerima permintaan masuk — hanya penerima baris pending yang boleh.
   * Kombinasi filter (id + addressee_id + status pending) plus RLS UPDATE
   * addressee-only (0008) membuat update 0 baris bila salah satu tidak
   * cocok; .single() atas 0 baris mengembalikan error → 'not-found'.
   */
  async acceptFriendRequest(userId: string, requestId: string): Promise<Friendship> {
    const user = assertUuid(userId, 'userId');
    const request = assertUuid(requestId, 'requestId');
    const response = await this.#supabase
      .from(FRIENDSHIPS_TABLE)
      .update({ status: FRIENDSHIP_STATUS_ACCEPTED })
      .eq('id', request)
      .eq('addressee_id', user)
      .eq('status', FRIENDSHIP_STATUS_PENDING)
      .select('*')
      .single();
    if (response.error !== null) {
      throw new FriendsError(
        'not-found',
        `permintaan tidak ditemukan / bukan milikmu / bukan pending: ${response.error.message}`,
        response.error,
      );
    }
    if (response.data === null) {
      throw new FriendsError('db-error', 'accept mengembalikan null tanpa error');
    }
    return parseFriendshipRow(response.data);
  }

  /** Menolak permintaan masuk (penerima menghapus baris pending). */
  async declineFriendRequest(userId: string, requestId: string): Promise<void> {
    await this.#deleteFriendshipRow({
      userId,
      rowId: requestId,
      expectedStatus: FRIENDSHIP_STATUS_PENDING,
      role: 'addressee',
    });
  }

  /** Membatalkan permintaan terkirim (pengirim menghapus baris pending). */
  async cancelFriendRequest(userId: string, requestId: string): Promise<void> {
    await this.#deleteFriendshipRow({
      userId,
      rowId: requestId,
      expectedStatus: FRIENDSHIP_STATUS_PENDING,
      role: 'requester',
    });
  }

  /** Menghapus pertemanan (unfriend) — salah satu pihak, baris accepted. */
  async removeFriend(userId: string, friendshipId: string): Promise<void> {
    await this.#deleteFriendshipRow({
      userId,
      rowId: friendshipId,
      expectedStatus: FRIENDSHIP_STATUS_ACCEPTED,
      role: 'either',
    });
  }

  /**
   * Daftar teman user: friendships peserta + accepted, dijoin profil
   * ringkas lawan. Diurutkan sejak paling lama (updated_at naik), maksimum
   * FRIENDS_LIST_MAX baris (payload guard).
   */
  async listFriends(userId: string): Promise<FriendEntry[]> {
    const user = assertUuid(userId, 'userId');
    const response = await this.#supabase
      .from(FRIENDSHIPS_TABLE)
      .select('*')
      .or(participantFilter(user))
      .eq('status', FRIENDSHIP_STATUS_ACCEPTED)
      .order('updated_at', { ascending: true })
      .limit(FRIENDS_LIST_MAX);
    if (response.error !== null) {
      throw new FriendsError(
        'db-error',
        `mengambil daftar teman gagal: ${response.error.message}`,
        response.error,
      );
    }
    const rows = response.data.map((raw) => parseFriendshipRow(raw));
    if (rows.length === 0) {
      return [];
    }
    const profilesById = await fetchProfileSummaries(
      this.#supabase,
      rows.map((row) => otherPartyOf(row, user)),
    );
    return rows.map((row) => {
      const friendId = otherPartyOf(row, user);
      return {
        friendshipId: row.id,
        friendId,
        since: row.updatedAt,
        profile: requireProfile(friendId, profilesById),
      };
    });
  }

  /** Permintaan masuk (user = addressee, pending) — terbaru dulu. */
  async listIncomingRequests(userId: string): Promise<FriendRequestEntry[]> {
    return this.#listRequests(userId, 'addressee');
  }

  /** Permintaan terkirim (user = requester, pending) — terbaru dulu. */
  async listOutgoingRequests(userId: string): Promise<FriendRequestEntry[]> {
    return this.#listRequests(userId, 'requester');
  }

  /**
   * Ringkasan relasi user ↔ otherUserId: 'none' | 'friends' |
   * 'pending-outgoing' | 'pending-incoming'. Memakai kueri pasangan kanonik
   * yang sama dengan sendFriendRequest. Self-pair selalu 'none' (CHECK
   * friendships_no_self membuat barisnya mustahil ada — dikembalikan apa
   * adanya, bukan error, supaya pemanggil daftar member tidak runtuh).
   */
  async getFriendshipState(userId: string, otherUserId: string): Promise<FriendshipState> {
    const user = assertUuid(userId, 'userId');
    const other = assertUuid(otherUserId, 'otherUserId');
    const response = await this.#supabase
      .from(FRIENDSHIPS_TABLE)
      .select('*')
      .or(canonicalPairFilter(user, other))
      .maybeSingle();
    if (response.error !== null) {
      throw new FriendsError(
        'db-error',
        `memeriksa status pertemanan gagal: ${response.error.message}`,
        response.error,
      );
    }
    if (response.data === null) {
      return 'none';
    }
    const row = parseFriendshipRow(response.data);
    if (row.status === FRIENDSHIP_STATUS_ACCEPTED) {
      return 'friends';
    }
    return row.requesterId === user ? 'pending-outgoing' : 'pending-incoming';
  }

  // ============================================================
  // Internal
  // ============================================================

  async #listRequests(
    userId: string,
    side: 'addressee' | 'requester',
  ): Promise<FriendRequestEntry[]> {
    const user = assertUuid(userId, 'userId');
    const response = await this.#supabase
      .from(FRIENDSHIPS_TABLE)
      .select('*')
      .eq(`${side}_id`, user)
      .eq('status', FRIENDSHIP_STATUS_PENDING)
      .order('created_at', { ascending: false })
      .limit(REQUESTS_LIST_MAX);
    if (response.error !== null) {
      throw new FriendsError(
        'db-error',
        `mengambil daftar permintaan gagal: ${response.error.message}`,
        response.error,
      );
    }
    const rows = response.data.map((raw) => parseFriendshipRow(raw));
    if (rows.length === 0) {
      return [];
    }
    const profilesById = await fetchProfileSummaries(
      this.#supabase,
      rows.map((row) => otherPartyOf(row, user)),
    );
    return rows.map((row) => ({
      friendshipId: row.id,
      requesterId: row.requesterId,
      addresseeId: row.addresseeId,
      createdAt: row.createdAt,
      profile: requireProfile(otherPartyOf(row, user), profilesById),
    }));
  }

  /**
   * DELETE friendships dengan filter peran: 'addressee' (decline),
   * 'requester' (cancel), 'either' (unfriend — peserta mana pun).
   * Baris tidak terhapus (id salah / peran salah / status tak cocok)
   * → 'not-found' — RLS DELETE participant-only (0008) adalah lapisan
   * kedua dengan efek yang sama.
   */
  async #deleteFriendshipRow(input: {
    userId: string;
    rowId: string;
    expectedStatus: 'pending' | 'accepted';
    role: 'requester' | 'addressee' | 'either';
  }): Promise<void> {
    const user = assertUuid(input.userId, 'userId');
    const rowId = assertUuid(input.rowId, 'rowId');
    let chain = this.#supabase
      .from(FRIENDSHIPS_TABLE)
      .delete()
      .eq('id', rowId)
      .eq('status', input.expectedStatus);
    chain =
      input.role === 'either'
        ? chain.or(participantFilter(user))
        : chain.eq(`${input.role}_id`, user);
    const response = await chain.select('id');
    if (response.error !== null) {
      throw new FriendsError(
        'db-error',
        `menghapus baris pertemanan gagal: ${response.error.message}`,
        response.error,
      );
    }
    if (!Array.isArray(response.data) || response.data.length === 0) {
      throw new FriendsError(
        'not-found',
        'baris pertemanan tidak ditemukan (id / status / peran tidak cocok)',
      );
    }
  }
}

/** Id pihak lawan pada baris friendship relatif terhadap `user`. */
function otherPartyOf(row: Friendship, user: string): string {
  return row.requesterId === user ? row.addresseeId : row.requesterId;
}

/**
 * Memetakan error insert PostgREST → FriendsError ber-kode:
 * - pesan memuat BLOCK_GUARD_MESSAGE (trigger 0007, P0001) → 'blocked';
 * - code '23505' (unique index kanonik — balapan yang lolos pra-cek)
 *   → 'request-exists';
 * - code '23514' (CHECK friendships_no_self — jalur defensif, biasanya
 *   sudah ditolak lokal) → 'self-request'.
 */
function mapFriendshipInsertError(error: SupabaseErrorLike): FriendsError {
  if (error.message.includes(BLOCK_GUARD_MESSAGE)) {
    return new FriendsError('blocked', 'permintaan ditolak: penerima telah memblokir kamu', error);
  }
  if (error.code === '23505') {
    return new FriendsError(
      'request-exists',
      `pasangan pertemanan sudah ada (balapan dengan permintaan lain): ${error.message}`,
      error,
    );
  }
  if (error.code === '23514') {
    return new FriendsError(
      'self-request',
      'tidak bisa mengirim permintaan ke diri sendiri',
      error,
    );
  }
  return new FriendsError(
    'db-error',
    `mengirim permintaan pertemanan gagal: ${error.message}`,
    error,
  );
}

/** Validasi baris mentah → Friendship (camelCase). */
function parseFriendshipRow(raw: unknown): Friendship {
  const parsed = FriendshipRowSchema.safeParse(raw);
  if (!parsed.success) {
    throw new FriendsError(
      'invalid-row',
      `baris friendship tidak lolos validasi: ${formatIssues(parsed.error.issues)}`,
      parsed.error.issues,
    );
  }
  const row: FriendshipRow = parsed.data;
  return {
    id: row.id,
    requesterId: row.requester_id,
    addresseeId: row.addressee_id,
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/**
 * Mengambil profil ringkas untuk kumpulan id user (batch `.in`) — dipakai
 * bersama FriendshipService dan BlockService, didefinisikan di sini dan
 * diimpor block-service (pola intra-modul seperti voice-snippet-manager
 * pada modul profile). Id pemanggil sudah tervalidasi (uuid dari baris
 * atau assertUuid). Profil hilang/dicorrupt melempar 'invalid-row' — FK
 * + ON DELETE CASCADE profiles seharusnya mencegah profil hilang.
 */
export async function fetchProfileSummaries(
  supabase: SupabaseFriendsLike,
  ids: readonly string[],
): Promise<Map<string, FriendProfileSummary>> {
  if (ids.length === 0) {
    return new Map();
  }
  const response = await supabase
    .from(PROFILES_TABLE)
    .select(FRIENDSHIP_PROFILE_COLUMNS)
    .in('id', [...ids]);
  if (response.error !== null) {
    throw new FriendsError(
      'db-error',
      `mengambil profil ringkas gagal: ${response.error.message}`,
      response.error,
    );
  }
  const summaries = new Map<string, FriendProfileSummary>();
  for (const raw of response.data) {
    const parsed = FriendshipProfileSummarySchema.safeParse(raw);
    if (!parsed.success) {
      throw new FriendsError(
        'invalid-row',
        `baris profil ringkas tidak lolos validasi: ${formatIssues(parsed.error.issues)}`,
        parsed.error.issues,
      );
    }
    summaries.set(parsed.data.id, {
      id: parsed.data.id,
      displayName: parsed.data.display_name,
      avatarColor: parsed.data.avatar_color,
    });
  }
  return summaries;
}

/** Profil dari peta hasil batch — melempar 'invalid-row' bila hilang. */
function requireProfile(
  userId: string,
  profilesById: ReadonlyMap<string, FriendProfileSummary>,
): FriendProfileSummary {
  const profile = profilesById.get(userId);
  if (profile === undefined) {
    throw new FriendsError(
      'invalid-row',
      `profil ${userId} tidak ditemukan — FK + ON DELETE CASCADE seharusnya mencegah ini`,
    );
  }
  return profile;
}
