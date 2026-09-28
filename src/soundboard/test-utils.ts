/**
 * Fake objek Supabase Storage untuk unit test soundboard (lingkungan
 * Node, tanpa jaringan). Hanya diimpor dari file *.test.ts — tidak
 * pernah masuk bundle produksi.
 *
 * Pola DISALIN dari src/profile/test-utils.ts (FakeStorageBucket /
 * FakeStorageClient) dengan penyesuaian nama bucket + prefix fullPath
 * 'soundboard-sounds/' — disalin, bukan diimpor, agar modul soundboard
 * mandiri dan tidak bergantung pada domain lain.
 */
import type { StorageBucketLike, SupabaseStorageLike } from './types';

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
  readonly listCalls: Array<string | undefined> = [];
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
      data: { path, fullPath: `soundboard-sounds/${path}` },
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

  async list(
    folder?: string,
  ): Promise<
    { data: Array<{ name: string }>; error: null } | { data: null; error: { message: string } }
  > {
    this.listCalls.push(folder);
    if (this.failListWith !== undefined) {
      return { data: null, error: this.failListWith };
    }
    const prefix = folder === undefined ? '' : `${folder}/`;
    const names = [...this.objects.keys()]
      .filter((path) => path.startsWith(prefix))
      .map((path) => path.slice(prefix.length));
    return { data: names.map((name) => ({ name })), error: null };
  }
}

export class FakeStorageClient implements SupabaseStorageLike {
  readonly buckets = new Map<string, FakeStorageBucket>();

  constructor(bucket?: FakeStorageBucket) {
    if (bucket !== undefined) {
      this.buckets.set('soundboard-sounds', bucket);
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
