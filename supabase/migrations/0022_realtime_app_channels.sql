-- ============================================================================
-- 0022_realtime_app_channels.sql — Fase 3 UI: channel aplikasi global.
--
-- Latar: 0017 + private_only=true mengunci SEMUA channel Realtime ke pola
-- tiket room:{kode} (penegakan P0-1). UI produk butuh dua channel global:
--   goofy:presence — indikator online (presence; key = userId, tanpa PII)
--   goofy:pokes    — sinyal "muat ulang" tanpa konten ({to, kind} saja)
-- Keduanya di-subscribe PRIVATE oleh klien + kebijakan di bawah: hanya
-- role authenticated. Dampak keamanan yang disadari:
--   * presence — user login dapat melihat userId lain yang online
--     (perilaku standar aplikasi chat; UUID, bukan PII);
--   * pokes — payload tanpa konten; spam poke hanya memicu refetch yang
--     sudah terjadi rutin lewat polling 10 detik (impact ~nol).
-- Room:{kode} TETAP eksklusif tiket (policy 0017 tidak disentuh); anon
-- tetap tidak mendapat apa pun.
--
-- Idempoten: policy di-drop dulu sebelum dibuat ulang.
-- ============================================================================

drop policy if exists app_channels_read on realtime.messages;
create policy app_channels_read
  on realtime.messages
  for select
  to authenticated
  using (
    realtime.messages.extension in ('broadcast', 'presence')
    and realtime.messages.topic in ('goofy:presence', 'goofy:pokes')
  );

drop policy if exists app_channels_write on realtime.messages;
create policy app_channels_write
  on realtime.messages
  for insert
  to authenticated
  with check (
    realtime.messages.extension in ('broadcast', 'presence')
    and realtime.messages.topic in ('goofy:presence', 'goofy:pokes')
  );
