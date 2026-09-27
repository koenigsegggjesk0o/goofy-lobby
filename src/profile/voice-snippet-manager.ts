import type { ProfileService } from './profile-service';
import type { UploadedSnippet, VoiceSnippetService } from './voice-snippet-service';

export interface VoiceSnippetManagerDeps {
  snippets: VoiceSnippetService;
  profiles: ProfileService;
  /** Laporan kegagalan non-fatal (mis. gagal menghapus snippet lama). */
  onError?: (context: string, error: unknown) => void;
}

export interface ReplaceSnippetResult extends UploadedSnippet {
  /** Path snippet sebelumnya bila ada; null bila user belum punya snippet. */
  previousPath: string | null;
  /** true bila objek lama berhasil dihapus dari bucket. */
  previousDeleted: boolean;
}

export interface ClearSnippetResult {
  /** Path yang dibersihkan; null bila memang belum ada snippet. */
  clearedPath: string | null;
}

/**
 * Orkestrator siklus hidup snippet suara profil (pure logic, tanpa UI):
 *
 *   replaceSnippet(userId, blob):
 *     1. unggah blob sebagai snippet BARU (path unik — tidak menimpa);
 *     2. arahkan profiles.voice_snippet_path ke path baru;
 *     3. hapus objek lama (best-effort — gagal hapus tidak membatalkan
 *        penggantian; sisa objek = orphan yang tidak membocorkan apa pun
 *        dan bisa dibersihkan belakangan).
 *
 * Urutan ini menjaga profil selalu menunjuk objek yang ADA: bila langkah 2
 * gagal, objek baru menjadi orphan (bukan profil menunjuk objek hilang).
 *
 *   clearSnippet(userId):
 *     1. arahkan voice_snippet_path ke null;
 *     2. hapus objeknya (best-effort).
 */
export class VoiceSnippetManager {
  readonly #snippets: VoiceSnippetService;
  readonly #profiles: ProfileService;
  readonly #onError?: (context: string, error: unknown) => void;

  constructor(deps: VoiceSnippetManagerDeps) {
    this.#snippets = deps.snippets;
    this.#profiles = deps.profiles;
    this.#onError = deps.onError;
  }

  /** Mengganti snippet aktif user dengan perekaman baru. */
  async replaceSnippet(userId: string, blob: Blob): Promise<ReplaceSnippetResult> {
    const profile = await this.#profiles.getProfile(userId);
    const previousPath = profile?.voiceSnippetPath ?? null;
    const uploaded = await this.#snippets.uploadSnippet(userId, blob);
    await this.#profiles.setVoiceSnippetPath(userId, uploaded.path);
    let previousDeleted = false;
    if (previousPath !== null && previousPath !== uploaded.path) {
      try {
        await this.#snippets.deleteSnippet(previousPath);
        previousDeleted = true;
      } catch (error) {
        // Non-fatal: snippet lama jadi orphan — dilaporkan untuk metrik.
        this.#onError?.('delete-previous-snippet', error);
      }
    } else if (previousPath === uploaded.path) {
      previousDeleted = true; // jalur nyaris mustahil (id unik) — anggap aman
    }
    return { ...uploaded, previousPath, previousDeleted };
  }

  /** Menghapus penunjuk + objek snippet milik user (idempoten). */
  async clearSnippet(userId: string): Promise<ClearSnippetResult> {
    const profile = await this.#profiles.getProfile(userId);
    const currentPath = profile?.voiceSnippetPath ?? null;
    if (currentPath === null) {
      return { clearedPath: null };
    }
    await this.#profiles.setVoiceSnippetPath(userId, null);
    try {
      await this.#snippets.deleteSnippet(currentPath);
    } catch (error) {
      this.#onError?.('delete-cleared-snippet', error);
    }
    return { clearedPath: currentPath };
  }
}
