import { z } from 'zod';
import type { SupabaseClient } from '@supabase/supabase-js';

// ============================================================
// Konstanta tabel & status (selaras migrasi 0007/0008)
// ============================================================

/**
 * Tabel pertemanan — satu baris per pasangan; arah kanonik dijaga unique
 * index `friendships_pair_canonical_unique` (least/greatest, 0007).
 */
export const FRIENDSHIPS_TABLE = 'friendships' as const;

/** Tabel blokir — PRIVAT (RLS blocker-only, 0008); PK komposit (blocker_id, blocked_id). */
export const BLOCKS_TABLE = 'blocks' as const;

/** Tabel profil — hanya untuk join ringkas pihak lawan (bukan milik modul ini). */
export const PROFILES_TABLE = 'profiles' as const;

/** Status awal permintaan — default kolom `status` (0007). */
export const FRIENDSHIP_STATUS_PENDING = 'pending' as const;

/** Status pertemanan yang telah diterima. */
export const FRIENDSHIP_STATUS_ACCEPTED = 'accepted' as const;

/**
 * Pesan exception trigger `friendships_block_guard` (0007, errcode P0001).
 * Dicocokkan sebagai SUBSTRING pesan error insert — daftar blokir tidak bisa
 * dibaca client (RLS blocks blocker-only), jadi pesan trigger ini adalah
 * satu-satunya sinyal bahwa permintaan ditolak karena blokir. Sejak 0019
 * guard ini DUA ARAH (requester maupun addressee yang memblokir sama-sama
 * menolak) — pesan tetap satu (arah tidak dibedakan demi privasi).
 */
export const BLOCK_GUARD_MESSAGE = 'friend request rejected: blocked' as const;

/**
 * Pesan exception trigger rate-limit permintaan pertemanan (0019, P0001):
 * > 10 request / jam per requester di sisi server (di luar kendali client).
 */
export const FRIENDSHIP_RATE_LIMIT_MESSAGE = 'RATE_LIMITED_FRIENDSHIP' as const;

/**
 * Pesan exception trigger guard transisi status friendships (0019, P0001):
 * downgrade accepted → pending ditolak di lapisan data, apa pun perannya.
 */
export const FRIENDSHIP_TRANSITION_GUARD_MESSAGE = 'INVALID_FRIENDSHIP_TRANSITION' as const;

/**
 * Proyeksi kolom profil untuk join ringkas pihak lawan. Daftar eksplisit
 * (bukan `*`) supaya payload kecil dan bentuk baris stabil — divalidasi
 * ulang oleh FriendshipProfileSummarySchema setelah diterima.
 */
export const FRIENDSHIP_PROFILE_COLUMNS = 'id, display_name, avatar_color' as const;

/**
 * Batas baris daftar teman (payload guard, MVP tanpa pagination). Query
 * profil lanjutan memakai filter `.in('id', ...)` sebesar ±37 karakter per
 * uuid — 100 id ≈ 3,7 KB query string, masih aman untuk batas URL umum.
 * Baris di luar batas TERPOTONG (dipangkas, bukan error).
 */
export const FRIENDS_LIST_MAX = 100;

/** Batas baris daftar permintaan masuk/keluar (payload guard, MVP). */
export const REQUESTS_LIST_MAX = 100;

/** Batas baris daftar blokir + batch profilnya (payload guard, MVP). */
export const BLOCKS_LIST_MAX = 100;

// ============================================================
// Skema validasi (Zod)
// ============================================================

/**
 * UUID — semua id user/baris modul ini. Berfungsi ganda: validasi bentuk
 * DAN guard injection: nilai harus lolos skema ini SEBELUM diinterpolasi
 * ke string filter `.or(...)` (payload seperti `A),and(1=1)` tidak pernah
 * sampai ke jaringan).
 */
export const UuidSchema = z.uuid();

/** Status pertemanan — persis CHECK constraint `friendships_status_check` (0007). */
export const FriendshipStatusSchema = z.enum(['pending', 'accepted']);

/** Nama tampilan ringkas — constraint sama dengan kolom profiles (1–32 setelah trim). */
export const SummaryDisplayNameSchema = z.string().trim().min(1).max(32);

/** Warna avatar #RRGGBB — constraint sama dengan kolom profiles. */
export const SummaryAvatarColorSchema = z.string().regex(/^#[0-9a-fA-F]{6}$/);

/** Baris mentah friendships dari PostgREST (kolom snake_case persis DB). */
export const FriendshipRowSchema = z.object({
  id: UuidSchema,
  requester_id: UuidSchema,
  addressee_id: UuidSchema,
  status: FriendshipStatusSchema,
  created_at: z.string().min(1),
  updated_at: z.string().min(1),
});

/** Baris mentah blocks dari PostgREST (PK komposit, tanpa state tambahan). */
export const BlockRowSchema = z.object({
  blocker_id: UuidSchema,
  blocked_id: UuidSchema,
  created_at: z.string().min(1),
});

/** Baris hasil proyeksi `select('blocked_id')` pada blocks. */
export const BlockedIdRowSchema = z.object({
  blocked_id: UuidSchema,
});

/**
 * Baris profil ringkas hasil join (proyeksi FRIENDSHIP_PROFILE_COLUMNS).
 * Sengaja didefinisikan MANDIRI — bukan impor dari src/profile — supaya
 * modul friends berdiri sendiri (keputusan Task 12-b); constraint kolomnya
 * identik dengan ProfileRowSchema milik modul profile, dan Zod memangkas
 * kolom lain bila baris penuh profil dikirim.
 */
export const FriendshipProfileSummarySchema = z.object({
  id: UuidSchema,
  display_name: SummaryDisplayNameSchema,
  avatar_color: SummaryAvatarColorSchema,
});

// ============================================================
// Tipe turunan
// ============================================================

export type FriendshipStatus = z.infer<typeof FriendshipStatusSchema>;
export type FriendshipRow = z.infer<typeof FriendshipRowSchema>;
export type BlockRow = z.infer<typeof BlockRowSchema>;
export type FriendshipProfileSummaryRow = z.infer<typeof FriendshipProfileSummarySchema>;

/** Pertemanan dalam bentuk camelCase (API publik modul). */
export interface Friendship {
  id: string;
  requesterId: string;
  addresseeId: string;
  status: FriendshipStatus;
  createdAt: string;
  updatedAt: string;
}

/** Blokir dalam bentuk camelCase. */
export interface Block {
  blockerId: string;
  blockedId: string;
  createdAt: string;
}

/** Profil ringkas pihak lawan (hasil join). */
export interface FriendProfileSummary {
  id: string;
  displayName: string;
  avatarColor: string;
}

/** Entri daftar teman (listFriends). */
export interface FriendEntry {
  friendshipId: string;
  friendId: string;
  /**
   * Waktu pertemanan terbentuk — proxy `updated_at` baris (waktu accept:
   * satu-satunya transisi UPDATE yang ada, dibump trigger set_updated_at).
   * MVP tanpa tabel histori status.
   */
  since: string;
  profile: FriendProfileSummary;
}

/** Entri permintaan masuk/keluar yang masih pending. */
export interface FriendRequestEntry {
  friendshipId: string;
  requesterId: string;
  addresseeId: string;
  /** Waktu permintaan dibuat (created_at baris). */
  createdAt: string;
  /** Profil pihak lawan: penerima untuk outgoing, pengirim untuk incoming. */
  profile: FriendProfileSummary;
}

/** Entri daftar blokir (listBlockedProfiles). */
export interface BlockedEntry {
  blockedId: string;
  /** Waktu diblokir (created_at baris). */
  since: string;
  profile: FriendProfileSummary;
}

/** Ringkasan relasi dua user (getFriendshipState). */
export type FriendshipState = 'none' | 'friends' | 'pending-outgoing' | 'pending-incoming';

// ============================================================
// Error domain
// ============================================================

/** Kode kegagalan modul friends — mesin pesan error yang seragam. */
export type FriendsErrorCode =
  | 'invalid-user-id'
  | 'self-request'
  | 'self-block'
  | 'already-friends'
  | 'request-exists'
  | 'rate-limited' // trigger 0019: >10 permintaan pertemanan/jam per requester (server)
  | 'blocked'
  | 'invalid-transition' // trigger 0019: transisi status friendships tidak sah (accepted→pending)
  | 'not-found'
  | 'invalid-row'
  | 'db-error';

export class FriendsError extends Error {
  readonly code: FriendsErrorCode;
  readonly cause?: unknown;

  constructor(code: FriendsErrorCode, message: string, cause?: unknown) {
    super(message);
    this.name = 'FriendsError';
    this.code = code;
    if (cause !== undefined) {
      this.cause = cause;
    }
  }
}

// ============================================================
// Bentuk struktural Supabase (structural typing — client asli lolos
// lewat adapter; test menyuntik fake; hanya sub-kemampuan yang dipakai)
// ============================================================

/** Error PostgREST minimal yang dibaca modul ini. */
export interface SupabaseErrorLike {
  message: string;
  statusCode?: string;
  code?: string;
}

export type FriendsResponseLike<T> =
  { data: T; error: null } | { data: null; error: SupabaseErrorLike };

/**
 * Rantai baca: await-able (array baris), .eq/.or/.in/.order/.limit, dan
 * .maybeSingle() untuk kueri tunggal (null bila tidak ada baris).
 */
export interface FriendsSelectChainLike extends PromiseLike<FriendsResponseLike<unknown[]>> {
  eq(column: string, value: string): FriendsSelectChainLike;
  or(filters: string): FriendsSelectChainLike;
  in(column: string, values: readonly string[]): FriendsSelectChainLike;
  order(column: string, options: { ascending: boolean }): FriendsSelectChainLike;
  limit(count: number): FriendsSelectChainLike;
  maybeSingle(): PromiseLike<FriendsResponseLike<unknown>>;
}

/**
 * Rantai tulis-baris (insert/upsert): await-able, .select(), .single().
 * Bentuk yang sama dipakai untuk insert biasa (friendships) dan upsert
 * ignoreDuplicates (blocks — INSERT ... ON CONFLICT DO NOTHING).
 */
export interface FriendsInsertChainLike extends PromiseLike<FriendsResponseLike<unknown>> {
  select(columns?: string): FriendsInsertChainLike;
  single(): PromiseLike<FriendsResponseLike<unknown>>;
}

/** Rantai update: await-able, .eq(), .select(), .single(). */
export interface FriendsUpdateChainLike extends PromiseLike<FriendsResponseLike<unknown>> {
  eq(column: string, value: string): FriendsUpdateChainLike;
  select(columns?: string): FriendsUpdateChainLike;
  single(): PromiseLike<FriendsResponseLike<unknown>>;
}

/** Rantai delete: await-able, .eq(), .or(), .select() (baris terhapus). */
export interface FriendsDeleteChainLike extends PromiseLike<FriendsResponseLike<unknown[]>> {
  eq(column: string, value: string): FriendsDeleteChainLike;
  or(filters: string): FriendsDeleteChainLike;
  select(columns?: string): FriendsDeleteChainLike;
}

export interface FriendsTableLike {
  select(columns?: string): FriendsSelectChainLike;
  insert(values: Record<string, unknown>): FriendsInsertChainLike;
  upsert(
    values: Record<string, unknown>,
    options?: { onConflict?: string; ignoreDuplicates?: boolean },
  ): FriendsInsertChainLike;
  update(values: Record<string, unknown>): FriendsUpdateChainLike;
  delete(): FriendsDeleteChainLike;
}

export interface SupabaseFriendsLike {
  from(table: string): FriendsTableLike;
}

/**
 * Adapter klien asli → SupabaseFriendsLike.
 *
 * Cast tunggal yang terkendali dan terdokumentasi: generics rantai
 * PostgREST (GetResult atas schema `any`) membuat TS menyerah dengan
 * TS2589 saat perbandingan struktural langsung — bukti kompatibilitas
 * dilakukan RUNTIME di type-compat.test.ts (menelusuri seluruh rantai
 * yang dipakai FriendshipService/BlockService pada klien asli).
 */
export function asFriendsClient(client: SupabaseClient): SupabaseFriendsLike {
  return client as unknown as SupabaseFriendsLike;
}

// ============================================================
// Helper uuid & filter (titik tunggal penyusunan string .or)
// ============================================================

/** Validasi uuid — melempar FriendsError('invalid-user-id') bila tidak sah. */
export function assertUuid(value: string, field: string): string {
  const parsed = UuidSchema.safeParse(value);
  if (!parsed.success) {
    throw new FriendsError(
      'invalid-user-id',
      `${field} bukan uuid yang valid: "${value}"`,
      parsed.error.issues,
    );
  }
  return parsed.data;
}

/**
 * Filter pasangan kanonik untuk `.or(...)`: mencocokkan A→B ATAU B→A —
 * unique index least/greatest (0007) menganggap keduanya pasangan YANG
 * SAMA, jadi pra-cek insert harus melihat kedua arah sekaligus.
 * Kedua argumen divalidasi uuid DI SINI: helper ini adalah titik tunggal
 * penyusunan string filter, sehingga jaminan anti-injection melekat pada
 * choke point ini (pemanggil tetap divalidasi lebih awal untuk fail-fast).
 *
 * SIMETRI: kedua uuid diurutkan leksikografis dulu (lo, hi) lalu kedua
 * grup-and selalu disusun dari urutan itu — argumen tertukar menghasilkan
 * string IDENTIK (bukan sekadar setara semantik), sehingga cache/assert
 * pemanggil bisa membandingkan filter secara langsung.
 */
export function canonicalPairFilter(userA: string, userB: string): string {
  assertUuid(userA, 'userA');
  assertUuid(userB, 'userB');
  const lo = userA < userB ? userA : userB;
  const hi = userA < userB ? userB : userA;
  return `and(requester_id.eq.${lo},addressee_id.eq.${hi}),and(requester_id.eq.${hi},addressee_id.eq.${lo})`;
}

/**
 * Filter peserta untuk `.or(...)`: requester ATAU addressee = userId —
 * kebalikan policy RLS SELECT friendships (baris yang melibatkan user).
 * Argumen divalidasi uuid di sini (alasan sama dengan canonicalPairFilter).
 */
export function participantFilter(userId: string): string {
  assertUuid(userId, 'userId');
  return `requester_id.eq.${userId},addressee_id.eq.${userId}`;
}

/** Format isu Zod jadi satu baris pesan (pola profile-service). */
export function formatIssues(issues: Array<{ path: PropertyKey[]; message: string }>): string {
  return issues
    .map((issue) => `${issue.path.map(String).join('.') || '(root)'}: ${issue.message}`)
    .join('; ');
}
