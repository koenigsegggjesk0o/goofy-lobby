-- ============================================================================
-- 0020_grant_hygiene.sql — remedi audit 25-b temuan INFO "hygiene privilege".
-- Grant 0005 (grant ALL on all tables/sequences untuk anon/authenticated)
-- meninggalkan privilege MATI yang "dinetralkan" oleh absensi policy — bukan
-- lubang aktif, tapi kebisingan keamanan yang menyesatkan matriks
-- privilege audit/pembaca berikutnya (audit 25-b harus menelusuri rantai
-- policy satu per satu hanya untuk menyimpulkan "sebenarnya tidak bisa").
-- Setiap revoke di bawah menyebut temuan + verifikasi jalur klien sah.
--
-- AUDIT JALUR KLIEN SEBELUM REVOKE (grep .update( / .delete( atas tabel
-- terkait di seluruh src/ + test-harness/):
--   messages : HANYA insert + select (src/chat/message-service.ts:107-111,
--              159) — tidak ada .update/.delete klien sama sekali.
--   blocks   : upsert + delete + select (src/friends/block-service.ts) —
--              delete = jalur unblock LEGIT (policy blocks_delete_blocker,
--              0008:66-71); tidak ada .update.
-- Policy messages (0010): hanya select + insert — TIDAK ada policy update/
-- delete untuk sender (fitur recall tidak ada; pesan immutable by design,
-- comment tabel 0009:27) → DELETE boleh dicabut.
-- Idempotent: REVOKE boleh dijalankan berulang.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- (a) [25-b INFO: "blocks/messages pegang UPDATE/DELETE via 0005"] messages:
--     UPDATE + DELETE dicabut dari authenticated (perintah remediasi) DAN
--     anon (penerima grant 0005 yang sama; anon bahkan tak punya policy
--     SELECT di tabel ini — privilege mati yang sama, dicabut sekalian
--     mengikuti pola dua-role 0015). Tanpa policy UPDATE/DELETE (0010),
--     keduanya memang tak pernah bisa menulis baris apa pun — revoke
--     mematri desain immutable ke lapisan privilege sehingga penambahan
--     policy di masa depan tidak bisa "menghidupkan" ulang tanpa keputusan
--     eksplisit. Jalur chat sah TIDAK tersentuh: INSERT + SELECT tetap.
-- ---------------------------------------------------------------------------
revoke update, delete on table public.messages from authenticated;
revoke update, delete on table public.messages from anon;

-- ---------------------------------------------------------------------------
-- (b) [25-b INFO, item yang sama] blocks: UPDATE dicabut — tabel tanpa
--     state yang bisa diubah (PK komposit blocker/blocked, created_at
--     sistem; satu-satunya mutasi sah = insert blok & delete unblock).
--     DELETE TETAP milik authenticated: jalur unblock via policy
--     blocks_delete_blocker (0008:66-71). Diverifikasi: tidak ada .update(
--     atas blocks di src/friends/** (grep; block-service hanya
--     upsert/delete/select).
-- ---------------------------------------------------------------------------
revoke update on table public.blocks from authenticated;
revoke update on table public.blocks from anon;

-- ---------------------------------------------------------------------------
-- (c) [25-b INFO: "anon pegang DELETE profiles"] anon tidak punya policy
--     apa pun di profiles (semua policy 0002 `to authenticated`) → DELETE
--     anon = privilege mati sisa grant 0005. DELETE authenticated TETAP
--     (by design — lifecycle akun via policy profiles_delete_own;
--     keputusan 0015:26-28 bahwa delete baris sendiri tetap diizinkan).
-- ---------------------------------------------------------------------------
revoke delete on table public.profiles from anon;

-- ---------------------------------------------------------------------------
-- (d) [25-b INFO: "sequence default-grant"] Enumerasi sequence milik tabel
--     skema public pada rantai 0001..0019 (grep serial/identity/nextval di
--     seluruh migrasi): SATU-SATUNYA sequence adalah
--     room_join_attempts_id_seq (identity kolom id, 0016:110). Tabel lain
--     memakai uuid default gen_random_uuid() atau PK komposit — tanpa
--     sequence. Temuan per-sequence:
--       * room_join_attempts_id_seq — tabel pemiliknya TIDAK di-insert
--         klien secara langsung (revoke ALL tabel 0016:144; satu-satunya
--         penulis = RPC join_room SECURITY DEFINER yang berjalan sebagai
--         owner) → REVOKE ALL dari anon + authenticated. nextval oleh
--         klien hanya membakar id dan membocorkan laju identitas; tidak
--         ada konsumsi sah satu pun.
--     Tidak ada sequence milik tabel yang di-insert klien secara langsung
--     (messages/friendships/blocks memakai uuid) — jalur "revoke dari anon
--     saja" tidak berlaku untuk siapa pun. (Migrasi 0021+ milik agent lain
--     — enumerasinya di luar scope remediasi ini.)
-- ---------------------------------------------------------------------------
revoke all on sequence public.room_join_attempts_id_seq from anon, authenticated;
