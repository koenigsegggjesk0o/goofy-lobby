-- ============================================================================
-- 0009_messages.sql — Fase 2 (chat)
-- Tabel pesan teks DM (direct message) antar user — persisten di Postgres,
-- dibaca lewat PostgREST oleh kedua peserta (RLS 0010).
--   body  : 1–500 karakter SETELAH btrim (sama persis dengan validasi Zod
--           client — dua lapis, client untuk UX + DB untuk kebenaran).
-- Guard anti-blokir: DM kepada penerima yang telah memblokir pengirim
-- ditolak di level DB (trigger SECURITY DEFINER — client tidak bisa membaca
-- blocks milik orang lain, lihat 0007/0008).
-- Gate pertemanan TIDAK di trigger ini — ada di policy INSERT 0010
-- (WITH CHECK exists friendship accepted) karena bisa dievaluasi di bawah
-- RLS milik pengirim sendiri (pengirim adalah peserta friendship-nya).
-- Idempotent: aman dijalankan ulang.
-- ============================================================================

create table if not exists public.messages (
  id           uuid primary key default gen_random_uuid(),
  sender_id    uuid not null references public.profiles (id) on delete cascade,
  recipient_id uuid not null references public.profiles (id) on delete cascade,
  body         text not null
    check (char_length(btrim(body)) between 1 and 500),
  created_at   timestamptz not null default now(),
  constraint messages_no_self check (sender_id <> recipient_id)
);

comment on table public.messages is
  'Fase 2 — DM antar user; immutable (tanpa policy UPDATE/DELETE), dibaca peserta saja (RLS 0010).';

-- Dua indeks pasangan: percakapan A↔B bisa diminta dari dua arah
-- (sender=A,recipient=B) maupun (sender=B,recipient=A).
create index if not exists messages_sender_recipient_time_idx
  on public.messages (sender_id, recipient_id, created_at desc);
create index if not exists messages_recipient_sender_time_idx
  on public.messages (recipient_id, sender_id, created_at desc);

-- ---------------------------------------------------------------------------
-- Guard blokir untuk DM (symmetric dengan friendships_block_guard 0007).
-- ---------------------------------------------------------------------------
create or replace function public.messages_block_guard()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if exists (
    select 1 from public.blocks
    where blocker_id = new.recipient_id
      and blocked_id = new.sender_id
  ) then
    raise exception 'message rejected: blocked'
      using errcode = 'P0001';
  end if;
  return new;
end;
$$;

drop trigger if exists messages_block_guard_trigger on public.messages;
create trigger messages_block_guard_trigger
  before insert on public.messages
  for each row execute function public.messages_block_guard();
