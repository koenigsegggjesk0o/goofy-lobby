import type { SupabaseClient } from '@supabase/supabase-js';
import { STORAGE_LIST_PAGE_SIZE, VOICE_BUCKET_NAME } from '../profile/types';
import { SOUNDBOARD_BUCKET_NAME } from '../soundboard/types';

// ============================================================
// Erasure layanan akun (remediasi audit 25 M3 + lifecycle 25-d)
// ============================================================
//
// Menghapus SELURUH data milik satu user — menutup celah lama
// "delete = profile-bricked + storage orphan + auth ghost":
//   1. STORAGE DULU (kedua bucket, prefix `${userId}/`, list PAGINATED
//      lalu remove): file tidak punya FK ke db, dan menghapusnya paling
//      aman dilakukan sebelum baris db hilang — kegagalan di tengah
//      jalan bisa diulang (idempoten: list ulang tinggal menemukan sisa).
//   2. DB eksplisit dua arah: paddle_transactions (0021, user_id),
//      friendships (requester ATAU addressee — pasangan kanonik 0007),
//      blocks (blocker ATAU blocked), messages (sender ATAU recipient).
//      Semua FK memang ON DELETE CASCADE ke profiles, jadi hapus profile
//      sendirian cukup — tapi delete eksplisit membuat urutan & ringkasan
//      terlihat jelas di log (keputusan terdokumentasi).
//   3. profiles TERAKHIR di db: baris identitas inti; cascade menutup
//      tabel apa pun yang terlewat di daftar eksplisit.
//   4. auth user (adminAuth.deleteUser) PALING AKHIR: menunggu data
//      aplikasi bersih dulu supaya jendela "auth hidup tanpa profile"
//      minimal. Injector disediakan PEMANGGIL (Edge Function memakai
//      klien service_role supabase.auth.admin); urutan panggilannya tetap
//      milik layanan ini agar konsisten teruji.
//
// ROOM MILIK USER (registri 0016): sengaja TIDAK dihapus eksplisit —
// room = tiket sesi EFEMER (TTL 1 jam + heartbeat, komentar 0016).
// rooms.host_id / room_participants.user_id / room_join_attempts.user_id
// memakai FK ke auth.users ON DELETE CASCADE, sehingga langkah (4) di
// atas otomatis ikut menyapu room beserta kepesertaan & catatan attempt;
// bila auth-deletion gagal/di-tunda, baris itu tetap kedaluwarsa sendiri
// via TTL. Dua jalan keluar, tidak ada yang menggantung.
//
// IDEMPOTENSI RETRY: setiap langkah aman diulang — list ulang menemukan
// sisa file, delete baris yang sudah hilang = 0 baris, remove path yang
// sudah absen tetap sukses di storage Supabase. Pemanggil boleh
// mencoba ulang seluruh eraseUserData setelah kegagalan parsial.
//
// Murni (tanpa runtime Deno/Node) — dipakai Edge Function Deno
// account-erasure DAN unit test vitest via injector.

/** Error PostgREST/Storage/Auth minimal yang dibaca modul ini. */
export interface SupabaseErrorLike {
  message: string;
  statusCode?: string;
  code?: string;
}

/** Kode kegagalan modul erasure — mesin pesan error yang seragam. */
export type ErasureErrorCode =
  'invalid-user-id' | 'storage-error' | 'db-error' | 'auth-admin-error';

export class ErasureError extends Error {
  readonly code: ErasureErrorCode;
  readonly cause?: unknown;

  constructor(code: ErasureErrorCode, message: string, cause?: unknown) {
    super(message);
    this.name = 'ErasureError';
    this.code = code;
    if (cause !== undefined) {
      this.cause = cause;
    }
  }
}

// ============================================================
// Bentuk struktural Supabase (pola profile/payment — hanya
// sub-kemampuan yang dipakai; klien asli lolos, test menyuntik fake)
// ============================================================

/** Respons delete PostgREST yang dibaca: baris terhapus dihitung via count. */
export interface ErasureDeleteResponse {
  data: unknown;
  error: SupabaseErrorLike | null;
  count: number | null;
}

/** Rantai delete: .eq() / .or() lalu await. */
export interface ErasureDeleteChainLike extends PromiseLike<ErasureDeleteResponse> {
  eq(column: string, value: string): ErasureDeleteChainLike;
  or(filters: string): ErasureDeleteChainLike;
}

export interface ErasureDeleteTableLike {
  delete(options?: { count?: 'exact' }): ErasureDeleteChainLike;
}

export interface ErasureDbLike {
  from(table: string): ErasureDeleteTableLike;
}

/**
 * Adapter klien asli → ErasureDbLike (pola asPremiumClient): generics
 * rantai PostgREST memicu TS2589 pada perbandingan struktural langsung
 * — kompatibilitas rantai delete().eq()/.or() dibuktikan runtime di
 * erasure-service.test.ts.
 */
export function asErasureDb(client: SupabaseClient): ErasureDbLike {
  return client as unknown as ErasureDbLike;
}

/** Entri hasil storage list (metadata.size tidak dipakai di sini). */
export interface ErasureListEntry {
  name: string;
  metadata?: { size?: number } | null;
}

export type ErasureListResponse =
  { data: ErasureListEntry[]; error: null } | { data: null; error: SupabaseErrorLike };

export type ErasureMutationResponse =
  { data: unknown; error: null } | { data: null; error: SupabaseErrorLike };

export interface ErasureBucketLike {
  list(
    prefix?: string,
    options?: { limit?: number; offset?: number },
  ): Promise<ErasureListResponse>;
  remove(paths: string[]): Promise<ErasureMutationResponse>;
}

export interface ErasureStorageLike {
  storage: { from(bucket: string): ErasureBucketLike };
}

/** Admin auth minimal: hapus user di auth.users (injector service_role). */
export interface AdminAuthLike {
  deleteUser(userId: string): Promise<ErasureMutationResponse>;
}

// ============================================================
// Ringkasan hasil
// ============================================================

export interface ErasureSummary {
  /** Jumlah objek storage yang dihapus (voice-snippets + soundboard-sounds). */
  removedFiles: number;
  /** Jumlah baris db yang dihapus eksplisit (sebelum cascade profile). */
  deletedRows: {
    paddleTransactions: number;
    friendships: number;
    blocks: number;
    messages: number;
    profiles: number;
  };
  /** true bila auth user juga sudah dihapus (selalu true bila sukses). */
  authUserDeleted: boolean;
}

// ============================================================
// Layanan erasure
// ============================================================

/**
 * Menghapus seluruh data user: storage 2 bucket → baris db eksplisit →
 * profile → auth user (urutan terdokumentasi di header modul). Melempar
 * ErasureError pada kegagalan pertama — pemanggil boleh mencoba ulang
 * (idempoten, lihat header). Harus dipanggil dengan klien service_role
 * (RLS owner-only tidak bisa menjangkau folder/baris user lain).
 */
export async function eraseUserData(args: {
  db: ErasureDbLike;
  storage: ErasureStorageLike;
  adminAuth: AdminAuthLike;
  userId: string;
}): Promise<ErasureSummary> {
  const { userId } = args;
  if (userId === '' || userId.includes('/')) {
    throw new ErasureError('invalid-user-id', `userId tidak valid: "${userId}"`);
  }

  // (1) Storage — kedua bucket, DULU.
  const removedFiles =
    (await removeAllObjects(args.storage, VOICE_BUCKET_NAME, userId)) +
    (await removeAllObjects(args.storage, SOUNDBOARD_BUCKET_NAME, userId));

  // (2) DB eksplisit — dua arah utk tabel relasi.
  const paddleTransactions = await deleteRows(
    args.db,
    'paddle_transactions',
    `user_id.eq.${userId}`,
  );
  const friendships = await deleteRows(
    args.db,
    'friendships',
    `requester_id.eq.${userId},addressee_id.eq.${userId}`,
  );
  const blocks = await deleteRows(
    args.db,
    'blocks',
    `blocker_id.eq.${userId},blocked_id.eq.${userId}`,
  );
  const messages = await deleteRows(
    args.db,
    'messages',
    `sender_id.eq.${userId},recipient_id.eq.${userId}`,
  );

  // (3) Profile — TERAKHIR di db (cascade menutup yang terlewat).
  const profiles = await deleteRows(args.db, 'profiles', `id.eq.${userId}`);

  // (4) Auth user — paling akhir (room registry 0016 ikut tersapu cascade
  //     auth.users; sisanya kedaluwarsa via TTL — lihat header modul).
  const authResult = await args.adminAuth.deleteUser(userId);
  if (authResult.error !== null) {
    throw new ErasureError(
      'auth-admin-error',
      `hapus auth user gagal: ${authResult.error.message}`,
      authResult.error,
    );
  }

  return {
    removedFiles,
    deletedRows: { paddleTransactions, friendships, blocks, messages, profiles },
    authUserDeleted: true,
  };
}

// ============================================================
// Internal
// ============================================================

/**
 * Menyosongkan folder `${userId}/` di satu bucket: list PAGINATED
 * (storage list max 100 objek per panggilan — offset loop sampai halaman
 * pendek) lalu remove seluruh path sekaligus. Mengembalikan jumlah file
 * yang dihapus. Entri folder (nama ber-'/') dilewati — bucket memang
 * flat per policy RLS.
 */
async function removeAllObjects(
  storage: ErasureStorageLike,
  bucketName: string,
  userId: string,
): Promise<number> {
  const prefix = `${userId}/`;
  const paths: string[] = [];
  let offset = 0;
  for (;;) {
    const response = await storage.storage.from(bucketName).list(prefix, {
      limit: STORAGE_LIST_PAGE_SIZE,
      offset,
    });
    if (response.error !== null) {
      throw new ErasureError(
        'storage-error',
        `list bucket ${bucketName} gagal: ${response.error.message}`,
        response.error,
      );
    }
    for (const entry of response.data) {
      if (entry.name !== '' && !entry.name.endsWith('/')) {
        paths.push(`${prefix}${entry.name}`);
      }
    }
    if (response.data.length < STORAGE_LIST_PAGE_SIZE) {
      break;
    }
    offset += response.data.length;
  }
  if (paths.length === 0) {
    return 0;
  }
  const removed = await storage.storage.from(bucketName).remove(paths);
  if (removed.error !== null) {
    throw new ErasureError(
      'storage-error',
      `remove bucket ${bucketName} gagal: ${removed.error.message}`,
      removed.error,
    );
  }
  return paths.length;
}

/** Delete baris dengan filter or() + hitung via count exact. */
async function deleteRows(db: ErasureDbLike, table: string, orFilter: string): Promise<number> {
  const response = await db.from(table).delete({ count: 'exact' }).or(orFilter);
  if (response.error !== null) {
    throw new ErasureError(
      'db-error',
      `hapus baris ${table} gagal: ${response.error.message}`,
      response.error,
    );
  }
  return response.count ?? 0;
}
