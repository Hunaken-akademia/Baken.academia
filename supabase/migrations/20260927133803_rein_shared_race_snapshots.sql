create table public.rein_race_snapshots (
 race_id text not null check (race_id ~ '^[0-9]{10,12}$'),
 slot text not null check (slot in ('live','preview','prestart')),
 race_date date not null, generated_at timestamptz not null, starts_at timestamptz,
 is_final boolean not null default false, payload jsonb not null,
 captured_at timestamptz not null default now(), primary key (race_id,slot),
 check (jsonb_typeof(payload)='object')
);
create index rein_snapshots_date_idx on public.rein_race_snapshots(race_date,slot);
create table public.rein_prediction_history (
 race_id text not null, generated_at timestamptz not null, race_date date not null,
 entry jsonb not null, captured_at timestamptz not null default now(),
 primary key(race_id,generated_at)
);
create index rein_prediction_history_latest_idx on public.rein_prediction_history(race_id,generated_at desc);
create table public.rein_race_outcomes (
 race_id text primary key, race_date date not null, roster text not null,
 finishers jsonb, captured_at timestamptz not null default now()
);
create table public.rein_schedule_snapshots (
 race_date date primary key, payload jsonb not null, generated_at timestamptz not null default now()
);
create table public.rein_capture_leases (
 key text primary key, token uuid not null, expires_at timestamptz not null
);
create table public.rein_capture_runs (
 id bigint generated always as identity primary key, checked_at timestamptz not null default now(),
 summary jsonb not null
);
do $setup$
declare t text;
begin
 foreach t in array array['rein_race_snapshots','rein_prediction_history','rein_race_outcomes','rein_schedule_snapshots','rein_capture_leases','rein_capture_runs'] loop
  execute format('alter table public.%I enable row level security',t);
  execute format('alter table public.%I force row level security',t);
  execute format('revoke all on public.%I from public, anon, authenticated',t);
  execute format('grant select,insert,update,delete on public.%I to service_role',t);
 end loop;
end $setup$;
grant usage,select on sequence public.rein_capture_runs_id_seq to service_role;

create function public.rein_acquire_capture(p_key text,p_ttl integer)
returns uuid language plpgsql set search_path='' as $fn$
declare lease_token uuid := gen_random_uuid(); acquired uuid;
begin
 if length(p_key)>100 or p_ttl not between 10 and 300 then raise exception 'Invalid lease'; end if;
 insert into public.rein_capture_leases(key,token,expires_at) values(p_key,lease_token,now()+make_interval(secs=>p_ttl))
 on conflict(key) do update set token=excluded.token,expires_at=excluded.expires_at
 where rein_capture_leases.expires_at<now() returning token into acquired;
 return acquired;
end $fn$;
revoke all on function public.rein_acquire_capture(text,integer) from public,anon,authenticated;
grant execute on function public.rein_acquire_capture(text,integer) to service_role;

create function public.rein_store_race_snapshot(r jsonb)
returns boolean language plpgsql set search_path='' as $fn$
begin
 if jsonb_typeof(r->'payload') is distinct from 'object' or octet_length(r::text)>1000000 then raise exception 'Invalid snapshot'; end if;
 insert into public.rein_race_snapshots(race_id,slot,race_date,generated_at,starts_at,is_final,payload)
 values(r->>'race_id',r->>'slot',(r->>'race_date')::date,(r->>'generated_at')::timestamptz,(r->>'starts_at')::timestamptz,(r->>'is_final')::boolean,r->'payload')
 on conflict(race_id,slot) do update set generated_at=excluded.generated_at,starts_at=excluded.starts_at,is_final=excluded.is_final,payload=excluded.payload,captured_at=now()
 where (not rein_race_snapshots.is_final or excluded.is_final)
 and (excluded.generated_at>=rein_race_snapshots.generated_at or excluded.is_final);
 if (r->>'prestart')::boolean then
  insert into public.rein_race_snapshots(race_id,slot,race_date,generated_at,starts_at,payload)
  values(r->>'race_id','prestart',(r->>'race_date')::date,(r->>'generated_at')::timestamptz,(r->>'starts_at')::timestamptz,r->'payload')
  on conflict(race_id,slot) do update set generated_at=excluded.generated_at,starts_at=excluded.starts_at,payload=excluded.payload,captured_at=now()
  where excluded.generated_at>rein_race_snapshots.generated_at;
 end if;
 if jsonb_typeof(r->'journal')='object' then
  insert into public.rein_prediction_history(race_id,generated_at,race_date,entry)
  values(r->>'race_id',(r->>'generated_at')::timestamptz,(r->>'race_date')::date,r->'journal') on conflict do nothing;
 end if;
 if (r->>'is_final')::boolean then
  insert into public.rein_race_outcomes(race_id,race_date,roster,finishers)
  values(r->>'race_id',(r->>'race_date')::date,r->>'roster',nullif(r->'result','null'::jsonb))
  on conflict(race_id) do update set roster=excluded.roster,finishers=excluded.finishers,captured_at=now();
 end if;
 return true;
end $fn$;
revoke all on function public.rein_store_race_snapshot(jsonb) from public,anon,authenticated;
grant execute on function public.rein_store_race_snapshot(jsonb) to service_role;

create function public.rein_shared_journal_summary()
returns jsonb language sql stable set search_path='' as $fn$
with latest as (
 select distinct on(h.race_id) h.race_id,h.entry,h.race_date from public.rein_prediction_history h order by h.race_id,h.generated_at desc
), assessed as (
 select l.*,o.finishers from latest l join public.rein_race_outcomes o using(race_id)
 where o.finishers is not null and l.entry->>'roster'=o.roster
), ranked as (
 select a.race_id,p.target,(h.h->>'number')::int number,(h.h->>'popularity')::int popularity,
 jsonb_array_length(a.entry->'horses') field_size,
 row_number() over(partition by a.race_id,p.target order by (h.h->>p.feature)::numeric desc,h.ord) as rank,
 a.finishers
 from assessed a cross join lateral jsonb_array_elements(a.entry->'horses') with ordinality h(h,ord)
 cross join (values(1,'firstProbability'),(2,'secondProbability'),(3,'thirdProbability')) p(target,feature)
), actual as (
 select k.* from ranked k where exists(select 1 from jsonb_array_elements(k.finishers) f where (f->>'finish')::int=k.target and (f->>'number')::int=k.number)
), counts as (
 select b.min_pop,p.target,count(a.race_id)::int races,count(a.race_id) filter(where a.rank<=5)::int hits
 from (values(1),(4),(6),(10)) b(min_pop) cross join (values(1),(2),(3)) p(target)
 left join actual a on a.target=p.target and (b.min_pop=1 or a.popularity between b.min_pop and a.field_size)
 group by b.min_pop,p.target
), groups as (
 select min_pop,jsonb_agg(jsonb_build_object('target',target,'races',races,'hits',hits) order by target) roles from counts group by min_pop
)
select jsonb_build_object('summary',(select jsonb_agg(jsonb_build_object('minPopularity',min_pop,'roles',roles) order by min_pop) from groups),'races',(select count(*) from assessed),'fromDate',(select min(race_date) from assessed),'throughDate',(select max(race_date) from assessed));
$fn$;
revoke all on function public.rein_shared_journal_summary() from public,anon,authenticated;
grant execute on function public.rein_shared_journal_summary() to service_role;
