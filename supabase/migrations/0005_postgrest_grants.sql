-- ============================================================================
-- 0005_postgrest_grants.sql — F1.2
-- Tabel yang dibuat lewat Management API (migrations endpoint) TIDAK
-- mendapat default grants yang biasanya diberikan jalur dashboard/SQL Editor.
-- Akibatnya PostgREST (anon/authenticated/service_role) mendapat
-- "permission denied for table profiles".
-- Migrasi ini memulihkan model permission standar Supabase (docs:
-- Managing Postgres permissions / default privileges), mencakup objek yang
-- sudah ada + objek migrasi mendatang (jalur API konsisten → satu grantor).
-- Idempotent: GRANT boleh dijalankan berulang.
-- ============================================================================

grant usage on schema public to anon, authenticated, service_role;

grant all on all tables in schema public to anon, authenticated, service_role;
grant all on all sequences in schema public to anon, authenticated, service_role;
grant execute on all functions in schema public to anon, authenticated, service_role;

alter default privileges in schema public
  grant all on tables to anon, authenticated, service_role;
alter default privileges in schema public
  grant all on sequences to anon, authenticated, service_role;
alter default privileges in schema public
  grant execute on functions to anon, authenticated, service_role;
