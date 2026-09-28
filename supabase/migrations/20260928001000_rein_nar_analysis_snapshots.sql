create table if not exists public.rein_nar_analysis_snapshots (
  id boolean primary key default true check (id is true),
  report jsonb not null check (jsonb_typeof(report) = 'object'),
  updated_at timestamptz not null default now()
);

alter table public.rein_nar_analysis_snapshots enable row level security;
revoke all on table public.rein_nar_analysis_snapshots from public, anon, authenticated;
grant select, insert, update on table public.rein_nar_analysis_snapshots to service_role;
