-- ============================================================================
-- 0013_soundboard_storage_rls.sql — Fase 2 (soundboard)
-- Policy RLS pada storage.objects KHUSUS bucket 'soundboard-sounds'
-- (scoped by bucket_id — tidak menyentuh bucket lain).
-- Model akses meniru voice-snippets (0004 + pelonggaran baca 0006):
--   INSERT/DELETE : folder milik sendiri {auth.uid()}/... saja.
--   SELECT        : semua authenticated (sesama anggota room perlu
--                   mengunduh custom sound untuk memutarnya).
-- Idempotent: policy di-drop dulu sebelum dibuat ulang.
-- ============================================================================

drop policy if exists soundboard_insert_own on storage.objects;
create policy soundboard_insert_own
  on storage.objects
  for insert
  to authenticated
  with check (
    bucket_id = 'soundboard-sounds'
    and (storage.foldername(name))[1] = auth.uid()::text
  );

drop policy if exists soundboard_select_authenticated on storage.objects;
create policy soundboard_select_authenticated
  on storage.objects
  for select
  to authenticated
  using (bucket_id = 'soundboard-sounds');

drop policy if exists soundboard_delete_own on storage.objects;
create policy soundboard_delete_own
  on storage.objects
  for delete
  to authenticated
  using (
    bucket_id = 'soundboard-sounds'
    and (storage.foldername(name))[1] = auth.uid()::text
  );
