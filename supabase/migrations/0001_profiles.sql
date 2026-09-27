-- ============================================================================
-- 0001_profiles.sql — F1.2
-- Tabel profil user (denormalisasi ringan dari auth.users).
-- Sumber display_name untuk presence & identitas peer di mesh WebRTC.
-- Idempotent: aman dijalankan ulang.
-- ============================================================================

create table if not exists public.profiles (
  id           uuid primary key references auth.users (id) on delete cascade,
  display_name text not null
    check (char_length(display_name) between 1 and 32),
  avatar_color text not null default '#9ca3af'
    check (avatar_color ~ '^#[0-9a-fA-F]{6}$'),
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);

comment on table public.profiles is
  'F1.2 — profil publik user; display_name dipakai presence/WebRTC mesh.';

-- ---------------------------------------------------------------------------
-- Auto-provision profile untuk setiap user baru (signup maupun admin API).
-- SECURITY DEFINER + search_path terkunci: fungsi jalan sebagai owner (postgres)
-- sehingga insert lolos RLS; user baru belum punya sesi untuk insert sendiri.
-- ---------------------------------------------------------------------------
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.profiles (id, display_name)
  values (
    new.id,
    left(
      coalesce(
        nullif(btrim(new.raw_user_meta_data ->> 'display_name'), ''),
        'guest_' || left(new.id::text, 8)
      ),
      32
    )
  )
  on conflict (id) do nothing;
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- ---------------------------------------------------------------------------
-- updated_at ter-set otomatis setiap baris profile di-update.
-- ---------------------------------------------------------------------------
create or replace function public.set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists profiles_set_updated_at on public.profiles;
create trigger profiles_set_updated_at
  before update on public.profiles
  for each row execute function public.set_updated_at();
