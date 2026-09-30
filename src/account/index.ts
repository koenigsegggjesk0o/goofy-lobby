// Barrel publik modul account (lifecycle). Semua ekspor MURNI
// (browser/Node/Deno) — Edge Function account-erasure mengimpor langsung
// dari erasure-service, bukan dari barrel ini.
export * from './erasure-service';
