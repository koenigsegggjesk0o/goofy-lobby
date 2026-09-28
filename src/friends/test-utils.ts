/**
 * Fake klien PostgREST in-memory untuk unit test modul friends (lingkungan
 * Node, tanpa jaringan). Hanya diimpor dari file *.test.ts — tidak pernah
 * masuk bundle produksi.
 *
 * KETERBATASAN (dibaca dulu sebelum menambah kasus test):
 * - Filter `.or` hanya memahami GRAMATIKA TERBATAS yang dipakai service:
 *   daftar term dipisah koma; term = `kolom.eq.nilai` atau
 *   `and(kolom.eq.nilai,kolom.eq.nilai)` (bentuk canonicalPairFilter /
 *   participantFilter). Operator lain (neq/gt/in di dalam or, not, dsb.)
 *   TIDAK didukung.
 * - Kolom `select(...)` DIABAIKAN — baris penuh dikembalikan; skema Zod
 *   di sisi service yang memangkas kolom berlebih (strip unknown keys),
 *   sama seperti baris `select('*')`.
 * - RLS TIDAK disimulasikan — fake meniru BENTUK rantai dan constraint
 *   yang relevan saja (unique index kanonik 23505, CHECK no_self 23514,
 *   trigger block guard P0001, trigger set_updated_at, PK blocks).
 *   Keamanan akses baris diuji migrasi PGlite di task lain — JANGAN
 *   mengklaim test di sini membuktikan RLS.
 * - Eksekusi rantai di-cache sekali (persis postgrest-js: builder =
 *   PromiseLike); mutasi store setelah rantai dibangun tapi sebelum
 *   await tidak tercermin (service selalu langsung meng-await).
 */
import {
  BLOCK_GUARD_MESSAGE,
  FRIENDSHIP_STATUS_ACCEPTED,
  FRIENDSHIP_STATUS_PENDING,
} from './types';
import type {
  BlockRow,
  FriendshipProfileSummaryRow,
  FriendshipRow,
  FriendsDeleteChainLike,
  FriendsInsertChainLike,
  FriendsResponseLike,
  FriendsSelectChainLike,
  FriendsTableLike,
  FriendsUpdateChainLike,
  SupabaseFriendsLike,
} from './types';

/** Nama tabel yang disediakan fake (persis konstanta modul). */
export type FakeFriendsTableName = 'friendships' | 'blocks' | 'profiles';

/** Bentuk error yang bisa diinjeksikan ke operasi fake. */
export interface FakeFailError {
  message: string;
  code?: string;
}

export interface FakeFriendsClientOptions {
  friendships?: FriendshipRow[];
  blocks?: BlockRow[];
  profiles?: FriendshipProfileSummaryRow[];
  /**
   * Jam fake (ISO string). Default: mulai 2026-01-01T00:00:00Z dan maju
   * 1 detik per pemanggilan — created_at/updated_at unik & terurut tanpa
   * timer nyata (test tetap deterministik).
   */
  now?: () => string;
  /**
   * Generator id baris baru. Default: counter uuid-shaped deterministik
   * (`00000000-0000-4000-8000-…`) supaya id lolos UuidSchema dan bisa
   * diprediksi test.
   */
  randomId?: () => string;
  failSelectWith?: FakeFailError;
  failInsertWith?: FakeFailError;
  failUpsertWith?: FakeFailError;
  failUpdateWith?: FakeFailError;
  failDeleteWith?: FakeFailError;
}

/** Baris store dilihat sebagai record generik (kolom snake_case). */
type FakeRow = Record<string, unknown>;

const FAKE_CLOCK_START_MS = Date.parse('2026-01-01T00:00:00.000Z');
const FAKE_CLOCK_STEP_MS = 1_000;

function makeAutoClock(): () => string {
  let currentMs = FAKE_CLOCK_START_MS;
  return () => {
    const iso = new Date(currentMs).toISOString();
    currentMs += FAKE_CLOCK_STEP_MS;
    return iso;
  };
}

function makeCounterUuid(): () => string {
  let counter = 0;
  return () => {
    counter += 1;
    return `00000000-0000-4000-8000-${counter.toString().padStart(12, '0')}`;
  };
}

function fieldString(values: FakeRow, column: string): string {
  const value = values[column];
  if (typeof value !== 'string' || value === '') {
    throw new Error(`fake insert membutuhkan kolom string "${column}"`);
  }
  return value;
}

// ============================================================
// Parser .or mini (grammar terbatas — lihat header file)
// ============================================================

function splitTopLevel(filter: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let current = '';
  for (const ch of filter) {
    if (ch === '(') depth += 1;
    else if (ch === ')') depth -= 1;
    if (ch === ',' && depth === 0) {
      parts.push(current);
      current = '';
    } else {
      current += ch;
    }
  }
  parts.push(current);
  return parts;
}

function parseEqTerm(term: string): (row: FakeRow) => boolean {
  const match = /^([a-z_]+)\.eq\.(.+)$/.exec(term);
  if (match === null) {
    throw new Error(`fake .or tidak memahami term: "${term}"`);
  }
  const column = match[1] ?? '';
  const value = match[2] ?? '';
  return (row) => row[column] === value;
}

function parseOrTerm(term: string): (row: FakeRow) => boolean {
  if (term.startsWith('and(') && term.endsWith(')')) {
    const matchers = splitTopLevel(term.slice('and('.length, -1)).map((inner) =>
      parseEqTerm(inner.trim()),
    );
    return (row) => matchers.every((matcher) => matcher(row));
  }
  return parseEqTerm(term);
}

function parseOrFilter(filter: string): (row: FakeRow) => boolean {
  const matchers = splitTopLevel(filter).map((term) => parseOrTerm(term.trim()));
  return (row) => matchers.some((matcher) => matcher(row));
}

function comparePrimitive(a: unknown, b: unknown): number {
  if (typeof a === 'string' && typeof b === 'string') {
    return a < b ? -1 : a > b ? 1 : 0;
  }
  if (typeof a === 'number' && typeof b === 'number') {
    return a - b;
  }
  return 0; // tipe campuran/undefined dianggap setara (cukup untuk fake)
}

// ============================================================
// Klien fake (pola FakeProfileClient profile/test-utils.ts)
// ============================================================

export class FakeFriendsClient implements SupabaseFriendsLike {
  readonly friendships: FriendshipRow[];
  readonly blocks: BlockRow[];
  readonly profiles: FriendshipProfileSummaryRow[];
  readonly now: () => string;
  readonly randomId: () => string;
  /** Jejak operasi yang BENAR-BENAR dieksekusi (untuk assert tanpa-jaringan). */
  readonly insertCalls: Array<{ table: FakeFriendsTableName; values: FakeRow }> = [];
  readonly upsertCalls: Array<{
    table: FakeFriendsTableName;
    values: FakeRow;
    ignoreDuplicates: boolean;
  }> = [];
  readonly updateCalls: Array<{
    table: FakeFriendsTableName;
    values: FakeRow;
    eq: Record<string, string>;
  }> = [];
  readonly deleteCalls: Array<{
    table: FakeFriendsTableName;
    eq: Record<string, string>;
    or: string | null;
  }> = [];
  readonly selectCalls: Array<{
    table: FakeFriendsTableName;
    eq: Record<string, string>;
    or: string | null;
    inFilters: Record<string, readonly string[]>;
  }> = [];
  failSelectWith?: FakeFailError;
  failInsertWith?: FakeFailError;
  failUpsertWith?: FakeFailError;
  failUpdateWith?: FakeFailError;
  failDeleteWith?: FakeFailError;

  constructor(options: FakeFriendsClientOptions = {}) {
    // Copy-per-baris supaya seed test tidak bocor antar kasus via referensi.
    this.friendships = options.friendships?.map((row) => ({ ...row })) ?? [];
    this.blocks = options.blocks?.map((row) => ({ ...row })) ?? [];
    this.profiles = options.profiles?.map((row) => ({ ...row })) ?? [];
    this.now = options.now ?? makeAutoClock();
    this.randomId = options.randomId ?? makeCounterUuid();
    this.failSelectWith = options.failSelectWith;
    this.failInsertWith = options.failInsertWith;
    this.failUpsertWith = options.failUpsertWith;
    this.failUpdateWith = options.failUpdateWith;
    this.failDeleteWith = options.failDeleteWith;
  }

  /** Store live sebuah tabel, dilihat sebagai record generik. */
  rowsFor(table: FakeFriendsTableName): FakeRow[] {
    switch (table) {
      case 'friendships':
        return this.friendships as unknown as FakeRow[];
      case 'blocks':
        return this.blocks as unknown as FakeRow[];
      case 'profiles':
        return this.profiles as unknown as FakeRow[];
    }
  }

  from = (table: string): FakeFriendsTable => {
    if (table !== 'friendships' && table !== 'blocks' && table !== 'profiles') {
      throw new Error(`tabel fake tidak disediakan: ${table}`);
    }
    return new FakeFriendsTable(this, table);
  };
}

class FakeFriendsTable implements FriendsTableLike {
  constructor(
    private readonly client: FakeFriendsClient,
    private readonly table: FakeFriendsTableName,
  ) {}

  // Parameter kolom diabaikan (baris penuh dikembalikan — lihat header file);
  // param opsional antarmuka boleh dihilangkan di implementasi.
  select(): FakeSelectChain {
    return new FakeSelectChain(this.client, this.table);
  }

  insert(values: FakeRow): FakeInsertChain {
    return new FakeInsertChain(this.client, this.table, values, {
      isUpsert: false,
      ignoreDuplicates: false,
    });
  }

  upsert(
    values: FakeRow,
    options?: { onConflict?: string; ignoreDuplicates?: boolean },
  ): FakeInsertChain {
    return new FakeInsertChain(this.client, this.table, values, {
      isUpsert: true,
      ignoreDuplicates: options?.ignoreDuplicates ?? false,
    });
  }

  update(values: FakeRow): FakeUpdateChain {
    return new FakeUpdateChain(this.client, this.table, values);
  }

  delete(): FakeDeleteChain {
    return new FakeDeleteChain(this.client, this.table);
  }
}

/**
 * Rantai dasar: filter eq/in/or + order/limit + eksekusi sekali (hasil
 * di-cache) — meniru PostgrestFilterBuilder postgrest-js (builder =
 * PromiseLike). Parameter generik T = tipe data yang DIJANJIKAN saat rantai
 * di-await — persis tipe settle interface struktural yang ditiru
 * (unknown[] untuk select/delete, unknown untuk insert/update) supaya
 * perbandingan tipe PromiseLike lolos tanpa cast. Subclass mendefinisikan
 * execute().
 */
abstract class FakeChainBase<T> implements PromiseLike<FriendsResponseLike<T>> {
  protected readonly eqFilters: Record<string, string> = {};
  protected readonly inFilters: Record<string, readonly string[]> = {};
  protected orFilter: string | null = null;
  protected readonly orders: Array<{ column: string; ascending: boolean }> = [];
  protected limitCount: number | null = null;
  #settled: Promise<FriendsResponseLike<T>> | null = null;

  eq(column: string, value: string): this {
    this.eqFilters[column] = value;
    return this;
  }

  or(filters: string): this {
    this.orFilter = filters;
    return this;
  }

  in(column: string, values: readonly string[]): this {
    this.inFilters[column] = values;
    return this;
  }

  order(column: string, options: { ascending: boolean }): this {
    this.orders.push({ column, ascending: options.ascending });
    return this;
  }

  limit(count: number): this {
    this.limitCount = count;
    return this;
  }

  protected matchesAll(row: FakeRow): boolean {
    for (const [column, value] of Object.entries(this.eqFilters)) {
      if (row[column] !== value) return false;
    }
    for (const [column, values] of Object.entries(this.inFilters)) {
      if (!values.includes(row[column] as string)) return false;
    }
    if (this.orFilter !== null && !parseOrFilter(this.orFilter)(row)) return false;
    return true;
  }

  /** Filter → urut (multi-kunci stabil) → pangkas limit. */
  protected finalize(rows: FakeRow[]): FakeRow[] {
    const sorted = [...rows];
    if (this.orders.length > 0) {
      sorted.sort((a, b) => {
        for (const { column, ascending } of this.orders) {
          const compared = comparePrimitive(a[column], b[column]);
          if (compared !== 0) return ascending ? compared : -compared;
        }
        return 0;
      });
    }
    return this.limitCount === null ? sorted : sorted.slice(0, this.limitCount);
  }

  protected run(): Promise<FriendsResponseLike<T>> {
    this.#settled ??= Promise.resolve(this.execute());
    return this.#settled;
  }

  protected abstract execute(): FriendsResponseLike<T>;

  then<TResult1 = FriendsResponseLike<T>, TResult2 = never>(
    onfulfilled?: ((value: FriendsResponseLike<T>) => TResult1 | PromiseLike<TResult1>) | null,
    onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null,
  ): PromiseLike<TResult1 | TResult2> {
    return this.run().then(onfulfilled ?? undefined, onrejected ?? undefined);
  }
}

class FakeSelectChain extends FakeChainBase<unknown[]> implements FriendsSelectChainLike {
  constructor(
    private readonly client: FakeFriendsClient,
    private readonly table: FakeFriendsTableName,
  ) {
    super();
  }

  /**
   * Konversi ke baris tunggal: hasil eksekusi (array) dipetakan ke elemen
   * pertama atau null — promise TURUNAN, bukan builder itu sendiri, karena
   * tipe settle berubah dari unknown[] ke unknown (pola postgrest-js:
   * maybeSingle mengembalikan builder baru bertype berbeda).
   */
  maybeSingle(): PromiseLike<FriendsResponseLike<unknown>> {
    return this.run().then((response) => {
      if (response.error !== null) {
        return response;
      }
      return { data: response.data[0] ?? null, error: null };
    });
  }

  protected execute(): FriendsResponseLike<unknown[]> {
    if (this.client.failSelectWith !== undefined) {
      return { data: null, error: this.client.failSelectWith };
    }
    this.client.selectCalls.push({
      table: this.table,
      eq: { ...this.eqFilters },
      or: this.orFilter,
      inFilters: { ...this.inFilters },
    });
    const matched = this.client.rowsFor(this.table).filter((row) => this.matchesAll(row));
    return { data: this.finalize(matched), error: null };
  }
}

class FakeInsertChain extends FakeChainBase<unknown> implements FriendsInsertChainLike {
  #wantsReturn = false;
  #single = false;

  constructor(
    private readonly client: FakeFriendsClient,
    private readonly table: FakeFriendsTableName,
    private readonly values: FakeRow,
    private readonly options: { isUpsert: boolean; ignoreDuplicates: boolean },
  ) {
    super();
  }

  select(): this {
    this.#wantsReturn = true;
    return this;
  }

  single(): this {
    this.#single = true;
    return this;
  }

  protected execute(): FriendsResponseLike<unknown> {
    if (this.options.isUpsert) {
      this.client.upsertCalls.push({
        table: this.table,
        values: this.values,
        ignoreDuplicates: this.options.ignoreDuplicates,
      });
      if (this.client.failUpsertWith !== undefined) {
        return { data: null, error: this.client.failUpsertWith };
      }
    } else {
      this.client.insertCalls.push({ table: this.table, values: this.values });
      if (this.client.failInsertWith !== undefined) {
        return { data: null, error: this.client.failInsertWith };
      }
    }
    if (this.table === 'friendships') {
      return this.#executeFriendshipsInsert();
    }
    if (this.table === 'blocks') {
      return this.#executeBlocksInsert();
    }
    throw new Error(`insert fake tidak mendukung tabel: ${this.table}`);
  }

  /**
   * Meniru DB asli (0007) pada insert friendships — URUTAN PostgreSQL:
   * BEFORE trigger dulu, baru constraint/index.
   */
  #executeFriendshipsInsert(): FriendsResponseLike<unknown> {
    const requester = fieldString(this.values, 'requester_id');
    const addressee = fieldString(this.values, 'addressee_id');
    // (1) trigger friendships_block_guard: penerima telah memblokir pengirim.
    const blocked = this.client.blocks.some(
      (row) => row.blocker_id === addressee && row.blocked_id === requester,
    );
    if (blocked) {
      return { data: null, error: { message: BLOCK_GUARD_MESSAGE, code: 'P0001' } };
    }
    // (2) unique index kanonik least/greatest: A→B dan B→A pasangan sama.
    const pairExists = this.client.friendships.some(
      (row) =>
        (row.requester_id === requester && row.addressee_id === addressee) ||
        (row.requester_id === addressee && row.addressee_id === requester),
    );
    if (pairExists) {
      return {
        data: null,
        error: {
          code: '23505',
          message:
            'duplicate key value violates unique constraint "friendships_pair_canonical_unique"',
        },
      };
    }
    // (3) CHECK friendships_no_self.
    if (requester === addressee) {
      return {
        data: null,
        error: {
          code: '23514',
          message:
            'new row for relation "friendships" violates check constraint "friendships_no_self"',
        },
      };
    }
    // now() stabil per transaksi — created_at = updated_at saat insert.
    const timestamp = this.client.now();
    const row: FriendshipRow = {
      id: this.client.randomId(),
      requester_id: requester,
      addressee_id: addressee,
      status:
        this.values.status === FRIENDSHIP_STATUS_ACCEPTED
          ? FRIENDSHIP_STATUS_ACCEPTED
          : FRIENDSHIP_STATUS_PENDING,
      created_at: timestamp,
      updated_at: timestamp,
    };
    this.client.friendships.push(row);
    return this.#respond(row);
  }

  /** Meniru DB asli (0007) pada insert/upsert blocks. */
  #executeBlocksInsert(): FriendsResponseLike<unknown> {
    const blocker = fieldString(this.values, 'blocker_id');
    const blocked = fieldString(this.values, 'blocked_id');
    // (1) CHECK blocks_no_self.
    if (blocker === blocked) {
      return {
        data: null,
        error: {
          code: '23514',
          message: 'new row for relation "blocks" violates check constraint "blocks_no_self"',
        },
      };
    }
    // (2) PK komposit — ignoreDuplicates = ON CONFLICT DO NOTHING (idempaten).
    const exists = this.client.blocks.some(
      (row) => row.blocker_id === blocker && row.blocked_id === blocked,
    );
    if (exists) {
      if (this.options.ignoreDuplicates) {
        return { data: null, error: null };
      }
      return {
        data: null,
        error: {
          code: '23505',
          message: 'duplicate key value violates unique constraint "blocks_pkey"',
        },
      };
    }
    const row: BlockRow = {
      blocker_id: blocker,
      blocked_id: blocked,
      created_at: this.client.now(),
    };
    this.client.blocks.push(row);
    return this.#respond(row);
  }

  /** Bentuk respons sesuai rantai: tanpa .select() = minimal (data null). */
  #respond(row: FakeRow): FriendsResponseLike<unknown> {
    if (!this.#wantsReturn) {
      return { data: null, error: null };
    }
    return this.#single ? { data: row, error: null } : { data: [row], error: null };
  }
}

class FakeUpdateChain extends FakeChainBase<unknown> implements FriendsUpdateChainLike {
  #wantsReturn = false;
  #single = false;

  constructor(
    private readonly client: FakeFriendsClient,
    private readonly table: FakeFriendsTableName,
    private readonly values: FakeRow,
  ) {
    super();
  }

  select(): this {
    this.#wantsReturn = true;
    return this;
  }

  single(): this {
    this.#single = true;
    return this;
  }

  protected execute(): FriendsResponseLike<unknown> {
    if (this.client.failUpdateWith !== undefined) {
      return { data: null, error: this.client.failUpdateWith };
    }
    this.client.updateCalls.push({
      table: this.table,
      values: this.values,
      eq: { ...this.eqFilters },
    });
    const matched = this.client.rowsFor(this.table).filter((row) => this.matchesAll(row));
    if (matched.length === 0) {
      // .single() atas 0 baris → PostgREST PGRST116 (perilaku klien asli).
      if (this.#wantsReturn && this.#single) {
        return {
          data: null,
          error: {
            code: 'PGRST116',
            message: 'JSON object requested, multiple (or no) rows returned',
          },
        };
      }
      return { data: null, error: null };
    }
    const timestamp = this.client.now();
    for (const row of matched) {
      Object.assign(row, this.values);
      if (this.table === 'friendships') {
        // trigger friendships_set_updated_at (0007) — dibump tiap update.
        row.updated_at = timestamp;
      }
    }
    const first = matched[0];
    if (first === undefined) {
      return { data: null, error: null };
    }
    if (!this.#wantsReturn) {
      return { data: null, error: null };
    }
    return this.#single ? { data: first, error: null } : { data: matched, error: null };
  }
}

class FakeDeleteChain extends FakeChainBase<unknown[]> implements FriendsDeleteChainLike {
  #wantsReturn = false;

  constructor(
    private readonly client: FakeFriendsClient,
    private readonly table: FakeFriendsTableName,
  ) {
    super();
  }

  select(): this {
    this.#wantsReturn = true;
    return this;
  }

  protected execute(): FriendsResponseLike<unknown[]> {
    if (this.client.failDeleteWith !== undefined) {
      return { data: null, error: this.client.failDeleteWith };
    }
    this.client.deleteCalls.push({
      table: this.table,
      eq: { ...this.eqFilters },
      or: this.orFilter,
    });
    const rows = this.client.rowsFor(this.table);
    const removed = rows.filter((row) => this.matchesAll(row));
    for (const row of removed) {
      const index = rows.indexOf(row);
      if (index !== -1) {
        rows.splice(index, 1);
      }
    }
    // Tanpa .select() PostgREST mengembalikan data null; kontrak rantai ini
    // menyatakan unknown[] — dikembalikan [] (baris terhapus kosong). Semua
    // pemanggilan service nyata selalu .select(...) sehingga cabang ini
    // hanya defensif.
    return this.#wantsReturn ? { data: removed, error: null } : { data: [], error: null };
  }
}
