/**
 * Helper unit test modul payment (lingkungan Node via vitest, tanpa
 * jaringan). Hanya diimpor dari file *.test.ts — tidak pernah masuk
 * bundle produksi.
 *
 * (1) Penanda tangan webhook Paddle REFERENCE: menghitung HMAC-SHA256
 *     via crypto.subtle LANGSUNG dengan input tetap (secret+ts+body)
 *     — implementasi independen di sisi test, bukan angka ajaib hasil
 *     karangan. Payload yang ditandatangani: `${ts}:${rawBody}` persis
 *     kontrak Paddle.
 * (2) Fake PostgREST untuk rantai baca yang dipakai PremiumStatusService:
 *     from('profiles').select('id,is_premium').eq().maybeSingle().
 * (3) Fake ledger webhook Paddle (migrasi 0021) untuk router: rantai
 *     upsert/select/update + eq/limit pada tabel paddle_events dan
 *     paddle_transactions, dengan dedup on-conflict-do-nothing.
 */
import type {
  PaddleDbChainLike,
  PaddleDbResponse,
  PaddleDbTableLike,
  PaddleTransactionRow,
  PaddleWebhookDbLike,
  SupabasePremiumLike,
} from './types';

/**
 * Menandatangani payload webhook seperti Paddle: HMAC-SHA256 hex lowercase
 * atas `${ts}:${rawBody}` dengan secret yang diberikan.
 */
export async function signPaddlePayload(
  secret: string,
  ts: number,
  rawBody: string,
): Promise<string> {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const mac = await crypto.subtle.sign('HMAC', key, encoder.encode(`${ts}:${rawBody}`));
  return [...new Uint8Array(mac)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

/** Menyusun header Paddle-Signature dari ts + daftar signature h1. */
export function makePaddleSignatureHeader(ts: number, signatures: readonly string[]): string {
  const parts = [`ts=${ts}`, ...signatures.map((signature) => `h1=${signature}`)];
  return parts.join(';');
}

// ============================================================
// Fake PostgREST profiles (in-memory + rantai builder)
// ============================================================

export interface FakePremiumClientOptions {
  /** Baris in-memory bentuk DB (snake_case). */
  rows?: Array<{ id: string; is_premium: boolean }>;
  /** Pesan error yang dipaksa untuk select. */
  failSelectWith?: { message: string };
}

type FakePremiumResponse =
  { data: unknown; error: null } | { data: null; error: { message: string } };

/**
 * Meniru sub-kemampuan PostgREST untuk tabel profiles: rantai
 * select(columns).eq().maybeSingle() dengan penyimpanan baris in-memory.
 * maybeSingle() mengembalikan builder itu sendiri — persis perilaku
 * postgrest-js asli (builder = PromiseLike); eksekusi sekali, hasil
 * di-cache.
 */
export class FakePremiumClient implements SupabasePremiumLike {
  rows: Array<{ id: string; is_premium: boolean }>;
  readonly selectCalls: Array<{ table: string; columns?: string }> = [];
  readonly eqFilters: Array<Record<string, string>> = [];
  failSelectWith?: { message: string };

  constructor(options: FakePremiumClientOptions = {}) {
    this.rows = options.rows ?? [];
    this.failSelectWith = options.failSelectWith;
  }

  from = (table: string): FakePremiumTable => {
    if (table !== 'profiles') {
      throw new Error(`tabel fake tidak disediakan: ${table}`);
    }
    return new FakePremiumTable(this, table);
  };
}

class FakePremiumTable {
  constructor(
    private readonly client: FakePremiumClient,
    private readonly table: string,
  ) {}

  select(columns?: string): FakePremiumSelectChain {
    this.client.selectCalls.push({ table: this.table, columns });
    return new FakePremiumSelectChain(this.client);
  }
}

class FakePremiumSelectChain implements PromiseLike<FakePremiumResponse> {
  private readonly filters: Record<string, string> = {};
  #settled: Promise<FakePremiumResponse> | null = null;

  constructor(private readonly client: FakePremiumClient) {}

  eq(column: string, value: string): this {
    this.filters[column] = value;
    return this;
  }

  maybeSingle(): this {
    return this;
  }

  private run(): Promise<FakePremiumResponse> {
    this.#settled ??= Promise.resolve(this.execute());
    return this.#settled;
  }

  private execute(): FakePremiumResponse {
    this.client.eqFilters.push({ ...this.filters });
    if (this.client.failSelectWith !== undefined) {
      return { data: null, error: this.client.failSelectWith };
    }
    const row = this.client.rows.find((candidate) =>
      Object.entries(this.filters).every(
        ([column, value]) => (candidate as unknown as Record<string, unknown>)[column] === value,
      ),
    );
    return { data: row ?? null, error: null };
  }

  then<TResult1 = FakePremiumResponse, TResult2 = never>(
    onfulfilled?: ((value: FakePremiumResponse) => TResult1 | PromiseLike<TResult1>) | null,
    onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null,
  ): PromiseLike<TResult1 | TResult2> {
    return this.run().then(onfulfilled ?? undefined, onrejected ?? undefined);
  }
}

// ============================================================
// Fake ledger webhook Paddle (migrasi 0021) — in-memory + rantai builder
// ============================================================

export interface FakePaddleDbOptions {
  /** event_id yang sudah pernah diklaim (seed uji duplicate). */
  claimedEvents?: string[];
  /** Baris paddle_transactions awal (snake_case, bentuk DB 0021). */
  transactions?: PaddleTransactionRow[];
  failClaimWith?: { message: string };
  failTransactionUpsertWith?: { message: string };
  failTransactionFindWith?: { message: string };
  failTransactionUpdateWith?: { message: string };
}

type FakeOperation =
  | {
      kind: 'upsert';
      values: Record<string, unknown>;
      options?: { onConflict?: string; ignoreDuplicates?: boolean };
    }
  | { kind: 'select' }
  | { kind: 'update'; values: Record<string, unknown> };

/**
 * Meniru sub-kemampuan PostgREST yang dipakai router webhook (0021):
 * upsert().select(), select().eq().limit(), update().eq() — penyimpanan
 * in-memory dengan dedup on-conflict-do-nothing untuk paddle_events dan
 * upsert by transaction_id untuk paddle_transactions. Menunggu (await)
 * mengeksekusi SEKALI lalu hasil di-cache — persis perilaku builder
 * postgrest-js asli (builder = PromiseLike).
 */
export class FakePaddleDb implements PaddleWebhookDbLike {
  readonly claimedEvents = new Set<string>();
  readonly transactions = new Map<string, PaddleTransactionRow>();
  readonly claimCalls: Array<{
    values: { event_id: string; event_type: string };
    options?: { onConflict?: string; ignoreDuplicates?: boolean };
  }> = [];
  readonly transactionUpsertCalls: Array<{
    row: PaddleTransactionRow;
    options?: { onConflict?: string };
  }> = [];
  readonly transactionFindCalls: Array<{ filters: Record<string, string> }> = [];
  readonly transactionUpdateCalls: Array<{
    values: Record<string, unknown>;
    filters: Record<string, string>;
  }> = [];
  failClaimWith?: { message: string };
  failTransactionUpsertWith?: { message: string };
  failTransactionFindWith?: { message: string };
  failTransactionUpdateWith?: { message: string };

  constructor(options: FakePaddleDbOptions = {}) {
    for (const eventId of options.claimedEvents ?? []) {
      this.claimedEvents.add(eventId);
    }
    for (const row of options.transactions ?? []) {
      this.transactions.set(row.transaction_id, { ...row });
    }
    this.failClaimWith = options.failClaimWith;
    this.failTransactionUpsertWith = options.failTransactionUpsertWith;
    this.failTransactionFindWith = options.failTransactionFindWith;
    this.failTransactionUpdateWith = options.failTransactionUpdateWith;
  }

  from = (table: string): PaddleDbTableLike => {
    if (table !== 'paddle_events' && table !== 'paddle_transactions') {
      throw new Error(`tabel fake tidak disediakan: ${table}`);
    }
    return new FakePaddleTable(this, table);
  };

  /** Eksekusi rantai (internal — dipanggil FakePaddleChain saat di-await). */
  run(
    table: 'paddle_events' | 'paddle_transactions',
    op: FakeOperation,
    filters: Record<string, string>,
    limitCount: number | null,
    wantsRows: boolean,
  ): PaddleDbResponse {
    if (table === 'paddle_events') {
      if (op.kind !== 'upsert') {
        throw new Error(`operasi fake paddle_events tidak disediakan: ${op.kind}`);
      }
      this.claimCalls.push({
        values: op.values as { event_id: string; event_type: string },
        options: op.options,
      });
      if (this.failClaimWith !== undefined) {
        return { data: null, error: this.failClaimWith };
      }
      const eventId = String(op.values.event_id ?? '');
      if (op.options?.ignoreDuplicates === true && this.claimedEvents.has(eventId)) {
        return { data: [], error: null };
      }
      this.claimedEvents.add(eventId);
      return { data: wantsRows ? [{ event_id: eventId }] : null, error: null };
    }

    if (op.kind === 'upsert') {
      this.transactionUpsertCalls.push({
        row: op.values as unknown as PaddleTransactionRow,
        options: op.options,
      });
      if (this.failTransactionUpsertWith !== undefined) {
        return { data: null, error: this.failTransactionUpsertWith };
      }
      const row = op.values as unknown as PaddleTransactionRow;
      this.transactions.set(row.transaction_id, { ...row });
      return { data: wantsRows ? [{ ...row }] : null, error: null };
    }
    if (op.kind === 'select') {
      this.transactionFindCalls.push({ filters: { ...filters } });
      if (this.failTransactionFindWith !== undefined) {
        return { data: null, error: this.failTransactionFindWith };
      }
      const matched = [...this.transactions.values()].filter((row) =>
        matchesFilters(row as unknown as Record<string, unknown>, filters),
      );
      const limited = limitCount === null ? matched : matched.slice(0, limitCount);
      return {
        data: limited.map((row) => ({ ...(row as unknown as Record<string, unknown>) })),
        error: null,
      };
    }
    this.transactionUpdateCalls.push({ values: op.values, filters: { ...filters } });
    if (this.failTransactionUpdateWith !== undefined) {
      return { data: null, error: this.failTransactionUpdateWith };
    }
    const updated: Array<Record<string, unknown>> = [];
    for (const [key, row] of this.transactions) {
      if (matchesFilters(row as unknown as Record<string, unknown>, filters)) {
        const merged = { ...(row as unknown as Record<string, unknown>), ...op.values };
        this.transactions.set(key, merged as unknown as PaddleTransactionRow);
        updated.push({ ...merged });
      }
    }
    return { data: wantsRows ? updated : null, error: null };
  }
}

function matchesFilters(row: Record<string, unknown>, filters: Record<string, string>): boolean {
  return Object.entries(filters).every(([column, value]) => row[column] === value);
}

class FakePaddleTable implements PaddleDbTableLike {
  constructor(
    private readonly db: FakePaddleDb,
    private readonly table: 'paddle_events' | 'paddle_transactions',
  ) {}

  upsert(
    values: Record<string, unknown>,
    options?: { onConflict?: string; ignoreDuplicates?: boolean },
  ): PaddleDbChainLike {
    return new FakePaddleChain(this.db, this.table, { kind: 'upsert', values, options });
  }

  select(): PaddleDbChainLike {
    return new FakePaddleChain(this.db, this.table, { kind: 'select' });
  }

  update(values: Record<string, unknown>): PaddleDbChainLike {
    return new FakePaddleChain(this.db, this.table, { kind: 'update', values });
  }
}

class FakePaddleChain implements PaddleDbChainLike {
  private readonly filters: Record<string, string> = {};
  private limitCount: number | null = null;
  private wantsRows = false;
  #settled: Promise<PaddleDbResponse> | null = null;

  constructor(
    private readonly db: FakePaddleDb,
    private readonly table: 'paddle_events' | 'paddle_transactions',
    private readonly op: FakeOperation,
  ) {}

  select(): this {
    this.wantsRows = true;
    return this;
  }

  eq(column: string, value: string): this {
    this.filters[column] = value;
    return this;
  }

  limit(count: number): this {
    this.limitCount = count;
    return this;
  }

  private run(): Promise<PaddleDbResponse> {
    this.#settled ??= Promise.resolve(
      this.db.run(this.table, this.op, { ...this.filters }, this.limitCount, this.wantsRows),
    );
    return this.#settled;
  }

  then<TResult1 = PaddleDbResponse, TResult2 = never>(
    onfulfilled?: ((value: PaddleDbResponse) => TResult1 | PromiseLike<TResult1>) | null,
    onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null,
  ): PromiseLike<TResult1 | TResult2> {
    return this.run().then(onfulfilled ?? undefined, onrejected ?? undefined);
  }
}
