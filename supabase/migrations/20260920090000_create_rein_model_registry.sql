create table if not exists public.rein_model_versions (
  version text primary key,
  status text not null check (status in ('building', 'ready', 'retired', 'failed')),
  storage_bucket text not null default 'baken-archive',
  manifest_path text not null unique,
  schema_version integer not null default 1 check (schema_version > 0),
  trained_through date not null,
  history_through date not null,
  feature_count integer not null check (feature_count > 0),
  model_roles text[] not null default array['first','second','third']::text[],
  artifact_sha256 text not null check (artifact_sha256 ~ '^[0-9a-f]{64}$'),
  artifact_size_bytes bigint not null check (artifact_size_bytes > 0),
  source_repository text not null default 'Hunaken-akademia/Baken.academia',
  source_commit text not null,
  metrics jsonb not null default '{}'::jsonb,
  activated_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.rein_model_versions enable row level security;

create unique index if not exists rein_model_versions_one_active_idx
  on public.rein_model_versions ((status)) where status = 'ready';
create index if not exists rein_model_versions_created_at_idx
  on public.rein_model_versions (created_at desc);

comment on table public.rein_model_versions is
  'Private registry for immutable REIN model/profile bundles stored in Supabase Storage. Service-role access only; no public RLS policies.';

create or replace function public.set_rein_model_versions_updated_at()
returns trigger language plpgsql set search_path = '' as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists set_rein_model_versions_updated_at on public.rein_model_versions;
create trigger set_rein_model_versions_updated_at
before update on public.rein_model_versions
for each row execute function public.set_rein_model_versions_updated_at();

create or replace function public.activate_rein_model_version(
  p_version text, p_manifest_path text, p_trained_through date,
  p_history_through date, p_feature_count integer, p_artifact_sha256 text,
  p_artifact_size_bytes bigint, p_source_commit text,
  p_metrics jsonb default '{}'::jsonb
)
returns public.rein_model_versions
language plpgsql security definer set search_path = '' as $$
declare activated public.rein_model_versions;
begin
  if p_version !~ '^rein-role-v4-[0-9a-f]{7,40}$' then
    raise exception 'invalid REIN model version';
  end if;
  if p_manifest_path <> 'rein/models/v4/' || p_version || '/manifest.json' then
    raise exception 'invalid manifest path';
  end if;
  update public.rein_model_versions set status = 'retired', updated_at = now()
    where status = 'ready' and version <> p_version;
  insert into public.rein_model_versions (
    version, status, manifest_path, trained_through, history_through,
    feature_count, artifact_sha256, artifact_size_bytes, source_commit,
    metrics, activated_at
  ) values (
    p_version, 'ready', p_manifest_path, p_trained_through, p_history_through,
    p_feature_count, p_artifact_sha256, p_artifact_size_bytes, p_source_commit,
    coalesce(p_metrics, '{}'::jsonb), now()
  ) on conflict (version) do update set
    status = 'ready', manifest_path = excluded.manifest_path,
    trained_through = excluded.trained_through,
    history_through = excluded.history_through,
    feature_count = excluded.feature_count,
    artifact_sha256 = excluded.artifact_sha256,
    artifact_size_bytes = excluded.artifact_size_bytes,
    source_commit = excluded.source_commit, metrics = excluded.metrics,
    activated_at = now(), updated_at = now()
  returning * into activated;
  return activated;
end;
$$;

revoke all on function public.activate_rein_model_version(text,text,date,date,integer,text,bigint,text,jsonb)
  from public, anon, authenticated;
grant execute on function public.activate_rein_model_version(text,text,date,date,integer,text,bigint,text,jsonb)
  to service_role;
