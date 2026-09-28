import {
  ALLOWED_CUSTOM_SOUND_MIMES,
  CUSTOM_SOUND_EXTENSION_BY_MIME,
  MAX_CUSTOM_SOUND_BYTES,
  SIGNED_URL_DEFAULT_EXPIRY_S,
  SOUNDBOARD_BUCKET_NAME,
  SoundboardError,
  assertCustomSoundPath,
  isAllowedCustomSoundMime,
  makeCustomSoundPath,
  type CustomSoundRef,
  type StorageBucketLike,
  type SupabaseStorageLike,
} from './types';

export interface CustomSoundServiceDeps {
  /** Klien Supabase (hanya sub-kemampuan storage yang dipakai). */
  supabase: SupabaseStorageLike;
  /** Jam terkontrol (test) — untuk menyusun soundId unik. */
  now?: () => number;
  /** Generator bagian acak soundId (default: crypto.randomUUID). */
  randomId?: () => string;
}

export interface PlaybackUrl {
  signedUrl: string;
  expiresInS: number;
}

/** Pesan daftar MIME untuk error wrong-mime (dibaca manusia, bukan kontrak). */
const ALLOWED_MIMES_MESSAGE = ALLOWED_CUSTOM_SOUND_MIMES.join(', ');

/**
 * Layanan storage custom sound di bucket privat `soundboard-sounds`.
 *
 * Mirror VoiceSnippetService (src/profile) dengan dua perbedaan kontraktual:
 * - MULTI-MIME: blob boleh salah satu dari 5 MIME allowed_mime_types (0012),
 *   dan ekstensi path diturunkan dari MIME lewat CUSTOM_SOUND_EXTENSION_BY_MIME.
 * - Content-Type upload = blob.type apa adanya, karena blob sudah divalidasi
 *   PERSIS terhadap daftar MIME bucket (varian `;codecs=...` ditolak lokal
 *   — bucket memang menolaknya, lihat komentar ALLOWED_CUSTOM_SOUND_MIMES).
 *
 * Path selalu `{userId}/{soundId}.{ext}` (folder-per-user, dijaga RLS 0013:
 * INSERT/DELETE folder milik sendiri, SELECT semua authenticated). Upload
 * TIDAK memakai upsert — bucket sengaja tanpa policy UPDATE, jadi sound baru
 * = path baru; sound lama dihapus eksplisit oleh caller. Semua validasi
 * lokal (userId, ukuran, mime, path) terjadi SEBELUM jaringan.
 */
export class CustomSoundService {
  readonly #bucket: () => StorageBucketLike;
  readonly #now: () => number;
  readonly #randomId: () => string;

  constructor(deps: CustomSoundServiceDeps) {
    const client = deps.supabase;
    this.#bucket = () => client.storage.from(SOUNDBOARD_BUCKET_NAME);
    this.#now = deps.now ?? Date.now;
    this.#randomId = deps.randomId ?? defaultRandomId;
  }

  /**
   * Mengunggah custom sound baru milik `userId`. Validasi lokal: userId
   * terisi, blob tidak kosong, ≤ 5 MiB, MIME PERSIS salah satu MIME bucket
   * (varian codecs ditolak di sini, bukan di server). Mengembalikan
   * referensi path + fullPath + byte + MIME objek.
   */
  async uploadCustomSound(userId: string, blob: Blob): Promise<CustomSoundRef> {
    if (userId === '') {
      throw new SoundboardError('not-signed-in', 'userId kosong — belum signin?');
    }
    if (blob.size === 0) {
      throw new SoundboardError('empty-file', 'file custom sound kosong (0 byte)');
    }
    if (blob.size > MAX_CUSTOM_SOUND_BYTES) {
      throw new SoundboardError(
        'too-large',
        `ukuran ${blob.size} byte melebihi cap ${MAX_CUSTOM_SOUND_BYTES} byte`,
      );
    }
    const mimeType = blob.type;
    if (!isAllowedCustomSoundMime(mimeType)) {
      throw new SoundboardError(
        'wrong-mime',
        `MIME blob "${mimeType}" bukan salah satu dari ${ALLOWED_MIMES_MESSAGE}`,
      );
    }
    const ext = CUSTOM_SOUND_EXTENSION_BY_MIME[mimeType];
    const soundId = `sound-${this.#now().toString(36)}-${this.#randomId()}`;
    const path = makeCustomSoundPath(userId, soundId, ext);
    const response = await this.#bucket().upload(path, blob, {
      contentType: mimeType,
      upsert: false,
      cacheControl: '3600',
    });
    if (response.error !== null) {
      throw new SoundboardError(
        'storage-error',
        `upload custom sound gagal: ${response.error.message}`,
        response.error,
      );
    }
    return {
      path: response.data.path,
      fullPath: response.data.fullPath,
      bytes: blob.size,
      mimeType,
    };
  }

  /**
   * Membuat signed URL playback untuk path custom sound (bucket privat).
   * Path divalidasi lokal dulu — path asing tidak dikirim ke server.
   */
  async createPlaybackUrl(
    path: string,
    expiresInS: number = SIGNED_URL_DEFAULT_EXPIRY_S,
  ): Promise<PlaybackUrl> {
    const validPath = assertCustomSoundPath(path);
    if (!Number.isInteger(expiresInS) || expiresInS <= 0 || expiresInS > 86_400) {
      throw new SoundboardError('invalid-path', `expiresInS tidak valid: ${expiresInS}`);
    }
    const response = await this.#bucket().createSignedUrl(validPath, expiresInS);
    if (response.error !== null) {
      throw new SoundboardError(
        'storage-error',
        `createSignedUrl gagal: ${response.error.message}`,
        response.error,
      );
    }
    return { signedUrl: response.data.signedUrl, expiresInS };
  }

  /** Menghapus objek custom sound milik user (RLS delete = owner-only). */
  async deleteCustomSound(path: string): Promise<void> {
    const validPath = assertCustomSoundPath(path);
    const response = await this.#bucket().remove([validPath]);
    if (response.error !== null) {
      throw new SoundboardError(
        'storage-error',
        `hapus custom sound gagal: ${response.error.message}`,
        response.error,
      );
    }
  }

  /**
   * Daftar nama file custom sound di folder `userId` (untuk kebersihan/audit;
   * RLS select mengizinkan folder siapa pun bagi yang terautentikasi).
   */
  async listCustomSoundNames(userId: string): Promise<string[]> {
    if (userId === '') {
      throw new SoundboardError('not-signed-in', 'userId kosong — belum signin?');
    }
    const response = await this.#bucket().list(userId);
    if (response.error !== null) {
      throw new SoundboardError(
        'storage-error',
        `list custom sound gagal: ${response.error.message}`,
        response.error,
      );
    }
    return response.data.map((entry) => entry.name);
  }
}

function defaultRandomId(): string {
  const cryptoApi = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto;
  if (typeof cryptoApi?.randomUUID === 'function') {
    return cryptoApi.randomUUID().slice(0, 8);
  }
  return Math.random().toString(36).slice(2, 10);
}
