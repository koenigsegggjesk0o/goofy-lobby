import {
  MAX_VOICE_SNIPPET_BYTES,
  MAX_VOICE_SNIPPET_FILES,
  MAX_VOICE_SNIPPET_TOTAL_BYTES,
  SIGNED_URL_DEFAULT_EXPIRY_S,
  STORAGE_LIST_PAGE_SIZE,
  VOICE_BUCKET_NAME,
  VOICE_UPLOAD_MIME,
  VoiceSnippetError,
  assertSnippetPath,
  makeSnippetPath,
  type StorageBucketLike,
  type SupabaseStorageLike,
} from './types';

export interface VoiceSnippetServiceDeps {
  /** Klien Supabase (hanya sub-kemampuan storage yang dipakai). */
  supabase: SupabaseStorageLike;
  /** Jam terkontrol (test) — untuk menyusun snippetId unik. */
  now?: () => number;
  /** Generator bagian acak snippetId (default: crypto.randomUUID). */
  randomId?: () => string;
}

export interface UploadedSnippet {
  path: string;
  fullPath: string;
  bytes: number;
}

export interface PlaybackUrl {
  signedUrl: string;
  expiresInS: number;
}

/**
 * Layanan storage snippet suara profil di bucket privat `voice-snippets`.
 *
 * - Path selalu `{userId}/{snippetId}.webm` (folder-per-user, dijaga RLS 0004).
 * - Upload TIDAK memakai upsert: bucket sengaja tanpa policy UPDATE, jadi
 *   snippet baru = path baru; snippet lama dihapus eksplisit oleh caller
 *   (lihat VoiceSnippetManager.replaceSnippet).
 * - Content-Type upload selalu PERSIS `audio/webm` (allowed_mime_types
 *   bucket 0003 tidak menerima varian `;codecs=opus`).
 * - Semua validasi lokal (ukuran, mime, path) terjadi SEBELUM jaringan.
 */
export class VoiceSnippetService {
  readonly #bucket: () => StorageBucketLike;
  readonly #now: () => number;
  readonly #randomId: () => string;

  constructor(deps: VoiceSnippetServiceDeps) {
    const client = deps.supabase;
    this.#bucket = () => client.storage.from(VOICE_BUCKET_NAME);
    this.#now = deps.now ?? Date.now;
    this.#randomId = deps.randomId ?? defaultRandomId;
  }

  /**
   * Mengunggah hasil perekaman sebagai snippet baru milik `userId`.
   * Validasi lokal: userId terisi, blob tidak kosong, ≤ 25 MiB, MIME
   * berawalan `audio/webm`; KUOTA per-user (audit 25 M1): jumlah file &
   * total byte folder `${userId}/` di bawah batas. Mengembalikan path +
   * fullPath objek.
   *
   * Residual yang DITERIMA (terdokumentasi): TOCTOU — dua upload bersamaan
   * dari tab/akun yang sama bisa lolos pengecekan kuota bersama-sama
   * (overshoot kecil, dibatasi cap 25 MiB/file). Penegakan kuota
   * server-side sejati membutuhkan mediasi Edge Function (hitung ulang di
   * sisi service_role sebelum menulis) — dicatat sebagai utang Fase 3.
   */
  async uploadSnippet(userId: string, blob: Blob): Promise<UploadedSnippet> {
    if (userId === '') {
      throw new VoiceSnippetError('not-signed-in', 'userId kosong — belum signin?');
    }
    if (blob.size === 0) {
      throw new VoiceSnippetError('empty-recording', 'perekaman kosong (0 byte)');
    }
    if (blob.size > MAX_VOICE_SNIPPET_BYTES) {
      throw new VoiceSnippetError(
        'too-large',
        `ukuran ${blob.size} byte melebihi cap ${MAX_VOICE_SNIPPET_BYTES} byte`,
      );
    }
    if (!blob.type.startsWith('audio/webm')) {
      throw new VoiceSnippetError('wrong-mime', `MIME blob "${blob.type}" bukan audio/webm`);
    }
    // Kuota per-user (audit 25 M1) — dihitung SEBELUM upload, dari
    // metadata.size seluruh folder milik sendiri (paginated: storage list
    // max 100 objek per panggilan).
    const usage = await this.#currentUsage(userId);
    if (usage.files >= MAX_VOICE_SNIPPET_FILES) {
      throw new VoiceSnippetError(
        'quota_exceeded',
        `kuota snippet penuh: maksimum ${MAX_VOICE_SNIPPET_FILES} file per akun — ` +
          `hapus snippet lama terlebih dulu`,
      );
    }
    if (usage.bytes + blob.size > MAX_VOICE_SNIPPET_TOTAL_BYTES) {
      throw new VoiceSnippetError(
        'quota_exceeded',
        `kuota penyimpanan snippet penuh: total terpakai ${usage.bytes} byte + unggahan ` +
          `${blob.size} byte melebihi batas ${MAX_VOICE_SNIPPET_TOTAL_BYTES} byte — ` +
          `hapus snippet lama terlebih dulu`,
      );
    }
    const snippetId = `snippet-${this.#now().toString(36)}-${this.#randomId()}`;
    const path = makeSnippetPath(userId, snippetId);
    const response = await this.#bucket().upload(path, blob, {
      contentType: VOICE_UPLOAD_MIME,
      upsert: false,
      cacheControl: '3600',
    });
    if (response.error !== null) {
      throw new VoiceSnippetError(
        'storage-error',
        `upload snippet gagal: ${response.error.message}`,
        response.error,
      );
    }
    return {
      path: response.data.path,
      fullPath: response.data.fullPath,
      bytes: blob.size,
    };
  }

  /**
   * Membuat signed URL playback untuk path snippet (bucket privat).
   * Path divalidasi lokal dulu — path asing tidak dikirim ke server.
   */
  async createPlaybackUrl(
    path: string,
    expiresInS: number = SIGNED_URL_DEFAULT_EXPIRY_S,
  ): Promise<PlaybackUrl> {
    const validPath = assertSnippetPath(path);
    if (!Number.isInteger(expiresInS) || expiresInS <= 0 || expiresInS > 86_400) {
      throw new VoiceSnippetError('invalid-path', `expiresInS tidak valid: ${expiresInS}`);
    }
    const response = await this.#bucket().createSignedUrl(validPath, expiresInS);
    if (response.error !== null) {
      throw new VoiceSnippetError(
        'storage-error',
        `createSignedUrl gagal: ${response.error.message}`,
        response.error,
      );
    }
    return { signedUrl: response.data.signedUrl, expiresInS };
  }

  /** Menghapus objek snippet milik user (RLS delete = owner-only). */
  async deleteSnippet(path: string): Promise<void> {
    const validPath = assertSnippetPath(path);
    const response = await this.#bucket().remove([validPath]);
    if (response.error !== null) {
      throw new VoiceSnippetError(
        'storage-error',
        `hapus snippet gagal: ${response.error.message}`,
        response.error,
      );
    }
  }

  /**
   * Daftar nama file snippet di folder `userId` (untuk kebersihan/audit;
   * RLS select mengizinkan folder siapa pun bagi yang terautentikasi).
   */
  async listSnippetNames(userId: string): Promise<string[]> {
    if (userId === '') {
      throw new VoiceSnippetError('not-signed-in', 'userId kosong — belum signin?');
    }
    const response = await this.#bucket().list(`${userId}/`);
    if (response.error !== null) {
      throw new VoiceSnippetError(
        'storage-error',
        `list snippet gagal: ${response.error.message}`,
        response.error,
      );
    }
    return response.data.map((entry) => entry.name);
  }

  /**
   * Menghitung pemakaian folder `${userId}/` (jumlah file + total byte)
   * dengan memaginasi storage list — API Supabase mengembalikan maksimum
   * STORAGE_LIST_PAGE_SIZE objek per panggilan, jadi loop offset sampai
   * halaman pendek. Entri tanpa metadata (folder) tidak dihitung.
   */
  async #currentUsage(userId: string): Promise<{ files: number; bytes: number }> {
    const prefix = `${userId}/`;
    let offset = 0;
    let files = 0;
    let bytes = 0;
    for (;;) {
      const response = await this.#bucket().list(prefix, {
        limit: STORAGE_LIST_PAGE_SIZE,
        offset,
      });
      if (response.error !== null) {
        throw new VoiceSnippetError(
          'storage-error',
          `list snippet gagal: ${response.error.message}`,
          response.error,
        );
      }
      files += response.data.length;
      for (const entry of response.data) {
        bytes += entry.metadata?.size ?? 0;
      }
      if (response.data.length < STORAGE_LIST_PAGE_SIZE) {
        return { files, bytes };
      }
      offset += response.data.length;
    }
  }
}

function defaultRandomId(): string {
  const cryptoApi = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto;
  if (typeof cryptoApi?.randomUUID === 'function') {
    return cryptoApi.randomUUID().slice(0, 8);
  }
  return Math.random().toString(36).slice(2, 10);
}
