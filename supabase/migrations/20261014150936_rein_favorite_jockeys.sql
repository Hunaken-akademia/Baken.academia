-- Account-owned favorite jockeys. Horses keep using rein_horse_notes.watched.
create table if not exists public.rein_favorite_jockeys (
  user_id uuid not null references auth.users(id) on delete cascade,
  jockey_key text not null check (jockey_key ~ '^(jra|nar):[0-9A-Za-z]{1,12}$'),
  name text not null check (length(name) between 1 and 60),
  created_at timestamptz not null default now(),
  primary key (user_id, jockey_key)
);

alter table public.rein_favorite_jockeys enable row level security;
alter table public.rein_favorite_jockeys force row level security;

create policy "rein users manage own favorite jockeys"
  on public.rein_favorite_jockeys for all to authenticated
  using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);

revoke all on public.rein_favorite_jockeys from public, anon;
grant select, insert, delete on public.rein_favorite_jockeys to authenticated;
