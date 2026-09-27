-- ============================================================================
-- 0004_voice_snippets_storage_rls.sql — F1.2 (dipakai penuh di F1.5)
-- Policy RLS pada storage.objects KHUSUS bucket 'voice-snippets'.
-- Semua akses dibatasi ke folder milik user: {auth.uid()}/...
-- (policy scoped by bucket_id agar tidak menyentuh bucket lain).
-- Idempotent: policy di-drop dulu sebelum dibuat ulang.
-- ============================================================================

drop policy if exists voice_snippets_insert_own on storage.objects;
create policy voice_snippets_insert_own
  on storage.objects
  for insert
  to authenticated
  with check (
    bucket_id = 'voice-snippets'
    and (storage.foldername(name))[1] = auth.uid()::text
  );

drop policy if exists voice_snippets_select_own on storage.objects;
create policy voice_snippets_select_own
  on storage.objects
  for select
  to authenticated
  using (
    bucket_id = 'voice-snippets'
    and (storage.foldername(name))[1] = auth.uid()::text
  );

drop policy if exists voice_snippets_delete_own on storage.objects;
create policy voice_snippets_delete_own
  on storage.objects
  for delete
  to authenticated
  using (
    bucket_id = 'voice-snippets'
    and (storage.foldername(name))[1] = auth.uid()::text
  );
