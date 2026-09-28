-- ============================================================================
-- 0012_soundboard_bucket.sql — Fase 2 (soundboard)
-- Bucket storage PRIVATE 'soundboard-sounds' untuk suara kustom milik user.
--   - Custom sound = klip audio pendek (upload Fase 3 lewat UI; logika
--     service client Fase 2 sudah siap memakai bucket ini).
--   - Hard cap 5 MiB per objek (klip pendek; jauh di bawah kebutuhan nyata).
--   - MIME umum yang dihasilkan perekam/uploader audio.
--   - Konvensi path: {auth.uid()}/{soundId}.{ext}  (dijaga policy 0013).
-- Idempotent: on conflict do update.
-- ============================================================================

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'soundboard-sounds',
  'soundboard-sounds',
  false,
  5242880,
  array['audio/webm', 'audio/mpeg', 'audio/wav', 'audio/ogg', 'audio/mp4']::text[]
)
on conflict (id) do update
  set public             = excluded.public,
      file_size_limit    = excluded.file_size_limit,
      allowed_mime_types = excluded.allowed_mime_types;
