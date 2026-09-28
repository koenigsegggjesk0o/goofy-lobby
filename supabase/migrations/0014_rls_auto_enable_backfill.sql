-- ============================================================================
-- 0014_rls_auto_enable_backfill.sql — remedi audit Task 19 TEMUAN 2 (MEDIUM)
-- Backfill drift cloud→repo. Audit BAGIAN 6 (blok 10 + verifikasi tambahan)
-- menemukan fungsi public.rls_auto_enable() + event trigger ensure_rls ADA
-- di cloud tetapi TIDAK ada di 13 migrasi lokal — proyek tidak bisa dibangun
-- ulang identik dari repo. Migrasi ini mereproduksi hardening tersebut
-- sehingga database hasil rebuild (proyek baru / PGlite / restore darurat)
-- memiliki perlindungan yang sama: SETIAP tabel baru di skema public
-- otomatis mendapat ENABLE ROW LEVEL SECURITY — lupa RLS tidak lagi bisa
-- terjadi secara diam-diam.
--
-- DESAIN "create-if-missing" (bukan drop-and-recreate):
--  - Di cloud EXISTING kedua objek sudah ada (itulah drift-nya). Migrasi ini
--    SENGAJA tidak menyentuh objek yang sudah ada — mengganti definisi yang
--    mungkin dimiliki role platform berisiko gagal permission di jalur
--    runner Management API. Setelah apply, catatan migrasi 0014 hadir di
--    kedua sisi dan definisi kanonik ini ter-reproduce di semua rebuild
--    berikutnya.
--  - Definisi kanonik repo: SECURITY DEFINER + search_path terkunci
--    (pg_catalog) — paritas properti yang diverifikasi audit pada versi
--    cloud. Filter defensif (object_identity is not null, object_type,
--    schema_name) membuat fungsi aman terhadap entri katalog kosong dari
--    perintah DDL yang di-skip (mis. CREATE TABLE IF NOT EXISTS).
-- Idempotent: aman dijalankan ulang (objek dibuat hanya bila absen).
-- ============================================================================

do $do$
begin
  -- (1) Fungsi event-trigger: hanya bila belum ada.
  if not exists (
    select 1
    from pg_catalog.pg_proc p
    join pg_catalog.pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and p.proname = 'rls_auto_enable'
  ) then
    create function public.rls_auto_enable()
    returns event_trigger
    language plpgsql
    security definer
    set search_path = pg_catalog
    as $body$
    declare
      obj record;
    begin
      for obj in
        select command_tag, object_type, schema_name, object_identity
        from pg_catalog.pg_event_trigger_ddl_commands()
        where command_tag in ('CREATE TABLE', 'CREATE TABLE AS', 'SELECT INTO')
          and object_type = 'table'
          and schema_name = 'public'
          and object_identity is not null
      loop
        execute format('alter table %s enable row level security', obj.object_identity);
      end loop;
    end;
    $body$;
  end if;

  -- (2) Event trigger: hanya bila belum ada.
  if not exists (
    select 1 from pg_catalog.pg_event_trigger where evtname = 'ensure_rls'
  ) then
    create event trigger ensure_rls
      on ddl_command_end
      when tag in ('CREATE TABLE', 'CREATE TABLE AS', 'SELECT INTO')
      execute function public.rls_auto_enable();
  end if;
end
$do$;
