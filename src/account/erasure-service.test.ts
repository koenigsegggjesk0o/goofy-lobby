import { describe, expect, it } from 'vitest';
import { eraseUserData } from './erasure-service';
import type {
  AdminAuthLike,
  ErasureDbLike,
  ErasureDeleteChainLike,
  ErasureDeleteResponse,
  ErasureListEntry,
  ErasureListResponse,
  ErasureMutationResponse,
  ErasureStorageLike,
} from './erasure-service';
import { STORAGE_LIST_PAGE_SIZE, VOICE_BUCKET_NAME } from '../profile/types';
import { SOUNDBOARD_BUCKET_NAME } from '../soundboard/types';

const USER = '7db26a0a-9ce5-4558-bd08-9612e9e9febe';

// ============================================================
// Fake db/storage/adminAuth dengan jurnal urutan GLOBAL — urutan
// langkah erasure (storage → db → profile terakhir → auth) adalah
// kontrak yang diuji, bukan hanya isi panggilan.
// ============================================================

class FakeDeleteChain implements ErasureDeleteChainLike {
  private orFilter?: string;
  #settled: Promise<ErasureDeleteResponse> | null = null;

  constructor(
    private readonly db: FakeErasureDb,
    private readonly table: string,
    private readonly options?: { count?: 'exact' },
  ) {}

  or(filters: string): this {
    this.orFilter = filters;
    return this;
  }

  // Service hanya memakai .or() — eq() tidak pernah dipanggil di jalur
  // erasure; implementasi boleh mendeklarasikan lebih sedikit parameter
  // daripada interface (kontravarian, idiomatik TS).
  eq(): this {
    return this;
  }

  private run(): Promise<ErasureDeleteResponse> {
    this.#settled ??= Promise.resolve(this.execute());
    return this.#settled;
  }

  private execute(): ErasureDeleteResponse {
    this.db.journal.push(`delete:${this.table}`);
    this.db.deleteCalls.push({
      table: this.table,
      options: this.options,
      orFilter: this.orFilter,
    });
    if (this.db.failWith !== undefined) {
      return { data: null, error: this.db.failWith, count: null };
    }
    const count = this.db.counts.get(this.table) ?? 0;
    this.db.counts.set(this.table, 0); // pengulangan delete = 0 baris.
    return { data: null, error: null, count };
  }

  then<TResult1 = ErasureDeleteResponse, TResult2 = never>(
    onfulfilled?: ((value: ErasureDeleteResponse) => TResult1 | PromiseLike<TResult1>) | null,
    onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null,
  ): PromiseLike<TResult1 | TResult2> {
    return this.run().then(onfulfilled ?? undefined, onrejected ?? undefined);
  }
}

class FakeErasureDb implements ErasureDbLike {
  readonly journal: string[];
  readonly deleteCalls: Array<{
    table: string;
    options?: { count?: 'exact' };
    orFilter?: string;
  }> = [];
  readonly counts = new Map<string, number>();
  failWith?: { message: string };

  constructor(journal: string[], counts: Record<string, number> = {}) {
    this.journal = journal;
    for (const [table, count] of Object.entries(counts)) {
      this.counts.set(table, count);
    }
  }

  from = (table: string): { delete(options?: { count?: 'exact' }): ErasureDeleteChainLike } => ({
    delete: (options?: { count?: 'exact' }) => new FakeDeleteChain(this, table, options),
  });
}

class FakeErasureBucket {
  constructor(
    private readonly storage: FakeErasureStorage,
    private readonly bucket: string,
  ) {}

  async list(
    prefix?: string,
    options?: { limit?: number; offset?: number },
  ): Promise<ErasureListResponse> {
    this.storage.journal.push(`list:${this.bucket}`);
    this.storage.listCalls.push({
      bucket: this.bucket,
      prefix,
      options: options === undefined ? undefined : { ...options },
    });
    if (this.storage.failListWith !== undefined) {
      return { data: null, error: this.storage.failListWith };
    }
    const resolvedPrefix = prefix ?? '';
    const names = [...(this.storage.objects.get(this.bucket) ?? new Set<string>())]
      .filter((path) => path.startsWith(resolvedPrefix))
      .map((path) => path.slice(resolvedPrefix.length))
      .sort();
    const limit = options?.limit ?? 100;
    const offset = options?.offset ?? 0;
    const page = names.slice(offset, offset + limit);
    const data: ErasureListEntry[] = page.map((name) => ({ name, metadata: null }));
    return { data, error: null };
  }

  async remove(paths: string[]): Promise<ErasureMutationResponse> {
    this.storage.journal.push(`remove:${this.bucket}`);
    this.storage.removeCalls.push({ bucket: this.bucket, paths: [...paths] });
    if (this.storage.failRemoveWith !== undefined) {
      return { data: null, error: this.storage.failRemoveWith };
    }
    const objects = this.storage.objects.get(this.bucket);
    if (objects !== undefined) {
      for (const path of paths) {
        objects.delete(path);
      }
    }
    return { data: null, error: null };
  }
}

class FakeErasureStorage implements ErasureStorageLike {
  readonly journal: string[];
  /** Object store per bucket: bucket → set path. */
  readonly objects = new Map<string, Set<string>>();
  readonly listCalls: Array<{
    bucket: string;
    prefix?: string;
    options?: { limit?: number; offset?: number };
  }> = [];
  readonly removeCalls: Array<{ bucket: string; paths: string[] }> = [];
  failListWith?: { message: string };
  failRemoveWith?: { message: string };

  constructor(journal: string[]) {
    this.journal = journal;
  }

  /** Seed objek milik test: path penuh `{userId}/{nama}` di bucket tertentu. */
  seed(bucket: string, path: string): void {
    const objects = this.objects.get(bucket) ?? new Set<string>();
    objects.add(path);
    this.objects.set(bucket, objects);
  }

  countObjects(bucket: string): number {
    return this.objects.get(bucket)?.size ?? 0;
  }

  storage = {
    from: (bucket: string): FakeErasureBucket => new FakeErasureBucket(this, bucket),
  };
}

class FakeAdminAuth implements AdminAuthLike {
  readonly calls: string[] = [];
  failWith?: { message: string };

  constructor(private readonly journal: string[]) {}

  async deleteUser(userId: string): Promise<ErasureMutationResponse> {
    this.journal.push('admin:deleteUser');
    this.calls.push(userId);
    if (this.failWith !== undefined) {
      return { data: null, error: this.failWith };
    }
    return { data: null, error: null };
  }
}

function setup(counts: Record<string, number> = {}) {
  const journal: string[] = [];
  return {
    journal,
    db: new FakeErasureDb(journal, counts),
    storage: new FakeErasureStorage(journal),
    adminAuth: new FakeAdminAuth(journal),
  };
}

describe('eraseUserData', () => {
  it('menghapus kedua bucket persis (voice-snippets + soundboard-sounds) lalu db eksplisit lalu auth', async () => {
    const ctx = setup({
      paddle_transactions: 2,
      friendships: 3,
      blocks: 1,
      messages: 7,
      profiles: 1,
    });
    // 3 file voice + 1 entri folder (dilewati) + 2 file soundboard.
    ctx.storage.seed('voice-snippets', `${USER}/snippet-a.webm`);
    ctx.storage.seed('voice-snippets', `${USER}/snippet-b.webm`);
    ctx.storage.seed('voice-snippets', `${USER}/snippet-c.webm`);
    ctx.storage.seed('voice-snippets', `${USER}/subfolder/`);
    ctx.storage.seed('soundboard-sounds', `${USER}/sound-a.mp3`);
    ctx.storage.seed('soundboard-sounds', `${USER}/sound-b.wav`);
    ctx.storage.seed('voice-snippets', 'user-lain/jangan-dihapus.webm');

    const summary = await eraseUserData({ ...ctx, userId: USER });

    expect(summary).toEqual({
      removedFiles: 5,
      deletedRows: {
        paddleTransactions: 2,
        friendships: 3,
        blocks: 1,
        messages: 7,
        profiles: 1,
      },
      authUserDeleted: true,
    });

    // Nama bucket PERSIS konstanta domain (0003/0012).
    expect(VOICE_BUCKET_NAME).toBe('voice-snippets');
    expect(SOUNDBOARD_BUCKET_NAME).toBe('soundboard-sounds');

    // List: prefix `${USER}/` paginated di KEDUA bucket.
    expect(ctx.storage.listCalls).toEqual([
      {
        bucket: 'voice-snippets',
        prefix: `${USER}/`,
        options: { limit: STORAGE_LIST_PAGE_SIZE, offset: 0 },
      },
      {
        bucket: 'soundboard-sounds',
        prefix: `${USER}/`,
        options: { limit: STORAGE_LIST_PAGE_SIZE, offset: 0 },
      },
    ]);

    // Remove: path penuh milik user saja (entri folder dilewati).
    expect(ctx.storage.removeCalls).toEqual([
      {
        bucket: 'voice-snippets',
        paths: [`${USER}/snippet-a.webm`, `${USER}/snippet-b.webm`, `${USER}/snippet-c.webm`],
      },
      { bucket: 'soundboard-sounds', paths: [`${USER}/sound-a.mp3`, `${USER}/sound-b.wav`] },
    ]);
    // Sisa di voice bucket: file user lain + entri folder (memang dilewati).
    expect([...(ctx.storage.objects.get('voice-snippets') ?? [])].sort()).toEqual([
      `${USER}/subfolder/`,
      'user-lain/jangan-dihapus.webm',
    ]);
    expect(ctx.storage.countObjects('soundboard-sounds')).toBe(0);

    // Delete db: urutan + filter or() dua arah PERSIS.
    expect(ctx.db.deleteCalls).toEqual([
      { table: 'paddle_transactions', options: { count: 'exact' }, orFilter: `user_id.eq.${USER}` },
      {
        table: 'friendships',
        options: { count: 'exact' },
        orFilter: `requester_id.eq.${USER},addressee_id.eq.${USER}`,
      },
      {
        table: 'blocks',
        options: { count: 'exact' },
        orFilter: `blocker_id.eq.${USER},blocked_id.eq.${USER}`,
      },
      {
        table: 'messages',
        options: { count: 'exact' },
        orFilter: `sender_id.eq.${USER},recipient_id.eq.${USER}`,
      },
      { table: 'profiles', options: { count: 'exact' }, orFilter: `id.eq.${USER}` },
    ]);

    // Auth user dihapus dengan id benar.
    expect(ctx.adminAuth.calls).toEqual([USER]);

    // URUTAN (kontrak): storage DULU, profile TERAKHIR di db, auth paling akhir.
    const firstRemove = ctx.journal.indexOf('remove:voice-snippets');
    const firstDelete = ctx.journal.indexOf('delete:paddle_transactions');
    const profileDelete = ctx.journal.indexOf('delete:profiles');
    const authDelete = ctx.journal.indexOf('admin:deleteUser');
    expect(firstRemove).toBeGreaterThanOrEqual(0);
    expect(firstRemove).toBeLessThan(firstDelete);
    expect(firstDelete).toBeLessThan(profileDelete);
    expect(profileDelete).toBeLessThan(authDelete);
  });

  it('folder > 100 objek → list memaginasi (2 halaman) dan semua file terhapus', async () => {
    const ctx = setup();
    for (let i = 0; i < STORAGE_LIST_PAGE_SIZE + 5; i += 1) {
      ctx.storage.seed('voice-snippets', `${USER}/snippet-${String(i).padStart(4, '0')}.webm`);
    }
    const summary = await eraseUserData({ ...ctx, userId: USER });
    expect(summary.removedFiles).toBe(STORAGE_LIST_PAGE_SIZE + 5);
    const voiceLists = ctx.storage.listCalls.filter((call) => call.bucket === 'voice-snippets');
    expect(voiceLists).toEqual([
      {
        bucket: 'voice-snippets',
        prefix: `${USER}/`,
        options: { limit: STORAGE_LIST_PAGE_SIZE, offset: 0 },
      },
      {
        bucket: 'voice-snippets',
        prefix: `${USER}/`,
        options: { limit: STORAGE_LIST_PAGE_SIZE, offset: STORAGE_LIST_PAGE_SIZE },
      },
    ]);
    expect(ctx.storage.countObjects('voice-snippets')).toBe(0);
  });

  it('bucket kosong → tidak memanggil remove sama sekali', async () => {
    const ctx = setup();
    const summary = await eraseUserData({ ...ctx, userId: USER });
    expect(summary.removedFiles).toBe(0);
    expect(ctx.storage.removeCalls).toEqual([]);
    expect(ctx.adminAuth.calls).toEqual([USER]);
  });

  it('pemanggilan ulang (retry) → semua hitungan 0, idempoten', async () => {
    const ctx = setup({ profiles: 1 });
    ctx.storage.seed('voice-snippets', `${USER}/snippet-a.webm`);
    await eraseUserData({ ...ctx, userId: USER });
    const second = await eraseUserData({ ...ctx, userId: USER });
    expect(second).toEqual({
      removedFiles: 0,
      deletedRows: {
        paddleTransactions: 0,
        friendships: 0,
        blocks: 0,
        messages: 0,
        profiles: 0,
      },
      authUserDeleted: true,
    });
    expect(ctx.adminAuth.calls).toEqual([USER, USER]);
  });

  it('userId kosong / mengandung slash → invalid-user-id, TIDAK ada efek samping', async () => {
    const ctx = setup();
    await expect(eraseUserData({ ...ctx, userId: '' })).rejects.toMatchObject({
      code: 'invalid-user-id',
    });
    await expect(eraseUserData({ ...ctx, userId: `${USER}/injeksi` })).rejects.toMatchObject({
      code: 'invalid-user-id',
    });
    expect(ctx.journal).toEqual([]);
    expect(ctx.adminAuth.calls).toEqual([]);
  });

  it('error list storage → ErasureError storage-error, db belum tersentuh', async () => {
    const ctx = setup();
    ctx.storage.failListWith = { message: 'list denied' };
    await expect(eraseUserData({ ...ctx, userId: USER })).rejects.toMatchObject({
      code: 'storage-error',
      message: expect.stringContaining('voice-snippets'),
    });
    expect(ctx.db.deleteCalls).toEqual([]);
    expect(ctx.adminAuth.calls).toEqual([]);
  });

  it('error remove storage → storage-error (auth user belum dihapus)', async () => {
    const ctx = setup();
    ctx.storage.seed('voice-snippets', `${USER}/snippet-a.webm`);
    ctx.storage.failRemoveWith = { message: 'remove denied' };
    await expect(eraseUserData({ ...ctx, userId: USER })).rejects.toMatchObject({
      code: 'storage-error',
      message: expect.stringContaining('remove denied'),
    });
    expect(ctx.adminAuth.calls).toEqual([]);
  });

  it('error delete db → db-error, auth user belum dihapus', async () => {
    const ctx = setup();
    ctx.db.failWith = { message: 'connection refused' };
    await expect(eraseUserData({ ...ctx, userId: USER })).rejects.toMatchObject({
      code: 'db-error',
      message: expect.stringContaining('paddle_transactions'),
    });
    expect(ctx.adminAuth.calls).toEqual([]);
  });

  it('error deleteUser auth → auth-admin-error', async () => {
    const ctx = setup();
    ctx.adminAuth.failWith = { message: 'user not found' };
    await expect(eraseUserData({ ...ctx, userId: USER })).rejects.toMatchObject({
      code: 'auth-admin-error',
      message: expect.stringContaining('user not found'),
    });
  });
});
