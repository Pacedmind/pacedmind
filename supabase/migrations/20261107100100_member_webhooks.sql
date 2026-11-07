-- Webhooks for the people in a team workspace: each member can have PacedMind call their own https address when a
-- task of the workspace is assigned to them, changes status (theirs, or one they wrote), or is created. The
-- database sends them itself, so no server holds a key:
--
-- 1. member_webhooks: a member's own webhooks in a workspace. The secret is made here, shown once to its owner by
--    set_webhook and never readable afterwards; every call carries X-PacedMind-Signature: sha256=<HMAC-SHA256 of
--    the body with the secret, hex>, X-PacedMind-Event and X-PacedMind-Delivery.
-- 2. webhook_deliveries: the outbox. Triggers on tasks add a row per webhook that wants the event; the row is handed
--    to pg_net (net.http_post), which sends it after the transaction commits. Where pg_net isn't installed the rows
--    wait as pending, and private.send_webhook_deliveries() sends them once it is.
-- 3. What's sent is the task's key, title, status, priority, dates and who it's assigned to and by: never its
--    description, sub-tasks, reports or anything personal. Addresses are https on a public name: no IP addresses,
--    ports, credentials, localhost or internal names. When a member leaves, their webhooks go.

do $$
begin
  if exists (select 1 from pg_available_extensions where name = 'pg_net') then
    create extension if not exists pg_net;
  end if;
end $$;

/* ---------- 1. a member's webhooks ---------- */

create table public.member_webhooks (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null,
  user_id uuid not null default auth.uid(),
  url text not null check (
    char_length(url) between 12 and 2000
    and url ~ '^https://[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*\.[a-z]{2,63}(?:/[^[:space:][:cntrl:]]*)?$'
  ),
  secret text not null check (secret ~ '^[0-9a-f]{64}$'),
  events text[] not null check (cardinality(events) between 1 and 3 and events <@ array['task.assigned', 'task.status_changed', 'task.created']),
  enabled boolean not null default true,
  created_at timestamptz not null default now(),
  unique (user_id, id),
  -- A webhook belongs to a member: leaving the workspace deletes it.
  foreign key (workspace_id, user_id) references public.workspace_members (workspace_id, user_id) on delete cascade
);

create index member_webhooks_workspace_idx on public.member_webhooks (workspace_id, user_id);

create table public.webhook_deliveries (
  id bigint generated always as identity primary key,
  -- The webhook's owner, who receives it.
  user_id uuid not null references auth.users (id) on delete cascade,
  webhook_id uuid not null,
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  event text not null check (event in ('task.assigned', 'task.status_changed', 'task.created')),
  task_id bigint,
  payload jsonb not null check (jsonb_typeof(payload) = 'object' and octet_length(payload::text) <= 8000),
  status text not null default 'pending' check (status in ('pending', 'queued', 'failed')),
  -- pg_net's request id, to find its response in net._http_response.
  request_id bigint,
  created_at timestamptz not null default now(),
  sent_at timestamptz,
  foreign key (user_id, webhook_id) references public.member_webhooks (user_id, id) on delete cascade
);

create index webhook_deliveries_webhook_idx on public.webhook_deliveries (user_id, webhook_id, created_at desc);
create index webhook_deliveries_pending_idx on public.webhook_deliveries (id) where status = 'pending';

revoke all on public.member_webhooks, public.webhook_deliveries from anon;
revoke all on sequence public.webhook_deliveries_id_seq from anon, authenticated;
revoke insert, update, delete, truncate, references, trigger on public.member_webhooks, public.webhook_deliveries from authenticated;
-- The secret stays out of every read.
revoke select on public.member_webhooks from authenticated;
grant select (id, workspace_id, user_id, url, events, enabled, created_at) on public.member_webhooks to authenticated;

alter table public.member_webhooks enable row level security;
alter table public.webhook_deliveries enable row level security;

create policy "Own webhooks" on public.member_webhooks for select to authenticated
  using ((select auth.uid()) = user_id and workspace_id = any ((select private.my_workspaces())::uuid[]));
create policy "Own deliveries" on public.webhook_deliveries for select to authenticated
  using ((select auth.uid()) = user_id);
create policy "Two-factor session" on public.member_webhooks as restrictive for all to authenticated
  using ((select private.planner_session_ok()) or (select private.agent_ok()))
  with check ((select private.planner_session_ok()) or (select private.agent_ok()));
create policy "Two-factor session" on public.webhook_deliveries as restrictive for all to authenticated
  using ((select private.planner_session_ok()) or (select private.agent_ok()))
  with check ((select private.planner_session_ok()) or (select private.agent_ok()));

create trigger member_webhooks_bump after insert or update or delete on public.member_webhooks
  for each row execute function private.bump_version();

/* ---------- signing ---------- */

-- HMAC-SHA256 (RFC 2104) from PostgreSQL's own sha256, so it runs wherever the schema does.
create function private.hmac_sha256(key bytea, message bytea) returns bytea
language plpgsql immutable set search_path = '' as $$
declare
  k bytea := key;
  inner_pad bytea;
  outer_pad bytea;
  i integer;
begin
  if length(k) > 64 then k := sha256(k); end if;
  k := k || decode(repeat('00', 64 - length(k)), 'hex');
  inner_pad := k;
  outer_pad := k;
  for i in 0..63 loop
    inner_pad := set_byte(inner_pad, i, get_byte(k, i) # 54);
    outer_pad := set_byte(outer_pad, i, get_byte(k, i) # 92);
  end loop;
  return sha256(outer_pad || sha256(inner_pad || message));
end $$;

-- Whether the address is a public https name: no IP literal, port, credentials, localhost or internal name.
create function private.webhook_url_ok(url text) returns boolean
language sql immutable set search_path = '' as $$
  select url ~ '^https://[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*\.[a-z]{2,63}(?:/[^[:space:][:cntrl:]]*)?$'
    and split_part(split_part(substr(url, 9), '/', 1), '?', 1) !~ '(^|\.)(localhost|local|internal|intranet|lan|home|corp|localdomain|home\.arpa|in-addr\.arpa|ip6\.arpa)$'
    and split_part(substr(url, 9), '/', 1) !~ '^[0-9.]+$'
$$;

/* ---------- 2. sending ---------- */

-- Hands one delivery to pg_net, signed. Without pg_net it stays pending.
create function private.send_webhook_delivery(delivery bigint) returns void
language plpgsql security definer set search_path = '' as $$
declare
  d public.webhook_deliveries;
  w public.member_webhooks;
  v_request bigint;
begin
  if not exists (select 1 from pg_catalog.pg_proc p join pg_catalog.pg_namespace n on n.oid = p.pronamespace
                 where n.nspname = 'net' and p.proname = 'http_post') then
    return;
  end if;
  select * into d from public.webhook_deliveries x where x.id = delivery and x.status = 'pending' for update;
  if not found then return; end if;
  select * into w from public.member_webhooks x where x.id = d.webhook_id and x.user_id = d.user_id;
  if not found or not w.enabled or not private.webhook_url_ok(w.url) then
    update public.webhook_deliveries x set status = 'failed' where x.id = d.id;
    return;
  end if;
  -- pg_net sends the jsonb as its text, so the signature is over exactly that.
  execute 'select net.http_post(url := $1, body := $2, headers := $3, timeout_milliseconds := 5000)'
    into v_request
    using w.url, d.payload, jsonb_build_object(
      'Content-Type', 'application/json',
      'User-Agent', 'PacedMind-Webhooks/1',
      'X-PacedMind-Event', d.event,
      'X-PacedMind-Delivery', d.id::text,
      'X-PacedMind-Signature', 'sha256=' || encode(private.hmac_sha256(convert_to(w.secret, 'UTF8'), convert_to(d.payload::text, 'UTF8')), 'hex')
    );
  update public.webhook_deliveries x set status = 'queued', request_id = v_request, sent_at = now() where x.id = d.id;
end $$;

-- Sends what waits (pending deliveries of the last day, oldest first), for when pg_net is installed later or a cron
-- job runs it. Answers how many it handed over.
create function private.send_webhook_deliveries() returns integer
language plpgsql security definer set search_path = '' as $$
declare
  r record;
  n integer := 0;
begin
  for r in select x.id from public.webhook_deliveries x
           where x.status = 'pending' and x.created_at > now() - interval '1 day' order by x.id limit 500 loop
    perform private.send_webhook_delivery(r.id);
    n := n + 1;
  end loop;
  return n;
end $$;

create function private.webhook_delivery_added() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  perform private.send_webhook_delivery(new.id);
  return null;
end $$;

create trigger webhook_deliveries_send after insert on public.webhook_deliveries
  for each row execute function private.webhook_delivery_added();

/* ---------- 3. what triggers them ---------- */

-- A shared task was created, assigned to someone, or changed status: a delivery for each webhook that wants it.
-- Created: every member's; assigned: the new assignee's; status: the assignee's and the author's.
create function private.task_webhooks() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  v_payload jsonb;
  v_actor uuid := auth.uid();
  v_ws public.workspaces;
  v_event text;
  v_people uuid[];
begin
  if new.workspace_id is null then return null; end if;
  if not exists (select 1 from public.member_webhooks h where h.workspace_id = new.workspace_id and h.enabled) then
    return null;
  end if;
  select * into v_ws from public.workspaces w where w.id = new.workspace_id;
  foreach v_event in array array['task.created', 'task.assigned', 'task.status_changed'] loop
    v_people := case v_event
      when 'task.created' then case when tg_op = 'INSERT' then
        (select array_agg(m.user_id) from public.workspace_members m where m.workspace_id = new.workspace_id) end
      when 'task.assigned' then case when new.assignee_id is not null
        and (tg_op = 'INSERT' or new.assignee_id is distinct from old.assignee_id) then array[new.assignee_id] end
      else case when tg_op = 'UPDATE' and new.status is distinct from old.status then
        array_remove(array[new.assignee_id, case when new.user_id is distinct from new.assignee_id then new.user_id end], null) end
    end;
    continue when v_people is null or cardinality(v_people) = 0;
    v_payload := jsonb_build_object(
      'event', v_event,
      'at', to_char(now() at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'),
      'workspace', jsonb_build_object('id', v_ws.id, 'name', v_ws.name, 'slug', v_ws.slug),
      'task', jsonb_build_object(
        'id', new.id, 'key', new.key, 'title', new.title, 'status', new.status, 'priority', new.priority,
        'due_date', new.due_date, 'planned_date', new.planned_date, 'area_id', new.area_id, 'project_id', new.project_id,
        'previous_status', case when tg_op = 'UPDATE' then old.status end,
        'assignee', (select jsonb_build_object('id', m.user_id, 'name', m.name, 'email', m.email)
                     from public.workspace_members m where m.workspace_id = new.workspace_id and m.user_id = new.assignee_id),
        'author', (select jsonb_build_object('id', m.user_id, 'name', m.name)
                   from public.workspace_members m where m.workspace_id = new.workspace_id and m.user_id = new.user_id)
      ),
      'actor', (select jsonb_build_object('id', m.user_id, 'name', m.name)
                from public.workspace_members m where m.workspace_id = new.workspace_id and m.user_id = v_actor)
    );
    insert into public.webhook_deliveries (user_id, webhook_id, workspace_id, event, task_id, payload)
      select h.user_id, h.id, h.workspace_id, v_event, new.id, v_payload
      from public.member_webhooks h
      where h.workspace_id = new.workspace_id and h.enabled and h.user_id = any (v_people) and v_event = any (h.events);
  end loop;
  return null;
end $$;

create trigger tasks_webhooks after insert or update of assignee_id, status on public.tasks
  for each row execute function private.task_webhooks();

/* ---------- 4. what the app calls ---------- */

-- Adds a webhook (no id) and answers its secret, once; or changes one of the caller's own (its address, events, or
-- whether it's on). At most ten per member and workspace.
create function public.set_webhook(ws uuid, hook_url text, hook_events text[], hook uuid default null, hook_enabled boolean default true)
returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_user uuid := auth.uid();
  v_url text := btrim(coalesce(hook_url, ''));
  v_host text;
  v_events text[];
  v_secret text;
  v_id uuid;
begin
  if v_user is null or not private.planner_or_agent() or not private.is_workspace_member(ws, v_user) then
    raise exception 'Only the workspace''s members add webhooks to it.' using errcode = '42501';
  end if;
  -- The host is kept in lowercase; the path as given.
  if lower(left(v_url, 8)) = 'https://' then
    v_host := split_part(substr(v_url, 9), '/', 1);
    v_url := 'https://' || lower(v_host) || substr(v_url, 9 + char_length(v_host));
  end if;
  if not private.webhook_url_ok(v_url) or char_length(v_url) > 2000 then
    raise exception 'A webhook''s address is https on a public name, without a port or credentials.' using errcode = '22023';
  end if;
  select coalesce(array_agg(distinct e order by e), '{}') into v_events from unnest(coalesce(hook_events, '{}')) e;
  if cardinality(v_events) = 0 or not v_events <@ array['task.assigned', 'task.status_changed', 'task.created'] then
    raise exception 'Choose events from task.assigned, task.status_changed and task.created.' using errcode = '22023';
  end if;
  if hook is null then
    if (select count(*) from public.member_webhooks h where h.workspace_id = ws and h.user_id = v_user) >= 10 then
      raise exception 'You have ten webhooks in this workspace already.' using errcode = '54000';
    end if;
    v_secret := encode(sha256(convert_to(gen_random_uuid()::text || gen_random_uuid()::text || clock_timestamp()::text, 'UTF8')), 'hex');
    insert into public.member_webhooks (workspace_id, user_id, url, secret, events, enabled)
      values (ws, v_user, v_url, v_secret, v_events, coalesce(hook_enabled, true))
      returning id into v_id;
    return jsonb_build_object('id', v_id, 'secret', v_secret, 'url', v_url, 'events', to_jsonb(v_events));
  end if;
  update public.member_webhooks h set url = v_url, events = v_events, enabled = coalesce(hook_enabled, h.enabled)
    where h.id = hook and h.user_id = v_user and h.workspace_id = ws
    returning h.id into v_id;
  if v_id is null then
    raise exception 'That webhook isn''t one of yours.' using errcode = 'P0002';
  end if;
  return jsonb_build_object('id', v_id, 'url', v_url, 'events', to_jsonb(v_events));
end $$;

create function public.delete_webhook(hook uuid) returns void
language plpgsql security definer set search_path = '' as $$
begin
  if auth.uid() is null or not private.planner_or_agent() then
    raise exception 'Sign in to PacedMind Cloud first.' using errcode = '42501';
  end if;
  delete from public.member_webhooks h where h.id = hook and h.user_id = auth.uid();
  if not found then
    raise exception 'That webhook isn''t one of yours.' using errcode = 'P0002';
  end if;
end $$;

revoke execute on function private.hmac_sha256(bytea, bytea), private.webhook_url_ok(text), private.send_webhook_delivery(bigint),
  private.send_webhook_deliveries(), private.webhook_delivery_added(), private.task_webhooks()
  from public, anon, authenticated;
revoke execute on function public.set_webhook(uuid, text, text[], uuid, boolean), public.delete_webhook(uuid) from public, anon;
grant execute on function public.set_webhook(uuid, text, text[], uuid, boolean), public.delete_webhook(uuid) to authenticated;
