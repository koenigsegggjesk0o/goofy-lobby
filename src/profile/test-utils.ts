/**
 * Fake objek MediaRecorder / MediaStream / Supabase Storage / PostgREST
 * untuk unit test profile (lingkungan Node, tanpa browser). Hanya diimpor
 * dari file *.test.ts — tidak pernah masuk bundle produksi.
 */
import type { MediaRecorderLike, RecorderStreamLike } from './voice-recorder';
import type {
  ProfileRow,
  StorageBucketLike,
  SupabaseProfileLike,
  SupabaseStorageLike,
} from './types';

// ============================================================
// MediaStream & track
// ============================================================

export class FakeMediaTrack {
  stopped = false;
  stop(): void {
    this.stopped = true;
  }
}

export class FakeRecorderStream {
  constructor(readonly tracks: FakeMediaTrack[] = [new FakeMediaTrack()]) {}
  getTracks(): FakeMediaTrack[] {
    return this.tracks;
  }
}

// ============================================================
// MediaRecorder
// ============================================================

export interface FakeMediaRecorderOptions {
  /** MIME yang dilaporkan isTypeSupported (default: keduanya didukung). */
  supportedMimes?: readonly string[];
  /** MIME final yang dilaporkan recorder.mimeType setelah konstruksi. */
  resultingMime?: string;
  /** Konfigurasi failure: getUserMedia melempar error ini. */
  failStart?: boolean;
}

/**
 * State machine MediaRecorder: start(timeslice) → 'recording', stop() →
 * memicu onstop sinkron; emitChunk() meniru ondataavailable; emitError()
 * meniru kegagalan encoder. Handler dipasang persis seperti aslinya.
 */
export class FakeMediaRecorder implements MediaRecorderLike {
  static supportedMimes: readonly string[] = ['audio/webm', 'audio/webm;codecs=opus'];

  static isTypeSupported(mimeType: string): boolean {
    return FakeMediaRecorder.supportedMimes.includes(mimeType);
  }

  mimeType: string;
  state: 'inactive' | 'recording' | 'paused' = 'inactive';
  ondataavailable: ((event: { data: Blob }) => void) | null = null;
  onstop: ((event: unknown) => void) | null = null;
  onerror: ((event: unknown) => void) | null = null;

  lastStartTimeslice: number | undefined;
  startCalls = 0;
  stopCalls = 0;

  constructor(_stream: RecorderStreamLike, options?: { mimeType?: string }) {
    this.mimeType = options?.mimeType ?? 'audio/webm;codecs=opus';
  }

  start(timeslice?: number): void {
    if (this.state !== 'inactive') {
      throw new Error('InvalidStateError: recorder sudah berjalan');
    }
    this.state = 'recording';
    this.startCalls += 1;
    this.lastStartTimeslice = timeslice;
  }

  stop(): void {
    if (this.state === 'inactive') {
      throw new Error('InvalidStateError: recorder tidak berjalan');
    }
    this.state = 'inactive';
    this.stopCalls += 1;
    // Browser asli memicu onstop secara asinkron — microtask menirunya
    // (membuka jalur uji cancel-while-stopping yang sesungguhnya).
    queueMicrotask(() => this.onstop?.({}));
  }

  /** Meniru dataavailable (dipanggil test secara manual/berkala). */
  emitChunk(bytes: number): void {
    if (this.state !== 'recording') {
      throw new Error('chunk saat tidak merekam');
    }
    this.ondataavailable?.({ data: new Blob([new Uint8Array(bytes)]) });
  }

  /** Meniru kegagalan encoder (error event dengan .error.message). */
  emitError(message: string): void {
    this.state = 'inactive';
    queueMicrotask(() => this.onerror?.({ error: { message } }));
  }
}

// ============================================================
// Supabase Storage (bucket in-memory sederhana)
// ============================================================

export interface FakeStorageBucketOptions {
  /** Object store: path → metadata (di-seed test). */
  objects?: Map<string, { size: number; contentType: string }>;
  /** Pesan error yang dipaksa untuk operasi tertentu. */
  failUploadWith?: { message: string };
  failSignedUrlWith?: { message: string };
  failRemoveWith?: { message: string };
  failListWith?: { message: string };
}

export class FakeStorageBucket implements StorageBucketLike {
  readonly objects: Map<string, { size: number; contentType: string }>;
  readonly uploadCalls: Array<{
    path: string;
    bytes: number;
    contentType?: string;
    upsert?: boolean;
    cacheControl?: string;
  }> = [];
  readonly signedUrlCalls: Array<{ path: string; expiresIn: number }> = [];
  readonly removeCalls: string[][] = [];
  /** Setiap panggilan list: prefix + opsi paginasi (utk asersi kuota). */
  readonly listCalls: Array<{
    folder?: string;
    options?: { limit?: number; offset?: number };
  }> = [];
  failUploadWith?: { message: string };
  failSignedUrlWith?: { message: string };
  failRemoveWith?: { message: string };
  failListWith?: { message: string };

  constructor(options: FakeStorageBucketOptions = {}) {
    this.objects = options.objects ?? new Map();
    this.failUploadWith = options.failUploadWith;
    this.failSignedUrlWith = options.failSignedUrlWith;
    this.failRemoveWith = options.failRemoveWith;
    this.failListWith = options.failListWith;
  }

  async upload(
    path: string,
    body: Blob,
    options?: { contentType?: string; upsert?: boolean; cacheControl?: string },
  ): Promise<
    | { data: { path: string; fullPath: string }; error: null }
    | { data: null; error: { message: string } }
  > {
    this.uploadCalls.push({
      path,
      bytes: body.size,
      contentType: options?.contentType,
      upsert: options?.upsert,
      cacheControl: options?.cacheControl,
    });
    if (this.failUploadWith !== undefined) {
      return { data: null, error: this.failUploadWith };
    }
    this.objects.set(path, { size: body.size, contentType: options?.contentType ?? '' });
    return {
      data: { path, fullPath: `voice-snippets/${path}` },
      error: null,
    };
  }

  async createSignedUrl(
    path: string,
    expiresIn: number,
  ): Promise<
    { data: { signedUrl: string }; error: null } | { data: null; error: { message: string } }
  > {
    this.signedUrlCalls.push({ path, expiresIn });
    if (this.failSignedUrlWith !== undefined) {
      return { data: null, error: this.failSignedUrlWith };
    }
    if (!this.objects.has(path)) {
      return { data: null, error: { message: 'Object not found' } };
    }
    return { data: { signedUrl: `https://fake.sign/${path}?exp=${expiresIn}` }, error: null };
  }

  async remove(
    paths: string[],
  ): Promise<{ data: string[]; error: null } | { data: null; error: { message: string } }> {
    this.removeCalls.push(paths);
    if (this.failRemoveWith !== undefined) {
      return { data: null, error: this.failRemoveWith };
    }
    for (const path of paths) {
      this.objects.delete(path);
    }
    return { data: paths, error: null };
  }

  /**
   * Meniru storage list Supabase: prefix mentah (folder dianggap prefix
   * `${uid}/`), paginasi limit/offset (default 100 — persis API asli),
   * urutan nama stabil (nama asc), dan entri membawa metadata.size
   * (persis kebutuhan penghitung kuota).
   */
  async list(
    folder?: string,
    options?: { limit?: number; offset?: number },
  ): Promise<
    | {
        data: Array<{ name: string; metadata: { size: number; contentType: string } | null }>;
        error: null;
      }
    | { data: null; error: { message: string } }
  > {
    this.listCalls.push({
      folder,
      options: options === undefined ? undefined : { ...options },
    });
    if (this.failListWith !== undefined) {
      return { data: null, error: this.failListWith };
    }
    const prefix = folder ?? '';
    const names = [...this.objects.keys()]
      .filter((path) => path.startsWith(prefix))
      .map((path) => path.slice(prefix.length))
      .sort();
    const limit = options?.limit ?? 100;
    const offset = options?.offset ?? 0;
    const page = names.slice(offset, offset + limit);
    return {
      data: page.map((name) => {
        const metadata = this.objects.get(`${prefix}${name}`) ?? null;
        return { name, metadata };
      }),
      error: null,
    };
  }
}

export class FakeStorageClient implements SupabaseStorageLike {
  readonly buckets = new Map<string, FakeStorageBucket>();

  constructor(bucket?: FakeStorageBucket) {
    if (bucket !== undefined) {
      this.buckets.set('voice-snippets', bucket);
    }
  }

  storage = {
    from: (bucketName: string): FakeStorageBucket => {
      const bucket = this.buckets.get(bucketName);
      if (bucket === undefined) {
        throw new Error(`bucket fake tidak di-seed: ${bucketName}`);
      }
      return bucket;
    },
  };
}

// ============================================================
// PostgREST profiles (in-memory + rantai builder)
// ============================================================

export interface FakeProfileTableOptions {
  rows?: ProfileRow[];
  failSelectWith?: { message: string };
  failUpdateWith?: { message: string };
}

type FakeResponse = { data: unknown; error: null } | { data: null; error: { message: string } };

/**
 * Meniru sub-kemampuan PostgREST untuk tabel profiles:
 * select().eq().maybeSingle() dan update().eq().select().single(),
 * dengan penyimpanan baris in-memory (snake_case, persis bentuk DB).
 * maybeSingle()/single() mengembalikan builder itu sendiri — persis
 * perilaku postgrest-js asli (builder = PromiseLike).
 */
export class FakeProfileClient implements SupabaseProfileLike {
  rows: ProfileRow[];
  readonly updateCalls: Array<{ values: Record<string, unknown>; eq: Record<string, string> }> = [];
  failSelectWith?: { message: string };
  failUpdateWith?: { message: string };

  constructor(options: FakeProfileTableOptions = {}) {
    this.rows = options.rows ?? [];
    this.failSelectWith = options.failSelectWith;
    this.failUpdateWith = options.failUpdateWith;
  }

  from = (table: string): FakeProfileTable => {
    if (table !== 'profiles') {
      throw new Error(`tabel fake tidak disediakan: ${table}`);
    }
    return new FakeProfileTable(this);
  };
}

class FakeProfileTable {
  constructor(private readonly client: FakeProfileClient) {}

  select(): FakeSelectChain {
    return new FakeSelectChain(this.client);
  }

  update(values: Record<string, unknown>): FakeUpdateChain {
    return new FakeUpdateChain(this.client, values);
  }
}

/** Rantai dasar: filter eq + eksekusi sekali (hasil di-cache). */
abstract class FakeChainBase implements PromiseLike<FakeResponse> {
  protected readonly filters: Record<string, string> = {};
  #settled: Promise<FakeResponse> | null = null;

  eq(column: string, value: string): this {
    this.filters[column] = value;
    return this;
  }

  protected matches(row: ProfileRow): boolean {
    const record = row as unknown as Record<string, unknown>;
    return Object.entries(this.filters).every(([column, value]) => record[column] === value);
  }

  protected run(): Promise<FakeResponse> {
    this.#settled ??= Promise.resolve(this.execute());
    return this.#settled;
  }

  protected abstract execute(): FakeResponse;

  then<TResult1 = FakeResponse, TResult2 = never>(
    onfulfilled?: ((value: FakeResponse) => TResult1 | PromiseLike<TResult1>) | null,
    onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null,
  ): PromiseLike<TResult1 | TResult2> {
    return this.run().then(onfulfilled ?? undefined, onrejected ?? undefined);
  }
}

class FakeSelectChain extends FakeChainBase {
  maybeSingle(): this {
    return this;
  }

  protected execute(): FakeResponse {
    if (this.selectClient.failSelectWith !== undefined) {
      return { data: null, error: this.selectClient.failSelectWith };
    }
    const row = this.selectClient.rows.find((candidate) => this.matches(candidate));
    return { data: row ?? null, error: null };
  }

  constructor(private readonly selectClient: FakeProfileClient) {
    super();
  }
}

class FakeUpdateChain extends FakeChainBase {
  #wantsReturn = false;

  constructor(
    private readonly updateClient: FakeProfileClient,
    private readonly values: Record<string, unknown>,
  ) {
    super();
  }

  select(): this {
    this.#wantsReturn = true;
    return this;
  }

  single(): this {
    return this;
  }

  protected execute(): FakeResponse {
    if (this.updateClient.failUpdateWith !== undefined) {
      return { data: null, error: this.updateClient.failUpdateWith };
    }
    this.updateClient.updateCalls.push({ values: this.values, eq: { ...this.filters } });
    const index = this.updateClient.rows.findIndex((candidate) => this.matches(candidate));
    if (index === -1) {
      return { data: null, error: { message: 'Baris tidak ditemukan (RLS?)' } };
    }
    const merged = {
      ...(this.updateClient.rows[index] as unknown as Record<string, unknown>),
      ...this.values,
    };
    this.updateClient.rows[index] = merged as unknown as ProfileRow;
    return this.#wantsReturn
      ? { data: this.updateClient.rows[index], error: null }
      : { data: null, error: null };
  }
}
