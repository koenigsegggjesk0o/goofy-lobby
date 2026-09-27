-- ============================================================================
-- 0002_profiles_rls.sql — F1.2
-- Row Level Security untuk public.profiles.
--   SELECT : semua user ter-autentikasi (nama anggota room dibutuhkan
--            oleh presence & mesh WebRTC).
--   INSERT / UPDATE / DELETE : hanya baris milik sendiri.
-- Idempotent: policy di-drop dulu sebelum dibuat ulang.
-- ============================================================================

alter table public.profiles enable row level security;

drop policy if exists profiles_select_authenticated on public.profiles;
create policy profiles_select_authenticated
  on public.profiles
  for select
  to authenticated
  using (true);

drop policy if exists profiles_insert_own on public.profiles;
create policy profiles_insert_own
  on public.profiles
  for insert
  to authenticated
  with check (auth.uid() = id);

drop policy if exists profiles_update_own on public.profiles;
create policy profiles_update_own
  on public.profiles
  for update
  to authenticated
  using (auth.uid() = id)
  with check (auth.uid() = id);

drop policy if exists profiles_delete_own on public.profiles;
create policy profiles_delete_own
  on public.profiles
  for delete
  to authenticated
  using (auth.uid() = id);
