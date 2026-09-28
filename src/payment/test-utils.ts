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
 */
import type { SupabasePremiumLike } from './types';

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
