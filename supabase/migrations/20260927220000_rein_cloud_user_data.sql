create table if not exists public.rein_saved_predictions (
  user_id uuid not null references auth.users(id) on delete cascade,
  entry_id text not null check (length(entry_id) between 1 and 200),
  prediction jsonb not null check (jsonb_typeof(prediction) = 'object'),
  result jsonb check (result is null or jsonb_typeof(result) = 'array'),
  saved_at timestamptz not null default now(),
  primary key (user_id, entry_id)
);

create index if not exists rein_saved_predictions_user_saved_idx
  on public.rein_saved_predictions (user_id, saved_at desc);

alter table public.rein_saved_predictions enable row level security;
alter table public.rein_saved_predictions force row level security;

create policy "rein users read own saved predictions"
  on public.rein_saved_predictions for select to authenticated
  using ((select auth.uid()) = user_id);
create policy "rein users insert own saved predictions"
  on public.rein_saved_predictions for insert to authenticated
  with check ((select auth.uid()) = user_id);
create policy "rein users append own saved results"
  on public.rein_saved_predictions for update to authenticated
  using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);
create policy "rein users retain own saved predictions"
  on public.rein_saved_predictions for delete to authenticated
  using ((select auth.uid()) = user_id);

revoke all on public.rein_saved_predictions from public, anon;
grant select, insert, delete on public.rein_saved_predictions to authenticated;
grant update (result) on public.rein_saved_predictions to authenticated;

create table if not exists public.rein_horse_notes (
  user_id uuid not null references auth.users(id) on delete cascade,
  horse_id text not null check (horse_id ~ '^[0-9]{1,16}$'),
  note_data jsonb not null check (
    jsonb_typeof(note_data) = 'object'
    and jsonb_typeof(note_data->'note') = 'string'
    and length(note_data->>'note') <= 1200
    and jsonb_typeof(note_data->'watched') = 'boolean'
  ),
  updated_at timestamptz not null default now(),
  primary key (user_id, horse_id)
);

alter table public.rein_horse_notes enable row level security;
alter table public.rein_horse_notes force row level security;

create policy "rein users manage own horse notes"
  on public.rein_horse_notes for all to authenticated
  using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);

revoke all on public.rein_horse_notes from public, anon;
grant select, insert, update, delete on public.rein_horse_notes to authenticated;

create or replace function public.rein_sync_saved_predictions(p_entries jsonb)
returns jsonb
language plpgsql
set search_path = ''
as $function$
declare
  v_user_id uuid := auth.uid();
  v_item jsonb;
  v_prediction jsonb;
  v_result jsonb;
  v_entry_id text;
  v_inserted integer;
  v_saved integer := 0;
  v_results integer := 0;
  v_removed integer := 0;
begin
  if v_user_id is null then
    raise exception 'Authentication required' using errcode = '42501';
  end if;
  if jsonb_typeof(p_entries) <> 'array' or jsonb_array_length(p_entries) > 60 then
    raise exception 'Invalid prediction batch' using errcode = '22023';
  end if;

  for v_item in select value from jsonb_array_elements(p_entries)
  loop
    v_prediction := v_item->'prediction';
    v_entry_id := v_prediction->>'id';
    if jsonb_typeof(v_prediction) <> 'object'
      or v_entry_id is null or length(v_entry_id) not between 1 and 200
      or jsonb_typeof(v_prediction->'horses') <> 'array'
      or jsonb_array_length(v_prediction->'horses') not between 1 and 18
      or jsonb_typeof(v_prediction->'generatedAt') <> 'string'
      or jsonb_typeof(v_prediction->'roster') <> 'string'
      or octet_length(v_prediction::text) > 32768 then
      raise exception 'Invalid saved prediction' using errcode = '22023';
    end if;

    insert into public.rein_saved_predictions (user_id, entry_id, prediction)
    values (v_user_id, v_entry_id, v_prediction)
    on conflict (user_id, entry_id) do nothing;
    get diagnostics v_inserted = row_count;
    v_saved := v_saved + v_inserted;

    v_result := v_item->'result';
    if v_result is not null and v_result <> 'null'::jsonb
      and jsonb_typeof(v_result) = 'array'
      and jsonb_array_length(v_result) = 3
      and (select count(distinct r->>'number') = 3
           and count(distinct r->>'finish') = 3
           and count(*) filter (where r->>'finish' in ('1','2','3')) = 3
           from jsonb_array_elements(v_result) r)
      and not exists (
        select 1 from jsonb_array_elements(v_result) r
        where not exists (
          select 1 from jsonb_array_elements(v_prediction->'horses') h
          where h->>'number' = r->>'number'
        )
      ) then
      update public.rein_saved_predictions p
        set result = v_result
        where p.user_id = v_user_id
          and p.entry_id = v_entry_id
          and p.result is null
          and p.prediction = v_prediction;
      get diagnostics v_inserted = row_count;
      v_results := v_results + v_inserted;
    end if;
  end loop;

  with keep_rows as (
    select entry_id from public.rein_saved_predictions
    where user_id = v_user_id
    order by saved_at desc, entry_id desc
    limit 60
  )
  delete from public.rein_saved_predictions p
  where p.user_id = v_user_id
    and not exists (select 1 from keep_rows k where k.entry_id = p.entry_id);
  get diagnostics v_removed = row_count;

  return jsonb_build_object('inserted', v_saved, 'results_appended', v_results, 'expired', v_removed);
end;
$function$;

revoke all on function public.rein_sync_saved_predictions(jsonb) from public, anon;
grant execute on function public.rein_sync_saved_predictions(jsonb) to authenticated;
