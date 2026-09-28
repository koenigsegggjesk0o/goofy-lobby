/**
 * Fake PostgREST in-memory untuk tabel `messages` + `friendships` (unit test
 * modul chat, lingkungan Node). Hanya diimpor dari file *.test.ts — tidak
 * pernah masuk bundle produksi. Pola mengikuti profile/test-utils.ts:
 * rantai builder yang bisa di-await, eksekusi sekali (hasil di-cache), dan
 * pencatatan panggilan untuk assertion.
 *
 * KETERBATASAN FAKE (disengaja, secukupnya untuk jalur yang dipakai
 * MessageService — bukan emulator PostgREST lengkap):
 * - .or() hanya mengerti bentuk `and(col.eq.val,col.eq.val),...` dan
 *   `col.eq.val` — PERSIS string yang dibangun MessageService. Aman
 *   di-split karena nilai uuid tidak memuat koma/kurung.
 * - .lt() membandingkan string ISO secara leksikografis (benar bila semua
 *   stempel waktu seragam format UTC 'Z' — begitu cara test me-seed).
 * - .order() hanya membandingkan kolom bertipe string (created_at).
 * - insert() TIDAK menegakan RLS/policy/trigger/check DB — kegagalan
 *   dunia nyata (blokir, 23514) disimulasikan lewat failInsertWith.
 * - maybeSingle() mengeksekusi kueri RAKUS (Promise langsung dibuat saat
 *   dipanggil) — hasil await sama dengan builder asli yang menunggu then.
 */
import type {
  ChatInsertChainLike,
  ChatSelectChainLike,
  ChatTableLike,
  ListResponseLike,
  MessageRow,
  SingleResponseLike,
  SupabaseChatLike,
  SupabaseErrorLike,
} from './types';

/** Baris mentah tabel `friendships` (migrasi 0007) — gate pertemanan. */
export interface FriendshipRow {
  id: string;
  requester_id: string;
  addressee_id: string;
  status: 'pending' | 'accepted';
  created_at: string;
  updated_at: string;
}

/** Rekam jejak satu eksekusi select (state rantai saat dieksekusi). */
export interface SelectCallLog {
  table: string;
  or?: string;
  eq: Record<string, string>;
  lt: Record<string, string>;
  order?: { column: string; ascending: boolean };
  limit?: number;
  maybeSingle: boolean;
}

export interface InsertCallLog {
  values: Record<string, unknown>;
}

export interface FakeChatClientOptions {
  messages?: MessageRow[];
  friendships?: FriendshipRow[];
  /** Pesan error paksa untuk SEMUA select (messages & friendships). */
  failSelectWith?: SupabaseErrorLike;
  /** Pesan error paksa untuk insert messages (simulasi trigger/check DB). */
  failInsertWith?: SupabaseErrorLike;
  /** Generator id baris insert (default: counter 00000000-0000-4000-8000-…). */
  makeId?: () => string;
  /** Stempel created_at baris insert (default tetap, tidak bertambah). */
  now?: () => string;
}

/**
 * Klien fake dengan dua toko baris in-memory (snake_case, persis bentuk DB).
 * from('messages')/from('friendships') mengembalikan builder rantai yang
 * meniru sub-kemampuan PostgREST yang dipakai MessageService.
 */
export class FakeChatClient implements SupabaseChatLike {
  messages: MessageRow[];
  friendships: FriendshipRow[];
  /** Nama tabel setiap pemanggilan from() — bukti "tidak menyentuh supabase". */
  readonly fromCalls: string[] = [];
  readonly selectCalls: SelectCallLog[] = [];
  readonly insertCalls: InsertCallLog[] = [];
  failSelectWith?: SupabaseErrorLike;
  failInsertWith?: SupabaseErrorLike;
  readonly makeId: () => string;
  readonly now: () => string;
  #idCounter = 0;

  constructor(options: FakeChatClientOptions = {}) {
    this.messages = options.messages ?? [];
    this.friendships = options.friendships ?? [];
    this.failSelectWith = options.failSelectWith;
    this.failInsertWith = options.failInsertWith;
    this.makeId =
      options.makeId ??
      (() => {
        this.#idCounter += 1;
        return `00000000-0000-4000-8000-${String(this.#idCounter).padStart(12, '0')}`;
      });
    this.now = options.now ?? (() => '2026-09-28T12:00:00Z');
  }

  from = (table: string): ChatTableLike => {
    if (table !== 'messages' && table !== 'friendships') {
      throw new Error(`tabel fake tidak disediakan: ${table}`);
    }
    this.fromCalls.push(table);
    return new FakeChatTable(this, table);
  };
}

class FakeChatTable implements ChatTableLike {
  constructor(
    private readonly client: FakeChatClient,
    private readonly table: string,
  ) {}

  select(): FakeChatSelectChain {
    return new FakeChatSelectChain(this.client, this.table);
  }

  insert(values: Record<string, unknown>): FakeChatInsertChain {
    return new FakeChatInsertChain(this.client, this.table, values);
  }
}

/** Memecah string berdasar koma level-atas (koma di dalam kurung diabaikan). */
function splitTopLevel(input: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let current = '';
  for (const ch of input) {
    if (ch === '(') {
      depth += 1;
    } else if (ch === ')') {
      depth -= 1;
    }
    if (ch === ',' && depth === 0) {
      parts.push(current);
      current = '';
      continue;
    }
    current += ch;
  }
  parts.push(current);
  return parts;
}

/** Benarkan satu kondisi `col.eq.val` terhadap baris. */
function matchesEqCondition(row: Record<string, unknown>, condition: string): boolean {
  const match = /^([A-Za-z_]\w*)\.eq\.(.+)$/.exec(condition);
  if (match === null || match[1] === undefined || match[2] === undefined) {
    throw new Error(`kondisi eq tidak dipahami fake: "${condition}"`);
  }
  return row[match[1]] === match[2];
}

/** .or(query): cukup SATU cabang yang cocok; cabang and() butuh SEMUA cocok. */
function matchesOr(row: Record<string, unknown>, orQuery: string | undefined): boolean {
  if (orQuery === undefined) {
    return true;
  }
  return splitTopLevel(orQuery).some((part) => {
    const trimmed = part.trim();
    const andMatch = /^and\((.*)\)$/.exec(trimmed);
    if (andMatch !== null) {
      const inner = andMatch[1];
      if (inner === undefined) {
        throw new Error(`kondisi and() kosong pada fake: "${trimmed}"`);
      }
      return splitTopLevel(inner).every((condition) => matchesEqCondition(row, condition.trim()));
    }
    return matchesEqCondition(row, trimmed);
  });
}

/** Filter .eq() (sama dengan) dan .lt() (kurang dari, string) level-atas. */
function matchesEqLt(
  row: Record<string, unknown>,
  eq: Record<string, string>,
  lt: Record<string, string>,
): boolean {
  for (const [column, value] of Object.entries(eq)) {
    if (row[column] !== value) {
      return false;
    }
  }
  for (const [column, value] of Object.entries(lt)) {
    const cell = row[column];
    if (typeof cell !== 'string' || !(cell < value)) {
      return false;
    }
  }
  return true;
}

/** Urut berdasar kolom string; naik/turun sesuai opsi. */
function compareByOrder(spec: { column: string; ascending: boolean }) {
  return (a: Record<string, unknown>, b: Record<string, unknown>): number => {
    const av = a[spec.column];
    const bv = b[spec.column];
    if (typeof av !== 'string' || typeof bv !== 'string') {
      throw new Error(`kolom order fake bukan string: ${spec.column}`);
    }
    if (av < bv) {
      return spec.ascending ? -1 : 1;
    }
    if (av > bv) {
      return spec.ascending ? 1 : -1;
    }
    return 0;
  };
}

/** Konversi hasil daftar → bentuk maybeSingle (baris pertama atau null). */
function toSingleResponse(list: ListResponseLike<unknown>): SingleResponseLike<unknown> {
  if (list.error !== null) {
    return list;
  }
  const first = list.data[0];
  return first === undefined ? { data: null, error: null } : { data: first, error: null };
}

class FakeChatSelectChain implements ChatSelectChainLike {
  #or: string | undefined;
  #eq: Record<string, string> = {};
  #lt: Record<string, string> = {};
  #order: { column: string; ascending: boolean } | undefined;
  #limit: number | undefined;
  #maybeSingle = false;
  #settled: Promise<ListResponseLike<unknown>> | null = null;

  constructor(
    private readonly client: FakeChatClient,
    private readonly table: string,
  ) {}

  or(query: string): this {
    this.#or = query;
    return this;
  }

  eq(column: string, value: string): this {
    this.#eq[column] = value;
    return this;
  }

  lt(column: string, value: string): this {
    this.#lt[column] = value;
    return this;
  }

  order(column: string, options: { ascending: boolean }): this {
    this.#order = { column, ascending: options.ascending };
    return this;
  }

  limit(count: number): this {
    this.#limit = count;
    return this;
  }

  maybeSingle(): PromiseLike<SingleResponseLike<unknown>> {
    this.#maybeSingle = true;
    return this.#settle().then(toSingleResponse);
  }

  then<TResult1 = ListResponseLike<unknown>, TResult2 = never>(
    onfulfilled?: ((value: ListResponseLike<unknown>) => TResult1 | PromiseLike<TResult1>) | null,
    onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null,
  ): PromiseLike<TResult1 | TResult2> {
    return this.#settle().then(onfulfilled ?? undefined, onrejected ?? undefined);
  }

  #settle(): Promise<ListResponseLike<unknown>> {
    this.#settled ??= Promise.resolve(this.#execute());
    return this.#settled;
  }

  #execute(): ListResponseLike<unknown> {
    this.client.selectCalls.push({
      table: this.table,
      or: this.#or,
      eq: { ...this.#eq },
      lt: { ...this.#lt },
      order: this.#order,
      limit: this.#limit,
      maybeSingle: this.#maybeSingle,
    });
    if (this.client.failSelectWith !== undefined) {
      return { data: null, error: this.client.failSelectWith };
    }
    // Cast terdokumentasi: baris interface (tanpa index signature) perlu
    // dibaca sebagai Record untuk filter kolom dinamis — bentuk aslinya
    // tetap divalidasi ulang oleh Zod di sisi service.
    const rows = (this.table === 'messages'
      ? this.client.messages
      : this.client.friendships) as unknown as Array<Record<string, unknown>>;
    let matched = rows.filter(
      (row) => matchesOr(row, this.#or) && matchesEqLt(row, this.#eq, this.#lt),
    );
    if (this.#order !== undefined) {
      matched = [...matched].sort(compareByOrder(this.#order));
    }
    if (this.#limit !== undefined) {
      matched = matched.slice(0, this.#limit);
    }
    return { data: matched, error: null };
  }
}

class FakeChatInsertChain implements ChatInsertChainLike {
  #wantsReturn = false;
  #settled: Promise<SingleResponseLike<unknown>> | null = null;

  constructor(
    private readonly client: FakeChatClient,
    private readonly table: string,
    private readonly values: Record<string, unknown>,
  ) {}

  select(): this {
    this.#wantsReturn = true;
    return this;
  }

  single(): this {
    return this;
  }

  then<TResult1 = SingleResponseLike<unknown>, TResult2 = never>(
    onfulfilled?: ((value: SingleResponseLike<unknown>) => TResult1 | PromiseLike<TResult1>) | null,
    onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null,
  ): PromiseLike<TResult1 | TResult2> {
    return this.#settle().then(onfulfilled ?? undefined, onrejected ?? undefined);
  }

  #settle(): Promise<SingleResponseLike<unknown>> {
    this.#settled ??= Promise.resolve(this.#execute());
    return this.#settled;
  }

  #execute(): SingleResponseLike<unknown> {
    this.client.insertCalls.push({ values: { ...this.values } });
    if (this.client.failInsertWith !== undefined) {
      return { data: null, error: this.client.failInsertWith };
    }
    if (this.table !== 'messages') {
      throw new Error(`insert fake hanya untuk messages, diterima: ${this.table}`);
    }
    const row: Record<string, unknown> = { ...this.values };
    if (row['id'] === undefined) {
      row['id'] = this.client.makeId();
    }
    if (row['created_at'] === undefined) {
      row['created_at'] = this.client.now();
    }
    // Cast terdokumentasi: fake TIDAK menegakan constraint DB (keterbatasan
    // di header file) — kebenaran bentuk tetap dijaga revalidasi Zod service.
    this.client.messages.push(row as MessageRow);
    return this.#wantsReturn ? { data: row, error: null } : { data: null, error: null };
  }
}
