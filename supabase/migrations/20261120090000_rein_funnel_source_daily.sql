-- REIN の入口を数える（2026-11-20 オーナー依頼「記録してないれいんは」）。rein-web/lib/funnel.mjs が書く。
-- 個人は記録しない。日（日本時間）×イベント×入口×場所 の回数だけ。
create table if not exists public.rein_funnel_source_daily (
  day date not null,
  event text not null check (event in ('free_view','plan_click')),
  src text not null check (src in ('x','yt','bookers','lp','search','note','line','wake','other','direct')),
  detail text not null default '' check (detail in ('','free','jra','nar','all')),
  n integer not null default 0,
  primary key (day, event, src, detail)
);
alter table public.rein_funnel_source_daily enable row level security;
grant select, insert, update on public.rein_funnel_source_daily to service_role;

create or replace function public.rein_funnel_bump(p_event text, p_src text, p_detail text)
returns void language sql security definer set search_path = public as $$
  insert into public.rein_funnel_source_daily (day, event, src, detail, n)
  values ((now() at time zone 'Asia/Tokyo')::date, p_event, p_src, coalesce(p_detail, ''), 1)
  on conflict (day, event, src, detail) do update set n = public.rein_funnel_source_daily.n + 1;
$$;
revoke all on function public.rein_funnel_bump(text, text, text) from public, anon, authenticated;
grant execute on function public.rein_funnel_bump(text, text, text) to service_role;
