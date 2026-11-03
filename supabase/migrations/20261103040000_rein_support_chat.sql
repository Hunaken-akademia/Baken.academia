create table public.rein_chat_threads (
 email text primary key check(email=lower(email)), user_read_id bigint not null default 0,
 admin_read_id bigint not null default 0, last_message_at timestamptz not null default now()
);
create table public.rein_chat_messages (
 id bigint generated always as identity primary key,
 email text not null references public.rein_chat_threads(email),
 request_id uuid not null, sender text not null check(sender in ('user','admin')),
 body text not null check(length(body)<=2000), image_data text check(length(image_data)<=1400000),
 created_at timestamptz not null default now(),
 unique(email,sender,request_id), check(length(trim(body))>0 or image_data is not null)
);
create index rein_chat_messages_email_id on public.rein_chat_messages(email,id desc);
alter table public.rein_chat_threads enable row level security;
alter table public.rein_chat_messages enable row level security;
revoke all on public.rein_chat_threads,public.rein_chat_messages from public,anon,authenticated;
grant select,insert,update on public.rein_chat_threads,public.rein_chat_messages to service_role;
grant usage,select on sequence public.rein_chat_messages_id_seq to service_role;
create view public.rein_chat_inbox with(security_invoker=true) as
select t.*, (select count(*) from public.rein_chat_messages m where m.email=t.email and m.sender='admin' and m.id>t.user_read_id) as user_unread,
(select count(*) from public.rein_chat_messages m where m.email=t.email and m.sender='user' and m.id>t.admin_read_id) as admin_unread,
(select left(m.body,100) from public.rein_chat_messages m where m.email=t.email order by m.id desc limit 1) as preview
from public.rein_chat_threads t;
revoke all on public.rein_chat_inbox from public,anon,authenticated;
grant select on public.rein_chat_inbox to service_role;
create function public.rein_chat_send(p_email text,p_sender text,p_request_id uuid,p_body text,p_image text default null)
returns bigint language plpgsql security invoker set search_path=public,pg_temp as $$
declare existing_id bigint; new_id bigint;
begin
 insert into public.rein_chat_threads(email) values(p_email) on conflict do nothing;
 perform 1 from public.rein_chat_threads where email=p_email for update;
 select id into existing_id from public.rein_chat_messages where email=p_email and sender=p_sender and request_id=p_request_id;
 if existing_id is not null then return existing_id; end if;
 if p_sender='user' and exists(select 1 from public.rein_chat_messages where email=p_email and sender='user' and created_at>now()-interval '5 seconds') then
 raise exception 'CHAT_RATE_LIMIT'; end if;
 insert into public.rein_chat_messages(email,sender,request_id,body,image_data) values(p_email,p_sender,p_request_id,p_body,p_image) returning id into new_id;
 update public.rein_chat_threads set last_message_at=now() where email=p_email;
 return new_id;
end $$;
revoke all on function public.rein_chat_send(text,text,uuid,text,text) from public,anon,authenticated;
grant execute on function public.rein_chat_send(text,text,uuid,text,text) to service_role;
create function public.rein_chat_read(p_email text,p_admin boolean,p_id bigint)
returns void language sql security invoker set search_path=public,pg_temp as $$
 update public.rein_chat_threads set
 user_read_id=case when not p_admin then greatest(user_read_id,p_id) else user_read_id end,
 admin_read_id=case when p_admin then greatest(admin_read_id,p_id) else admin_read_id end
 where email=p_email and exists(select 1 from public.rein_chat_messages where email=p_email and id=p_id);
$$;
revoke all on function public.rein_chat_read(text,boolean,bigint) from public,anon,authenticated;
grant execute on function public.rein_chat_read(text,boolean,bigint) to service_role;
create view public.rein_chat_message_list with(security_invoker=true) as select id,email,sender,body,created_at,image_data is not null as has_image from public.rein_chat_messages;
revoke all on public.rein_chat_message_list from public,anon,authenticated;
grant select on public.rein_chat_message_list to service_role;
