import {
  PaymentError,
  PremiumProfileRowSchema,
  type PremiumStatus,
  type SupabasePremiumLike,
} from './types';

export interface PremiumStatusServiceDeps {
  /** Klien Supabase (hanya sub-kemampuan PostgREST baca yang dipakai). */
  supabase: SupabasePremiumLike;
}

/**
 * Membaca status premium user dari tabel `profiles` (kolom `is_premium`,
 * migrasi 0011).
 *
 * Catatan mapping spec: hook UI `usePremiumStatus` (Fase 3) tinggal
 * membungkus kelas ini — seluruh logika murni non-hook ada di sini:
 * - null → baris tidak ada (belum pernah signin dsb.);
 * - PaymentError → kode domain ('not-signed-in' / 'profile-error' /
 *   'invalid-profile-row') — hook hanya menerjemahkan ke state UI.
 *
 * is_premium HANYA dibaca (select) oleh modul ini — penulis sah
 * satu-satunya adalah service_role di dalam Edge Function
 * paddle-webhook (lockdown column-level grants, migrasi 0011).
 */
export class PremiumStatusService {
  readonly #supabase: SupabasePremiumLike;

  constructor(deps: PremiumStatusServiceDeps) {
    this.#supabase = deps.supabase;
  }

  /**
   * Mengambil status premium satu user.
   * Mengembalikan null bila baris tidak ada (user terhapus dsb.).
   * Melempar PaymentError('invalid-profile-row') bila baris ada tetapi
   * tidak lolos validasi bentuk — data jaringan tidak pernah diteruskan
   * mentah ke pemanggil.
   */
  async getPremiumStatus(userId: string): Promise<PremiumStatus | null> {
    if (userId === '') {
      throw new PaymentError('not-signed-in', 'userId kosong — belum signin?');
    }
    const response = await this.#supabase
      .from('profiles')
      .select('id,is_premium')
      .eq('id', userId)
      .maybeSingle();
    if (response.error !== null) {
      throw new PaymentError(
        'profile-error',
        `mengambil status premium gagal: ${response.error.message}`,
        response.error,
      );
    }
    if (response.data === null) {
      return null;
    }
    const parsed = PremiumProfileRowSchema.safeParse(response.data);
    if (!parsed.success) {
      throw new PaymentError(
        'invalid-profile-row',
        `baris status premium tidak lolos validasi: ${formatIssues(parsed.error.issues)}`,
        parsed.error.issues,
      );
    }
    return { userId: parsed.data.id, isPremium: parsed.data.is_premium };
  }
}

function formatIssues(issues: Array<{ path: PropertyKey[]; message: string }>): string {
  return issues
    .map((issue) => `${issue.path.map(String).join('.') || '(root)'}: ${issue.message}`)
    .join('; ');
}
