-- ============================================================================
-- 0018_audit_fixes.sql — Hardening hasil AUDIT MENYELURH malam 29/30 Sep
-- 2026 (Task 23-a → verifikasi main 23-d). Empat perbaikan, semuanya
-- idempoten (aman dijalankan ulang):
--
--   1. [HIGH — audit HIGH-1] Lockdown UPDATE friendships level KOLOM.
--      Policy 0008 friendships_update_addressee hanya mengunci BARIS
--      (addressee); requester_id/status/created_at bebas diubah klien via
--      PostgREST. Rantai eksploit terverifikasi (audit 23-a): addressee
--      memalsukan (requester_id=<korban>, status='accepted') → gate INSERT
--      messages 0010 (butuh friendship accepted) lolos → DM ke siapa pun
--      tanpa persetujuan. Pola perbaikan = 0011 (column-level privileges):
--      revoke UPDATE tabel penuh, grant UPDATE hanya (status) — satu-satunya
--      transisi sah memang pending→accepted oleh addressee.
--   2. [MEDIUM — audit MEDIUM-1] join_room: hitung kapasitas TANPA tiket
--      sendiri. Peserta hidup yang rejoin (refresh/reconnect — leave_room
--      tidak terpanggil saat tab mati) tadinya ditolak ROOM_FULL oleh
--      slotnya sendiri (tiket TTL 1 jam ikut terhitung di v_live) → user
--      terkunci dari roomnya + slot zombie memakan kapasitas.
--   3. [LOW — audit LOW-1] Cabut EXECUTE 3 helper internal 0016 dari role
--      authenticated (revokes 0016 hanya menyasar public+anon; default
--      privileges 0005:23-24 masih memberi execute ke authenticated —
--      kontrak "hanya lewat SECURITY DEFINER" kini utuh).
--   4. [LOW — audit LOW-3] Trigger profiles: voice_snippet_path WAJIB
--      ber-folder = uid pemilik (anti spoofing intro suara milik user
--      lain — bucket voice-snippets memang terbuka baca semua
--      authenticated, tapi profil sendiri tidak boleh MENUNJUK objek
--      orang lain). auth.uid() null (service/superuser) → lolos.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- (1) Lockdown kolom friendships
-- ---------------------------------------------------------------------------
revoke update on table public.friendships from anon, authenticated;

grant update (status) on table public.friendships to authenticated;

comment on policy friendships_update_addressee on public.friendships is
  'Row-level: addressee saja (0008). Column-level (0018): hanya kolom status — requester_id/addressee_id/created_at tak lagi bisa ditulis klien (audit HIGH-1).';

-- ---------------------------------------------------------------------------
-- (2) join_room — rejoin peserta hidup tidak terhalang slotnya sendiri
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
-- (3) Cabut execute helper internal 0016 dari authenticated
-- ---------------------------------------------------------------------------
revoke execute on function public.normalize_room_code(text) from authenticated;
revoke execute on function public.request_client_ip() from authenticated;
revoke execute on function public.generate_room_code() from authenticated;

-- ---------------------------------------------------------------------------
-- (4) Trigger folder-milik-sendiri untuk voice_snippet_path
-- ---------------------------------------------------------------------------
create or replace function public.guard_profile_voice_snippet_owner()
returns trigger
language plpgsql
security definer
set search_path = public, pg_catalog
as $$
begin
  -- auth.uid() null (koneksi service/superuser tanpa klaim user) → lolos;
  -- koneksi user biasa → folder pertama path WAJIB = uid sendiri.
  if new.voice_snippet_path is not null
     and auth.uid() is not null
     and split_part(new.voice_snippet_path, '/', 1) <> auth.uid()::text then
    raise exception 'voice_snippet_path harus berada di folder milik sendiri'
      using errcode = 'P0001';
  end if;
  return new;
end;
$$;

drop trigger if exists profiles_voice_snippet_owner_trigger on public.profiles;
create trigger profiles_voice_snippet_owner_trigger
  before update of voice_snippet_path on public.profiles
  for each row
  execute function public.guard_profile_voice_snippet_owner();
