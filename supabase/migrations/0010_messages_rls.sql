-- ============================================================================
-- 0010_messages_rls.sql — Fase 2
-- Row Level Security untuk public.messages.
--   SELECT : hanya peserta (pengirim & penerima).
--   INSERT : hanya sebagai pengirim sendiri, DAN hanya kepada TEMAN
--            (exists friendship status='accepted' antara keduanya —
--            subquery dievaluasi di bawah RLS friendships milik pengirim:
--            pengirim adalah peserta relasinya sehingga barisnya terlihat).
--   UPDATE / DELETE : TIDAK ADA policy — pesan immutable (MVP).
-- Blokir ditegakkan trigger messages_block_guard (0009), BUKAN policy —
-- blocks tidak terbaca oleh pengirim (RLS blocker-only).
-- Idempotent: policy di-drop dulu sebelum dibuat ulang.
-- ============================================================================

alter table public.messages enable row level security;

drop policy if exists messages_select_participants on public.messages;
create policy messages_select_participants
  on public.messages
  for select
  to authenticated
  using (auth.uid() = sender_id or auth.uid() = recipient_id);

drop policy if exists messages_insert_sender_friends on public.messages;
create policy messages_insert_sender_friends
  on public.messages
  for insert
  to authenticated
  with check (
    auth.uid() = sender_id
    and exists (
      select 1 from public.friendships f
      where f.status = 'accepted'
        and (
          (f.requester_id = sender_id and f.addressee_id = recipient_id)
          or (f.requester_id = recipient_id and f.addressee_id = sender_id)
        )
    )
  );
