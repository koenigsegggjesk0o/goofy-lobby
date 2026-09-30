import { z } from 'zod';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { PaddleSignatureFailure } from './paddle-signature';

// ============================================================
// Error domain
// ============================================================

/**
 * Kode kegagalan modul payment — mesin pesan error yang seragam
 * (pola VoiceSnippetErrorCode di src/profile/types.ts).
 */
export type PaymentErrorCode = 'not-signed-in' | 'profile-error' | 'invalid-profile-row';

export class PaymentError extends Error {
  readonly code: PaymentErrorCode;
  readonly cause?: unknown;

  constructor(code: PaymentErrorCode, message: string, cause?: unknown) {
    super(message);
    this.name = 'PaymentError';
    this.code = code;
    if (cause !== undefined) {
      this.cause = cause;
    }
  }
}

// ============================================================
// Skema baris premium (kontrak migrasi 0011)
// ============================================================

/**
 * Baris hasil select('id,is_premium') — dua kolom PERSIS yang diminta
 * layanan baca; kolom lain tidak pernah diminta, dan hasil jaringan
 * selalu direvalidasi Zod di sisi terima sebelum dipakai.
 */
export const PremiumProfileRowSchema = z.object({
  id: z.string().min(1),
  is_premium: z.boolean(),
});

export type PremiumProfileRow = z.infer<typeof PremiumProfileRowSchema>;

/** Hasil publik pembacaan status premium (camelCase). */
export interface PremiumStatus {
  userId: string;
  isPremium: boolean;
}

// ============================================================
// Bentuk struktural Supabase (pola profile/types.ts: hanya
// sub-kemampuan yang dipakai — rantai baca select().eq().maybeSingle()).
// Klien asli lolos lewat adapter; test menyuntik fake.
// ============================================================

/** Error PostgREST minimal yang dibaca modul ini. */
export interface SupabaseErrorLike {
  message: string;
  statusCode?: string;
  code?: string;
}

export type PremiumSingleResponseLike =
  { data: unknown; error: null } | { data: null; error: SupabaseErrorLike };

/** Rantai select baca status premium: await-able, .eq(), .maybeSingle(). */
export interface PremiumSelectChainLike extends PromiseLike<PremiumSingleResponseLike> {
  eq(column: string, value: string): PremiumSelectChainLike;
  maybeSingle(): PromiseLike<PremiumSingleResponseLike>;
}

export interface PremiumTableLike {
  select(columns?: string): PremiumSelectChainLike;
}

export interface SupabasePremiumLike {
  from(table: string): PremiumTableLike;
}

/**
 * Adapter klien asli → SupabasePremiumLike.
 *
 * Cast tunggal yang terkendali dan terdokumentasi (pola asProfileClient):
 * generics rantai PostgREST (GetResult atas schema `any`) membuat TS
 * menyerah dengan TS2589 saat perbandingan struktural langsung — bukti
 * kompatibilitas dilakukan RUNTIME di type-compat.test.ts (menelusuri
 * rantai from().select('id,is_premium').eq().maybeSingle() pada klien
 * asli).
 */
export function asPremiumClient(client: SupabaseClient): SupabasePremiumLike {
  return client as unknown as SupabasePremiumLike;
}

// ============================================================
// Tipe webhook Paddle (dipakai router core paddle-webhook.ts)
// ============================================================

/** Input mentah webhook: header signature + raw body + secret verifikasi. */
export interface PaddleWebhookEventInput {
  header: string;
  rawBody: string;
  secret: string;
}

/**
 * Efek samping penerapan status premium — disuntik pemanggil:
 * Edge Function memakai klien service_role, test memakai spy, sehingga
 * router core tetap murni dan teruji tanpa jaringan.
 */
export type ApplyPremiumStatus = (userId: string, isPremium: boolean) => Promise<void>;

// ============================================================
// Bentuk struktural db webhook Paddle (migrasi 0021)
// ============================================================

/**
 * Baris paddle_transactions yang ditulis router (snake_case, persis
 * kolom migrasi 0021). amount_total/currency nullable — event Paddle
 * boleh tidak membawanya (zod optional di router).
 */
export interface PaddleTransactionRow {
  transaction_id: string;
  user_id: string;
  price_id: string;
  amount_total: number | null;
  currency: string | null;
  status: 'completed' | 'price_rejected';
  refunded_at: string | null;
}

/**
 * Respons seragam rantai db webhook: daftar baris (null bila tanpa
 * .select()) atau error. Semua rantai router membaca bentuk ini —
 * row tunggal diambil via .limit(1) lalu data[0] (menghindari
 * maybeSingle() supaya satu tipe rantai cukup untuk semua kebutuhan).
 */
export type PaddleDbResponse =
  | { data: Array<Record<string, unknown>> | null; error: null }
  | { data: null; error: SupabaseErrorLike };

/**
 * Rantai PostgREST seragam yang dipakai router webhook (0021):
 * upsert(...).select(...), select(...).eq().limit(1), update(...).eq(),
 * lalu await. Satu bentuk rantai (bukan per-tabel) supaya fake test
 * tunggal mencukupi; bukti kompatibilitas klien asli ada di
 * type-compat.test.ts (pola asPremiumClient).
 */
export interface PaddleDbChainLike extends PromiseLike<PaddleDbResponse> {
  select(columns?: string): PaddleDbChainLike;
  eq(column: string, value: string): PaddleDbChainLike;
  limit(count: number): PaddleDbChainLike;
}

export interface PaddleDbTableLike {
  upsert(
    values: Record<string, unknown>,
    options?: { onConflict?: string; ignoreDuplicates?: boolean },
  ): PaddleDbChainLike;
  select(columns?: string): PaddleDbChainLike;
  update(values: Record<string, unknown>): PaddleDbChainLike;
}

/** Klien db minimal router webhook — tabel 'paddle_events' / 'paddle_transactions'. */
export interface PaddleWebhookDbLike {
  from(table: string): PaddleDbTableLike;
}

/**
 * Adapter klien asli → PaddleWebhookDbLike (pola asPremiumClient):
 * generics rantai PostgREST memicu TS2589 pada perbandingan struktural
 * langsung — kompatibilitas rantai upsert/select/update/eq/limit
 * dibuktikan RUNTIME di type-compat.test.ts.
 */
export function asPaddleWebhookDb(client: SupabaseClient): PaddleWebhookDbLike {
  return client as unknown as PaddleWebhookDbLike;
}

/**
 * Hasil routing event webhook:
 * - ok:true → event diproses (handled:true) atau di-acknowledge
 *   (handled:false — event tak dikenal/replay; idempoten & aman untuk
 *   event baru Paddle: menolaknya hanya memicu retry tanpa henti):
 *   - status 'duplicate'      : replay event yang pernah diproses — TANPA
 *     apply apa pun (idempotency 0021, audit 25 B2);
 *   - status 'granted'        : premium diaktifkan (transaction.completed
 *     dengan price_id lolos allowlist);
 *   - status 'revoked'        : premium dimatikan (subscription.canceled
 *     atau adjustment refund/credit approved);
 *   - status 'price_rejected' : transaksi DICATAT sebagai ditolak — TIDAK
 *     ada grant (allowlist kosong = fail-closed, audit 25 MEDIUM);
 *   - tanpa status            : event dikenal tapi tidak mengubah apa pun
 *     (mis. adjustment pending/rejected).
 * - ok:false → alasan bertingkat sesuai urutan pemeriksaan:
 *   signature (PaddleSignatureFailure) → bentuk (invalid-json,
 *   invalid-event) → pemetaan user (missing-user-id) → penerapan
 *   (apply-failed — termasuk kegagalan tulis ledger 0021).
 *
 * Anti-info-disclosure (audit 23-c LOW): detail kegagalan bentuk/zod
 * TIDAK PERNAH dibawa outcome — hanya ke console.error di router.
 * Satu-satunya detail yang tersisa = pesan error apply-failed, dan itu
 * pun TIDAK diteruskan ke body respons oleh Edge Function.
 */
export type PaddleWebhookOutcome =
  | {
      ok: true;
      handled: boolean;
      eventType: string;
      userId?: string;
      status?: 'duplicate' | 'granted' | 'revoked' | 'price_rejected';
    }
  | {
      ok: false;
      reason:
        | PaddleSignatureFailure
        | 'invalid-json'
        | 'invalid-event'
        | 'missing-user-id'
        | 'apply-failed';
      detail?: string;
    };
