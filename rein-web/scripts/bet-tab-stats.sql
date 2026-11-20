-- REIN 買い方タブの成績（lib/bet-tab-stats.json の "kinds" の元）。Supabase の SQL エディタで実行する（読み取りのみ）。
-- 元データ：rein_race_snapshots slot='live'（買い目と予想。中央の2026-10-03より前は確定オッズで再計算した参考）と review.payouts（実際の払戻）。
-- レースの型は lib/race-finder.ts の FINDER_CUTS（単勝オッズの有効頭数）。固めは REIN 本命＝1番人気（solidT）とそれ以外（solidO）に分ける。
-- 地方の再計算分はほぼ買い目が無いので、JSON には地方は発走前保存（pre）だけを入れる。値は [レース数, 的中レース数, 点数, 払戻合計]。
-- 狙い目ナビの "navi"（[レース数, 1番人気の1着, 3着内, 3連複1万円以上]）は同じ型の分け方で finishers と 3連複の払戻から数える。
with r as (select race_id, case when length(race_id)=10 then 'jra' else 'nar' end lg, generated_at<starts_at pre, payload->'tickets' t, payload->'review'->'payouts' p,
 (payload->'picks'->'main'->>'number')::int mainno,
 (select case when count(*)>=5 and bool_and((h->>'odds')::numeric>=1) then exp(-sum( (1/(h->>'odds')::numeric)/s.tot * ln((1/(h->>'odds')::numeric)/s.tot) )) end
   from jsonb_array_elements(payload->'horses') h, (select sum(1/(x->>'odds')::numeric) tot from jsonb_array_elements(payload->'horses') x where (x->>'odds')::numeric>=1) s) eff,
 (select (h->>'number')::int from jsonb_array_elements(payload->'horses') h where (h->>'odds')::numeric>0 order by (h->>'odds')::numeric, (h->>'number')::int limit 1) favno
 from rein_race_snapshots where slot='live' and jsonb_typeof(payload->'tickets')='array' and jsonb_array_length(payload->'tickets')>0 and jsonb_typeof(payload->'review'->'payouts')='array' and jsonb_array_length(payload->'review'->'payouts')>0),
r2 as (select *, case when eff is null then null when eff <= case lg when 'nar' then 5.16 else 6.51 end then case when mainno=favno then 'solidT' else 'solidO' end when eff < case lg when 'nar' then 6.57 else 8.84 end then 'middle' else 'rough' end k from r),
tk as (select r2.race_id, lg, pre, k, replace(tt->>'type','三連','3連') typ, ti->>'group' grp, s.value sel from r2, jsonb_array_elements(r2.t) tt, jsonb_array_elements(tt->'tiers') ti, jsonb_array_elements_text(ti->'selections') s
  where k is not null and (tt->>'type', ti->>'group') in (('複勝','本線'),('複勝','穴'),('ワイド','本線'),('ワイド','穴'),('馬連','本線'),('三連複','本線'))),
py as (select r2.race_id, replace(x->>'type','三連','3連') typ, replace(x->>'selection','→','-') sel, max((x->>'payout')::numeric) pay from r2, jsonb_array_elements(r2.p) x where x->>'type' in ('複勝','ワイド','馬連','三連複','3連複') group by 1,2,3),
b as (select race_id, lg, pre, k, typ||grp tg, count(*) pts, sum(coalesce(pay,0)) ret, bool_or(pay is not null) hit from tk left join py using(race_id,typ,sel) group by 1,2,3,4,5),
a as (select lg, pre, k, tg, count(*) n, sum(hit::int) h, sum(pts) pt, sum(ret) rt from b group by 1,2,3,4)
select jsonb_object_agg(lg||'|'||case when pre then 'pre' else 'rebuilt' end||'|'||k||'|'||tg, jsonb_build_array(n,h,pt,rt)) from a;
