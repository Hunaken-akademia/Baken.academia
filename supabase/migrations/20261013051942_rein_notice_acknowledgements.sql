create table public.rein_notice_acknowledgements (
  user_id uuid not null references auth.users(id) on delete cascade,
  notice_id text not null check (notice_id ~ '^[a-z0-9-]{1,100}$'),
  acknowledged_at timestamptz not null default now(),
  primary key (user_id, notice_id)
);
alter table public.rein_notice_acknowledgements enable row level security;
revoke all on public.rein_notice_acknowledgements from public, anon, authenticated;
grant select, insert on public.rein_notice_acknowledgements to authenticated;
create policy rein_notice_read_own on public.rein_notice_acknowledgements
  for select to authenticated using ((select auth.uid()) = user_id);
create policy rein_notice_acknowledge_own on public.rein_notice_acknowledgements
  for insert to authenticated with check ((select auth.uid()) = user_id);
