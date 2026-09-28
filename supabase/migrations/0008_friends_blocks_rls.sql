-- ============================================================================
-- 0008_friends_blocks_rls.sql — Fase 2
-- Row Level Security untuk public.friendships dan public.blocks.
--
--   friendships:
--     SELECT  : kedua pihak (requester & addressee melihat permintaan mereka).
--     INSERT  : hanya requester (addressee tidak bisa membuat permintaan
--               atas nama orang lain; blokir ditegakkan trigger 0007).
--     UPDATE  : hanya addressee (satu-satunya transisi sah: accept
--               pending → accepted oleh penerima).
--     DELETE  : kedua pihak (cancel oleh requester, decline/unfriend
--               oleh salah satu).
--   blocks:
--     SELECT/INSERT/DELETE : hanya blocker — daftar blokir PRIVAT,
--     pihak yang diblokir tidak bisa mengetahui statusnya lewat DB.
-- Idempotent: policy di-drop dulu sebelum dibuat ulang.
-- ============================================================================

alter table public.friendships enable row level security;

drop policy if exists friendships_select_participants on public.friendships;
create policy friendships_select_participants
  on public.friendships
  for select
  to authenticated
  using (auth.uid() = requester_id or auth.uid() = addressee_id);

drop policy if exists friendships_insert_requester on public.friendships;
create policy friendships_insert_requester
  on public.friendships
  for insert
  to authenticated
  with check (auth.uid() = requester_id);

drop policy if exists friendships_update_addressee on public.friendships;
create policy friendships_update_addressee
  on public.friendships
  for update
  to authenticated
  using (auth.uid() = addressee_id)
  with check (auth.uid() = addressee_id);

drop policy if exists friendships_delete_participant on public.friendships;
create policy friendships_delete_participant
  on public.friendships
  for delete
  to authenticated
  using (auth.uid() = requester_id or auth.uid() = addressee_id);

alter table public.blocks enable row level security;

drop policy if exists blocks_select_blocker on public.blocks;
create policy blocks_select_blocker
  on public.blocks
  for select
  to authenticated
  using (auth.uid() = blocker_id);

drop policy if exists blocks_insert_blocker on public.blocks;
create policy blocks_insert_blocker
  on public.blocks
  for insert
  to authenticated
  with check (auth.uid() = blocker_id);

drop policy if exists blocks_delete_blocker on public.blocks;
create policy blocks_delete_blocker
  on public.blocks
  for delete
  to authenticated
  using (auth.uid() = blocker_id);
