begin;
do $test$
declare jra integer; nar integer;
begin
 if has_table_privilege('anon','public.rein_nar_model_releases','SELECT') or has_table_privilege('authenticated','public.rein_nar_model_releases','UPDATE') then raise exception 'Model profile exposed'; end if;
 if has_function_privilege('authenticated','public.rein_area_journal_summary(text)','EXECUTE') then raise exception 'History RPC exposed'; end if;
 if not exists(select 1 from pg_class where oid='public.rein_nar_model_releases'::regclass and relrowsecurity and relforcerowsecurity) then raise exception 'RLS not enforced'; end if;
 insert into public.rein_schedule_snapshots(race_date,league,payload) values('2099-01-01','jra','{"venues":[]}'),('2099-01-01','nar','{"venues":[]}');
 if (select count(*) from public.rein_schedule_snapshots where race_date='2099-01-01')<>2 then raise exception 'Schedules collide'; end if;
 jra := (public.rein_area_journal_summary('jra')->>'races')::int;
 nar := (public.rein_area_journal_summary('nar')->>'races')::int;
 insert into public.rein_prediction_history(race_id,generated_at,race_date,entry) values('209901011901','2099-01-01 01:00+00','2099-01-01','{"roster":"1-2-3","horses":[{"number":1,"popularity":1,"firstProbability":0.5,"secondProbability":0.2,"thirdProbability":0.1},{"number":2,"popularity":2,"firstProbability":0.3,"secondProbability":0.5,"thirdProbability":0.3},{"number":3,"popularity":3,"firstProbability":0.2,"secondProbability":0.3,"thirdProbability":0.6}]}');
 insert into public.rein_race_outcomes(race_id,race_date,roster,finishers) values('209901011901','2099-01-01','1-2-3','[{"number":1,"finish":1},{"number":2,"finish":2},{"number":3,"finish":3}]');
 if (public.rein_area_journal_summary('jra')->>'races')::int<>jra then raise exception 'NAR contaminated JRA'; end if;
 if (public.rein_area_journal_summary('nar')->>'races')::int<>nar+1 then raise exception 'NAR not counted'; end if;
 if public.rein_shared_journal_summary()<>public.rein_area_journal_summary('jra') then raise exception 'Legacy summary no longer JRA'; end if;
end $test$;
rollback;
