import { describe, expect, it, vi } from 'vitest';
import {
  BLOCK_LIST_FETCH_LIMIT,
  defaultBlockListProvider,
  fetchOwnBlockedPeerIds,
  type BlockListClient,
  type BlockListResponseLike,
} from './block-muting';

/**
 * Fake klien query blokir — bentuk structural BlockListClient persis
 * PostgREST supabase-js ({ data, error }), rantai select/eq/limit yang
 * bisa di-await. Mencatat urutan pemanggilan rantai untuk asersi.
 */
class FakeBlockChain implements PromiseLike<BlockListResponseLike> {
  readonly calls: string[] = [];
  readonly table: string;
  readonly columns: string;
  #respond: () => BlockListResponseLike;

  constructor(table: string, columns: string, respond: () => BlockListResponseLike) {
    this.table = table;
    this.columns = columns;
    this.#respond = respond;
  }

  eq(column: string, value: string): FakeBlockChain {
    this.calls.push(`eq:${column}=${value}`);
    return this;
  }

  limit(count: number): FakeBlockChain {
    this.calls.push(`limit:${count}`);
    return this;
  }

  then<TResult1 = BlockListResponseLike, TResult2 = never>(
    onfulfilled?: ((value: BlockListResponseLike) => TResult1 | PromiseLike<TResult1>) | null,
    onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null,
  ): PromiseLike<TResult1 | TResult2> {
    return Promise.resolve(this.#respond()).then(onfulfilled, onrejected);
  }
}

class FakeBlockClient {
  readonly chains: FakeBlockChain[] = [];
  #respond: () => BlockListResponseLike;
  #userResponse: () => {
    data: { user: { id: string } | null } | null;
    error: { message: string } | null;
  };

  constructor(
    respond: () => BlockListResponseLike = () => ({ data: [], error: null }),
    userResponse: () => {
      data: { user: { id: string } | null } | null;
      error: { message: string } | null;
    } = () => ({ data: { user: { id: '11111111-1111-1111-1111-111111111111' } }, error: null }),
  ) {
    this.#respond = respond;
    this.#userResponse = userResponse;
  }

  auth = {
    getUser: async () => this.#userResponse(),
  };

  from(table: string): { select(columns: string): FakeBlockChain } {
    const chain = new FakeBlockChain(table, 'blocked_id', this.#respond);
    this.chains.push(chain);
    return {
      select: (columns: string) => {
        expect(columns).toBe('blocked_id');
        return chain;
      },
    };
  }

  asClient(): BlockListClient {
    return this as unknown as BlockListClient;
  }
}

describe('fetchOwnBlockedPeerIds', () => {
  it('sukses: memilih blocked_id milik uid sendiri → Set userId terblokir', async () => {
    const client = new FakeBlockClient(() => ({
      data: [
        { blocked_id: '22222222-2222-2222-2222-222222222222' },
        { blocked_id: '33333333-3333-3333-3333-333333333333' },
      ],
      error: null,
    }));

    const ids = await fetchOwnBlockedPeerIds(client.asClient());

    expect(ids).toEqual(
      new Set(['22222222-2222-2222-2222-222222222222', '33333333-3333-3333-3333-333333333333']),
    );
    // Filter eksplisit blocker_id = uid sendiri (RLS 0008 tetap otoritatif).
    const chain = client.chains[0];
    expect(chain?.table).toBe('blocks');
    expect(chain?.columns).toBe('blocked_id');
    expect(chain?.calls).toContain('eq:blocker_id=11111111-1111-1111-1111-111111111111');
    expect(chain?.calls).toContain(`limit:${String(BLOCK_LIST_FETCH_LIMIT)}`);
  });

  it('error query → Set kosong + console.warn (fail-open, tidak melempar)', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      const client = new FakeBlockClient(() => ({
        data: null,
        error: { message: 'RLS menolak' },
      }));

      const ids = await fetchOwnBlockedPeerIds(client.asClient());

      expect(ids).toEqual(new Set());
      expect(warnSpy).toHaveBeenCalledTimes(1);
      expect(String(warnSpy.mock.calls[0])).toContain('RLS menolak');
    } finally {
      warnSpy.mockRestore();
    }
  });

  it('error auth (belum signin) → Set kosong + warn (fail-open)', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      const client = new FakeBlockClient(
        () => ({ data: [], error: null }),
        () => ({ data: { user: null }, error: null }),
      );

      const ids = await fetchOwnBlockedPeerIds(client.asClient());

      expect(ids).toEqual(new Set());
      expect(warnSpy).toHaveBeenCalledTimes(1);
    } finally {
      warnSpy.mockRestore();
    }
  });

  it('baris rusak / data bukan array → dilewati tanpa menggugurkan sisanya', async () => {
    const client = new FakeBlockClient(() => ({
      data: [
        { blocked_id: '44444444-4444-4444-4444-444444444444' },
        { blocked_id: '' }, // kosong — tidak sah
        { sesuatu: 'lain' }, // field hilang
        'bukan-objek',
        null,
        { blocked_id: 42 }, // bukan string
      ],
      error: null,
    }));

    const ids = await fetchOwnBlockedPeerIds(client.asClient());

    expect(ids).toEqual(new Set(['44444444-4444-4444-4444-444444444444']));
  });

  it('provider yang melempar (network reject) → tetap Set kosong via fail-open', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      const client = new FakeBlockClient(() => {
        throw new Error('jaringan mati');
      });

      const ids = await fetchOwnBlockedPeerIds(client.asClient());

      expect(ids).toEqual(new Set());
      expect(warnSpy).toHaveBeenCalledTimes(1);
    } finally {
      warnSpy.mockRestore();
    }
  });
});

describe('defaultBlockListProvider', () => {
  it('klien dengan .from + .auth → provider aktif dan membaca lewat klien itu', async () => {
    const client = new FakeBlockClient(() => ({
      data: [{ blocked_id: '55555555-5555-5555-5555-555555555555' }],
      error: null,
    }));

    const provider = defaultBlockListProvider(client.asClient());

    expect(provider).toBeDefined();
    const ids = await provider?.();
    expect(ids).toEqual(new Set(['55555555-5555-5555-5555-555555555555']));
  });

  it('klien tanpa kemampuan query (fake realtime test) → undefined (fitur mati)', () => {
    expect(defaultBlockListProvider({ channel: () => undefined })).toBeUndefined();
    expect(defaultBlockListProvider(null)).toBeUndefined();
    expect(defaultBlockListProvider({ from: () => undefined })).toBeUndefined(); // tanpa .auth
  });
});
