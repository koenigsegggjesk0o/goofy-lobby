-- ============================================================================
-- 0016_room_registry.sql — P0-1 hardening: tutup kebocoran IP via channel
-- signaling publik (bagian 1 dari 2 — registri room server-side; kebijakan
-- otorisasi Realtime ada di 0017).
--
-- ANCAMAN YANG DITUTUP:
--   Sebelumnya channel `room:{kode}` PUBLIK: siapa pun yang mengetahui atau
--   menebak kode (dulu cukup 4 karakter, 36^4 ≈ 1,68 juta kemungkinan —
--   sekejap di-brute-force) bisa subscribe dan membaca broadcast SDP/ICE
--   candidate yang menyertakan ALAMAT IP semua peserta room, plus presence
--   (roster), tanpa pernah menjadi peserta sah. Ini vektor doxxing.
--
-- DESAIN (verifikasi docs resmi Supabase "Realtime Authorization" — lihat
-- worklog Task 22-b untuk kutipan verbatim + URL):
--   rooms              — registri room: kode (PK), host, TTL, kapasitas.
--                        Role client TANPA grant sama sekali (0005/default
--                        privileges memberi ALL utk tabel public baru —
--                        dicabut eksplisit) + RLS tanpa policy → tabel ini
--                        tak terlihat dan tak bisa ditulis klien. Room hanya
--                        lahir lewat create_room() (SECURITY DEFINER).
--   room_participants  — kepesertaan (PK room_code+user_id) + TTL. Penulis
--                        satu-satunya = RPC SECURITY DEFINER di bawah. Klien
--                        boleh SELECT baris MILIKNYA SENDIRI (policy) —
--                        kebutuhan UI "room aku sekarang"; baris orang lain
--                        tak terlihat. Ini TIDAK duplikasi konsep profiles/
--                        friendships: itu relasi identitas/pertemanan
--                        persisten; room_participants = tiket sesi EFEMER
--                        (TTL 1 jam, heartbeat 15 menit).
--   room_join_attempts — catatan PERCOBAAN join (termasuk yang gagal —
--                        inti anti-brute-force). Hanya server yang baca.
--
-- KODE ROOM — ruang kemungkinan (spesifikasi P0-1: min 8 karakter, alfabet
-- tanpa karakter ambigu O/0, I/1/l):
--   Alfabet 32 simbol (Crockford base-32): 0-9 + A-Z tanpa I, L, O, U.
--   32^8 = 2^40 = 1.099.511.627.776 (≈ 1,1 triliun) kombinasi.
--   Rate-limit join 10 percobaan/user/menit → enumerasi penuh per akun
--   ≈ 2^40 / 10 / 60 / 24 / 365 ≈ 208 juta tahun. Kode lama (36^4) bisa
--   ditemukan dalam ~12 hari pada laju yang sama.
--   Kode diterbitkan dari gen_random_uuid() (CSPRNG inti Postgres,
--   pg_catalog — tanpa dependensi ekstensi). Pemetaan byte→simbol:
--   256 % 32 = 0 → modulo TANPA bias (uniform sempurna).
--
-- NORMALISASI INPUT (server dan client memakai aturan IDENTIK — lihat
-- normalizeRoomCode di src/webrtc/types.ts):
--   uppercase → buang non-alfanumerik → O→0, I→1, L→1 → cocokkan pola
--   ^[0-9A-HJKMNP-TV-Z]{8}$. Memaafkan salah baca karakter ambigu saat user
--   mengetik/membacakan kode.
--
-- RATE LIMIT JOIN (server-side di Postgres — klien tidak bisa membongkar):
--   - per USER : 10 percobaan / menit — menghitung SEMUA percobaan (kode
--     salah format maupun room tidak ada): yang dibatasi adalah orakel
--     penebakan, bukan hanya join sukses.
--   - per IP   : 100 percobaan / menit (belts-and-suspenders utk rotasi
--     akun). IP diambil dari elemen TERAKHIR X-Forwarded-For — satu-satunya
--     yang ditambahkan oleh edge Supabase sendiri; elemen awal daftar bisa
--     dipalsukan klien. Header tak ada/tak terbaca → 'unknown' → cek IP
--     dilewati (limit per-user tetap jalan) — NAT kantor/sekolah tidak
--     salah-positif oleh kesalahan parsing.
--   - create   : 5 room / 10 menit per user (anti spam registri).
--   Catatan: cek count-then-insert punya race kecil antar-tab/akun yang
--   sama (overshoot 1-2 percobaan) — diterima; memakai advisory lock utk
--   presisi matematis tidak sebanding dengan ancamannya.
--
-- KONTRAK ERROR = NILAI RETURN, BUKAN raise exception (keputusan desain
-- penting): pencatatan percobaan join WAJIB bertahan melewati penolakan —
-- kalau join_room melempar exception SETELAH insert attempt, seluruh
-- transaksi (termasuk catatan itu) ROLLBACK dan brute-force tidak pernah
-- terhitung. Postgres tanpa dblink tidak punya autonomous transaction,
-- maka kegagalan yang harus di-akuntansi-kan dikembalikan sebagai NILAI
-- ('RATE_LIMITED', 'ROOM_NOT_FOUND', dst) supaya insert attempt COMMIT.
-- NOT_AUTHENTICATED tetap raise (tak terjangkau via PostgREST — 401 di
-- gerbang; murni pertahanan panggilan SQL langsung).
--
-- TTL & HEARTBEAT: room + kepesertaan hidup 1 jam, diperpanjang
-- heartbeat_room() (klien memanggil tiap 15 menit — src/webrtc/room-gate.ts).
-- Otorisasi Realtime di-CACHE seumur koneksi (docs resmi) → TTL hanya
-- menggerbangi JOIN BARU / REJOIN; peserta yang masih tersambung tidak
-- diputus oleh kedaluwarsa baris (perilaku platform).
--
-- Idempotent: aman dijalankan ulang.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- (1) Tabel
-- ---------------------------------------------------------------------------

create table if not exists public.rooms (
  code            text primary key check (code ~ '^[0-9A-HJKMNP-TV-Z]{8}$'),
  host_id         uuid not null references auth.users (id) on delete cascade,
  created_at      timestamptz not null default now(),
  expires_at      timestamptz not null,
  max_participants int not null default 8 check (max_participants between 2 and 16)
);

comment on table public.rooms is
  'P0-1 — registri room server-side; kode Crockford-32 8 karakter (2^40 ruang kode); role client tanpa akses (hanya via RPC SECURITY DEFINER).';

create table if not exists public.room_participants (
  room_code  text not null references public.rooms (code) on delete cascade,
  user_id    uuid not null references auth.users (id) on delete cascade,
  joined_at  timestamptz not null default now(),
  expires_at timestamptz not null,
  primary key (room_code, user_id)
);

comment on table public.room_participants is
  'P0-1 — tiket kepesertaan room (efemeral, TTL 1 jam + heartbeat); penulis sah hanya RPC SECURITY DEFINER; klien bisa SELECT baris miliknya sendiri.';

create table if not exists public.room_join_attempts (
  id         bigint generated always as identity primary key,
  user_id    uuid not null references auth.users (id) on delete cascade,
  code_attempted text not null,
  ip         text not null default 'unknown',
  attempted_at timestamptz not null default now()
);

comment on table public.room_join_attempts is
  'P0-1 — catatan PERCOBAAN join (termasuk gagal) untuk rate-limit server-side; hanya dibaca RPC, tanpa akses klien.';

create index if not exists rooms_expiry_idx on public.rooms (expires_at);
create index if not exists rooms_host_created_idx on public.rooms (host_id, created_at desc);
-- Jalur panas otorisasi Realtime (0017): per join dieksekusi 1x —
-- "where user_id = ? and expires_at > now()" butuh indeks user-first.
create index if not exists room_participants_user_expiry_idx
  on public.room_participants (user_id, expires_at);
create index if not exists room_join_attempts_user_time_idx
  on public.room_join_attempts (user_id, attempted_at desc);
create index if not exists room_join_attempts_ip_time_idx
  on public.room_join_attempts (ip, attempted_at desc);

-- ---------------------------------------------------------------------------
-- (2) RLS + privilege lockdown
--     (event trigger ensure_rls dari 0014 sudah meng-RLS tabel baru di
--     cloud; alter eksplisit di bawah idempoten + menjaga rebuild manual)
-- ---------------------------------------------------------------------------

alter table public.rooms enable row level security;
alter table public.room_participants enable row level security;
alter table public.room_join_attempts enable row level security;

-- 0005 (grant all) + default privileges memberi ALL pada tabel public baru
-- ke role client — dicabut eksplisit untuk tiga tabel ini.
revoke all on table public.rooms from anon, authenticated;
revoke all on table public.room_join_attempts from anon, authenticated;
revoke all on table public.room_participants from anon, authenticated;
grant select on table public.room_participants to authenticated;

drop policy if exists room_participants_select_own on public.room_participants;
create policy room_participants_select_own
  on public.room_participants
  for select
  to authenticated
  using (user_id = auth.uid());

-- ---------------------------------------------------------------------------
-- (3) Helper internal (tanpa grant ke role client — hanya dipakai lewat
--     SECURITY DEFINER di bawah; fungsi baru default EXECUTE ke PUBLIC di
--     Postgres murni → dicabut)
-- ---------------------------------------------------------------------------

create or replace function public.normalize_room_code(p_code text)
returns text
language sql
immutable
strict
set search_path = public, pg_catalog
as $$
  select translate(
    upper(regexp_replace(p_code, '[^0-9A-Za-z]', '', 'g')),
    'OIL',
    '011'
  );
$$;

create or replace function public.request_client_ip()
returns text
language plpgsql
stable
set search_path = public, pg_catalog
as $$
declare
  headers json;
  xff text;
  parts text[];
begin
  begin
    headers := nullif(current_setting('request.headers', true), '')::json;
  exception when others then
    return 'unknown'; -- header GUC rusak/terlalu besar — jangan gagalkan join
  end;
  xff := headers ->> 'x-forwarded-for';
  if xff is null or btrim(xff) = '' then
    return 'unknown';
  end if;
  -- Elemen TERAKIRI XFF = yang ditambahkan edge Supabase (IP klien nyata);
  -- elemen awal bisa dipalsukan klien (append standar gateway).
  parts := regexp_split_to_array(xff, ',');
  return btrim(parts[array_length(parts, 1)]);
end;
$$;

create or replace function public.generate_room_code()
returns text
language plpgsql
set search_path = public, pg_catalog
as $$
declare
  b bytea;
  symbols constant text := '0123456789ABCDEFGHJKMNPQRSTVWXYZ'; -- 32 simbol, tanpa I/L/O/U
  code text := '';
  i int;
begin
  -- 16 hex char pertama gen_random_uuid() (setelah dash dibuang) = 8 byte
  -- dari CSPRNG inti Postgres. 8 simbol × 5 bit = 2^40 ≈ 1,1 triliun
  -- kemungkinan. byte % 32 uniform (256 % 32 = 0) — tanpa modulo bias.
  b := pg_catalog.decode(
    substr(pg_catalog.replace(pg_catalog.gen_random_uuid()::text, '-', ''), 1, 16),
    'hex'
  );
  for i in 0 .. 7 loop
    code := code || substr(symbols, 1 + (pg_catalog.get_byte(b, i) % 32), 1);
  end loop;
  return code;
end;
$$;

revoke execute on function public.normalize_room_code(text) from public, anon;
revoke execute on function public.request_client_ip() from public, anon;
revoke execute on function public.generate_room_code() from public, anon;

-- ---------------------------------------------------------------------------
-- (4) Helper otorisasi Realtime (dipakai policy 0017; dievaluasi sebagai
--     role authenticated → butuh EXECUTE utk authenticated).
--     SECURITY DEFINER: pemilik (postgres) melewati RLS room_participants
--     supaya policy bisa melihat SEMUA baris lalu memfilter user_id =
--     auth.uid() sendiri. Dipanggil langsung di luar konteks Realtime →
--     realtime.topic() NULL → selalu false (tidak jadi orakel).
-- ---------------------------------------------------------------------------

create or replace function public.realtime_room_entitled()
returns boolean
language sql
stable
security definer
set search_path = public, pg_catalog
as $$
  select exists (
    select 1 from public.room_participants rp
    where rp.user_id = (select auth.uid())
      and rp.expires_at > now()
      and ('room:' || rp.room_code) = (select realtime.topic())
  )
$$;

revoke execute on function public.realtime_room_entitled() from public, anon;
grant execute on function public.realtime_room_entitled() to authenticated;

-- ---------------------------------------------------------------------------
-- (5) RPC siklus hidup room (semua SECURITY DEFINER + search_path terkunci
--     + cek auth.uid() eksplisit). Kontrak error: create_room/join_room
--     MENGEMBALIKAN token (bukan raise) supaya pencatatan attempt commit —
--     lihat blok komentar KONTRAK ERROR di header. Client memetakan token:
--     src/webrtc/room-gate.ts.
-- ---------------------------------------------------------------------------

create or replace function public.create_room()
returns text
language plpgsql
security definer
set search_path = public, pg_catalog
as $$
declare
  v_uid uuid := auth.uid();
  v_code text;
  v_candidate text;
  v_recent_rooms int;
  i int;
begin
  if v_uid is null then
    raise exception 'NOT_AUTHENTICATED';
  end if;

  -- Anti-spam registri: max 5 room baru / 10 menit per user.
  select count(*) into v_recent_rooms
  from public.rooms
  where host_id = v_uid and created_at > now() - interval '10 minutes';
  if v_recent_rooms >= 5 then
    return 'ROOM_CREATE_LIMIT';
  end if;

  -- Pembersihan oportunis (frekuensi = pembuatan room, human-scale):
  -- room kedaluwarsa > 1 hari (cascade participants), sisa participants,
  -- attempt > 2 jam. Kebenaran TIDAK bergantung pada pembersihan ini
  -- (semua query memakai predikat kedaluwarsa).
  delete from public.rooms where expires_at <= now() - interval '1 day';
  delete from public.room_participants where expires_at <= now() - interval '1 day';
  delete from public.room_join_attempts where attempted_at <= now() - interval '2 hours';

  -- Terbitkan kode unik (retry anti-kolisi; ON CONFLICT DO NOTHING).
  v_code := null;
  for i in 1 .. 8 loop
    v_candidate := public.generate_room_code();
    insert into public.rooms (code, host_id, expires_at, max_participants)
    values (v_candidate, v_uid, now() + interval '1 hour', 8)
    on conflict (code) do nothing
    returning code into v_code;
    exit when v_code is not null;
  end loop;
  if v_code is null then
    raise exception 'room code issuance failed (8 kolisi berturut — tidak normal, laporkan)';
  end if;

  -- Host langsung tercatat sebagai peserta (tiket otorisasi channel).
  insert into public.room_participants (room_code, user_id, expires_at)
  values (v_code, v_uid, now() + interval '1 hour')
  on conflict (room_code, user_id)
  do update set expires_at = now() + interval '1 hour';

  return v_code;
end;
$$;

create or replace function public.join_room(p_code text)
returns text
language plpgsql
security definer
set search_path = public, pg_catalog
as $$
declare
  v_uid uuid := auth.uid();
  v_code text;
  v_ip text;
  v_user_attempts int;
  v_ip_attempts int;
  v_cap int;
  v_live int;
begin
  if v_uid is null then
    raise exception 'NOT_AUTHENTICATED';
  end if;

  v_code := public.normalize_room_code(p_code);
  v_ip := public.request_client_ip();

  -- RATE LIMIT dulu (sebelum validasi apa pun): semua percobaan dihitung,
  -- termasuk yang akan gagal format/eksistensi — membatasi orakel tebakan.
  select count(*) into v_user_attempts
  from public.room_join_attempts
  where user_id = v_uid and attempted_at > now() - interval '1 minute';
  if v_user_attempts >= 10 then
    return 'RATE_LIMITED';
  end if;
  if v_ip <> 'unknown' then
    select count(*) into v_ip_attempts
    from public.room_join_attempts
    where ip = v_ip and attempted_at > now() - interval '1 minute';
    if v_ip_attempts >= 100 then
      return 'RATE_LIMITED';
    end if;
  end if;

  -- Catat attempt SEBELUM validasi — dan karena kegagalan berikutnya
  -- berupa RETURN (bukan raise), catatan ini COMMIT walau join ditolak.
  insert into public.room_join_attempts (user_id, code_attempted, ip)
  values (v_uid, left(coalesce(p_code, ''), 32), v_ip);

  -- Validasi format (setelah attempt tercatat — tebakan format tidak gratis).
  if v_code !~ '^[0-9A-HJKMNP-TV-Z]{8}$' then
    return 'INVALID_ROOM_CODE';
  end if;

  -- Room harus ada & hidup; sekaligus baca kapasitas + jumlah peserta hidup.
  select r.max_participants,
         (select count(*) from public.room_participants p
          where p.room_code = r.code and p.expires_at > now())
    into v_cap, v_live
  from public.rooms r
  where r.code = v_code and r.expires_at > now();
  if v_cap is null then
    return 'ROOM_NOT_FOUND';
  end if;
  if v_live >= v_cap then
    return 'ROOM_FULL';
  end if;

  -- Tiket kepesertaan (rejoin memperpanjang).
  insert into public.room_participants (room_code, user_id, expires_at)
  values (v_code, v_uid, now() + interval '1 hour')
  on conflict (room_code, user_id)
  do update set expires_at = now() + interval '1 hour';

  return 'OK';
end;
$$;

create or replace function public.heartbeat_room(p_code text)
returns void
language plpgsql
security definer
set search_path = public, pg_catalog
as $$
declare
  v_uid uuid := auth.uid();
  v_code text;
begin
  if v_uid is null then
    raise exception 'NOT_AUTHENTICATED';
  end if;
  v_code := public.normalize_room_code(p_code);

  -- Perpanjang tiket sendiri — HANYA bila masih hidup; peserta kedaluwarsa
  -- TIDAK boleh "bangkit" via heartbeat (harus join_room lagi → kena
  -- rate-limit join, by design).
  update public.room_participants
  set expires_at = now() + interval '1 hour'
  where room_code = v_code and user_id = v_uid and expires_at > now();

  -- Room diperpanjang oleh heartbeat peserta HIDUP mana pun (host tidak
  -- istimewa — mesh ini peer-simetris): room hidup selama ada yang aktif.
  update public.rooms
  set expires_at = now() + interval '1 hour'
  where code = v_code
    and exists (
      select 1 from public.room_participants p
      where p.room_code = v_code and p.user_id = v_uid and p.expires_at > now()
    );
end;
$$;

create or replace function public.leave_room(p_code text)
returns void
language plpgsql
security definer
set search_path = public, pg_catalog
as $$
declare
  v_uid uuid := auth.uid();
  v_code text;
begin
  if v_uid is null then
    raise exception 'NOT_AUTHENTICATED';
  end if;
  v_code := public.normalize_room_code(p_code);
  delete from public.room_participants
  where room_code = v_code and user_id = v_uid;
end;
$$;

revoke execute on function public.create_room() from public, anon;
revoke execute on function public.join_room(text) from public, anon;
revoke execute on function public.heartbeat_room(text) from public, anon;
revoke execute on function public.leave_room(text) from public, anon;
grant execute on function public.create_room() to authenticated;
grant execute on function public.join_room(text) to authenticated;
grant execute on function public.heartbeat_room(text) to authenticated;
grant execute on function public.leave_room(text) to authenticated;
