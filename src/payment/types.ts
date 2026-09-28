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

/**
 * Hasil routing event webhook:
 * - ok:true → event diproses (handled:true) atau di-acknowledge
 *   (handled:false — event tak dikenal; idempoten & aman untuk event
 *   baru Paddle: menolaknya hanya memicu retry tanpa henti).
 * - ok:false → alasan bertingkat sesuai urutan pemeriksaan:
 *   signature (PaddleSignatureFailure) → bentuk (invalid-json,
 *   invalid-event) → pemetaan user (missing-user-id) → penerapan
 *   (apply-failed).
 */
export type PaddleWebhookOutcome =
  | { ok: true; handled: boolean; eventType: string; userId?: string }
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
