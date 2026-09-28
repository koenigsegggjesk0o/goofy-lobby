/**
 * Verifikasi migrasi database 0001..0013 pada PostgreSQL ASLI in-process
 * (@electric-sql/pglite, build WASM) — mengubah status migrasi dari
 * "ditulis tapi tak pernah dijalankan" menjadi "terverifikasi eksekusi +
 * semantik keamanan lokal". File ini mengeksekusi seluruh
 * supabase/migrations/*.sql secara berurutan, LALU menguji perilaku
 * RLS / grant kolom / trigger guard secara empiris lewat role switching
 * (SET ROLE authenticated + klaim JWT di GUC sesi).
 *
 * BATAS KEJUJURAN:
 * - PGlite tidak membawa infrastruktur Supabase. Schema `auth` (tabel users
 *   + fungsi auth.uid()) dan schema `storage` (buckets/objects +
 *   storage.foldername) dibangun sebagai STUB yang meniru semantiknya:
 *   auth.uid() membaca GUC `request.jwt.claims` dan mengembalikan null bila
 *   claims kosong / tidak ada sub. Ini BUKAN Supabase asli — hasil di sini
 *   memverifikasi SQL migrasi terhadap inti Postgres, bukan terhadap
 *   PostgREST/JWT pipeline Supabase.
 * - Stub menambah GRANT pada schema auth/storage yang di Supabase asli sudah
 *   ada bawaan (tanpa ini role authenticated kena "permission denied for
 *   schema" SEBELUM RLS sempat dievaluasi). Penyimpangan ini hanya di sisi
 *   stub, file migrasi tidak disentuh.
 *
 * PENYIMPANGAN DESAIN vs spec task 12-g (didokumentasikan):
 * - Spec meminta pass idempotensi (jalankan ulang SEMUA file) di beforeAll.
 *   Hasil empiris: 0006_profile_voice_snippet.sql GAGAL dijalankan ulang
 *   (SQLSTATE 42710 — `create policy voice_snippets_select_authenticated`
 *   tanpa `drop policy if exists` dulu) padahal header file itu mengklaim
 *   "Idempotent: aman dijalankan ulang". Pass kedua dipindah menjadi test
 *   TERAKHIR agar test-test semantik di atasnya tetap terverifikasi hijau
 *   dan kegagalan idempotensi terisolasi sebagai temuan merah yang jelas.
 *   Assertion tidak dikurangi — test itu memang harus tetap merah sampai
 *   file migrasinya diperbaiki.
 *
 * STATE ANTAR-TEST: satu instance PGlite dipakai bersama (apply migrasi itu
 * mahal), test berjalan berurutan dan beberapa test sengaja mewarisi state
 * test sebelumnya (dibolehkan permanen setelah selesai):
 * - a friendship A↔B pending → accepted → dihapus → dibuat ulang accepted;
 * - block B→A dibuat (test guard), dihapus (test messages), dibuat lagi.
 * afterEach selalu me-reset role + klaim JWT agar tidak ada kebocoran konteks.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PGlite } from '@electric-sql/pglite';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

/** UUID deterministik (hardcode supaya test reproducible). */
const USER_A = '11111111-1111-1111-1111-111111111111';
const USER_B = '22222222-2222-2222-2222-222222222222';
const USER_C = '33333333-3333-3333-3333-333333333333';
const USER_D = '44444444-4444-4444-4444-444444444444';

const MIGRATIONS_DIR = fileURLToPath(new URL('../../supabase/migrations', import.meta.url));

/** File migrasi urut nama (zero-padded 0001..0013 → urut leksikografis = numerik). */
const MIGRATION_FILES = readdirSync(MIGRATIONS_DIR)
  .filter((f) => f.endsWith('.sql'))
  .sort();

/**
 * STUB infrastruktur Supabase — bagian yang TIDAK dibawa PGlite. Semantik
 * mengikuti Supabase: auth.uid() dari GUC request.jwt.claims (null bila
 * kosong / tanpa sub); storage.foldername mengembalikan segmen folder path.
 * Role anon/authenticated/service_role adalah role nologin biasa — cukup
 * untuk SET ROLE dan evaluasi policy `to authenticated`.
 */
const SUPABASE_STUB_SQL = `
  create role anon nologin;
  create role authenticated nologin;
  create role service_role nologin;

  create schema auth;
  create table auth.users (
    id uuid primary key,
    raw_user_meta_data jsonb not null default '{}'
  );
  create or replace function auth.uid() returns uuid language sql stable as
    $$ select nullif(current_setting('request.jwt.claimS', true)::jsonb ->> 'sub', '')::uuid $$;

  create schema storage;
  create table storage.buckets (
    id text primary key,
    name text not null,
    public boolean not null default false,
    file_size_limit bigint,
    allowed_mime_types text[]
  );
  create table storage.objects (
    id uuid primary key default gen_random_uuid(),
    bucket_id text references storage.buckets (id),
    name text not null,
    created_at timestamptz not null default now()
  );
  create or replace function storage.foldername(fullpath text) returns text[] language sql immutable as
    $$ select (string_to_array(fullpath, '/'))[1 : array_length(string_to_array(fullpath, '/'), 1) - 1] $$;

  alter table storage.objects enable row level security;

  -- PENYIMPANGAN TERDOKUMENTASI (hanya di stub, lihat header file): grant
  -- bawaan Supabase yang harus direplikasi supaya RLS storage teruji.
  grant usage on schema auth to anon, authenticated, service_role;
  grant usage on schema storage to anon, authenticated, service_role;
  grant select on storage.buckets to anon, authenticated;
  grant select, insert, update, delete on storage.objects to anon, authenticated;
`;

/** Satu instance untuk SEMUA test — inisialisasi + apply migrasi itu mahal. */
const db = new PGlite();

function readMigration(file: string): string {
  return readFileSync(join(MIGRATIONS_DIR, file), 'utf8');
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** SQLSTATE dari error PGlite (property `code` pada DatabaseError). */
function errorCode(err: unknown): string | undefined {
  if (typeof err === 'object' && err !== null && 'code' in err) {
    const code = (err as { code?: unknown }).code;
    if (typeof code === 'string') return code;
  }
  return undefined;
}

/**
 * Masuk ke konteks user ter-autentikasi: SET ROLE authenticated + klaim JWT
 * (GUC sesi). Setiap exec/query pglite berjalan pada sesi yang sama sehingga
 * role + GUC bertahan lintas panggilan. `set local` sengaja tidak dipakai
 * (berlaku hanya dalam transaksi per-exec).
 */
async function asUser(userId: string): Promise<void> {
  await db.exec('reset role;');
  await db.exec(`select set_config('request.jwt.claims', '{"sub":"${userId}"}', false);`);
  await db.exec('set role authenticated;');
}

/**
 * Kembali ke superuser (postgres) — melewati RLS. Analogi service_role untuk
 * operasi server-side; di Supabase asli penulis sah is_premium adalah
 * service_role dari DALAM Edge Function, bukan koneksi interaktif.
 */
async function asSuperuser(): Promise<void> {
  await db.exec('reset role;');
}

async function one<T>(sql: string, params?: unknown[]): Promise<T> {
  const result = await db.query<T>(sql, params);
  const row = result.rows[0];
  if (row === undefined) {
    throw new Error(`query tidak mengembalikan baris: ${sql}`);
  }
  return row;
}

async function scalarInt(sql: string, params?: unknown[]): Promise<number> {
  return (await one<{ n: number }>(sql, params)).n;
}

/**
 * Asersi error Postgres yang DIHARAPKAN: SQLSTATE (+ potongan pesan opsional).
 * Memastikan kegagalan terjadi karena alasan yang benar — RLS vs constraint
 * vs trigger guard vs permission — bukan sekadar "gagal".
 */
async function expectPgError(
  fn: () => Promise<unknown>,
  code: string,
  messageIncludes?: string,
): Promise<void> {
  let caught: unknown;
  try {
    await fn();
  } catch (err) {
    caught = err;
  }
  if (caught === undefined) {
    throw new Error(
      `diharapkan error Postgres ${code} (${messageIncludes ?? 'tanpa cek pesan'}) tetapi statement sukses`,
    );
  }
  expect(errorCode(caught)).toBe(code);
  if (messageIncludes !== undefined) {
    expect(errorMessage(caught).toLowerCase()).toContain(messageIncludes.toLowerCase());
  }
}

beforeAll(async () => {
  // 1) Stub lingkungan Supabase (role, schema auth/storage, helper functions).
  await db.exec(SUPABASE_STUB_SQL);

  // 2) Terapkan 0001..0013 BERURUTAN. Error apa pun → seluruh suite gagal
  //    dengan nama file — memang begitu, kita justru berburu SQL rusak.
  //    (Pass idempotensi sengaja bukan di sini — lihat test terakhir + header.)
  for (const file of MIGRATION_FILES) {
    try {
      await db.exec(readMigration(file));
    } catch (err) {
      throw new Error(`migrasi gagal dijalankan: ${file} — ${errorMessage(err)}`, {
        cause: err,
      });
    }
  }

  // 3) Seed tiga user. Profil TIDAK di-insert manual — harus dibuat otomatis
  //    oleh trigger handle_new_user (0001); test berikutnya mengasertinya.
  await db.exec(`
    insert into auth.users (id, raw_user_meta_data) values
      ('${USER_A}', '{"display_name": "Alice"}'),
      ('${USER_B}', '{}'),
      ('${USER_C}', '{"display_name": "Charlie"}');
  `);
}, 120_000);

afterEach(async () => {
  // Higiene sesi: kembali ke superuser + bersihkan klaim JWT supaya test
  // berikutnya tidak teracuni konteks user dari test sebelumnya.
  await db.exec('reset role;');
  await db.exec('reset request.jwt.claims;');
});

afterAll(async () => {
  await db.close();
});

describe('migrasi 0001..0013 pada PGlite (WASM Postgres)', () => {
  it(
    'membaca 13 file migrasi dan membentuk semua objek inti (tabel, kolom, policy, bucket)',
    { timeout: 60_000 },
    async () => {
      expect(MIGRATION_FILES).toHaveLength(13);
      expect(MIGRATION_FILES[0]).toBe('0001_profiles.sql');
      expect(MIGRATION_FILES[12]).toBe('0013_soundboard_storage_rls.sql');

      const tables = await db.query<{ tablename: string }>(
        `select tablename from pg_tables
       where schemaname = 'public'
         and tablename in ('profiles', 'friendships', 'blocks', 'messages')
       order by tablename`,
      );
      expect(tables.rows.map((r) => r.tablename)).toEqual([
        'blocks',
        'friendships',
        'messages',
        'profiles',
      ]);

      // Kolom dari migrasi lanjutan: 0006 voice_snippet_path + 0011 is_premium.
      const cols = await db.query<{ column_name: string }>(
        `select column_name from information_schema.columns
       where table_schema = 'public' and table_name = 'profiles'
         and column_name in ('voice_snippet_path', 'is_premium')
       order by column_name`,
      );
      expect(cols.rows.map((r) => r.column_name)).toEqual(['is_premium', 'voice_snippet_path']);

      // RLS aktif di semua tabel public + storage.objects (hasil 0002/0008/0010
      // + stub storage). 4 tabel public + 1 objects = 5.
      expect(
        await scalarInt(
          `select count(*)::int as n from pg_class c
         where c.relrowsecurity
           and (
             (c.relnamespace = 'public'::regnamespace
               and c.relname in ('profiles', 'friendships', 'blocks', 'messages'))
             or (c.relnamespace = 'storage'::regnamespace and c.relname = 'objects')
           )`,
        ),
      ).toBe(5);

      // Seluruh policy yang dibuat migrasi (nama persis per file; 0004 membuat
      // select_own lalu 0006 menggantinya dengan versi longgar authenticated).
      const policies = await db.query<{ policyname: string }>(
        `select policyname from pg_policies
       where (schemaname = 'public'
               and tablename in ('profiles', 'friendships', 'blocks', 'messages'))
          or (schemaname = 'storage' and tablename = 'objects')
       order by policyname`,
      );
      expect(policies.rows.map((r) => r.policyname)).toEqual([
        'blocks_delete_blocker',
        'blocks_insert_blocker',
        'blocks_select_blocker',
        'friendships_delete_participant',
        'friendships_insert_requester',
        'friendships_select_participants',
        'friendships_update_addressee',
        'messages_insert_sender_friends',
        'messages_select_participants',
        'profiles_delete_own',
        'profiles_insert_own',
        'profiles_select_authenticated',
        'profiles_update_own',
        'soundboard_delete_own',
        'soundboard_insert_own',
        'soundboard_select_authenticated',
        'voice_snippets_delete_own',
        'voice_snippets_insert_own',
        'voice_snippets_select_authenticated',
      ]);

      // Bucket storage dari 0003 + 0012.
      const buckets = await db.query<{ id: string }>(
        `select id from storage.buckets
       where id in ('voice-snippets', 'soundboard-sounds')
       order by id`,
      );
      expect(buckets.rows.map((r) => r.id)).toEqual(['soundboard-sounds', 'voice-snippets']);
    },
  );

  it(
    'trigger handle_new_user (0001): profil dibuat otomatis — metadata dipakai, fallback guest_',
    { timeout: 60_000 },
    async () => {
      // User D di-insert DI SINI (bukan saat seed) untuk membuktikan trigger
      // menyala pada setiap insert auth.users. display_name D berisi whitespace
      // murni → nullif(btrim(...)) harus menjatuhkannya ke fallback guest_.
      await db.exec(
        `insert into auth.users (id, raw_user_meta_data)
       values ('${USER_D}', '{"display_name": "   "}')`,
      );

      const rows = await db.query<{ id: string; display_name: string; is_premium: boolean }>(
        'select id::text as id, display_name, is_premium from public.profiles order by id',
      );
      expect(rows.rows).toHaveLength(4);
      const byId = new Map(rows.rows.map((r) => [r.id, r]));
      expect(byId.get(USER_A)?.display_name).toBe('Alice'); // dari metadata
      expect(byId.get(USER_B)?.display_name).toBe(`guest_${USER_B.slice(0, 8)}`); // tanpa metadata
      expect(byId.get(USER_C)?.display_name).toBe('Charlie'); // dari metadata
      expect(byId.get(USER_D)?.display_name).toBe(`guest_${USER_D.slice(0, 8)}`); // whitespace → fallback
      for (const row of rows.rows) {
        expect(row.is_premium).toBe(false); // default kolom 0011
      }
    },
  );

  it(
    'friendships kanonik (0007): A→B sukses; B→A ditolak unique index pasangan (23505)',
    { timeout: 60_000 },
    async () => {
      await asUser(USER_A);
      await db.query(
        'insert into public.friendships (requester_id, addressee_id) values ($1, $2)',
        [USER_A, USER_B],
      );

      // Insert arah terbalik SEBAGAI B: lolos RLS insert (B memang requester-
      // nya sendiri) lalu ditampar unique index ekspresi least/greatest —
      // A→B dan B→A adalah pasangan yang sama.
      await asUser(USER_B);
      await expectPgError(
        () =>
          db.query('insert into public.friendships (requester_id, addressee_id) values ($1, $2)', [
            USER_B,
            USER_A,
          ]),
        '23505',
        'friendships_pair_canonical_unique',
      );
    },
  );

  it(
    'RLS friendships (0008): C buta terhadap relasi A↔B; UPDATE hanya addressee; DELETE peserta saja',
    { timeout: 60_000 },
    async () => {
      await asUser(USER_C);
      expect(await scalarInt('select count(*)::int as n from public.friendships')).toBe(0);

      await asUser(USER_A);
      expect(await scalarInt('select count(*)::int as n from public.friendships')).toBe(1);
      await asUser(USER_B);
      expect(await scalarInt('select count(*)::int as n from public.friendships')).toBe(1);

      // A (requester) TIDAK boleh mengubah status — policy update hanya addressee.
      await asUser(USER_A);
      const updByA = await db.query(
        `update public.friendships set status = 'accepted'
       where requester_id = $1 and addressee_id = $2`,
        [USER_A, USER_B],
      );
      expect(updByA.affectedRows).toBe(0);

      // B (addressee) satu-satunya yang bisa accept pending → accepted.
      await asUser(USER_B);
      const updByB = await db.query(
        `update public.friendships set status = 'accepted'
       where requester_id = $1 and addressee_id = $2`,
        [USER_A, USER_B],
      );
      expect(updByB.affectedRows).toBe(1);
      expect(
        await one<{ status: string }>(
          'select status from public.friendships where requester_id = $1 and addressee_id = $2',
          [USER_A, USER_B],
        ),
      ).toEqual({ status: 'accepted' });

      // C tidak bisa menghapus relasi orang lain.
      await asUser(USER_C);
      const delByC = await db.query(
        'delete from public.friendships where requester_id = $1 and addressee_id = $2',
        [USER_A, USER_B],
      );
      expect(delByC.affectedRows).toBe(0);
      await asUser(USER_A);
      expect(await scalarInt('select count(*)::int as n from public.friendships')).toBe(1);
    },
  );

  it(
    'guard blokir pertemanan (0007): setelah B memblokir A, request ulang A→B ditolak trigger (P0001)',
    { timeout: 60_000 },
    async () => {
      // B memblokir A — block ini dipakai lagi oleh test RLS blocks berikutnya.
      await asUser(USER_B);
      await db.query('insert into public.blocks (blocker_id, blocked_id) values ($1, $2)', [
        USER_B,
        USER_A,
      ]);

      // Hapus relasi dulu supaya insert ulang tidak menabrak unique pasangan.
      await asUser(USER_A);
      const del = await db.query(
        'delete from public.friendships where requester_id = $1 and addressee_id = $2',
        [USER_A, USER_B],
      );
      expect(del.affectedRows).toBe(1);

      // Trigger SECURITY DEFINER membaca blocks melewati RLS (client tidak
      // bisa) dan menolak permintaan teman dari user yang telah diblokir.
      await expectPgError(
        () =>
          db.query('insert into public.friendships (requester_id, addressee_id) values ($1, $2)', [
            USER_A,
            USER_B,
          ]),
        'P0001',
        'friend request rejected: blocked',
      );
    },
  );

  it(
    'RLS blocks (0008): PRIVAT — A tidak tahu diblokir; hanya blocker yang bisa menulis',
    { timeout: 60_000 },
    async () => {
      // Block B→A dibuat test sebelumnya dan tetap ada.
      await asUser(USER_A);
      expect(await scalarInt('select count(*)::int as n from public.blocks')).toBe(0); // A buta

      await asUser(USER_B);
      expect(await scalarInt('select count(*)::int as n from public.blocks')).toBe(1); // B melihat miliknya

      // A tidak bisa membuat blok atas nama B (pemalsuan blocker_id).
      // blocked_id sengaja C supaya TIDAK menabrak PK — satu-satunya alasan
      // kegagalan harus RLS, bukan duplikat kunci.
      await asUser(USER_A);
      await expectPgError(
        () =>
          db.query('insert into public.blocks (blocker_id, blocked_id) values ($1, $2)', [
            USER_B,
            USER_C,
          ]),
        '42501',
        'violates row-level security',
      );
    },
  );

  it(
    'messages (0009 + 0010): gate pertemanan, privatitas peserta, batas body, guard blokir',
    { timeout: 60_000 },
    async () => {
      // --- Persiapan: pulihkan relasi A↔B (block dari dua test lalu dihapus) ---
      await asUser(USER_B);
      const unblock = await db.query(
        'delete from public.blocks where blocker_id = $1 and blocked_id = $2',
        [USER_B, USER_A],
      );
      expect(unblock.affectedRows).toBe(1);

      await asUser(USER_A);
      await db.query(
        'insert into public.friendships (requester_id, addressee_id) values ($1, $2)',
        [USER_A, USER_B],
      );
      await asUser(USER_B);
      const accept = await db.query(
        `update public.friendships set status = 'accepted'
       where requester_id = $1 and addressee_id = $2`,
        [USER_A, USER_B],
      );
      expect(accept.affectedRows).toBe(1);

      // (a) A→B sebagai teman accepted: boleh kirim.
      await asUser(USER_A);
      await db.query(
        'insert into public.messages (sender_id, recipient_id, body) values ($1, $2, $3)',
        [USER_A, USER_B, 'halo B'],
      );

      // (b) A→C bukan teman: RLS WITH CHECK menolak (gate pertemanan di policy).
      await expectPgError(
        () =>
          db.query(
            'insert into public.messages (sender_id, recipient_id, body) values ($1, $2, $3)',
            [USER_A, USER_C, 'halo C'],
          ),
        '42501',
        'violates row-level security',
      );

      // (c) C memalsukan sender_id = A: ditolak — harus kirim sebagai diri sendiri.
      await asUser(USER_C);
      await expectPgError(
        () =>
          db.query(
            'insert into public.messages (sender_id, recipient_id, body) values ($1, $2, $3)',
            [USER_A, USER_C, 'palsu'],
          ),
        '42501',
        'violates row-level security',
      );

      // (d) C tidak melihat percakapan A↔B; B (peserta) melihat pesan dari A.
      expect(await scalarInt('select count(*)::int as n from public.messages')).toBe(0);
      await asUser(USER_B);
      expect(await scalarInt('select count(*)::int as n from public.messages')).toBe(1);

      // (e) Validasi body: 501 karakter & whitespace-only (btrim → 0) ditolak
      // check constraint — sama dengan validasi Zod di client (dua lapis).
      await asUser(USER_A);
      await expectPgError(
        () =>
          db.query(
            'insert into public.messages (sender_id, recipient_id, body) values ($1, $2, $3)',
            [USER_A, USER_B, 'x'.repeat(501)],
          ),
        '23514',
      );
      await expectPgError(
        () =>
          db.query(
            'insert into public.messages (sender_id, recipient_id, body) values ($1, $2, $3)',
            [USER_A, USER_B, '   '],
          ),
        '23514',
      );

      // (f) B memblokir A lagi → DM A→B ditolak trigger guard. Perhatikan
      // pembagian tugas: relasi masih accepted sehingga gate RLS LOLOS, yang
      // menolak justru trigger SECURITY DEFINER (blocks tak terbaca pengirim).
      await asUser(USER_B);
      await db.query('insert into public.blocks (blocker_id, blocked_id) values ($1, $2)', [
        USER_B,
        USER_A,
      ]);
      await asUser(USER_A);
      await expectPgError(
        () =>
          db.query(
            'insert into public.messages (sender_id, recipient_id, body) values ($1, $2, $3)',
            [USER_A, USER_B, 'masih bisa?'],
          ),
        'P0001',
        'message rejected: blocked',
      );
    },
  );

  it(
    'lockdown kolom is_premium (0011): client ditolak; kolom lain tetap bisa dan trigger updated_at TETAP jalan; superuser bisa',
    { timeout: 60_000 },
    async () => {
      await asUser(USER_A);

      // Column-level privilege: UPDATE is_premium tidak termasuk grant →
      // ditolak sebelum RLS/policy sempat dievaluasi.
      await expectPgError(
        () => db.query('update public.profiles set is_premium = true where id = $1', [USER_A]),
        '42501',
        'permission denied',
      );

      // PERTANYAAN EMPIRIS spec 12-g: apakah trigger updated_at (0001) tetap
      // berjalan ketika grant UPDATE dibatasi per kolom? Jawaban: YA —
      // BEFORE UPDATE trigger dieksekusi untuk baris yang di-update terlepas
      // dari column privileges; trigger menulis NEW.updated_at di dalam
      // plpgsql (bukan lewat SET dari statement user), dan eksekusi trigger
      // tidak tunduk pada column privileges. Jadi updated_at tetap terjaga
      // tanpa memberi user hak menulis kolom apa pun.
      const before = await one<{ ts: number }>(
        'select extract(epoch from updated_at)::float8 as ts from public.profiles where id = $1',
        [USER_A],
      );
      await db.exec('select pg_sleep(0.05);');
      const upd = await db.query(
        "update public.profiles set display_name = 'Nama Baru' where id = $1",
        [USER_A],
      );
      expect(upd.affectedRows).toBe(1);
      const after = await one<{ ts: number }>(
        'select extract(epoch from updated_at)::float8 as ts from public.profiles where id = $1',
        [USER_A],
      );
      expect(after.ts).toBeGreaterThan(before.ts);

      // Sisi server: superuser (analogi service_role — di Supabase asli penulis
      // sah is_premium = service_role via Edge Function paddle-webhook) bebas.
      await asSuperuser();
      const su = await db.query('update public.profiles set is_premium = true where id = $1', [
        USER_A,
      ]);
      expect(su.affectedRows).toBe(1);

      // SELECT tetap table-wide: user lain boleh membaca status premium
      // (dibutuhkan untuk menampilkan badge dsb.).
      await asUser(USER_B);
      expect(
        await one<{ is_premium: boolean }>('select is_premium from public.profiles where id = $1', [
          USER_A,
        ]),
      ).toEqual({ is_premium: true });
    },
  );

  it(
    'storage RLS (0003/0004/0006/0012/0013): tulis folder sendiri saja; baca lintas user di kedua bucket',
    { timeout: 60_000 },
    async () => {
      await asUser(USER_A);

      // voice-snippets: insert hanya ke folder {auth.uid()}/...
      await db.query('insert into storage.objects (bucket_id, name) values ($1, $2)', [
        'voice-snippets',
        `${USER_A}/s1.webm`,
      ]);
      await expectPgError(
        () =>
          db.query('insert into storage.objects (bucket_id, name) values ($1, $2)', [
            'voice-snippets',
            `${USER_B}/s2.webm`,
          ]),
        '42501',
        'violates row-level security',
      );

      // Pelonggaran 0006: SEMUA user authenticated boleh MEMBACA objek di
      // bucket voice-snippets (snippet intro suara memang untuk didengar).
      await asUser(USER_B);
      expect(
        await scalarInt(
          "select count(*)::int as n from storage.objects where bucket_id = 'voice-snippets'",
        ),
      ).toBe(1);

      // soundboard-sounds (0012 + 0013): insert owner-only, select terbuka.
      await asUser(USER_A);
      await db.query('insert into storage.objects (bucket_id, name) values ($1, $2)', [
        'soundboard-sounds',
        `${USER_A}/x.mp3`,
      ]);
      await expectPgError(
        () =>
          db.query('insert into storage.objects (bucket_id, name) values ($1, $2)', [
            'soundboard-sounds',
            `${USER_C}/y.ogg`,
          ]),
        '42501',
        'violates row-level security',
      );
      await asUser(USER_C);
      expect(
        await scalarInt(
          "select count(*)::int as n from storage.objects where bucket_id = 'soundboard-sounds'",
        ),
      ).toBe(1);
    },
  );

  it(
    'trigger updated_at friendships (0007): update status oleh addressee menggeser updated_at',
    { timeout: 60_000 },
    async () => {
      const selectTs = () =>
        one<{ updated: number; created: number }>(
          `select extract(epoch from updated_at)::float8 as updated,
                extract(epoch from created_at)::float8 as created
         from public.friendships where requester_id = $1 and addressee_id = $2`,
          [USER_A, USER_B],
        );
      await asSuperuser();
      const before = await selectTs();
      expect(before.updated).toBeGreaterThanOrEqual(before.created); // saat insert keduanya now() sama
      await db.exec('select pg_sleep(0.05);');

      // Hanya addressee (B) yang bisa update — sudah dibuktikan test RLS di atas.
      await asUser(USER_B);
      const upd = await db.query(
        `update public.friendships set status = 'accepted'
       where requester_id = $1 and addressee_id = $2`,
        [USER_A, USER_B],
      );
      expect(upd.affectedRows).toBe(1);

      await asSuperuser();
      const after = await selectTs();
      expect(after.updated).toBeGreaterThan(before.updated); // maju dari nilai sebelum update
      expect(after.updated).toBeGreaterThan(after.created); // dan terpisah dari waktu insert
    },
  );

  it(
    'idempotensi: SELURUH file migrasi dapat dijalankan ulang tanpa error',
    { timeout: 120_000 },
    async () => {
      // Test ini sengaja ditaruh PALING AKHIR — lihat header file. Spec task
      // meminta pass kedua di beforeAll, tetapi hasil empiris menunjukkan
      // 0006_profile_voice_snippet.sql TIDAK idempoten:
      //   SQLSTATE 42710 — policy "voice_snippets_select_authenticated"
      //   for table "objects" already exists
      // padahal header file itu mengklaim "Idempotent: aman dijalankan ulang".
      // Perbaikannya satu baris DI FILE MIGRASI (bukan di test ini — assertion
      // tidak boleh dicabut demi hijau):
      //   drop policy if exists voice_snippets_select_authenticated
      //     on storage.objects;
      // sebelum `create policy` — pola yang sudah dipakai 0002/0004/0008/0010/0013.
      await asSuperuser();
      for (const file of MIGRATION_FILES) {
        try {
          await db.exec(readMigration(file));
        } catch (err) {
          // Bungkus dengan nama file supaya output vitest langsung menunjuk
          // file migrasi bermasalah — error tidak ditelan.
          throw new Error(`tidak idempoten: ${file} — ${errorMessage(err)}`, {
            cause: err,
          });
        }
      }
    },
  );
});
