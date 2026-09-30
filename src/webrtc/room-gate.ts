import { RoomCodeSchema, normalizeRoomCode } from './types';

// ============================================================
// P0-1 — RoomGate: gerbang registri room SERVER-SIDE.
// ============================================================
//
// Menutup celah "channel room:{kode} publik": sebelum P0-1 siapa pun yang
// mengetahui/menebak kode bisa subscribe channel dan memanen broadcast
// SDP/ICE (berisi alamat IP peserta). Sekarang:
//   1. Kode diterbitkan server (create_room — Crockford-32, 8 karakter,
//      2^40 ruang kode) — klien tidak lagi mengarang kode sendiri.
//   2. Join divalidasi + di-rate-limit DI DATABASE (join_room) — bypass
//      client tidak mempan karena tiket kepesertaan hanya bisa ditulis
//      oleh RPC SECURITY DEFINER (0016_room_registry.sql).
//   3. Channel di-subscribe dengan { private: true } — kebijakan RLS
//      realtime.messages (0017) menolak subscribe tanpa tiket.
//
// KONTRAK ERROR SERVER (penting — lihat header 0016): create_room/join_room
// MENGEMBALIKAN token sebagai DATA ('ROOM_NOT_FOUND', 'RATE_LIMITED', dst),
// BUKAN sebagai error PostgREST — supaya catatan percobaan join yang telah
// di-insert COMMIT walau join ditolak (raise exception akan me-rollback
// catatan itu dan brute-force tak pernah terhitung). Error level PostgREST
// (tanpa JWT, dsb.) tetap lewat jalur error dan dipetakan juga.

/** Kode error machines-readable — token identik dengan sisi server (0016). */
export type RoomGateErrorCode =
  | 'NOT_AUTHENTICATED'
  | 'RATE_LIMITED'
  | 'INVALID_ROOM_CODE'
  | 'ROOM_NOT_FOUND'
  | 'ROOM_FULL'
  | 'ROOM_CREATE_LIMIT'
  | 'BLOCKED_FROM_ROOM'
  | 'UNKNOWN';

/** Pesan human per kode error (untuk UI Fase 3 / harness). */
export const ROOM_GATE_ERROR_MESSAGES: Record<RoomGateErrorCode, string> = {
  NOT_AUTHENTICATED: 'belum signin — tidak bisa mengakses room',
  RATE_LIMITED: 'terlalu banyak percobaan — tunggu sebentar lalu coba lagi',
  INVALID_ROOM_CODE: 'format kode room tidak valid',
  ROOM_NOT_FOUND: 'room tidak ditemukan atau sudah berakhir',
  ROOM_FULL: 'room penuh',
  ROOM_CREATE_LIMIT: 'terlalu banyak room dibuat — tunggu sebentar',
  // 0019 (remediasi audit 25 M4): pemilik room memblokir caller → join_room
  // me-raise exception 'BLOCKED_FROM_ROOM' (bukan token data — penolakan
  // tidak perlu mencatat percobaan join di room itu).
  BLOCKED_FROM_ROOM: 'kamu diblokir pemilik room ini',
  UNKNOWN: 'kegagalan gerbang room tidak dikenal',
};

/** Error terpetakan dari gerbang registri room (baca .code, bukan teks). */
export class RoomGateError extends Error {
  readonly code: RoomGateErrorCode;
  /**
   * Detail mentah sisi server (pesan RPC / respons asli) — DIPISAHKAN dari
   * `.message` supaya UI tidak menampilkan teks internal (remediasi audit 25-a
   * LOW-5: UNKNOWN dulu membawa pesan server mentah ke user). QA/harness
   * tetap bisa membaca detail ini untuk diagnosis.
   */
  readonly serverMessage?: string;

  constructor(code: RoomGateErrorCode, detail?: string, serverMessage?: string) {
    const human = ROOM_GATE_ERROR_MESSAGES[code];
    super(detail === undefined ? human : `${human} (${detail})`);
    this.name = 'RoomGateError';
    this.code = code;
    this.serverMessage = serverMessage;
  }
}

// ============================================================
// Structural typing supabase (SupabaseClient asli lolos tanpa adaptasi)
// ============================================================

export interface RoomGateRpcError {
  message: string;
}

export interface RoomGateRpcResult {
  data: unknown;
  error: RoomGateRpcError | null;
}

export interface RoomGateSupabaseLike {
  rpc(fn: string, args?: Record<string, unknown>): PromiseLike<RoomGateRpcResult>;
}

// ============================================================
// RoomGate
// ============================================================

export interface RoomGateOptions {
  supabase: RoomGateSupabaseLike;
  /**
   * Interval heartbeat (default 15 menit). TTL tiket server = 1 jam —
   * 4x margin terhadap heartbeat yang hilang; heartbeat hanya memperpanjang
   * JOIN BARU (otorisasi Realtime di-cache seumur koneksi — docs resmi).
   */
  heartbeatIntervalMs?: number;
  /** Laporan kegagalan heartbeat (fire-and-forget — tidak melempar). */
  onHeartbeatError?: (error: unknown) => void;
  /** Injeksi timer untuk test (default: setInterval/clearInterval global). */
  setIntervalFn?: (fn: () => void, ms: number) => unknown;
  clearIntervalFn?: (handle: unknown) => void;
}

const DEFAULT_HEARTBEAT_INTERVAL_MS = 15 * 60_000;

/** Token error server — dicek dengan includes() (tahan pembungkusan pesan). */
const SERVER_TOKENS: readonly RoomGateErrorCode[] = [
  'NOT_AUTHENTICATED',
  'RATE_LIMITED',
  'INVALID_ROOM_CODE',
  'ROOM_NOT_FOUND',
  'ROOM_FULL',
  'ROOM_CREATE_LIMIT',
];

export class RoomGate {
  readonly #supabase: RoomGateSupabaseLike;
  readonly #heartbeatIntervalMs: number;
  readonly #onHeartbeatError: ((error: unknown) => void) | undefined;
  readonly #setIntervalFn: (fn: () => void, ms: number) => unknown;
  readonly #clearIntervalFn: (handle: unknown) => void;
  #code: string | null = null;
  #heartbeatHandle: unknown = null;

  constructor(options: RoomGateOptions) {
    this.#supabase = options.supabase;
    this.#heartbeatIntervalMs = options.heartbeatIntervalMs ?? DEFAULT_HEARTBEAT_INTERVAL_MS;
    this.#onHeartbeatError = options.onHeartbeatError;
    this.#setIntervalFn = options.setIntervalFn ?? ((fn, ms) => setInterval(fn, ms));
    this.#clearIntervalFn =
      options.clearIntervalFn ??
      ((handle) => clearInterval(handle as Parameters<typeof clearInterval>[0]));
  }

  /** Kode room aktif (null bila belum create/join atau sudah leave). */
  get currentCode(): string | null {
    return this.#code;
  }

  /**
   * HOST: minta server menerbitkan room baru. Mengembalikan kode 8 karakter
   * (server-generated, CSPRNG). Host otomatis tercatat sebagai peserta.
   * Kegagalan terkontrak datang sebagai DATA token (lihat header) maupun
   * error PostgREST — keduanya dipetakan ke RoomGateError.code.
   */
  async createRoom(): Promise<string> {
    const { data, error } = await this.#supabase.rpc('create_room');
    if (error !== null) {
      throw mapRpcError('create_room', error.message);
    }
    if (typeof data !== 'string') {
      throw new RoomGateError(
        'UNKNOWN',
        'dari create_room',
        `respons create_room bukan kode: ${JSON.stringify(data)}`,
      );
    }
    const token = tokenFromData(data);
    if (token !== null) {
      throw new RoomGateError(token, 'dari create_room');
    }
    const parsed = RoomCodeSchema.safeParse(data);
    if (!parsed.success) {
      // Server mengirim kode di luar kontrak — jangan pernah diteruskan ke
      // .message (detail mentah hanya di serverMessage).
      throw new RoomGateError(
        'UNKNOWN',
        'dari create_room',
        `kode room server tidak valid: ${data}`,
      );
    }
    this.#startHeartbeat(parsed.data);
    return parsed.data;
  }

  /**
   * TAMU: tukar kode (input bebas — dinormalisasi dulu) menjadi tiket
   * kepesertaan. Melempar RoomGateError dengan code terpetakan:
   * INVALID_ROOM_CODE / ROOM_NOT_FOUND / ROOM_FULL / RATE_LIMITED / dst.
   * Mengembalikan kode TER-NORMALISASI (dipakai untuk topic channel).
   */
  async joinRoom(rawCode: string): Promise<string> {
    const normalized = normalizeRoomCode(rawCode);
    // Pra-cek format lokal: cepat gagal tanpa memakai kuota rate-limit
    // (hanya memvalidasi FORMAT — tidak membocorkan apa pun).
    if (!RoomCodeSchema.safeParse(normalized).success) {
      throw new RoomGateError('INVALID_ROOM_CODE', `input: ${rawCode}`);
    }
    const { data, error } = await this.#supabase.rpc('join_room', { p_code: normalized });
    if (error !== null) {
      throw mapRpcError('join_room', error.message);
    }
    if (data !== 'OK') {
      const token = tokenFromData(data);
      if (token === null) {
        // Respons asli disimpan di serverMessage — bukan di .message
        // (remediasi audit 25-a LOW-5).
        throw new RoomGateError(
          'UNKNOWN',
          'dari join_room',
          `respons join_room tak dikenal: ${JSON.stringify(data)}`,
        );
      }
      throw new RoomGateError(token, 'dari join_room');
    }
    this.#startHeartbeat(normalized);
    return normalized;
  }

  /**
   * Keluar dari room aktif: hentikan heartbeat + hapus tiket kepesertaan
   * (server). No-op bila tidak sedang berada di room.
   */
  async leaveRoom(): Promise<void> {
    const code = this.#code;
    this.dispose();
    if (code === null) {
      return;
    }
    const { error } = await this.#supabase.rpc('leave_room', { p_code: code });
    if (error !== null) {
      throw mapRpcError('leave_room', error.message);
    }
  }

  /** Berhenti tanpa RPC (mis. tab ditutup / cleanup setelah gagal). */
  dispose(): void {
    if (this.#heartbeatHandle !== null) {
      this.#clearIntervalFn(this.#heartbeatHandle);
      this.#heartbeatHandle = null;
    }
    this.#code = null;
  }

  #startHeartbeat(code: string): void {
    this.dispose();
    this.#code = code;
    this.#heartbeatHandle = this.#setIntervalFn(() => {
      void this.#beat();
    }, this.#heartbeatIntervalMs);
  }

  async #beat(): Promise<void> {
    const code = this.#code;
    if (code === null) {
      return;
    }
    try {
      const { error } = await this.#supabase.rpc('heartbeat_room', { p_code: code });
      if (error !== null) {
        this.#onHeartbeatError?.(mapRpcError('heartbeat_room', error.message));
      }
    } catch (error) {
      this.#onHeartbeatError?.(error);
    }
  }
}

function mapRpcError(fn: string, message: string): RoomGateError {
  const upper = message.toUpperCase();
  // 0019: penolakan krn diblokir pemilik room (exception PG, bukan token
  // data) — dipetakan EKSPLISIT sebelum UNKNOWN supaya UI bisa menampilkan
  // pesan yang benar (audit 25 M4).
  if (upper.includes('BLOCKED_FROM_ROOM')) {
    return new RoomGateError('BLOCKED_FROM_ROOM', `dari ${fn}`, message);
  }
  for (const token of SERVER_TOKENS) {
    if (upper.includes(token)) {
      return new RoomGateError(token, `dari ${fn}`, message);
    }
  }
  // Tanpa JWT/ kedaluwarsa — PostgREST menolak sebelum RPC jalan.
  if (upper.includes('JWT') || upper.includes('401')) {
    return new RoomGateError('NOT_AUTHENTICATED', `dari ${fn}`, message);
  }
  // Pesan mentah TIDAK lagi masuk .message (audit 25-a LOW-5) — hanya ke
  // serverMessage untuk diagnosis QA.
  return new RoomGateError('UNKNOWN', `dari ${fn}`, message);
}

/** Token kontrak DATA (kesamaan eksak — data server bersih, bukan narasi). */
function tokenFromData(data: unknown): RoomGateErrorCode | null {
  if (typeof data !== 'string') {
    return null;
  }
  return SERVER_TOKENS.find((token) => token === data) ?? null;
}
