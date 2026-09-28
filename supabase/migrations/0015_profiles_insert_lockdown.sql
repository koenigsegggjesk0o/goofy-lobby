-- ============================================================================
-- 0015_profiles_insert_lockdown.sql — remedi audit Task 19 TEMUAN 1 (HIGH)
-- Rantai eskalasi premium yang ditemukan audit BAGIAN 6 pada cloud asli:
--   grant 0005 memberikan INSERT level TABEL pada profiles ke
--   anon/authenticated — mencakup KOLOM is_premium, karena revoke 0011
--   hanya menyentuh UPDATE. Bersama policy profiles_insert_own (0002,
--   insert baris milik sendiri) dan profiles_delete_own (0002, delete baris
--   milik sendiri), rantai berikut terbuka untuk klien manapun:
--     (1) DELETE profil sendiri;
--     (2) INSERT ulang baris itu dengan is_premium = true
--   → status premium tanpa membayar. Audit membuktikan secara empiris:
--   has_table_privilege(authenticated, public.profiles, 'INSERT') = true
--   pada state pra-migrasi ini (klaim checklist lama bahwa INSERT pun sudah
--   dicabut 0011 ternyata KELIRU — hanya UPDATE yang dicabut).
--
-- REMEDI (keputusan: revoke PENUH, bukan column-level grant):
--  - TIDAK ADA jalur klien yang sah melakukan INSERT profiles: provisioning
--    profil ditangani trigger SECURITY DEFINER handle_new_user (0001) saat
--    signup — berjalan sebagai owner sehingga kebal revoke ini; klien
--    (ProfileService, test-harness, e2e) hanya melakukan select/update;
--    service_role (Edge Function paddle-webhook, penulis sah is_premium)
--    tetap memegang INSERT via grant 0005 dan bypass RLS.
--  - Policy profiles_insert_own menjadi dead code tanpa privilege INSERT —
--    di-drop supaya matriks policy tidak menyesatkan audit/pembaca
--    berikutnya (policy yang tak pernah bisa fire = kebisingan keamanan).
--  - DELETE baris sendiri TETAP diizinkan (by design — lifecycle akun;
--    tanpa INSERT ulang, delete kini hanya merusak profil sendiri, bukan
--    jalur eskalasi).
-- Idempotent: aman dijalankan ulang.
-- ============================================================================

revoke insert on table public.profiles from anon, authenticated;

drop policy if exists profiles_insert_own on public.profiles;

comment on table public.profiles is
  'F1.2 — profil publik user; display_name dipakai presence/WebRTC mesh. INSERT tertutup untuk role client sejak 0015 (provisioning = trigger handle_new_user; penulis sah is_premium = service_role) — remedi audit Task 19 TEMUAN 1.';
