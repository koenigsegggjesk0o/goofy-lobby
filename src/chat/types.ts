import { z } from 'zod';
import type { SupabaseClient } from '@supabase/supabase-js';

// ============================================================
// Konstanta (selaras migrasi 0009/0010 — tabel public.messages)
// ============================================================

/**
 * Batas panjang body pesan — PERSIS constraint DB 0009:
 * `char_length(btrim(body)) between 1 and 500`.
 */
export const MAX_MESSAGE_BODY_CHARS = 500;

/** Jumlah pesan yang diambil listConversation tanpa opts.limit. */
export const DEFAULT_CONVERSATION_LIMIT = 50;

/**
 * Batas atas opts.limit listConversation. Limit di-clamp ke [1, MAX]
 * (bukan ditolak): limit adalah hint paging dari pemanggil internal,
 * bukan input user ujung yang perlu pesan error.
 */
export const MAX_CONVERSATION_LIMIT = 200;

/**
 * Kebijakan rate limit pengiriman pesan per pengirim: 10 pesan / 30 detik
 * (jendela geser). DAPAT DISETEL lewat deps MessageService / constructor
 * SlidingWindowRateLimiter — ini angka AWAL Fase 2, belum ada data produksi
 * untuk menyetelnya lebih presisi.
 */
export const DEFAULT_MESSAGE_RATE_LIMIT = { maxEvents: 10, windowMs: 30_000 } as const;

// ============================================================
// Skema validasi (Zod)
// ============================================================

/**
 * Bentuk uuid (8-4-4-4-12 heksadesimal, huruf besar/kecil) — kolom id/
 * sender_id/recipient_id di DB. Dipakai untuk memvalidasi ARGUMEN SEBELUM
 * nilainya diinterpolasi ke filter `.or()` PostgREST (pertahanan injeksi:
 * hanya hex dan strip yang lolos).
 */
export const UuidSchema = z
  .string()
  .regex(/^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/);

/**
 * Body pesan — 1..MAX_MESSAGE_BODY_CHARS karakter SETELAH trim, semantik
 * constraint DB `char_length(btrim(body)) between 1 and 500`. Catatan jujur:
 * Zod .trim() memangkas SEMUA whitespace sedangkan btrim SQL hanya spasi,
 * sehingga client sedikit LEBIH KETAT — arah selisih ini aman: hasil trim
 * Zod tidak pernah diawali/diakhiri spasi lagi sehingga btrim tidak memotong
 * apa pun dan apa pun yang lolos skema PASTI lolos constraint DB.
 */
export const MessageBodySchema = z.string().trim().min(1).max(MAX_MESSAGE_BODY_CHARS);

/**
 * Stempel waktu ISO-8601 `YYYY-MM-DDTHH:mm:ss[.sss](Z|±HH:MM)` — bentuk yang
 * dipancarkan PostgREST untuk timestamptz (offset +00:00) maupun ISO standar
 * (Z). Dipakai untuk kolom created_at baris dan kursor `before`. Validasi
 * BENTUK saja (bukan kalender) — cukup untuk tujuannya: nilai asing tidak
 * pernah sampai terinterpolasi ke filter `.lt()`.
 */
export const IsoTimestampSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}[Tt]\d{2}:\d{2}:\d{2}(\.\d+)?([Zz]|[+-]\d{2}:\d{2})$/);

/**
 * Baris mentah tabel `messages` (kolom snake_case persis DB 0009). Refine
 * sender ≠ recipient mengikuti constraint `messages_no_self` — baris hasil
 * jaringan yang melanggar invariant itu ditolak di revalidasi.
 */
export const MessageRowSchema = z
  .object({
    id: UuidSchema,
    sender_id: UuidSchema,
    recipient_id: UuidSchema,
    body: MessageBodySchema,
    created_at: IsoTimestampSchema,
  })
  .refine((row) => row.sender_id !== row.recipient_id, {
    message: 'sender_id dan recipient_id tidak boleh sama (messages_no_self)',
  });

// ============================================================
// Tipe turunan
// ============================================================

export type MessageRow = z.infer<typeof MessageRowSchema>;

/** Pesan dalam bentuk camelCase (API publik modul). */
export interface ChatMessage {
  id: string;
  senderId: string;
  recipientId: string;
  body: string;
  createdAt: string;
}

// ============================================================
// Error domain
// ============================================================

/** Kode kegagalan modul chat — mesin pesan error yang seragam. */
export type ChatErrorCode =
  | 'invalid-uuid' // senderId/recipientId/userId/otherUserId bukan uuid
  | 'invalid-body' // body gagal MessageBodySchema
  | 'invalid-cursor' // opts.before bukan timestamp ISO valid
  | 'self' // kirim/minta percakapan ke diri sendiri (cek lokal maupun DB 23514)
  | 'rate-limited' // jendela geser pengirim habis (lihat retryAfterMs)
  | 'not-friends' // gate pertemanan: tidak ada friendship accepted antar keduanya
  | 'blocked' // trigger messages_block_guard menolak insert (P0001)
  | 'db-error' // kegagalan PostgREST lain
  | 'invalid-row'; // baris hasil tidak lolos revalidasi Zod

/** Opsi tambahan ChatError (keduanya opsional, keduanya terdokumentasi). */
export interface ChatErrorOptions {
  cause?: unknown;
  /**
   * HANYA untuk kode 'rate-limited': sisa milidetik sampai satu slot event
   * bebas — pemanggil bisa memakainya untuk menunda coba ulang tanpa harus
   * mem-parsing pesan error.
   */
  retryAfterMs?: number;
}

export class ChatError extends Error {
  readonly code: ChatErrorCode;
  readonly cause?: unknown;
  readonly retryAfterMs?: number;

  constructor(code: ChatErrorCode, message: string, options?: ChatErrorOptions) {
    super(message);
    this.name = 'ChatError';
    this.code = code;
    if (options?.cause !== undefined) {
      this.cause = options.cause;
    }
    if (options?.retryAfterMs !== undefined) {
      this.retryAfterMs = options.retryAfterMs;
    }
  }
}

// ============================================================
// Bentuk struktural Supabase (structural typing — klien asli lolos
// lewat adapter; test menyuntik fake; hanya sub-kemampuan yang dipakai)
// ============================================================

/** Error PostgREST minimal yang dibaca modul ini. */
export interface SupabaseErrorLike {
  message: string;
  statusCode?: string;
  code?: string;
}

export type SingleResponseLike<T> =
  { data: T; error: null } | { data: null; error: SupabaseErrorLike };

export type ListResponseLike<T> =
  { data: T[]; error: null } | { data: null; error: SupabaseErrorLike };

/**
 * Rantai select yang dipakai modul chat: await-able (hasil DAFTAR baris),
 * .or() untuk filter pasangan kanonik (messages maupun friendships),
 * .eq() untuk gate status friendship, .lt() untuk kursor created_at,
 * .order()+.limit() untuk pagination DESC. maybeSingle() mengubah bentuk
 * hasil menjadi SATU baris (null bila kosong) — dipakai gate pertemanan.
 */
export interface ChatSelectChainLike extends PromiseLike<ListResponseLike<unknown>> {
  or(query: string): ChatSelectChainLike;
  eq(column: string, value: string): ChatSelectChainLike;
  lt(column: string, value: string): ChatSelectChainLike;
  order(column: string, options: { ascending: boolean }): ChatSelectChainLike;
  limit(count: number): ChatSelectChainLike;
  maybeSingle(): PromiseLike<SingleResponseLike<unknown>>;
}

/** Rantai insert: await-able, .select().single() mengembalikan baris baru. */
export interface ChatInsertChainLike extends PromiseLike<SingleResponseLike<unknown>> {
  select(columns?: string): ChatInsertChainLike;
  single(): PromiseLike<SingleResponseLike<unknown>>;
}

/** Sub-kemampuan tabel `messages` dan `friendships` yang dipakai modul ini. */
export interface ChatTableLike {
  select(columns?: string): ChatSelectChainLike;
  insert(values: Record<string, unknown>): ChatInsertChainLike;
}

export interface SupabaseChatLike {
  from(table: string): ChatTableLike;
}

/**
 * Adapter klien asli → SupabaseChatLike.
 *
 * Cast tunggal yang terkendali dan terdokumentasi — alasan sama dengan
 * profile (asProfileClient): generics rantai PostgREST (GetResult atas
 * schema `any`) memicu TS2589 saat perbandingan struktural langsung.
 * Bukti kompatibilitas dilakukan RUNTIME di type-compat.test.ts, yang
 * menelusuri rantai persis yang dipakai MessageService pada klien asli:
 * from().select().or(and(...),and(...)).eq().maybeSingle(),
 * from().select().or(...).lt().order().limit(), dan
 * from().insert().select().single().
 */
export function asChatClient(client: SupabaseClient): SupabaseChatLike {
  return client as unknown as SupabaseChatLike;
}
