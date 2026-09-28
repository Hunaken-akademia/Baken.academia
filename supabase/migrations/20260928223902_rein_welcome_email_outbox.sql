create table if not exists public.rein_welcome_email_outbox (
  member_key text primary key,
  recipient_email text not null,
  status text not null default 'pending' check (status in ('pending', 'sending', 'sent', 'failed')),
  attempts integer not null default 0 check (attempts >= 0),
  resend_email_id text,
  last_error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  sent_at timestamptz
);

alter table public.rein_welcome_email_outbox enable row level security;
revoke all on public.rein_welcome_email_outbox from anon, authenticated;
grant all on public.rein_welcome_email_outbox to service_role;

create or replace function public.increment_rein_welcome_attempts(target_member_key text)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  affected integer;
begin
  update public.rein_welcome_email_outbox
     set attempts = attempts + 1, updated_at = now()
   where member_key = target_member_key and status = 'sending';
  get diagnostics affected = row_count;
  return affected = 1;
end;
$$;

revoke all on function public.increment_rein_welcome_attempts(text) from public, anon, authenticated;
grant execute on function public.increment_rein_welcome_attempts(text) to service_role;
