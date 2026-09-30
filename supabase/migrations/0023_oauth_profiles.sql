-- ============================================================================
-- 0023_oauth_profiles.sql — Task 37
-- Perkaya handle_new_user untuk login OAuth (Google/Facebook/Apple/Discord):
-- display_name jatuh berurutan ke display_name → full_name → name →
-- preferred_username → bagian lokal email → guest_; avatar_color acak dari
-- palet bila tidak disediakan metadata. Tanpa ini user OAuth bernama
-- "guest_xxxxxxxx" tanpa warna.
-- Idempotent: create or replace + drop/create trigger.
-- ============================================================================

create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.profiles (id, display_name, avatar_color)
  values (
    new.id,
    left(
      coalesce(
        nullif(btrim(new.raw_user_meta_data ->> 'display_name'), ''),
        nullif(btrim(new.raw_user_meta_data ->> 'full_name'), ''),
        nullif(btrim(new.raw_user_meta_data ->> 'name'), ''),
        nullif(btrim(new.raw_user_meta_data ->> 'preferred_username'), ''),
        nullif(btrim(split_part(coalesce(new.email, ''), '@', 1)), ''),
        'guest_' || left(new.id::text, 8)
      ),
      32
    ),
    coalesce(
      nullif(btrim(new.raw_user_meta_data ->> 'avatar_color'), ''),
      (array['#e67146','#23a55a','#5865f2','#e91e63','#00bcd4','#ff9800','#9c27b0','#4caf50'])
        [1 + floor(random() * 8)::int]
    )
  )
  on conflict (id) do nothing;
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();
