-- Shared official reference data; no customer data or prediction writes.
create table public.rein_track_references (
  league text not null check (league in ('jra','nar')),
  venue text not null,
  reference_date date not null,
  source_url text not null check (source_url like 'https://%'),
  payload jsonb not null check (jsonb_typeof(payload) = 'object'),
  imported_at timestamptz not null default now(),
  primary key (league, venue, reference_date, source_url)
);
alter table public.rein_track_references enable row level security;
revoke all on public.rein_track_references from public, anon, authenticated;
grant select on public.rein_track_references to authenticated;
grant all on public.rein_track_references to service_role;
create policy rein_track_references_member_read on public.rein_track_references
for select to authenticated using (
  exists (select 1 from public.rein_memberships m
    where m.auth_user_id = (select auth.uid())
      and m.plan in (rein_track_references.league, 'all')
      and m.status in ('active','cancelled')
      and m.access_starts_at <= now()
      and (m.access_ends_at is null or m.access_ends_at > now())
      and (m.status <> 'cancelled' or m.access_ends_at is not null))
);
comment on table public.rein_track_references is 'Official archived measurements and dated notices, for reference display only. Not predictive inputs.';
