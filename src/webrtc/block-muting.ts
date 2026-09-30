/**
 * Block-awareness untuk mesh room (remediasi audit 25-c M4 — requirement
 * owner "mute+leave mesh"): daftar user yang kita blokir (tabel `blocks`,
 * migrasi 0007/0008) dipakai MeshRoomController untuk mematikan audio dua
 * arah dengan peer yang dimiliki user terblokir (PeerConnectionManager
 * .setPeerMuted).
 *
 * Keamanan data: RLS `blocks_select_blocker` (0008:52-57) membatasi SELECT
 * ke baris milik blocker sendiri (`auth.uid() = blocker_id`) — klien hanya
 * pernah melihat BLOKIRANNYA SENDIRI; pihak yang diblokir tidak bisa
 * mengetahui statusnya lewat DB. Filter `eq('blocker_id', uid)` eksplisit
 * tetap dipasang (pertahanan kedua + kejelasan intent).
 *
 * Semantik kegagalan: FAIL-OPEN — error fetch/validasi → Set kosong + log.
 * Mute adalah fitur kenyamanan, bukan boundary keamanan; kegagalan daftar
 * blokir TIDAK boleh memutus join mesh. (Penyerang TIDAK bisa memanfaatkan
 * ini untuk membuka suara: mengosongkan set hanya menonaktifkan fitur mute
 * — tidak pernah memberi akses baru.)
 *
 * Catatan desain: `BlockService.getBlockedUserIds` (src/friends) punya data
 * yang sama, tapi melempar FriendsError dan hidup di dependency graph
 * sosial; mesh butuh bentuk fail-open + Set dan tidak boleh menarik modul
 * friends — duplikasi kecil yang disengaja.
 */

/** Batas jumlah baris blokir yang dibaca sekali fetch (payload guard). */
export const BLOCK_LIST_FETCH_LIMIT = 1_000;

/** Respons PostgREST bentuk longgar (structural typing — pola friends/types). */
export interface BlockListResponseLike {
  data: unknown;
  error: { message: string } | null;
}

/** Rantai select+eq yang bisa di-await. */
export interface BlockListSelectChainLike extends PromiseLike<BlockListResponseLike> {
  eq(column: string, value: string): BlockListSelectChainLike;
  limit(count: number): BlockListSelectChainLike;
}

export interface BlockListTableLike {
  select(columns: string): BlockListSelectChainLike;
}

/** Sub-kemampuan auth yang dipakai (mendapatkan uid sendiri). */
export interface BlockListAuthLike {
  getUser(): PromiseLike<{
    data: { user: { id: string } | null } | null;
    error: { message: string } | null;
  }>;
}

/**
 * Klien yang dibutuhkan fetchOwnBlockedPeerIds — SupabaseClient asli lolos
 * tanpa adaptasi (structural typing), test menyuntik fake.
 */
export interface BlockListClient {
  auth: BlockListAuthLike;
  from(table: string): BlockListTableLike;
}

/** Penyedia daftar blokir untuk MeshRoomController (bisa di-inject di test). */
export type BlockListProvider = () => Promise<Set<string>>;

/** Validasi satu baris proyeksi `select('blocked_id')` → id (null bila rusak). */
function parseBlockedIdRow(row: unknown): string | null {
  if (typeof row !== 'object' || row === null) {
    return null;
  }
  const blocked = (row as { blocked_id?: unknown }).blocked_id;
  return typeof blocked === 'string' && blocked.length > 0 ? blocked : null;
}

/**
 * Mengambil kumpulan userId yang diblokir oleh user yang sedang signin
 * (blocker = uid sendiri). FAIL-OPEN: kegagalan apa pun (auth, jaringan,
 * baris rusak) → Set kosong + console.warn — pemanggil tidak pernah
 * menerima exception.
 */
export async function fetchOwnBlockedPeerIds(client: BlockListClient): Promise<Set<string>> {
  try {
    const { data: userData, error: userError } = await client.auth.getUser();
    if (userError !== null) {
      throw new Error(`auth.getUser gagal: ${userError.message}`);
    }
    const uid = userData?.user?.id;
    if (typeof uid !== 'string' || uid === '') {
      throw new Error('auth.getUser tidak memuat user id (belum signin?)');
    }
    const response = await client
      .from('blocks')
      .select('blocked_id')
      .eq('blocker_id', uid)
      .limit(BLOCK_LIST_FETCH_LIMIT);
    if (response.error !== null) {
      throw new Error(`select blocks gagal: ${response.error.message}`);
    }
    const rows = Array.isArray(response.data) ? response.data : [];
    const ids = new Set<string>();
    for (const row of rows) {
      const blocked = parseBlockedIdRow(row);
      if (blocked !== null) {
        ids.add(blocked);
      }
    }
    return ids;
  } catch (error) {
    // Fail-open + log: fitur mute mati untuk sesi ini, join tidak terganggu.
    console.warn(
      '[block-muting] gagal mengambil daftar blokir — dianggap kosong (fail-open):',
      error instanceof Error ? error.message : String(error),
    );
    return new Set<string>();
  }
}

/**
 * Adapter default untuk opsi `blockListProvider` MeshRoomController: memakai
 * klien Supabase yang SAMA dengan yang dipakai untuk channel Realtime bila
 * (dan hanya bila) objek itu juga punya kemampuan query `.from` + `.auth`
 * (SupabaseClient asli memilikinya; fake unit test tidak — fitur otomatis
 * mati di lingkungan tanpa query, bukan error).
 *
 * Wiring produk (Fase 3): bootstrap cukup meneruskan klien Supabase app ke
 * MeshRoomController — provider default aktif sendiri; atau menyuntikkan
 * `blockListProvider` eksplisit bila mau sumber lain.
 */
export function defaultBlockListProvider(supabase: unknown): BlockListProvider | undefined {
  const candidate = supabase as { from?: unknown; auth?: unknown } | null;
  if (
    candidate === null ||
    typeof candidate.from !== 'function' ||
    typeof candidate.auth !== 'object' ||
    candidate.auth === null
  ) {
    return undefined;
  }
  const client = supabase as BlockListClient;
  return () => fetchOwnBlockedPeerIds(client);
}
