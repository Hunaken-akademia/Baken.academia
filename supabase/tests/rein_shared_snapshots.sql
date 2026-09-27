-- Transactional checks: leave no synthetic forecasts, outcomes, locks or users behind.
begin;
set local role service_role;
do $test$
declare r jsonb; h jsonb; token1 uuid; token2 uuid; s jsonb; before_count bigint;
begin
 if has_table_privilege('anon','public.rein_race_snapshots','select') or
    has_table_privilege('authenticated','public.rein_prediction_history','insert') or
    has_function_privilege('authenticated','public.rein_store_race_snapshot(jsonb)','execute') then
  raise exception 'Shared storage grants are too broad';
 end if;
 token1 := public.rein_acquire_capture('race:qa-transaction',30);
 token2 := public.rein_acquire_capture('race:qa-transaction',30);
 if token1 is null or token2 is not null then raise exception 'Lease failed to exclude a second writer'; end if;
 select jsonb_agg(jsonb_build_object('number',n,'name','test','popularity',11-n,'odds',2,'firstProbability',0.1,'secondProbability',0.1,'thirdProbability',0.1) order by n) into h from generate_series(1,10) n;
 s := public.rein_shared_journal_summary(); before_count := (s->>'races')::bigint;
 r := jsonb_build_object('race_id','0000000091','slot','live','race_date','2026-09-27','generated_at','2026-09-27T04:00:00Z','starts_at','2026-09-27T06:00:00Z','is_final',false,'prestart',true,'payload',jsonb_build_object('marker','before'),'roster','1-2-3-4-5-6-7-8-9-10','journal',jsonb_build_object('raceId','0000000091','generatedAt','2026-09-27T04:00:00Z','roster','1-2-3-4-5-6-7-8-9-10','horses',h));
 perform public.rein_store_race_snapshot(r);
 perform public.rein_store_race_snapshot(r);
 if (select count(*) from public.rein_prediction_history where race_id='0000000091')<>1 then raise exception 'Duplicate forecast was appended'; end if;
 r := r || jsonb_build_object('is_final',true,'prestart',false,'payload',jsonb_build_object('marker','final'),'result','[{"number":1,"finish":1},{"number":2,"finish":2},{"number":3,"finish":3}]'::jsonb);
 perform public.rein_store_race_snapshot(r);
 -- A delayed prestart write cannot replace the final snapshot.
 perform public.rein_store_race_snapshot(r || jsonb_build_object('is_final',false,'payload',jsonb_build_object('marker','late')));
 if (select payload->>'marker' from public.rein_race_snapshots where race_id='0000000091' and slot='live')<>'final' then raise exception 'Final snapshot regressed'; end if;
 if (select payload->>'marker' from public.rein_race_snapshots where race_id='0000000091' and slot='prestart')<>'before' then raise exception 'Prestart forecast was overwritten'; end if;
 if (select entry ? 'finishers' from public.rein_prediction_history where race_id='0000000091') then raise exception 'Result mutated forecast'; end if;
 s := public.rein_shared_journal_summary();
 if (s->>'races')::bigint<>before_count+1 then raise exception 'Completed race did not enter summary'; end if;
 -- Changed runner sets (e.g. cancellation) are excluded even with a valid result.
 perform public.rein_store_race_snapshot(r || jsonb_build_object('roster','1-2-3'));
 s := public.rein_shared_journal_summary();
 if (s->>'races')::bigint<>before_count then raise exception 'Changed roster entered summary'; end if;
end $test$;
rollback;
select 'snapshot immutability, result matching, duplicate lease and permissions passed' as verification;
