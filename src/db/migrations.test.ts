/**
 * Verifikasi migrasi database 0001..0018 pada PostgreSQL ASLI in-process
 * (@electric-sql/pglite, build WASM) — mengubah status migrasi dari
 * "ditulis tapi tak pernah dijalankan" menjadi "terverifikasi eksekusi +
 * semantik keamanan lokal". File ini mengeksekusi seluruh
 * supabase/migrations/*.sql secara berurutan, LALU menguji perilaku
 * RLS / grant kolom / trigger guard secara empiris lewat role switching
 * (SET ROLE authenticated + klaim JWT di GUC sesi). Migrasi 0014/0015 =
 * remedi audit Task 19; 0016/0017 = P0-1 private channel (Task 22-c);
 * 0018 = remedi audit menyeluruh malam 29/30 Sep 2026 (Task 23) — tes
 * regresinya berlabel "audit 0018-*" di bawah.
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
 *   (Pembaruan 29 Sep 2026: 0006 KEMUDIAN diperbaiki — `drop policy if
 *   exists` kini ada di 0006:46-47 sebelum create; catatan ini dipertahankan
 *   sebagai sejarah keputusan penempatan test idempotensi paling akhir.)
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
/** User khusus test regresi audit Task 19 TEMUAN 1 (rantai eskalasi premium). */
const USER_E = '55555555-5555-5555-5555-555555555555';
/** User tambahan untuk test P0-1 (Task 23): kapasitas room + rate-limit join. */
const USER_F = '66666666-6666-6666-6666-666666666666';
const USER_G = '77777777-7777-7777-7777-777777777777';
const USER_H = '88888888-8888-8888-8888-888888888888';
const USER_I = '99999999-9999-9999-9999-999999999999';
const USER_J = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const USER_K = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
const USER_L = 'cccccccc-cccc-cccc-cccc-cccccccccccc';
const USER_M = 'dddddddd-dddd-dddd-dddd-dddddddddddd';
const USER_N = 'eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee';
const USER_O = 'ffffffff-ffff-ffff-ffff-ffffffffffff';
const USER_P = '10101010-1010-1010-1010-101010101010';
const USER_Q = '20202020-2020-2020-2020-202020202020';
const USER_R = '30303030-3030-3030-3030-303030303030';
const USER_S = '40404040-4040-4040-4040-404040404040';
const USER_T = '50505050-5050-5050-5050-505050505050';
const USER_U = '60606060-6060-6060-6060-606060606060';
/** User untuk tes regresi audit malam 29/30 Sep 2026 (0018). */
const USER_V = '70707070-7070-7070-7070-707070707070';
const USER_W = '80808080-8080-8080-8080-808080808080';
const USER_X = '90909090-9090-9090-9090-909090909090';

const MIGRATIONS_DIR = fileURLToPath(new URL('../../supabase/migrations', import.meta.url));

/** File migrasi urut nama (zero-padded 0001..0017 → urut leksikografis = numerik). */
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

  -- STUB P0-1 (Task 23): schema realtime — realtime.messages + realtime.topic().
  -- Meniru semantik platform Supabase: RLS aktif bawaan, grants
  -- SELECT/INSERT untuk role client (migrasi platform resmi sudah
  -- memberikannya — TIDAK boleh ada GRANT di file migrasi 0017), dan
  -- realtime.topic() membaca GUC 'realtime.topic' yang diset server
  -- Realtime saat evaluasi otorisasi. Policy 0017 dibuat di atas stub ini;
  -- di cloud, policy yang sama menempel pada tabel ASLI milik platform.
  create schema realtime;
  create table realtime.messages (
    id bigint,
    topic text not null,
    extension text not null,
    payload jsonb,
    inserted_at timestamptz not null default now()
  );
  alter table realtime.messages enable row level security;
  grant usage on schema realtime to anon, authenticated, service_role;
  grant select, insert on realtime.messages to anon, authenticated, service_role;
  create or replace function realtime.topic() returns text language sql stable as
    $$ select nullif(current_setting('realtime.topic', true), '') $$;
  grant execute on function realtime.topic() to anon, authenticated, service_role;
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

/**
 * Insert user QA tambahan (idempoten — on conflict do nothing). Profil
 * masing-masing dibuat otomatis oleh trigger handle_new_user (0001).
 */
async function seedUsers(ids: string[]): Promise<void> {
  await asSuperuser();
  const values = ids.map((id) => `('${id}', '{}')`).join(', ');
  await db.exec(
    `insert into auth.users (id, raw_user_meta_data) values ${values} on conflict (id) do nothing`,
  );
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

  // 2) Terapkan 0001..0015 BERURUTAN. Error apa pun → seluruh suite gagal
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
  // Higiene sesi: kembali ke superuser + bersihkan klaim JWT + GUC stub
  // (realtime.topic / request.headers — dipakai test P0-1) supaya test
  // berikutnya tidak teracuni konteks user dari test sebelumnya.
  await db.exec('reset role;');
  await db.exec('reset request.jwt.claims;');
  await db.exec(`select set_config('realtime.topic', '', false)`);
  await db.exec(`select set_config('request.headers', '', false)`);
});

afterAll(async () => {
  await db.close();
});

describe('migrasi 0001..0018 pada PGlite (WASM Postgres)', () => {
  it(
    'membaca 18 file migrasi dan membentuk semua objek inti (tabel, kolom, policy, bucket)',
    { timeout: 60_000 },
    async () => {
      expect(MIGRATION_FILES).toHaveLength(18);
      expect(MIGRATION_FILES[0]).toBe('0001_profiles.sql');
      expect(MIGRATION_FILES[13]).toBe('0014_rls_auto_enable_backfill.sql');
      expect(MIGRATION_FILES[14]).toBe('0015_profiles_insert_lockdown.sql');
      expect(MIGRATION_FILES[15]).toBe('0016_room_registry.sql');
      expect(MIGRATION_FILES[16]).toBe('0017_realtime_room_authorization.sql');

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
    'audit Task 19 TEMUAN 2 (0014): ensure_rls otomatis mengaktifkan RLS untuk CREATE TABLE di public',
    { timeout: 60_000 },
    async () => {
      await asSuperuser();

      // Fungsi kanonik ada, SECURITY DEFINER, search_path terkunci —
      // paritas properti yang diverifikasi audit pada versi cloud (blok 10).
      const fn = await one<{ prosecdef: boolean; proconfig: string | null }>(
        `select p.prosecdef, array_to_string(p.proconfig, ',') as proconfig
         from pg_proc p
         join pg_namespace n on n.oid = p.pronamespace
         where n.nspname = 'public' and p.proname = 'rls_auto_enable'`,
      );
      expect(fn.prosecdef).toBe(true);
      expect(fn.proconfig).toContain('search_path=pg_catalog');

      // Event trigger terpasang dan ENABLED ('O' = origin, aktif).
      expect(
        await one<{ evtenabled: string }>(
          `select evtenabled from pg_event_trigger where evtname = 'ensure_rls'`,
        ),
      ).toEqual({ evtenabled: 'O' });

      // Bukti empiris perilaku (bukan sekadar keberadaan objek): tabel baru
      // di skema public otomatis RLS-on tanpa ALTER manual.
      await db.exec('create table public._rls_audit_probe (id int primary key);');
      const probe = await one<{ relrowsecurity: boolean }>(
        `select c.relrowsecurity from pg_class c
         join pg_namespace n on n.oid = c.relnamespace
         where n.nspname = 'public' and c.relname = '_rls_audit_probe'`,
      );
      expect(probe.relrowsecurity).toBe(true);
      await db.exec('drop table public._rls_audit_probe;');

      // Tabel di schema LAIN tidak tersentuh (guard schema_name = 'public').
      await db.exec('create schema if not exists audit_scratch;');
      await db.exec('create table audit_scratch._rls_audit_probe (id int primary key);');
      const outside = await one<{ relrowsecurity: boolean }>(
        `select c.relrowsecurity from pg_class c
         join pg_namespace n on n.oid = c.relnamespace
         where n.nspname = 'audit_scratch' and c.relname = '_rls_audit_probe'`,
      );
      expect(outside.relrowsecurity).toBe(false);
      await db.exec('drop table audit_scratch._rls_audit_probe;');
      await db.exec('drop schema audit_scratch;');
    },
  );

  it(
    'audit Task 19 TEMUAN 1 (0015): rantai eskalasi premium (delete→insert ulang) TERPUTUS di lapisan privilege',
    { timeout: 60_000 },
    async () => {
      // User E dibuat SEKARANG — sekaligus membuktikan provisioning via
      // trigger handle_new_user tetap jalan SETELAH revoke (trigger SECURITY
      // DEFINER berjalan sebagai owner, bukan sebagai role client).
      await asSuperuser();
      await db.exec(`insert into auth.users (id, raw_user_meta_data) values ('${USER_E}', '{}')`);
      expect(
        await one<{ display_name: string }>(
          'select display_name from public.profiles where id = $1',
          [USER_E],
        ),
      ).toEqual({ display_name: `guest_${USER_E.slice(0, 8)}` });

      // Langkah (1) rantai audit: DELETE profil sendiri — MASIH diizinkan
      // (policy profiles_delete_own + grant DELETE 0005 tetap, by design).
      await asUser(USER_E);
      const del = await db.query('delete from public.profiles where id = $1', [USER_E]);
      expect(del.affectedRows).toBe(1);

      // Langkah (2) rantai audit: INSERT ulang dengan is_premium = true —
      // DITOLAK sebelum RLS sempat dievaluasi (revoke level tabel, bukan
      // kolom): inilah penutup jalur eskalasi yang dilaporkan audit.
      await expectPgError(
        () =>
          db.query(
            'insert into public.profiles (id, display_name, is_premium) values ($1, $2, true)',
            [USER_E, 'Hacker'],
          ),
        '42501',
        'permission denied',
      );

      // INSERT polos tanpa is_premium juga tertutup (revoke PENUH untuk
      // role client; policy insert-own sudah dead-code dan di-drop 0015).
      await expectPgError(
        () =>
          db.query('insert into public.profiles (id, display_name) values ($1, $2)', [
            USER_E,
            'Guest',
          ]),
        '42501',
        'permission denied',
      );

      // anon sama-sama tanpa jalur insert (revoke menyasar kedua role client).
      await db.exec('reset role;');
      await db.exec('reset request.jwt.claims;');
      await db.exec('set role anon;');
      await expectPgError(
        () =>
          db.query('insert into public.profiles (id, display_name) values ($1, $2)', [
            USER_E,
            'Anon',
          ]),
        '42501',
        'permission denied',
      );
    },
  );

  // ================================================================
  // P0-1 (Task 23 — hardening 100k): registri room (0016) + otorisasi
  // Realtime (0017). Urutan test SALING BERGANTUNG (akuntansi percobaan
  // join utk rate-limit) — jangan diacak.
  // ================================================================

  it(
    'P0-1 (0016): create_room menerbitkan kode Crockford-32 + host jadi peserta; join_room menormalisasi input',
    { timeout: 60_000 },
    async () => {
      await seedUsers([
        USER_D,
        USER_E,
        USER_F,
        USER_G,
        USER_H,
        USER_I,
        USER_J,
        USER_K,
        USER_L,
        USER_M,
        USER_N,
        USER_O,
        USER_P,
        USER_Q,
        USER_R,
        USER_S,
        USER_T,
        USER_U,
      ]);

      await asUser(USER_A);
      const room1 = await one<{ code: string }>('select public.create_room() as code');
      expect(room1.code).toMatch(/^[0-9A-HJKMNP-TV-Z]{8}$/);

      // Host otomatis tercatat sebagai peserta (tiket otorisasi channel).
      await asSuperuser();
      const host = await one<{ user_id: string }>(
        'select user_id::text as user_id from public.room_participants where room_code = $1',
        [room1.code],
      );
      expect(host.user_id).toBe(USER_A);

      // Kapasitas default 8 (paritas MAX_ROOM_SIZE client) + host tercatat.
      const meta = await one<{ max_participants: number; host_id: string }>(
        'select max_participants, host_id::text as host_id from public.rooms where code = $1',
        [room1.code],
      );
      expect(meta.max_participants).toBe(8);
      expect(meta.host_id).toBe(USER_A);

      // Room kedua = kode BERBEDA (CSPRNG — bukan sekuens).
      await asUser(USER_A);
      const room2 = await one<{ code: string }>('select public.create_room() as code');
      expect(room2.code).not.toBe(room1.code);

      // Join dengan input kotor (lowercase + spasi) → dinormalisasi server
      // menjadi kode yang sama — paritas normalizeRoomCode client.
      await asUser(USER_B);
      await db.query('select public.join_room($1)', [`  ${room1.code.toLowerCase()}  `]);
      await asSuperuser();
      expect(
        await scalarInt('select count(*) as n from public.room_participants where room_code = $1', [
          room1.code,
        ]),
      ).toBe(2); // host + B

      // Format tidak valid → INVALID_ROOM_CODE (tetap tercatat sebagai attempt
      // — kontrak return, bukan raise, supaya catatan commit).
      await asUser(USER_B);
      expect(
        await one<{ join_room: string }>('select public.join_room($1) as join_room', ['pendek']),
      ).toEqual({ join_room: 'INVALID_ROOM_CODE' });
      // Input "ambigu" yang bisa dinormalisasi lolos cek format (bukan berarti room ada).
      expect(
        await one<{ join_room: string }>('select public.join_room($1) as join_room', ['zzzz-99oi']),
      ).toEqual({ join_room: 'ROOM_NOT_FOUND' });
    },
  );

  it(
    'P0-1 (0017): non-peserta DITOLAK baca/tulis realtime.messages; peserta sah lolos (simulasi cek otorisasi server)',
    { timeout: 60_000 },
    async () => {
      // Room pertama milik A dari test sebelumnya.
      await asSuperuser();
      const room = await one<{ code: string }>(
        'select code from public.rooms where host_id = $1 order by created_at limit 1',
        [USER_A],
      );
      const topic = `room:${room.code}`;

      // Baris yang merepresentasikan pesan broadcast yang sedang dicek server
      // Realtime saat otorisasi join/kirim (dibuat superuser = pemilik stub).
      await db.exec(
        `insert into realtime.messages (topic, extension, payload) values ('${topic}', 'broadcast', '{}')`,
      );

      const visibleCount = (): Promise<number> =>
        scalarInt(
          `select count(*) as n from realtime.messages where topic = $1 and extension in ('broadcast', 'presence')`,
          [topic],
        );

      // (1) C belum peserta: baris TIDAK terlihat — inilah "subscribe ditolak".
      await asUser(USER_C);
      await db.exec(`select set_config('realtime.topic', '${topic}', false)`);
      expect(await visibleCount()).toBe(0);
      // Menulis broadcast juga DITOLAK (jalur verifikasi kirim server Realtime).
      await expectPgError(
        () =>
          db.query(
            `insert into realtime.messages (topic, extension, payload) values ($1, 'broadcast', '{}')`,
            [topic],
          ),
        '42501',
        'row-level security',
      );

      // (2) C join → baris terlihat.
      await db.query('select public.join_room($1)', [room.code]);
      expect(await visibleCount()).toBe(1);

      // (3) A (host) boleh menulis broadcast...
      await asUser(USER_A);
      await db.query(
        `insert into realtime.messages (topic, extension, payload) values ($1, 'broadcast', '{}')`,
        [topic],
      );
      // ...tapi extension di luar broadcast/presence DITOLAK (policy ter-scoped).
      await expectPgError(
        () =>
          db.query(
            `insert into realtime.messages (topic, extension, payload) values ($1, 'postgres_changes', '{}')`,
            [topic],
          ),
        '42501',
        'row-level security',
      );

      // (4) Tiket kedaluwarsa → akses hangus (simulasi TTL lewat).
      await asSuperuser();
      await db.exec(
        `update public.room_participants set expires_at = now() - interval '1 minute' where room_code = '${room.code}' and user_id = '${USER_C}'`,
      );
      await asUser(USER_C);
      expect(await visibleCount()).toBe(0);
      expect(
        await one<{ entitled: boolean }>('select public.realtime_room_entitled() as entitled'),
      ).toEqual({ entitled: false });
      await asUser(USER_A);
      expect(
        await one<{ entitled: boolean }>('select public.realtime_room_entitled() as entitled'),
      ).toEqual({ entitled: true });

      // (5) Topic room ORANG LAIN → false walau punya tiket room sendiri
      //     (kode tidak bisa dipakai lintas room).
      await db.exec(`select set_config('realtime.topic', 'room:ZZZZZZ99', false)`);
      expect(
        await one<{ entitled: boolean }>('select public.realtime_room_entitled() as entitled'),
      ).toEqual({ entitled: false });

      // Cleanup stub rows.
      await asSuperuser();
      await db.exec(`delete from realtime.messages where topic = '${topic}'`);
    },
  );

  it(
    'P0-1 (0016): heartbeat memperpanjang tiket hidup; tiket kedaluwarsa TIDAK bangkit; leave menghapus tiket',
    { timeout: 60_000 },
    async () => {
      await asSuperuser();
      const room = await one<{ code: string }>(
        'select code from public.rooms where host_id = $1 order by created_at limit 1',
        [USER_A],
      );

      // B masih peserta dari test pertama. Dekatkan kedaluwarsa lalu heartbeat.
      await db.exec(
        `update public.room_participants set expires_at = now() + interval '5 minutes' where room_code = '${room.code}' and user_id = '${USER_B}'`,
      );
      await db.exec(
        `update public.rooms set expires_at = now() + interval '5 minutes' where code = '${room.code}'`,
      );
      await asUser(USER_B);
      await db.query('select public.heartbeat_room($1)', [room.code]);
      await asSuperuser();
      const part = await one<{ expires_at: string }>(
        'select expires_at from public.room_participants where room_code = $1 and user_id = $2',
        [room.code, USER_B],
      );
      expect(Date.parse(part.expires_at)).toBeGreaterThan(Date.now() + 50 * 60_000);
      const roomRow = await one<{ expires_at: string }>(
        'select expires_at from public.rooms where code = $1',
        [room.code],
      );
      expect(Date.parse(roomRow.expires_at)).toBeGreaterThan(Date.now() + 50 * 60_000);

      // Tiket kedaluwarsa TIDAK boleh "bangkit" lewat heartbeat
      // (harus join_room lagi → kena rate-limit join, by design).
      await db.exec(
        `update public.room_participants set expires_at = now() - interval '1 minute' where room_code = '${room.code}' and user_id = '${USER_B}'`,
      );
      await asUser(USER_B);
      await db.query('select public.heartbeat_room($1)', [room.code]);
      await asSuperuser();
      const dead = await one<{ expires_at: string }>(
        'select expires_at from public.room_participants where room_code = $1 and user_id = $2',
        [room.code, USER_B],
      );
      expect(Date.parse(dead.expires_at)).toBeLessThan(Date.now());

      // Rejoin sah lalu leave bersih → tiket hilang.
      await asUser(USER_B);
      await db.query('select public.join_room($1)', [room.code]);
      await db.query('select public.leave_room($1)', [room.code]);
      await asSuperuser();
      expect(
        await scalarInt(
          'select count(*) as n from public.room_participants where room_code = $1 and user_id = $2',
          [room.code, USER_B],
        ),
      ).toBe(0);
    },
  );

  it(
    'P0-1 (0016): kapasitas room max 8 → join ke-9 DITOLAK ROOM_FULL di database',
    { timeout: 60_000 },
    async () => {
      await asUser(USER_A);
      const room = await one<{ code: string }>('select public.create_room() as code');

      // 7 joiner (B..H) + host A = 8 penuh.
      for (const user of [USER_B, USER_C, USER_D, USER_E, USER_F, USER_G, USER_H]) {
        await asUser(user);
        expect(
          await one<{ join_room: string }>('select public.join_room($1) as join_room', [room.code]),
        ).toEqual({ join_room: 'OK' });
      }

      await asUser(USER_I);
      expect(
        await one<{ join_room: string }>('select public.join_room($1) as join_room', [room.code]),
      ).toEqual({ join_room: 'ROOM_FULL' });
    },
  );

  it(
    'P0-1 (0016): rate-limit join server-side — per-user 10/menit lalu per-IP 100/menit (elemen TERAKHIR XFF)',
    { timeout: 180_000 },
    async () => {
      const attempt = (code: string): Promise<string> =>
        one<{ join_room: string }>('select public.join_room($1) as join_room', [code]).then(
          (row) => row.join_room,
        );

      // Per-user: 10 percobaan tercatat (room tak ada — tetap dihitung),
      // percobaan 11 & 12 DITOLAK RATE_LIMITED.
      await asUser(USER_J);
      const jSequence: string[] = [];
      for (let i = 0; i < 12; i += 1) {
        jSequence.push(await attempt('ZZZZZZ99'));
      }
      expect(jSequence.slice(0, 10)).toEqual(Array<string>(10).fill('ROOM_NOT_FOUND'));
      expect(jSequence.slice(10)).toEqual(['RATE_LIMITED', 'RATE_LIMITED']);
      await asSuperuser();
      expect(
        await scalarInt('select count(*) as n from public.room_join_attempts where user_id = $1', [
          USER_J,
        ]),
      ).toBe(10); // yang DITOLAK tidak tercatat ulang — tepat 10.

      // Per-IP: 10 user segar × 10 percobaan dari SATU IP. Elemen awal XFF
      // dipalsukan ('203.0.113.7') — IP yang dihitung harus elemen TERAKHIR.
      await db.exec(
        `select set_config('request.headers', '{"x-forwarded-for":"203.0.113.7, 198.51.100.9"}', false)`,
      );
      const batch = [
        USER_K,
        USER_L,
        USER_M,
        USER_N,
        USER_O,
        USER_P,
        USER_Q,
        USER_R,
        USER_S,
        USER_T,
      ];
      for (const user of batch) {
        await asUser(user);
        for (let i = 0; i < 10; i += 1) {
          expect(await attempt('ZZZZZZ99')).toBe('ROOM_NOT_FOUND');
        }
      }
      // Percobaan ke-101 dari IP yang sama → RATE_LIMITED walau user segar
      // (0 percobaan sendiri) — inilah belts-and-suspenders anti rotasi akun.
      await asUser(USER_U);
      expect(await attempt('ZZZZZZ99')).toBe('RATE_LIMITED');
      await asSuperuser();
      expect(
        await scalarInt('select count(*) as n from public.room_join_attempts where ip = $1', [
          '198.51.100.9',
        ]),
      ).toBe(100);
    },
  );

  it(
    'audit 0018-1 (HIGH-1): friendships UPDATE dikunci kolom — pemalsuan requester_id DITOLAK, accept status tetap jalan',
    { timeout: 60_000 },
    async () => {
      await seedUsers([USER_V, USER_W, USER_X]);
      // V meminta pertemanan ke W (jalur sah: INSERT oleh requester).
      await asUser(USER_V);
      await db.query(
        'insert into public.friendships (requester_id, addressee_id, status) values ($1, $2, $3)',
        [USER_V, USER_W, 'pending'],
      );

      // Eksploit audit 23-a HIGH-1: W (addressee) memalsukan requester_id
      // + status dalam satu statement → gate DM 0010 akan terbuka.
      await asUser(USER_W);
      await expectPgError(
        () =>
          db.query(
            "update public.friendships set requester_id = $1, status = 'accepted' where addressee_id = $2",
            [USER_X, USER_W],
          ),
        '42501',
        'permission denied',
      );
      await expectPgError(
        () =>
          db.query('update public.friendships set requester_id = $1 where addressee_id = $2', [
            USER_X,
            USER_W,
          ]),
        '42501',
        'permission denied',
      );
      await expectPgError(
        () =>
          db.query('update public.friendships set addressee_id = $1 where addressee_id = $2', [
            USER_X,
            USER_W,
          ]),
        '42501',
        'permission denied',
      );

      // Jalur sah tetap hidup: W menerima (UPDATE kolom status saja).
      const accept = await db.query(
        "update public.friendships set status = 'accepted' where addressee_id = $1 and status = 'pending'",
        [USER_W],
      );
      expect(accept.affectedRows).toBe(1);

      // Baris TIDAK sempat dipalsukan: pasangan tetap V↔W accepted.
      expect(
        await one<{ requester: string; status: string }>(
          'select requester_id::text as requester, status from public.friendships where requester_id = $1 and addressee_id = $2',
          [USER_V, USER_W],
        ),
      ).toEqual({ requester: USER_V, status: 'accepted' });

      // Analogi service_role (superuser) tetap bebas kolom penuh.
      await asSuperuser();
      const su = await db.query(
        'update public.friendships set status = $1 where requester_id = $2 and addressee_id = $3',
        ['pending', USER_V, USER_W],
      );
      expect(su.affectedRows).toBe(1);
      await db.query(
        'update public.friendships set status = $1 where requester_id = $2 and addressee_id = $3',
        ['accepted', USER_V, USER_W],
      );
    },
  );

  it(
    'audit 0018-2 (MEDIUM-1): rejoin peserta hidup di room penuh → OK (slot sendiri tidak mengunci); user baru tetap ROOM_FULL',
    { timeout: 60_000 },
    async () => {
      await seedUsers([USER_V, USER_W, USER_X]);
      // Room kapasitas 2 dibuat langsung sebagai superuser (bypass create_room
      // yang mematok 8) supaya kondisi "penuh termasuk tiket sendiri" presisi.
      await asSuperuser();
      await db.query(
        "insert into public.rooms (code, host_id, expires_at, max_participants) values ('AB234567', $1, now() + interval '1 hour', 2)",
        [USER_V],
      );
      await db.query(
        "insert into public.room_participants (room_code, user_id, expires_at) values ('AB234567', $1, now() + interval '1 hour')",
        [USER_V],
      );

      // W join (input kotor — juga menguji normalisasi) → OK. Room kini 2/2.
      await asUser(USER_W);
      expect(
        await one<{ join_room: string }>('select public.join_room($1) as join_room', ['ab234567']),
      ).toEqual({ join_room: 'OK' });

      // REGRESI audit: V rejoin saat room penuh — sebelum 0018 ini ROOM_FULL
      // (tiket V sendiri ikut terhitung di v_live); kini OK + tiket diperpanjang.
      await asUser(USER_V);
      expect(
        await one<{ join_room: string }>('select public.join_room($1) as join_room', ['AB234567']),
      ).toEqual({ join_room: 'OK' });

      // User baru X tetap ditolak — kapasitas terjaga (others V+W = 2 >= 2).
      await asUser(USER_X);
      expect(
        await one<{ join_room: string }>('select public.join_room($1) as join_room', ['AB234567']),
      ).toEqual({ join_room: 'ROOM_FULL' });
    },
  );

  it(
    'audit 0018-3 (LOW-1): helper internal 0016 tidak bisa dieksekusi authenticated; RPC publik tetap ter-grant',
    { timeout: 60_000 },
    async () => {
      await asUser(USER_V);
      await expectPgError(
        () => db.query("select public.normalize_room_code(' abc ')"),
        '42501',
        'permission denied',
      );
      await expectPgError(
        () => db.query('select public.request_client_ip()'),
        '42501',
        'permission denied',
      );
      await expectPgError(
        () => db.query('select public.generate_room_code()'),
        '42501',
        'permission denied',
      );

      // Bukti matriks dari sisi superuser: 3 helper = false, RPC = true.
      await asSuperuser();
      for (const fn of [
        'normalize_room_code(text)',
        'request_client_ip()',
        'generate_room_code()',
      ]) {
        expect(
          await one<{ p: boolean }>(
            `select has_function_privilege('authenticated', 'public.${fn}', 'execute') as p`,
          ),
        ).toEqual({ p: false });
      }
      expect(
        await one<{ p: boolean }>(
          "select has_function_privilege('authenticated', 'public.join_room(text)', 'execute') as p",
        ),
      ).toEqual({ p: true });
    },
  );

  it(
    'audit 0018-4 (LOW-3): voice_snippet_path wajib folder milik sendiri — spoofing lintas user DITOLAK trigger',
    { timeout: 60_000 },
    async () => {
      await seedUsers([USER_V, USER_W]);
      await asUser(USER_V);
      // Menunjuk snippet milik W → ditolak trigger (P0001).
      await expectPgError(
        () =>
          db.query('update public.profiles set voice_snippet_path = $1 where id = $2', [
            `${USER_W}/intro.webm`,
            USER_V,
          ]),
        'P0001',
        'folder milik sendiri',
      );
      // Folder sendiri → lolos (constraint format 0006 juga puas).
      const own = await db.query(
        'update public.profiles set voice_snippet_path = $1 where id = $2',
        [`${USER_V}/intro.webm`, USER_V],
      );
      expect(own.affectedRows).toBe(1);
      // Mengosongkan → lolos.
      const clear = await db.query(
        'update public.profiles set voice_snippet_path = null where id = $1',
        [USER_V],
      );
      expect(clear.affectedRows).toBe(1);

      // Analogi koneksi service (tanpa klaim user) → bebas, tooling admin
      // tidak terkunci (auth.uid() null → guard dilewati by design).
      // Catatan PGlite: `reset request.jwt.claims` meninggalkan string kosong
      // yang membuat ''::jsonb di auth.uid() MELEMPAR — pakai objek JSON kosong
      // untuk mensimulasikan "JWT tanpa sub" (semantik yang sama dengan null).
      await asSuperuser();
      await db.exec("select set_config('request.jwt.claims', '{}', false);");
      const su = await db.query(
        'update public.profiles set voice_snippet_path = $1 where id = $2',
        [`${USER_W}/admin.webm`, USER_W],
      );
      expect(su.affectedRows).toBe(1);
      await db.query('update public.profiles set voice_snippet_path = null where id = $1', [
        USER_W,
      ]);
    },
  );

  it(
    'P0-1 (0016): matriks RLS/privilege — rooms & attempts buta untuk klien; participants hanya baris sendiri; anon tanpa execute',
    { timeout: 60_000 },
    async () => {
      await asUser(USER_B);
      await expectPgError(
        () => db.query('select count(*) from public.rooms'),
        '42501',
        'permission denied',
      );
      await expectPgError(
        () => db.query('select count(*) from public.room_join_attempts'),
        '42501',
        'permission denied',
      );
      await expectPgError(
        () =>
          db.query(
            "insert into public.room_participants (room_code, user_id, expires_at) values ('ZZZZZZ99', $1, now())",
            [USER_B],
          ),
        '42501',
        'permission denied',
      );
      await expectPgError(
        () =>
          db.query(
            "insert into public.rooms (code, host_id, expires_at) values ('ZZZZZZ99', $1, now())",
            [USER_B],
          ),
        '42501',
        'permission denied',
      );

      // participants: SELECT diizinkan tapi HANYA baris milik sendiri
      // (B hanya tercatat di room kapasitas dari test sebelumnya).
      const own = await db.query<{ room_code: string; user_id: string }>(
        'select room_code, user_id::text as user_id from public.room_participants',
      );
      expect(own.rows).toHaveLength(1);
      expect(own.rows[0]?.user_id).toBe(USER_B);

      // anon tidak punya execute RPC (revoke) — gerbang registry tertutup rapat.
      await asSuperuser();
      await db.exec('reset request.jwt.claims;');
      await db.exec('set role anon;');
      await expectPgError(
        () => db.query('select public.join_room($1)', ['ZZZZZZ99']),
        '42501',
        'permission denied',
      );
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
