-- ============================================================================
-- 0007_friends_blocks.sql — Fase 2 (fitur sosial)
-- Tabel pertemanan & blokir.
--   friendships : satu baris per pasangan (arah kanonik dijaga unique index
--                 least/greatest — A→B dan B→A dianggap PASANGAN YANG SAMA,
--                 tidak bisa dobel).
--                 status 'pending' | 'accepted'; decline/cancel/unfriend =
--                 hapus baris (MVP: tanpa histori status).
--   blocks      : pasangan blocker→blocked, PK komposit, tanpa update state.
-- Guard anti-blokir: trigger SECURITY DEFINER menolak insert friendship
-- bila CALON PENERIMA telah memblokir pengirim. Blok TIDAK bisa dicek dari
-- client (RLS blocks: blocker-only) sehingga penegakan WAJIB di level DB.
-- Idempotent: aman dijalankan ulang.
-- ============================================================================

create table if not exists public.friendships (
  id           uuid primary key default gen_random_uuid(),
  requester_id uuid not null references public.profiles (id) on delete cascade,
  addressee_id uuid not null references public.profiles (id) on delete cascade,
  status       text not null default 'pending'
    check (status in ('pending', 'accepted')),
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  constraint friendships_no_self check (requester_id <> addressee_id)
);

comment on table public.friendships is
  'Fase 2 — permintaan & relasi pertemanan; satu baris per pasangan (kanonik), decline/cancel/unfriend = delete.';

-- Pasangan kanonik: mencegah A→B dan B→A hidup bersamaan (unique index
-- ekspresi least/greatest — constraint UNIQUE biasa tidak bisa menangkap
-- arah terbalik).
create unique index if not exists friendships_pair_canonical_unique
  on public.friendships (least(requester_id, addressee_id), greatest(requester_id, addressee_id));

create index if not exists friendships_requester_idx on public.friendships (requester_id);
create index if not exists friendships_addressee_idx on public.friendships (addressee_id);

-- updated_at otomatis (fungsi generik dari 0001 dipakai ulang).
drop trigger if exists friendships_set_updated_at on public.friendships;
create trigger friendships_set_updated_at
  before update on public.friendships
  for each row execute function public.set_updated_at();

-- ---------------------------------------------------------------------------
-- Guard blokir untuk permintaan pertemanan.
-- SECURITY DEFINER + search_path terkunci: fungsi berjalan sebagai owner
-- sehingga dapat membaca tabel blocks MELEWATI RLS (client tidak bisa —
-- dan memang tidak boleh — tahu isi blokir orang lain).
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
    where blocker_id = new.addressee_id
      and blocked_id = new.requester_id
  ) then
    raise exception 'friend request rejected: blocked'
      using errcode = 'P0001';
  end if;
  return new;
end;
$$;

drop trigger if exists friendships_block_guard_trigger on public.friendships;
create trigger friendships_block_guard_trigger
  before insert on public.friendships
  for each row execute function public.friendships_block_guard();

-- ---------------------------------------------------------------------------
-- Tabel blokir (privat: hanya blocker yang bisa membaca barisnya — RLS 0008).
-- ---------------------------------------------------------------------------
create table if not exists public.blocks (
  blocker_id uuid not null references public.profiles (id) on delete cascade,
  blocked_id uuid not null references public.profiles (id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (blocker_id, blocked_id),
  constraint blocks_no_self check (blocker_id <> blocked_id)
);

comment on table public.blocks is
  'Fase 2 — daftar blokir per user; PRIVAT (RLS blocker-only); menegakkan penolakan friend request & DM lewat trigger guard.';

create index if not exists blocks_blocked_idx on public.blocks (blocked_id);
