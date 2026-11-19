-- REIN の BOOKERS 会員向け「合言葉」方式の利用権付与（WAKE の bookers_access_codes と同じ仕組み）。
-- BOOKERS には加入・解約を外へ知らせる仕組みが無いため、各プランの会員限定記事に毎月の合言葉を載せ、
-- 会員が REIN で入力すると rein_memberships に利用権（翌月1日0時まで）が付く。
-- WAKE の合言葉と取り違えないよう、表は REIN 専用に分ける。すべてサーバー（service_role）からだけ読み書きする。

create table if not exists public.rein_bookers_access_codes (
  id uuid primary key default gen_random_uuid(),
  plan text not null check (plan in ('nar','jra','all')),
  month text not null check (month ~ '^[0-9]{4}-[0-9]{2}$'),
  code text not null,
  valid_until timestamptz not null,
  created_at timestamptz not null default now(),
  retired_at timestamptz,
  post_synced_at timestamptz,
  post_error text
);
create unique index if not exists rein_bookers_access_codes_code_key on public.rein_bookers_access_codes (code);
create unique index if not exists rein_bookers_access_codes_current_key on public.rein_bookers_access_codes (plan, month) where retired_at is null;

create table if not exists public.rein_bookers_code_posts (
  plan text primary key check (plan in ('nar','jra','all')),
  post_uuid text not null check (post_uuid ~ '^[0-9a-f-]{36}$'),
  updated_at timestamptz not null default now()
);

create table if not exists public.rein_bookers_redemptions (
  id uuid primary key default gen_random_uuid(),
  code_id uuid not null references public.rein_bookers_access_codes(id) on delete cascade,
  user_id uuid not null,
  email text not null,
  plan text not null,
  month text not null,
  expires_at timestamptz not null,
  redeemed_at timestamptz not null default now(),
  revoked_at timestamptz,
  unique (user_id, code_id)
);
create index if not exists rein_bookers_redemptions_recent_idx on public.rein_bookers_redemptions (redeemed_at desc);

create table if not exists public.rein_bookers_code_attempts (
  id bigint generated always as identity primary key,
  user_id uuid not null,
  ok boolean not null,
  at timestamptz not null default now()
);
create index if not exists rein_bookers_code_attempts_user_idx on public.rein_bookers_code_attempts (user_id, at desc);

alter table public.rein_bookers_access_codes enable row level security;
alter table public.rein_bookers_code_posts enable row level security;
alter table public.rein_bookers_redemptions enable row level security;
alter table public.rein_bookers_code_attempts enable row level security;
revoke all on public.rein_bookers_access_codes, public.rein_bookers_code_posts, public.rein_bookers_redemptions, public.rein_bookers_code_attempts from anon, authenticated;
grant select, insert, update, delete on public.rein_bookers_access_codes, public.rein_bookers_code_posts, public.rein_bookers_redemptions, public.rein_bookers_code_attempts to service_role;
grant usage, select on sequence public.rein_bookers_code_attempts_id_seq to service_role;

-- BOOKERS の会員限定記事（合言葉記事）。毎月の合言葉は cron（/api/cron/rein-bookers-codes）がこの記事に書き込む。
insert into public.rein_bookers_code_posts (plan, post_uuid) values
  ('nar', '6d9a03de-21ee-4287-ae8f-76223ae8037c'),
  ('jra', '8e10de88-c5e1-463a-99cc-d414ee3c63db'),
  ('all', '469066b9-3422-47a1-9d22-ae8d036a9f25')
on conflict (plan) do nothing;
