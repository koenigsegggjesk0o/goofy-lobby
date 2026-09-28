-- ============================================================================
-- 0011_premium_status.sql — Fase 2 (payment)
-- 1) Kolom is_premium pada profiles (default false).
-- 2) LOCKDOWN KOLOM (inti dari spec payment):
--    "Kolom is_premium DILARANG dapat ditulis oleh role client — hanya
--    service_role di dalam Edge Function."
--    RLS UPDATE-own-row (0002) adalah level BARIS — tidak bisa membatasi
--    KOLOM. Penegakan yang benar: column-level privileges.
--      revoke UPDATE tabel penuh dari anon & authenticated,
--      grant UPDATE hanya pada kolom yang memang boleh diedit user.
--    service_role tidak disentuh (tetap full lewat grant 0005) dan
--    melewati RLS — Edge Function paddle-webhook satu-satunya penulis sah.
-- Idempotent: aman dijalankan ulang.
-- ============================================================================

alter table public.profiles
  add column if not exists is_premium boolean not null default false;

comment on column public.profiles.is_premium is
  'Fase 2 — status premium; HANYA service_role (Edge Function paddle-webhook) boleh menulis; client diblokir lewat column-level grants (revoke UPDATE tabel, grant kolom terbatas).';

-- ---------------------------------------------------------------------------
-- Lockdown column-level. GRANT 0005 memberikan UPDATE(all columns) ke
-- anon/authenticated — dicabut khusus untuk profiles lalu diberikan ulang
-- secara selektif. SELECT tetap table-wide (status premium boleh dibaca
-- semua authenticated — dibutuhkan menampilkan badge dll).
-- ---------------------------------------------------------------------------
revoke update on table public.profiles from anon, authenticated;

grant update (display_name, avatar_color, voice_snippet_path)
  on table public.profiles to authenticated;
