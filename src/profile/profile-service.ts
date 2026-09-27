import {
  ProfileRowSchema,
  ProfileUpdateSchema,
  VoiceSnippetError,
  type Profile,
  type ProfileRow,
  type ProfileUpdate,
  type SupabaseProfileLike,
} from './types';

export interface ProfileServiceDeps {
  /** Klien Supabase (hanya sub-kemampuan PostgREST yang dipakai). */
  supabase: SupabaseProfileLike;
}

/**
 * Layanan CRUD tabel `profiles` (RLS 0002: baca semua authenticated,
 * tulis hanya baris sendiri).
 *
 * - Baris hasil PostgREST selalu divalidasi ulang dengan Zod sebelum
 *   dipakai — data jahat/anzur dari jaringan tidak pernah diteruskan
 *   mentah ke pemanggil (pertahanan di sisi terima).
 * - Patch update ber-whitelist: hanya kolom yang eksplisit dikirim
 *   (display_name / avatar_color / voice_snippet_path) — tidak pernah
 *   menyebarkan objek asing mentah ke kueri.
 */
export class ProfileService {
  readonly #supabase: SupabaseProfileLike;

  constructor(deps: ProfileServiceDeps) {
    this.#supabase = deps.supabase;
  }

  /**
   * Mengambil profil satu user.
   * Mengembalikan null bila baris tidak ada (user terhapus dsb.).
   * Melempar VoiceSnippetError('invalid-profile-row') bila baris ada
   * tetapi tidak lolos validasi bentuk.
   */
  async getProfile(userId: string): Promise<Profile | null> {
    if (userId === '') {
      throw new VoiceSnippetError('not-signed-in', 'userId kosong — belum signin?');
    }
    const response = await this.#supabase
      .from('profiles')
      .select('*')
      .eq('id', userId)
      .maybeSingle();
    if (response.error !== null) {
      throw new VoiceSnippetError(
        'profile-error',
        `mengambil profil gagal: ${response.error.message}`,
        response.error,
      );
    }
    if (response.data === null) {
      return null;
    }
    return parseProfileRow(response.data);
  }

  /**
   * Memperbarui profil sendiri (displayName dan/atau avatarColor).
   * Validasi Zod terjadi sebelum kueri; hasil dikembalikan sudah
   * tervalidasi ulang.
   */
  async updateProfile(userId: string, patch: ProfileUpdate): Promise<Profile> {
    const parsed = ProfileUpdateSchema.safeParse(patch);
    if (!parsed.success) {
      throw new VoiceSnippetError(
        'update-empty',
        `patch profil tidak valid: ${formatIssues(parsed.error.issues)}`,
        parsed.error.issues,
      );
    }
    const values: Record<string, unknown> = {};
    if (parsed.data.displayName !== undefined) {
      values.display_name = parsed.data.displayName;
    }
    if (parsed.data.avatarColor !== undefined) {
      values.avatar_color = parsed.data.avatarColor;
    }
    return this.#patchProfile(userId, values);
  }

  /**
   * Menunjuk path snippet aktif pada profil (null = hapus penunjuk).
   * Path divalidasi SnippetPathSchema — kandidat asing tidak dikirim.
   */
  async setVoiceSnippetPath(userId: string, path: string | null): Promise<Profile> {
    const values: Record<string, unknown> = {};
    if (path !== null) {
      const parsed = ProfileRowSchema.shape.voice_snippet_path.safeParse(path);
      if (!parsed.success) {
        throw new VoiceSnippetError(
          'invalid-path',
          `path snippet tidak lolos validasi: ${path}`,
          parsed.error.issues,
        );
      }
      values.voice_snippet_path = parsed.data;
    } else {
      values.voice_snippet_path = null;
    }
    return this.#patchProfile(userId, values);
  }

  // ============================================================
  // Internal
  // ============================================================

  async #patchProfile(userId: string, values: Record<string, unknown>): Promise<Profile> {
    const response = await this.#supabase
      .from('profiles')
      .update(values)
      .eq('id', userId)
      .select('*')
      .single();
    if (response.error !== null) {
      throw new VoiceSnippetError(
        'profile-error',
        `update profil gagal: ${response.error.message}`,
        response.error,
      );
    }
    if (response.data === null) {
      throw new VoiceSnippetError('profile-error', 'update profil mengembalikan null tanpa error');
    }
    return parseProfileRow(response.data);
  }
}

/** Validasi baris mentah → Profile (camelCase). */
function parseProfileRow(raw: unknown): Profile {
  const parsed = ProfileRowSchema.safeParse(raw);
  if (!parsed.success) {
    throw new VoiceSnippetError(
      'invalid-profile-row',
      `baris profil tidak lolos validasi: ${formatIssues(parsed.error.issues)}`,
      parsed.error.issues,
    );
  }
  const row: ProfileRow = parsed.data;
  return {
    id: row.id,
    displayName: row.display_name,
    avatarColor: row.avatar_color,
    voiceSnippetPath: row.voice_snippet_path,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function formatIssues(issues: Array<{ path: PropertyKey[]; message: string }>): string {
  return issues
    .map((issue) => `${issue.path.map(String).join('.') || '(root)'}: ${issue.message}`)
    .join('; ');
}
