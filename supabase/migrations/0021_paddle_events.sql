-- ============================================================================
-- 0021_paddle_events.sql — Hardening hasil AUDIT KEAMANAN Task 25
-- (remediasi 26-d; temuan 25-c item 5):
--   1. [B2 — idempotency] Tabel paddle_events: ledger event webhook yang
--      SUDAH diproses. Router (src/payment/paddle-webhook.ts) melakukan
--      insert ... on conflict (event_id) do nothing sebagai LANGKAAH PERTAMA
--      setelah envelope tervalidasi; bila tidak ada baris ter-insert =
--      replay → di-acknowledge 200 tanpa apply apa pun. Menutup celah
--      replay-pada-retry Paddle yang sebelumnya bisa double-apply premium.
--   2. [MEDIUM — verifikasi harga & refund] Tabel paddle_transactions:
--      catatan transaksi per user (price_id yang diverifikasi terhadap
--      allowlist PADDLE_ALLOWED_PRICE_IDS di Edge Function) + penanda
--      refund (refunded_at). Event adjustment (refund/credit approved)
--      mencari baris di sini untuk MENCABUT premium user terkait.
--
-- Model akses: KHUSUS service_role (pola 0016/0018) — RLS aktif TANPA
-- policy + REVOKE ALL dari anon/authenticated. Tidak ada jalur klien
-- sah untuk membaca/menulis kedua tabel ini; satu-satunya penulis =
-- Edge Function paddle-webhook (SUPABASE_SERVICE_ROLE_KEY) dan pembaca
-- erasure = Edge Function account-erasure (service_role juga).
--
-- Catatan user_id: on delete cascade ke profiles — eraseUserData
-- (src/account/erasure-service.ts) tetap menghapus eksplisit demi
-- kejelasan, cascade ini menjadi jaring pengaman bila profile dihapus
-- lewat jalur lain.
--
-- Idempotent: aman dijalankan ulang (if not exists / enable ulang /
-- revoke ulang).
-- ============================================================================

-- ---------------------------------------------------------------------------
-- (1) Ledger event — dedup replay webhook
-- ---------------------------------------------------------------------------
create table if not exists public.paddle_events (
  event_id     text primary key,
  event_type   text not null,
  processed_at timestamptz not null default now()
);

comment on table public.paddle_events is
  'Audit 25 B2 — dedup replay webhook Paddle (insert on conflict do nothing); service_role-only (RLS tanpa policy + revoke).';

-- ---------------------------------------------------------------------------
-- (2) Ledger transaksi — verifikasi harga + refund revoke
--     status: 'completed'      = price_id lolos allowlist → premium granted;
--            'price_rejected'  = allowlist kosong/price tak dikenal →
--                                TIDAK ada grant (fail-closed).
-- ---------------------------------------------------------------------------
create table if not exists public.paddle_transactions (
  transaction_id text primary key,
  user_id        uuid not null references public.profiles (id) on delete cascade,
  price_id       text not null,
  amount_total   bigint,
  currency       text,
  status         text not null default 'completed'
    check (status in ('completed', 'price_rejected')),
  created_at     timestamptz not null default now(),
  refunded_at    timestamptz
);

comment on table public.paddle_transactions is
  'Audit 25 MEDIUM — ledger transaksi Paddle: verifikasi price_id (allowlist) + penanda refund utk pencabutan premium; service_role-only.';

-- Jalur baca erasure (delete by user_id) + audit manual.
create index if not exists paddle_transactions_user_idx
  on public.paddle_transactions (user_id);

-- ---------------------------------------------------------------------------
-- (3) Lockdown akses — RLS aktif TANPA policy (deny-all utk role klien)
--     + revoke eksplisit (0005/default privileges memberi ALL utk tabel
--     public baru ke anon/authenticated). service_role lolos RLS by design
--     (bypassrls) — tidak perlu grant eksplisit.
-- ---------------------------------------------------------------------------
alter table public.paddle_events enable row level security;
alter table public.paddle_transactions enable row level security;

revoke all on table public.paddle_events from anon, authenticated;
revoke all on table public.paddle_transactions from anon, authenticated;
