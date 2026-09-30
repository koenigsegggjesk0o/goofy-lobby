-- ============================================================================
-- 0019_rate_limits_and_room_guards.sql — remedi audit keamanan Task 25
-- (temuan 25-b domain data layer + peta rate-limit 25-c). Enam perbaikan,
-- semuanya idempoten (aman dijalankan ulang):
--
--   a. [25-c HIGH-1 parsial / backlog B3] RATE LIMIT PESAN server-side:
--      20 pesan / 10 detik per pengirim — trigger BEFORE INSERT pada
--      public.messages. Sebelumnya satu-satunya batas ada di CLIENT
--      (SlidingWindowRateLimiter 10/30s di MessageService) — tab ganda /
--      klien dimodifikasi / skrip menulis ke Postgres tanpa batas apa pun.
--      (Bagian HIGH-1 yang sebenarnya — flood broadcast Realtime — tidak
--      bisa dibatasi di level DB; lihat catatan 0017.)
--   b. [25-c MEDIUM "friendship pending-row spam"] RATE LIMIT FRIENDSHIP
--      REQUEST: 10 request / jam per requester — trigger BEFORE INSERT pada
--      public.friendships. Menutup spam baris pending (satu baris per target
--      × jumlah target tak terbatas).
--   c. [25-b LOW] TRANSITION GUARD friendship: downgrade accepted → pending
--      DITOLAK. Policy 0008 (UPDATE addressee-only) + column-grant 0018
--      (hanya kolom status) masih membiarkan addressee menurunkan relasi
--      yang sudah accepted kembali menjadi permintaan pending.
--   d. [25-b MEDIUM M4 sisi data] join_room menolak caller yang diblokir
--      PEMILIK room → exception 'BLOCKED_FROM_ROOM'. Sebelumnya blokir
--      tidak ditegakkan di lapisan room sama sekali (audit 25-b: grep
--      'block' src/webrtc = 0 hit; join_room 0016/0018 tanpa cek blokir).
--      Hanya arah owner-blocks-joiner — block joiner→owner TIDAK menolak
--      (mesh peer-simetris; keputusan remediasi).
--   e. [23-c LOW-5] PURGE room_join_attempts saat INSERT: baris (termasuk
--      IP) berumur > 2 jam dihapus trigger BEFORE INSERT. Sebelumnya purge
--      2 jam hanya oportunis di create_room (0016:297) — sepanjang periode
--      tanpa room baru, retensi IP melebihi 2 jam. Purge oportunis lama
--      TETAP dipertahankan.
--   f. [25-b INFO] GUARD BLOKIR DUA ARAH untuk friend request: 0007 hanya
--      menolak bila PENERIMA memblokir pengirim — pengirim yang memblokir
--      penerima masih bisa mengirim request ke korban blokirnya. Guard
--      diperluas: block di KEDUA arah menolak request.
--
-- KONTRAK STRING ERROR (dikonsumsi lapisan klien — jangan diubah):
--   'RATE_LIMITED_MESSAGES' | 'RATE_LIMITED_FRIENDSHIP' |
--   'INVALID_FRIENDSHIP_TRANSITION' | 'BLOCKED_FROM_ROOM'
-- (semua errcode P0001 — pola raise-exception guard 0007/0009).
-- ============================================================================

-- ---------------------------------------------------------------------------
-- (a) Rate limit pesan: 20 / 10 detik per pengirim.
--     SECURITY DEFINER ala guard 0007:48 / 0009:42: fungsi berjalan sebagai
--     owner sehingga membaca public.messages MELEWATI RLS — hitungan harus
--     melihat SEMUA pesan pengirim (baris pengirim terlihat oleh pengirim
--     sendiri di RLS 0010, tapi definer membuat guard tidak bergantung pada
--     siapa invoker: service_role, trigger berantai, maupun klien biasa
--     mendapat hitungan yang benar).
-- ---------------------------------------------------------------------------
create or replace function public.messages_rate_limit_guard()
returns trigger
language plpgsql
security definer
set search_path = public, pg_catalog
as $$
declare
  v_recent int;
begin
  select count(*) into v_recent
  from public.messages
  where sender_id = new.sender_id
    and created_at > now() - interval '10 seconds';
  if v_recent >= 20 then
    raise exception 'RATE_LIMITED_MESSAGES'
      using errcode = 'P0001';
  end if;
  return new;
end;
$$;

revoke execute on function public.messages_rate_limit_guard()
  from public, anon, authenticated;

drop trigger if exists messages_rate_limit_guard_trigger on public.messages;
create trigger messages_rate_limit_guard_trigger
  before insert on public.messages
  for each row execute function public.messages_rate_limit_guard();

-- Jalur panas guard: count per pengirim dalam jendela 10 detik.
create index if not exists messages_sender_time_idx
  on public.messages (sender_id, created_at);

-- ---------------------------------------------------------------------------
-- (b) Rate limit friend request: 10 / jam per requester (kolom requester_id
--     & created_at diverifikasi pada 0007:18-22). Indeks
--     friendships_requester_idx (0007:36) sudah menopang kueri count ini —
--     tidak perlu indeks baru. SECURITY DEFINER: hitungan mencakup SEMUA
--     baris requester (pending maupun accepted) melewati RLS.
-- ---------------------------------------------------------------------------
create or replace function public.friendship_request_rate_limit_guard()
returns trigger
language plpgsql
security definer
set search_path = public, pg_catalog
as $$
declare
  v_recent int;
begin
  select count(*) into v_recent
  from public.friendships
  where requester_id = new.requester_id
    and created_at > now() - interval '1 hour';
  if v_recent >= 10 then
    raise exception 'RATE_LIMITED_FRIENDSHIP'
      using errcode = 'P0001';
  end if;
  return new;
end;
$$;

revoke execute on function public.friendship_request_rate_limit_guard()
  from public, anon, authenticated;

drop trigger if exists friendship_request_rate_limit_trigger on public.friendships;
create trigger friendship_request_rate_limit_trigger
  before insert on public.friendships
  for each row execute function public.friendship_request_rate_limit_guard();

-- ---------------------------------------------------------------------------
-- (c) Transition guard friendship: accepted tidak boleh turun ke pending.
--     (Nilai status yang ada: 'pending' | 'accepted' — CHECK 0007:20-21.)
--     Satu-satunya transisi sah tetap pending → accepted oleh addressee;
--     decline/cancel/unfriend = DELETE baris (MVP tanpa histori status).
--     Guard role-agnostic: service_role/superuser pun tidak bisa downgrade
--     diam-diam — perbaikan data darurat harus delete + insert ulang.
-- ---------------------------------------------------------------------------
create or replace function public.friendship_transition_guard()
returns trigger
language plpgsql
security definer
set search_path = public, pg_catalog
as $$
begin
  if old.status = 'accepted' and new.status = 'pending' then
    raise exception 'INVALID_FRIENDSHIP_TRANSITION'
      using errcode = 'P0001';
  end if;
  return new;
end;
$$;

revoke execute on function public.friendship_transition_guard()
  from public, anon, authenticated;

drop trigger if exists friendship_transition_guard_trigger on public.friendships;
create trigger friendship_transition_guard_trigger
  before update on public.friendships
  for each row execute function public.friendship_transition_guard();

-- ---------------------------------------------------------------------------
-- (d) join_room: tolak caller yang diblokir PEMILIK room (audit 25-b M4
--     sisi data). Body disalin verbatim dari 0018 (kapasitas tanpa tiket
--     sendiri dkk) + SATU cek tambahan di awal. Registri room = tabel
--     public.rooms (host_id, 0016:87-93); blokir = public.blocks.
--
--     Penempatan cek SEBELUM rate-limit & pencatatan attempt adalah
--     keharusan, bukan selera: exception meng-rollback SELURUH transaksi —
--     bila cek ini datang setelah INSERT room_join_attempts, catatan
--     attempt ikut ter-rollback dan kontrak akuntansi 0016 rusak. Trade-off
--     yang diterima: percobaan join yang ditolak karena blokir TIDAK
--     tercatat / tidak memakan kuota rate-limit join (cek blokir sendiri
--     satu kueri terindeks murah). Room kedaluwarsa tetap diperlakukan
--     ROOM_NOT_FOUND seperti biasa, bukan blokir.
-- ---------------------------------------------------------------------------
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

  -- 0019 (audit 25-b M4): pemilik room hidup telah memblokir caller →
  -- tolak keras. Hanya arah owner-blocks-joiner.
  if exists (
    select 1
    from public.rooms r
    where r.code = v_code
      and r.expires_at > now()
      and exists (
        select 1 from public.blocks b
        where b.blocker_id = r.host_id
          and b.blocked_id = v_uid
      )
  ) then
    raise exception 'BLOCKED_FROM_ROOM'
      using errcode = 'P0001';
  end if;

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
  -- 0018: v_live kini mengecualikan tiket SENDIRI (p.user_id <> v_uid) —
  -- peserta hidup yang rejoin tidak dihitung dua kali, sehingga tidak
  -- ditolak ROOM_FULL oleh slotnya sendiri (audit MEDIUM-1). Kapasitas
  -- tetap terjaga: user BARU melihat v_live = seluruh peserta hidup.
  select r.max_participants,
         (select count(*) from public.room_participants p
          where p.room_code = r.code and p.expires_at > now()
            and p.user_id <> v_uid)
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

-- ---------------------------------------------------------------------------
-- (e) Purge room_join_attempts saat insert baru: baris berumur > 2 jam
--     dihapus (kolom waktu tabel ini adalah attempted_at, 0016:114).
--     SECURITY DEFINER: DELETE harus menghapus baris SEMUA user — invoker
--     tidak bisa menghapus baris milik orang lain di bawah RLS 0016.
--     Purge oportunis di create_room (0016:297) TETAP berjalan
--     (belt-and-suspenders; kebenaran query tidak bergantung pada purge).
-- ---------------------------------------------------------------------------
create or replace function public.purge_stale_room_join_attempts()
returns trigger
language plpgsql
security definer
set search_path = public, pg_catalog
as $$
begin
  delete from public.room_join_attempts
  where attempted_at < now() - interval '2 hours';
  return new;
end;
$$;

revoke execute on function public.purge_stale_room_join_attempts()
  from public, anon, authenticated;

drop trigger if exists room_join_attempts_purge_trigger on public.room_join_attempts;
create trigger room_join_attempts_purge_trigger
  before insert on public.room_join_attempts
  for each row execute function public.purge_stale_room_join_attempts();

-- ---------------------------------------------------------------------------
-- (f) Guard blokir DUA ARAH untuk friend request — perluas 0007:51-73.
--     Seluruh logika lain dipertahankan verbatim; hanya predicate WHERE
--     yang diperluas: block addressee→requester (semula) ATAU
--     requester→addressee (baru — blocker tidak boleh bisa mengirim request
--     ke korban blokirnya, temuan INFO 25-b). Pesan exception tetap persis
--     'friend request rejected: blocked' — dikonsumsi BLOCK_GUARD_MESSAGE
--     (src/friends/types.ts) dan tes PGlite; arah mana pun yang memicu
--     TIDAK dibedakan (privasi daftar blokir tetap terjaga — klien bisa
--     membedakan sendiri via daftar blokir miliknya).
-- ---------------------------------------------------------------------------
create or replace function public.friendships_block_guard()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if exists (
    select 1 from public.blocks
    where (blocker_id = new.addressee_id and blocked_id = new.requester_id)
       or (blocker_id = new.requester_id and blocked_id = new.addressee_id)
  ) then
    raise exception 'friend request rejected: blocked'
      using errcode = 'P0001';
  end if;
  return new;
end;
$$;

-- Hygiene 0018-style: fungsi trigger tidak bisa dipanggil langsung oleh
-- klien (returns trigger), revoke mematrinya tetap eksplisit.
revoke execute on function public.friendships_block_guard()
  from public, anon, authenticated;
