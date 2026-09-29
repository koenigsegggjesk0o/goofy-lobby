-- ============================================================================
-- 0017_realtime_room_authorization.sql — P0-1 hardening (bagian 2 dari 2;
-- prasyarat: 0016_room_registry.sql).
--
-- Dua kebijakan otorisasi channel Realtime PRIVATE `room:{kode}` pada tabel
-- realtime.messages — MILIK PLATFORM (supabase_realtime_admin):
--   * DILARANG `alter table realtime.messages enable row level security` —
--     RLS SUDAH aktif bawaan; statement itu GAGAL 42501 "must be owner of
--     table messages" dan MEMBATALKAN seluruh transaksi migrasi (docs resmi
--     Supabase — Realtime Authorization; verifikasi Task 22-b).
--   * TIDAK perlu GRANT pada realtime.messages — migrasi platform sudah
--     memberikan SELECT/INSERT ke postgres, anon, authenticated,
--     service_role (migration resmi supabase/realtime
--     20240523004032_redefine_authorization_tables.ex).
--   * CREATE POLICY oleh role postgres DIBOLEHKAN via supautils.
--
-- SEMANTIK (mengikuti pola contoh resmi docs, versi gabungan):
--   SELECT  : peserta room SAH boleh MEMBACA broadcast (SDP/ICE signaling)
--             DAN presence (roster) pada topic room miliknya.
--   INSERT  : peserta SAH boleh MENGIRIM broadcast + MEN-TRACK presence —
--             server Realtime memverifikasi hak kirim lewat jalur insert
--             (broadcast_handler.ex; tanpa policy INSERT, pengiriman
--             di-DROP DIAM-DIAM oleh server).
--   Syarat "peserta sah" = realtime_room_entitled() (0016): ada baris
--   room_participants HIDUP (TTL belum lewat) milik auth.uid() dengan
--   'room:'||room_code = topic yang sedang dicek.
--
-- EFEK PADA PENYERANG: subscribe ke room:{kode} tanpa tiket → server
-- membalas error join → supabase-js melaporkan CHANNEL_ERROR dengan pesan
-- "Unauthorized: You do not have permissions to read from this Channel
-- topic: room:{kode}" → SDP/ICE (alamat IP peserta) TIDAK PERNAH sampai ke
-- penyusup.
--
-- PENEGAKAN PENUH butuh setting "Allow public access" = OFF di Realtime
-- Settings (PATCH /v1/projects/{ref}/config/realtime {"private_only":true})
-- — tanpa itu, penyerang bisa subscribe channel TANPA flag private dan
-- melewati RLS. Setting itu di-flip oleh scripts/db/verify-p0-1.mjs saat
-- verifikasi cloud (bukan lewat migrasi ini).
--
-- CATATAN PERFORMA (docs resmi, verbatim): "Increased RLS complexity can
-- impact database performance and connection time, leading to higher
-- connection latency and decreased join rates." Evaluasi terjadi SEKALI per
-- join + saat access_token baru (cache seumur koneksi — bukan per pesan).
-- Helper berjalan di atas indeks room_participants(user_id, expires_at).
-- Pengukuran nyata pada beban ratusan join/detik = P1-10 (load test) —
-- bukan asumsi.
--
-- Idempotent: policy di-drop dulu sebelum dibuat ulang.
-- ============================================================================

drop policy if exists room_signaling_read on realtime.messages;
create policy room_signaling_read
  on realtime.messages
  for select
  to authenticated
  using (
    realtime.messages.extension in ('broadcast', 'presence')
    and public.realtime_room_entitled()
  );

drop policy if exists room_signaling_write on realtime.messages;
create policy room_signaling_write
  on realtime.messages
  for insert
  to authenticated
  with check (
    realtime.messages.extension in ('broadcast', 'presence')
    and public.realtime_room_entitled()
  );
