-- ============================================================================
-- 0006_profile_voice_snippet.sql — F1.5
-- 1) Kolom penunjuk snippet suara aktif pada profiles (path di bucket
--    'voice-snippets'). Dikelola client lewat update-own-profile (RLS 0002).
-- 2) Policy SELECT bucket voice-snippets dilonggarkan: semua user
--    authenticated boleh MEMBACA objek di bucket (snippet = intro suara
--    profil — memang ditujukan didengar member lain). Tulis/hapus TETAP
--    owner-only (policy insert/delete 0004 tidak disentuh).
-- Idempotent: aman dijalankan ulang.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1) Kolom voice_snippet_path (null = user belum punya snippet).
-- ---------------------------------------------------------------------------
alter table public.profiles
  add column if not exists voice_snippet_path text;

comment on column public.profiles.voice_snippet_path is
  'F1.5 — path objek di bucket voice-snippets yang jadi snippet aktif user (format {userId}/{snippetId}.webm); null = belum ada.';

-- Constraint ringan: satu level folder + ekstensi .webm (pertahanan pertama;
-- client juga memvalidasi path via Zod sebelum menulis).
do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'profiles_voice_snippet_path_format'
  ) then
    alter table public.profiles
      add constraint profiles_voice_snippet_path_format
      check (
        voice_snippet_path is null
        or voice_snippet_path ~ '^[0-9a-fA-F-]{1,64}/[A-Za-z0-9._-]{1,64}\.webm$'
      );
  end if;
end
$$;

-- ---------------------------------------------------------------------------
-- 2) Policy select: owner-only → authenticated (baca saja, scoped bucket).
--    INSERT/DELETE tetap folder-per-user (0004 tidak diubah).
-- ---------------------------------------------------------------------------
drop policy if exists voice_snippets_select_own on storage.objects;

create policy voice_snippets_select_authenticated
  on storage.objects
  for select
  to authenticated
  using (bucket_id = 'voice-snippets');
