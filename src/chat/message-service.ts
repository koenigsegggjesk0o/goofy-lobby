import { SlidingWindowRateLimiter } from './rate-limiter';
import type { RateLimiterLike } from './rate-limiter';
import {
  ChatError,
  DEFAULT_CONVERSATION_LIMIT,
  DEFAULT_MESSAGE_RATE_LIMIT,
  IsoTimestampSchema,
  MAX_CONVERSATION_LIMIT,
  MessageBodySchema,
  MessageRowSchema,
  UuidSchema,
} from './types';
import type {
  ChatMessage,
  ChatSelectChainLike,
  MessageRow,
  SupabaseChatLike,
  SupabaseErrorLike,
} from './types';

export interface MessageServiceDeps {
  /** Klien Supabase (hanya sub-kemampuan PostgREST yang dipakai). */
  supabase: SupabaseChatLike;
  /** Rate limiter per-pengirim (default: SlidingWindowRateLimiter kebijakan Fase 2). */
  rateLimiter?: RateLimiterLike;
}

export interface ConversationOptions {
  /** Hint jumlah pesan — di-clamp ke [1, MAX_CONVERSATION_LIMIT]. */
  limit?: number;
  /** Kursor pagination: hanya pesan dengan created_at < before (ISO). */
  before?: string;
}

/**
 * Layanan DM tabel `messages` (migrasi 0009/0010).
 *
 * - Validasi argumen (uuid, body, kursor) terjadi LOKAL dan SEBELUM nilai
 *   diinterpolasi ke filter `.or()`/`.lt()` PostgREST — hanya nilai yang
 *   lolos Zod (uuid hex, ISO shape) yang pernah masuk string filter.
 * - Gate pertemanan (policy INSERT 0010) dicentang eksplisit dulu supaya
 *   kesalahan 'not-friends' punya pesan jelas, bukan error RLS mentah.
 * - Blokir TIDAK bisa dicek dari client (RLS blocks blocker-only) —
 *   penegakan ada di trigger messages_block_guard (0009) dan error DB-nya
 *   dipetakan ke kode 'blocked'.
 * - Baris hasil jaringan selalu divalidasi ulang dengan Zod sebelum
 *   diteruskan ke pemanggil (pertahanan di sisi terima).
 */
export class MessageService {
  readonly #supabase: SupabaseChatLike;
  readonly #rateLimiter: RateLimiterLike;

  constructor(deps: MessageServiceDeps) {
    this.#supabase = deps.supabase;
    this.#rateLimiter =
      deps.rateLimiter ?? new SlidingWindowRateLimiter(DEFAULT_MESSAGE_RATE_LIMIT);
  }

  /**
   * Mengirim satu DM. Urutan wajib: (1) validasi lokal + tolak kirim ke
   * diri sendiri; (2) rate limit pengirim; (3) gate pertemanan; (4) insert;
   * (5) revalidasi baris hasil. Percobaan yang gugur di tahap (1) TIDAK
   * mengonsumsi slot rate limit.
   */
  async sendMessage(senderId: string, recipientId: string, body: string): Promise<ChatMessage> {
    const sender = parseUuidArgument(senderId, 'senderId');
    const recipient = parseUuidArgument(recipientId, 'recipientId');
    if (sender === recipient) {
      throw new ChatError('self', 'tidak bisa mengirim pesan ke diri sendiri');
    }
    const parsedBody = MessageBodySchema.safeParse(body);
    if (!parsedBody.success) {
      throw new ChatError(
        'invalid-body',
        `body pesan tidak valid: ${formatIssues(parsedBody.error.issues)}`,
        { cause: parsedBody.error.issues },
      );
    }

    const limit = this.#rateLimiter.tryAcquire(sender);
    if (!limit.allowed) {
      throw new ChatError(
        'rate-limited',
        `terlalu banyak pesan terkirim — coba lagi dalam ${limit.retryAfterMs} ms`,
        { retryAfterMs: limit.retryAfterMs },
      );
    }

    // Pasangan kanonik least/greatest di DB berarti arah bebas — dua cabang
    // and() menangkap requester→addressee maupun sebaliknya.
    const pairFilter = `and(requester_id.eq.${sender},addressee_id.eq.${recipient}),and(requester_id.eq.${recipient},addressee_id.eq.${sender})`;
    const gate = await this.#supabase
      .from('friendships')
      .select('*')
      .or(pairFilter)
      .eq('status', 'accepted')
      .maybeSingle();
    if (gate.error !== null) {
      throw new ChatError('db-error', `memeriksa pertemanan gagal: ${gate.error.message}`, {
        cause: gate.error,
      });
    }
    if (gate.data === null) {
      throw new ChatError('not-friends', 'pesan hanya bisa dikirim kepada teman yang diterima');
    }

    const response = await this.#supabase
      .from('messages')
      .insert({ sender_id: sender, recipient_id: recipient, body: parsedBody.data })
      .select()
      .single();
    if (response.error !== null) {
      throw mapInsertError(response.error);
    }
    if (response.data === null) {
      throw new ChatError('db-error', 'menyimpan pesan mengembalikan null tanpa error');
    }
    return parseMessageRow(response.data);
  }

  /**
   * Memuat percakapan dua sisi antara userId dan otherUserId, diurutkan
   * ASCENDING (urutan tampil). Kueri memakai indeks 0009 (DESC + limit N)
   * lalu hasilnya dibalik.
   *
   * Trade-off revalidasi: baris yang tidak lolos Zod melempar 'invalid-row'
   * untuk SELURUH halaman — TIDAK dibuang diam-diam. Ini disengaja: diam
   * menyembunyikan korupsi data dari pemanggil (pesan tampak "hilang"
   * tanpa jejak); gagal keras lebih jujur dan mudah didiagnosis.
   */
  async listConversation(
    userId: string,
    otherUserId: string,
    opts?: ConversationOptions,
  ): Promise<ChatMessage[]> {
    const me = parseUuidArgument(userId, 'userId');
    const other = parseUuidArgument(otherUserId, 'otherUserId');
    if (me === other) {
      throw new ChatError(
        'self',
        'percakapan dengan diri sendiri tidak mungkin ada (messages_no_self)',
      );
    }
    const limit = clampConversationLimit(opts?.limit);
    let before: string | undefined;
    if (opts?.before !== undefined) {
      const parsedBefore = IsoTimestampSchema.safeParse(opts.before);
      if (!parsedBefore.success) {
        throw new ChatError(
          'invalid-cursor',
          `kursor before bukan timestamp ISO valid: "${opts.before}"`,
          { cause: parsedBefore.error.issues },
        );
      }
      before = parsedBefore.data;
    }

    const pairFilter = `and(sender_id.eq.${me},recipient_id.eq.${other}),and(sender_id.eq.${other},recipient_id.eq.${me})`;
    let chain: ChatSelectChainLike = this.#supabase.from('messages').select('*').or(pairFilter);
    if (before !== undefined) {
      chain = chain.lt('created_at', before);
    }
    const response = await chain.order('created_at', { ascending: false }).limit(limit);
    if (response.error !== null) {
      throw new ChatError('db-error', `memuat percakapan gagal: ${response.error.message}`, {
        cause: response.error,
      });
    }
    const messages = response.data.map((row) => parseMessageRow(row));
    messages.reverse();
    return messages;
  }
}

/** Validasi argumen uuid — melempar ChatError('invalid-uuid'). */
function parseUuidArgument(value: string, field: string): string {
  const parsed = UuidSchema.safeParse(value);
  if (!parsed.success) {
    throw new ChatError('invalid-uuid', `${field} bukan uuid valid: "${value}"`, {
      cause: parsed.error.issues,
    });
  }
  return parsed.data;
}

/** Clamp hint limit; nilai tak hingga/nan jatuh ke default (bukan error). */
function clampConversationLimit(limit: number | undefined): number {
  if (limit === undefined || !Number.isFinite(limit)) {
    return DEFAULT_CONVERSATION_LIMIT;
  }
  return Math.min(MAX_CONVERSATION_LIMIT, Math.max(1, Math.floor(limit)));
}

/**
 * Pemetaan error insert ke kode domain: pesan trigger blokir → 'blocked';
 * check_violation (23514) → 'self' (body sudah divalidasi lokal, satu-satunya
 * check yang tersisa adalah messages_no_self); selain itu 'db-error'.
 */
function mapInsertError(error: SupabaseErrorLike): ChatError {
  if (error.message.includes('message rejected: blocked')) {
    return new ChatError(
      'blocked',
      `penerima telah memblokir Anda (trigger messages_block_guard): ${error.message}`,
      { cause: error },
    );
  }
  if (error.code === '23514') {
    return new ChatError(
      'self',
      `check constraint DB dilanggar — kemungkinan kirim ke diri sendiri (messages_no_self): ${error.message}`,
      { cause: error },
    );
  }
  return new ChatError('db-error', `menyimpan pesan gagal: ${error.message}`, { cause: error });
}

/** Validasi baris mentah → ChatMessage (camelCase). */
function parseMessageRow(raw: unknown): ChatMessage {
  const parsed = MessageRowSchema.safeParse(raw);
  if (!parsed.success) {
    throw new ChatError(
      'invalid-row',
      `baris pesan tidak lolos validasi: ${formatIssues(parsed.error.issues)}`,
      { cause: parsed.error.issues },
    );
  }
  const row: MessageRow = parsed.data;
  return {
    id: row.id,
    senderId: row.sender_id,
    recipientId: row.recipient_id,
    body: row.body,
    createdAt: row.created_at,
  };
}

function formatIssues(issues: Array<{ path: PropertyKey[]; message: string }>): string {
  return issues
    .map((issue) => `${issue.path.map(String).join('.') || '(root)'}: ${issue.message}`)
    .join('; ');
}
