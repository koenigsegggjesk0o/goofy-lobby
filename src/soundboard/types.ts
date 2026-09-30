import { z } from 'zod';

// ============================================================
// Konstanta bucket & custom sound (selaras migrasi 0012/0013)
// ============================================================

/** Nama bucket storage privat untuk custom sound milik user. */
export const SOUNDBOARD_BUCKET_NAME = 'soundboard-sounds' as const;

/**
 * Hard cap ukuran objek bucket (5.242.880 byte = 5 MiB, persis
 * `file_size_limit` di migrasi 0012). Client menolak lebih awal supaya
 * pesan errornya jelas sebelum menyentuh jaringan.
 */
export const MAX_CUSTOM_SOUND_BYTES = 5_242_880;

/**
 * MIME yang diterima bucket — PERSIS isi `allowed_mime_types` migrasi
 * 0012 (audio/webm, audio/mpeg, audio/wav, audio/ogg, audio/mp4).
 * Perbandingan di layanan memakai kesamaan EKSAK, bukan startsWith:
 * bucket menolak varian parameter seperti `audio/webm;codecs=opus`,
 * jadi menerima varian itu secara lokal hanya memindahkan kegagalan
 * ke respons server dengan pesan yang jauh lebih kabur.
 */
export const ALLOWED_CUSTOM_SOUND_MIMES = [
  'audio/webm',
  'audio/mpeg',
  'audio/wav',
  'audio/ogg',
  'audio/mp4',
] as const;

/** Ekstensi file yang dipakai konvensi path `{userId}/{soundId}.{ext}`. */
export type CustomSoundExtension = 'webm' | 'mp3' | 'wav' | 'ogg' | 'm4a';

/** MIME custom sound yang diterima (union dari ALLOWED_CUSTOM_SOUND_MIMES). */
export type CustomSoundMimeType = (typeof ALLOWED_CUSTOM_SOUND_MIMES)[number];

/**
 * Peta MIME → ekstensi file. Ekstensi TIDAK bisa diturunkan dari MIME
 * secara string-slicing (audio/mpeg → mp3, audio/mp4 → m4a), jadi dipetakan
 * eksplisit dan dikunci const agar test bisa memverifikasi keduanya.
 */
export const CUSTOM_SOUND_EXTENSION_BY_MIME: Readonly<
  Record<CustomSoundMimeType, CustomSoundExtension>
> = {
  'audio/webm': 'webm',
  'audio/mpeg': 'mp3',
  'audio/wav': 'wav',
  'audio/ogg': 'ogg',
  'audio/mp4': 'm4a',
};

/** Lama default signed URL playback (5 menit — cukup untuk memutar sekali). */
export const SIGNED_URL_DEFAULT_EXPIRY_S = 300;

// ============================================================
// Kuota penyimpanan per-user (remediasi audit 25 M1 — storage burn)
// ============================================================

/**
 * Maksimum JUMLAH custom sound per user (kuota per-user, audit 25 M1:
 * tanpa batas ini seorang user bisa membakar kuota 1 GB project
 * seorang diri). 30 klip pendek per akun — soundboard penuh bagi satu
 * room masih jauh di bawahnya.
 */
export const MAX_CUSTOM_SOUND_FILES = 30;

/**
 * Maksimum TOTAL byte folder `${userId}/` di bucket soundboard-sounds
 * (150 MiB = 157.286.400 byte). Dipakai bersama MAX_CUSTOM_SOUND_FILES;
 * yang mana pun tercapai lebih dulu → penolakan 'quota_exceeded'.
 */
export const MAX_CUSTOM_SOUND_TOTAL_BYTES = 157_286_400;

/**
 * Ukuran halaman panggilan storage list — API Supabase mengembalikan
 * maksimum 100 objek per panggilan, sehingga penghitungan kuota WAJIB
 * memaginasi (limit+offset) sampai folder habis (remediasi audit 25 M1).
 */
export const STORAGE_LIST_PAGE_SIZE = 100;

// ============================================================
// Skema validasi (Zod)
// ============================================================

/**
 * Path objek custom sound: satu level folder (userId) + nama file dengan
 * salah satu ekstensi yang didukung. Selaras dengan konvensi path yang
 * dijaga policy RLS 0013 (folder-per-user `{auth.uid()}/...`).
 */
export const CustomSoundPathSchema = z
  .string()
  .regex(/^[0-9a-fA-F-]{1,64}\/[A-Za-z0-9._-]{1,64}\.(webm|mp3|wav|ogg|m4a)$/);

/** Slug kebab-case untuk id preset (huruf kecil/angka, tanpa dash di ujung). */
export const PresetSoundIdSchema = z.string().regex(/^[a-z0-9]+(-[a-z0-9]+)*$/);

/**
 * Path aset preset di repo: `/sounds/{nama}.{ext}` — file statis di
 * `public/sounds/` (aset fisik dijadwalkan Fase 3; ini kontrak pathnya).
 */
export const PresetSoundAssetPathSchema = z
  .string()
  .regex(/^\/sounds\/[a-z0-9-]+\.(webm|mp3|wav|ogg|m4a)$/);

/** Kategori preset sound — selaras enum UI Fase 3. */
export const PresetSoundCategorySchema = z.enum(['sfx', 'meme']);

/** Entri katalog preset sound (data model — bukan aset fisik). */
export const PresetSoundSchema = z.object({
  id: PresetSoundIdSchema,
  name: z.string().min(1).max(32),
  category: PresetSoundCategorySchema,
  assetPath: PresetSoundAssetPathSchema,
});

// ============================================================
// Tipe turunan
// ============================================================

/** Preset sound bawaan (katalog statis, id stabil lintas rilis). */
export type PresetSound = z.infer<typeof PresetSoundSchema>;

/**
 * Referensi custom sound yang berhasil diunggah — bentuk publik yang
 * dikembalikan layanan upload dan disimpan caller.
 */
export interface CustomSoundRef {
  /** Path objek di bucket: `{userId}/{soundId}.{ext}`. */
  path: string;
  /** Path penuh versi Supabase: `{bucketName}/{path}`. */
  fullPath: string;
  /** Ukuran blob yang diunggah (byte). */
  bytes: number;
  /** MIME yang terkirim (selalu salah satu ALLOWED_CUSTOM_SOUND_MIMES). */
  mimeType: CustomSoundMimeType;
}

// ============================================================
// Error domain
// ============================================================

/** Kode kegagalan modul soundboard — mesin pesan error yang seragam. */
export type SoundboardErrorCode =
  | 'not-signed-in'
  | 'empty-file'
  | 'too-large'
  | 'wrong-mime'
  | 'invalid-path'
  | 'storage-error'
  | 'quota_exceeded'
  | 'invalid-preset';

export class SoundboardError extends Error {
  readonly code: SoundboardErrorCode;
  readonly cause?: unknown;

  constructor(code: SoundboardErrorCode, message: string, cause?: unknown) {
    super(message);
    this.name = 'SoundboardError';
    this.code = code;
    if (cause !== undefined) {
      this.cause = cause;
    }
  }
}

// ============================================================
// Bentuk struktural Supabase (structural typing)
// ============================================================
// Pola ini DISALIN dari src/profile/types.ts (SupabaseErrorLike s.d.
// SupabaseStorageLike) supaya modul soundboard mandiri dan tidak
// menimbulkan dependensi antar-domain — bentuknya identik secara
// struktural sehingga SupabaseClient asli tetap lolos tanpa adaptasi;
// bukti kompatibilitas ada di type-compat.test.ts.

/** Error PostgREST/Storage minimal yang dibaca modul ini. */
export interface SupabaseErrorLike {
  message: string;
  statusCode?: string;
  code?: string;
}

export type SingleResponseLike<T> =
  { data: T; error: null } | { data: null; error: SupabaseErrorLike };

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
// Helper MIME
// ============================================================

/**
 * Type guard: apakah `mime` PERSIS salah satu ALLOWED_CUSTOM_SOUND_MIMES?
 * Kesamaan eksak — bukan startsWith — karena allowed_mime_types bucket
 * (0012) tidak memuat varian `;codecs=...`.
 */
export function isAllowedCustomSoundMime(mime: string): mime is CustomSoundMimeType {
  return (ALLOWED_CUSTOM_SOUND_MIMES as readonly string[]).includes(mime);
}

// ============================================================
// Helper path
// ============================================================

/**
 * Menyusun path custom sound `{userId}/{soundId}.{ext}` — menolak segmen
 * yang mengandung `/` atau kosong (pertahanan pertama sebelum Zod/DB).
 */
export function makeCustomSoundPath(
  userId: string,
  soundId: string,
  ext: CustomSoundExtension,
): string {
  if (userId === '' || userId.includes('/')) {
    throw new SoundboardError('invalid-path', `userId tidak valid: "${userId}"`);
  }
  if (soundId === '' || soundId.includes('/')) {
    throw new SoundboardError('invalid-path', `soundId tidak valid: "${soundId}"`);
  }
  const path = `${userId}/${soundId}.${ext}`;
  const parsed = CustomSoundPathSchema.safeParse(path);
  if (!parsed.success) {
    throw new SoundboardError(
      'invalid-path',
      `path custom sound tidak lolos validasi: ${path}`,
      parsed.error.issues,
    );
  }
  return path;
}

/** Validasi path custom sound — melempar SoundboardError bila tidak sah. */
export function assertCustomSoundPath(path: string): string {
  const parsed = CustomSoundPathSchema.safeParse(path);
  if (!parsed.success) {
    throw new SoundboardError(
      'invalid-path',
      `path custom sound tidak lolos validasi: ${path}`,
      parsed.error.issues,
    );
  }
  return parsed.data;
}
