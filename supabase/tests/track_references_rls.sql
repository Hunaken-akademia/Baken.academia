-- Read-only access checks; no membership or reference data is modified.
begin;
do $$
declare member_id uuid;
begin
  select auth_user_id into member_id from public.rein_memberships
  where auth_user_id is not null and plan='all' and status='active'
    and access_starts_at <= now() and (access_ends_at is null or access_ends_at > now()) limit 1;
  if member_id is null then raise exception 'Active all-plan member required for verification'; end if;
  perform set_config('request.jwt.claim.sub',member_id::text,true);
end $$;
set local role authenticated;
do $$ begin
  if not exists(select 1 from public.rein_track_references where league='jra')
    or not exists(select 1 from public.rein_track_references where league='nar') then
    raise exception 'Authorized read failed';
  end if;
  if has_table_privilege(current_user,'public.rein_track_references','insert')
    or has_table_privilege(current_user,'public.rein_track_references','update')
    or has_table_privilege(current_user,'public.rein_track_references','delete') then
    raise exception 'Member write privilege leaked';
  end if;
end $$;
reset role;
select set_config('request.jwt.claim.sub','00000000-0000-0000-0000-000000000000',true);
set local role authenticated;
do $$ begin
  if exists(select 1 from public.rein_track_references) then raise exception 'Nonmember read leaked'; end if;
end $$;
reset role;
do $$ begin
  if has_table_privilege('anon','public.rein_track_references','select') then raise exception 'Anonymous read leaked'; end if;
  if not (select relrowsecurity from pg_class where oid='public.rein_track_references'::regclass) then raise exception 'RLS disabled'; end if;
end $$;
rollback;
