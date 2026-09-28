-- Applied 2026-09-28. Keep JRA schedules intact for the same date as NAR.
alter table public.rein_schedule_snapshots add column league text not null default 'jra' check(league in ('jra','nar'));
alter table public.rein_schedule_snapshots drop constraint rein_schedule_snapshots_pkey;
alter table public.rein_schedule_snapshots add primary key(race_date,league);

-- Candidate analyses may grow continuously. Serving a new correction requires an
-- explicit release, so unfinished acquisition cannot silently change live scores.
create table public.rein_nar_model_releases (
 id boolean primary key default true check(id),
 report jsonb not null, activated_at timestamptz not null default now()
);
alter table public.rein_nar_model_releases enable row level security;
alter table public.rein_nar_model_releases force row level security;
revoke all on public.rein_nar_model_releases from public,anon,authenticated;
grant select,insert,update,delete on public.rein_nar_model_releases to service_role;
insert into public.rein_nar_model_releases(id,report)
 select true,report from public.rein_nar_analysis_snapshots
 where report->'live_model'->>'status'='provisional' and report->>'profileSha' ~ '^[a-f0-9]{64}$';

create function public.rein_area_journal_summary(p_league text)
returns jsonb language sql stable set search_path='' as $fn$
with latest as (
 select distinct on(h.race_id) h.race_id,h.entry,h.race_date from public.rein_prediction_history h
 where (p_league='nar' and length(h.race_id)=12) or (p_league='jra' and length(h.race_id)=10)
 order by h.race_id,h.generated_at desc
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
revoke all on function public.rein_area_journal_summary(text) from public,anon,authenticated;
grant execute on function public.rein_area_journal_summary(text) to service_role;
-- Old readers keep their JRA-only results after the NAR history starts growing.
create or replace function public.rein_shared_journal_summary()
returns jsonb language sql stable set search_path='' as $fn$
select public.rein_area_journal_summary('jra');
$fn$;
