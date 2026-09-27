-- ============================================================================
-- 0003_voice_snippets_bucket.sql — F1.2 (dipakai penuh di F1.5)
-- Bucket storage PRIVATE 'voice-snippets'.
--   - Snippet singkat hasil MediaRecorder (audio/webm; opus), nyata ~10KB/5s.
--   - Hard cap 25 MB per objek (jauh di atas kebutuhan nyata).
--   - Konvensi path: {auth.uid()}/{snippet_id}.webm  (dijaga policy 0004).
-- Idempotent: on conflict do update.
-- ============================================================================

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'voice-snippets',
  'voice-snippets',
  false,
  26214400,
  array['audio/webm']::text[]
)
on conflict (id) do update
  set public           = excluded.public,
      file_size_limit  = excluded.file_size_limit,
      allowed_mime_types = excluded.allowed_mime_types;
