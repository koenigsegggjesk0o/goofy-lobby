import { z } from 'zod';
import type { SupabaseClient } from '@supabase/supabase-js';

// ============================================================
// Konstanta bucket & snippet (selaras migrasi 0003/0006)
// ============================================================

/** Nama bucket storage privat untuk snippet suara profil. */
export const VOICE_BUCKET_NAME = 'voice-snippets' as const;

/**
 * Hard cap ukuran objek bucket (26.214.400 byte = 25 MiB, persis
 * `file_size_limit` di migrasi 0003). Client menolak lebih awal supaya
 * pesan errornya jelas sebelum menyentuh jaringan.
 */
export const MAX_VOICE_SNIPPET_BYTES = 26_214_400;

/**
 * Durasi maksimum perekaman snippet (auto-stop). Snippet = intro suara
 * profil yang singkat; 15 detik sangat cukup dan menjauhkan ukuran
 * dari cap 25 MiB (Opus ~24 kbps × 15 s ≈ 45 KB).
 */
export const MAX_VOICE_DURATION_MS = 15_000;

/**
 * MIME yang diterima bucket — PERSIS `audio/webm` (allowed_mime_types di
 * migrasi 0003 tidak memuat varian `;codecs=opus`). Header Content-Type
 * saat upload memakai konstanta ini, terlepas dari `recorder.mimeType`.
 */
export const VOICE_UPLOAD_MIME = 'audio/webm' as const;

/** Kandidat MIME perekaman, diuji berurutan lewat MediaRecorder.isTypeSupported. */
export const PREFERRED_RECORDING_MIMES = ['audio/webm', 'audio/webm;codecs=opus'] as const;

/** Lama default signed URL playback (5 menit — cukup untuk dengar sekali). */
export const SIGNED_URL_DEFAULT_EXPIRY_S = 300;

/** Interval timeslice ondataavailable (ms) — untuk pemantauan byte budget. */
export const RECORDER_TIMESLICE_MS = 500;

// ============================================================
// Kuota penyimpanan per-user (remediasi audit 25 M1 — storage burn)
// ============================================================

/**
 * Maksimum JUMLAH file snippet suara per user (kuota per-user, audit 25
 * M1: tanpa batas ini seorang user bisa membakar kuota 1 GB project
 * seorang diri). 5 versi snippet lebih dari cukup untuk "intro suara
 * profil" — snippet aktif memang selalu satu (profiles.voice_snippet_path).
 */
export const MAX_VOICE_SNIPPET_FILES = 5;

/**
 * Maksimum TOTAL byte folder `${userId}/` di bucket voice-snippets
 * (100 MiB = 104.857.600 byte). Dipakai bersama MAX_VOICE_SNIPPET_FILES;
 * yang mana pun tercapai lebih dulu → penolakan 'quota_exceeded'.
 */
export const MAX_VOICE_SNIPPET_TOTAL_BYTES = 104_857_600;

/**
 * Batas Ukuran halaman panggilan storage list — API Supabase mengembalikan
 * maksimum 100 objek per panggilan, sehingga penghitungan kuota WAJIB
 * memaginasi (limit+offset) sampai folder habis (remediasi audit 25 M1).
 */
export const STORAGE_LIST_PAGE_SIZE = 100;

// ============================================================
// Skema validasi (Zod)
// ============================================================

/** Nama tampilan — sama dengan constraint DB: 1–32 karakter setelah trim. */
export const DisplayNameSchema = z.string().trim().min(1).max(32);

/** Warna avatar heksadesimal #RRGGBB — sama dengan constraint DB. */
export const AvatarColorSchema = z.string().regex(/^#[0-9a-fA-F]{6}$/);

/**
 * Path objek snippet: satu level folder (userId) + nama file .webm.
 * Selaras dengan constraint `profiles_voice_snippet_path_format` (0006).
 */
export const SnippetPathSchema = z
  .string()
  .regex(/^[0-9a-fA-F-]{1,64}\/[A-Za-z0-9._-]{1,64}\.webm$/);

/** Patch profil yang boleh dikirim client (whitelist eksplisit). */
export const ProfileUpdateSchema = z
  .object({
    displayName: DisplayNameSchema.optional(),
    avatarColor: AvatarColorSchema.optional(),
  })
  .refine((patch) => patch.displayName !== undefined || patch.avatarColor !== undefined, {
    message: 'minimal satu field (displayName/avatarColor)',
  });

/** Baris mentah dari PostgREST (kolom snake_case persis DB). */
export const ProfileRowSchema = z.object({
  id: z.string().min(1),
  display_name: DisplayNameSchema,
  avatar_color: AvatarColorSchema,
  voice_snippet_path: SnippetPathSchema.nullable(),
  created_at: z.string().min(1),
  updated_at: z.string().min(1),
});

// ============================================================
// Tipe turunan
// ============================================================

export type ProfileUpdate = z.infer<typeof ProfileUpdateSchema>;
export type ProfileRow = z.infer<typeof ProfileRowSchema>;

/** Profil dalam bentuk camelCase (API publik modul). */
export interface Profile {
  id: string;
  displayName: string;
  avatarColor: string;
  voiceSnippetPath: string | null;
  createdAt: string;
  updatedAt: string;
}

/** Hasil perekaman yang siap diunggah. */
export interface VoiceRecordingResult {
  blob: Blob;
  durationMs: number;
  /** 'duration' | 'byte-cap' bila perekaman berhenti otomatis, null lainnya. */
  autoStopped: 'duration' | 'byte-cap' | null;
}

// ============================================================
// Error domain
// ============================================================

/** Kode kegagalan modul profil/snippet — mesin pesan error yang seragam. */
export type VoiceSnippetErrorCode =
  | 'busy'
  | 'mic-denied'
  | 'unsupported-mime'
  | 'recorder-error'
  | 'not-signed-in'
  | 'empty-recording'
  | 'too-large'
  | 'wrong-mime'
  | 'invalid-path'
  | 'storage-error'
  | 'quota_exceeded'
  | 'profile-error'
  | 'invalid-profile-row'
  | 'update-empty';

export class VoiceSnippetError extends Error {
  readonly code: VoiceSnippetErrorCode;
  readonly cause?: unknown;

  constructor(code: VoiceSnippetErrorCode, message: string, cause?: unknown) {
    super(message);
    this.name = 'VoiceSnippetError';
    this.code = code;
    if (cause !== undefined) {
      this.cause = cause;
    }
  }
}

// ============================================================
// Bentuk struktural Supabase (structural typing — client asli lolos
// tanpa adaptasi; test menyuntik fake; hanya sub-kemampuan yang dipakai)
// ============================================================

/** Error PostgREST/Storage minimal yang dibaca modul ini. */
export interface SupabaseErrorLike {
  message: string;
  statusCode?: string;
  code?: string;
}

export type SingleResponseLike<T> =
  { data: T; error: null } | { data: null; error: SupabaseErrorLike };

/** Rantai select: await-able, .eq(), .maybeSingle(). */
export interface ProfileSelectChainLike extends PromiseLike<SingleResponseLike<unknown>> {
  eq(column: string, value: string): ProfileSelectChainLike;
  maybeSingle(): PromiseLike<SingleResponseLike<unknown>>;
}

/** Rantai update: await-able, .eq(), .select(), .single(). */
export interface ProfileUpdateChainLike extends PromiseLike<SingleResponseLike<unknown>> {
  eq(column: string, value: string): ProfileUpdateChainLike;
  select(columns?: string): ProfileUpdateChainLike;
  single(): PromiseLike<SingleResponseLike<unknown>>;
}

export interface ProfileTableLike {
  select(columns?: string): ProfileSelectChainLike;
  update(values: Record<string, unknown>): ProfileUpdateChainLike;
}

export interface SupabaseProfileLike {
  from(table: string): ProfileTableLike;
}

/**
 * Adapter klien asli → SupabaseProfileLike.
 *
 * Cast tunggal yang terkendali dan terdokumentasi: generics rantai
 * PostgREST (GetResult atas schema `any`) membuat TS menyerah dengan
 * TS2589 saat perbandingan struktural langsung — bukti kompatibilitas
 * dilakukan RUNTIME di type-compat.test.ts (berjalan menelusuri rantai
 * from().select().eq().maybeSingle() dan from().update().eq().select()
 * .single() pada klien asli).
 */
export function asProfileClient(client: SupabaseClient): SupabaseProfileLike {
  return client as unknown as SupabaseProfileLike;
}

export interface UploadResultLike {
  path: string;
  fullPath: string;
}

export interface StorageBucketLike {
  upload(
    path: string,
    body: Blob,
    options?: { contentType?: string; upsert?: boolean; cacheControl?: string },
  ): Promise<SingleResponseLike<UploadResultLike>>;
  createSignedUrl(
    path: string,
    expiresIn: number,
  ): Promise<SingleResponseLike<{ signedUrl: string }>>;
  remove(paths: string[]): Promise<SingleResponseLike<unknown>>;
  /**
   * Daftar objek dengan prefix path — opsi paginasi (limit/offset) +
   * metadata.size dipakai penghitung kuota (audit 25 M1). Entri folder
   * punya metadata null (konvensi Supabase: id null) — diabaikan.
   */
  list(
    folder?: string,
    options?: {
      limit?: number;
      offset?: number;
      sortBy?: { column: string; order?: 'asc' | 'desc' };
    },
  ): Promise<SingleResponseLike<Array<{ name: string; metadata?: { size?: number } | null }>>>;
}

export interface SupabaseStorageLike {
  storage: { from(bucket: string): StorageBucketLike };
}

// ============================================================
// Helper
// ============================================================

/**
 * Menyusun path snippet `{userId}/{snippetId}.webm` — menolak segmen yang
 * mengandung `/` atau kosong (pertahanan pertama sebelum Zod/DB).
 */
export function makeSnippetPath(userId: string, snippetId: string): string {
  if (userId === '' || userId.includes('/')) {
    throw new VoiceSnippetError('invalid-path', `userId tidak valid: "${userId}"`);
  }
  if (snippetId === '' || snippetId.includes('/')) {
    throw new VoiceSnippetError('invalid-path', `snippetId tidak valid: "${snippetId}"`);
  }
  const path = `${userId}/${snippetId}.webm`;
  const parsed = SnippetPathSchema.safeParse(path);
  if (!parsed.success) {
    throw new VoiceSnippetError(
      'invalid-path',
      `path snippet tidak lolos validasi: ${path}`,
      parsed.error.issues,
    );
  }
  return path;
}

/** Validasi path snippet — melempar VoiceSnippetError bila tidak sah. */
export function assertSnippetPath(path: string): string {
  const parsed = SnippetPathSchema.safeParse(path);
  if (!parsed.success) {
    throw new VoiceSnippetError(
      'invalid-path',
      `path snippet tidak lolos validasi: ${path}`,
      parsed.error.issues,
    );
  }
  return parsed.data;
}
