-- Race facts only. Browser roles cannot read or write observation records.
create table public.rein_odds_trend_observations (
  race_id text not null check (race_id ~ '^[0-9]{10}([0-9]{2})?$'),
  rule_id text not null check (rule_id ~ '^odds90-[0-9]+$'),
  odds_at timestamptz not null,
  starts_at timestamptz not null,
  captured_at timestamptz not null default now(),
  payload jsonb not null check (jsonb_typeof(payload)='object'),
  stake_yen integer not null check (stake_yen in (100,200,300)),
  settlement_status text not null default 'pending' check (settlement_status in ('pending','settled','excluded')),
  return_yen integer check (return_yen >= 0),
  settled_at timestamptz,
  primary key (race_id,rule_id,odds_at),
  check (odds_at < starts_at and captured_at < starts_at and odds_at <= captured_at),
  check ((settlement_status='settled' and return_yen is not null) or (settlement_status<>'settled' and return_yen is null))
);
create index rein_odds_trend_race_time_idx on public.rein_odds_trend_observations (race_id,odds_at desc);
alter table public.rein_odds_trend_observations enable row level security;
revoke all on public.rein_odds_trend_observations from public,anon,authenticated,service_role;
grant select,insert,update on public.rein_odds_trend_observations to service_role;
