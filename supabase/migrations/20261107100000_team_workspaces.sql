-- Team workspaces: a company shares areas with its people, and everything in a shared area (projects, tasks,
-- sub-tasks, dependencies, and the reports and images agents hand back) is shared with every member. Everything
-- else stays exactly as private as before: personal areas, calendar events, sessions, computers, settings,
-- preferences, copies.
--
-- 1. workspaces, workspace_members (owner, admin, member), workspace_invites (a link for one email address, kept
--    only as a SHA-256 digest of its token) and workspace_domains (people whose confirmed email address is at the
--    domain may join as members without an invitation). Only the functions below change them.
-- 2. A shared row carries workspace_id, which the database derives from its area, project or task; user_id stays
--    its author. The composite foreign keys onto (user_id, id) couldn't hold a row written by one member under a
--    parent written by another, so references to areas, projects and tasks become plain foreign keys, and triggers
--    keep the guarantee they gave: a personal row only points at the same account's personal rows, a shared row
--    only at rows of its own workspace, and a personal row (an event, a session, a request) at a shared one only
--    while its account is a member. A task stays in its workspace once it's there.
-- 3. Row level security: personal rows as before, shared rows for the workspace's members. Only owners and admins
--    create, change, share or delete shared areas; members work on everything inside them. Reports and images are
--    changed only by their author. The restrictive two-factor policies stay as they are.
-- 4. Task keys in a workspace come from the workspace's own counters, and an area's key is unique in it, so two
--    members never get the same key. A task can be assigned to a member of its workspace (a personal task only to
--    its owner).
-- 5. Billing: writes to a workspace's rows are allowed while one of its owners' Cloud is (the owner pays for the
--    team); personal rows keep each account's own rule.
-- 6. Deleting an account keeps what it wrote in its workspaces (under an owner); a workspace's last owner can't
--    delete the account or leave while others are in it; a workspace that loses its last member goes with it.
--    Copies of an account (Settings > Data) hold and replace only its personal data.

/* ---------- 1. workspaces and who is in them ---------- */

create table public.workspaces (
  id uuid primary key default gen_random_uuid(),
  name text not null check (char_length(name) between 1 and 80 and name !~ '[[:cntrl:]]'),
  slug text not null unique check (slug ~ '^[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?$'),
  created_by uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now()
);

create table public.workspace_members (
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  user_id uuid not null references auth.users (id) on delete cascade,
  role text not null check (role in ('owner', 'admin', 'member')),
  -- How the member appears to the others: a snapshot taken when they joined.
  name text not null check (char_length(name) between 1 and 120 and name !~ '[[:cntrl:]]'),
  email text not null check (char_length(email) <= 320 and email = lower(email)),
  joined_via text not null check (joined_via in ('created', 'invite', 'domain')),
  joined_at timestamptz not null default now(),
  primary key (workspace_id, user_id)
);

create index workspace_members_user_idx on public.workspace_members (user_id);

create table public.workspace_invites (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  -- Only an account whose confirmed email address is this one can accept it.
  email text not null check (char_length(email) between 3 and 320 and email = lower(email) and email ~ '^[^@[:space:]]+@[^@[:space:]]+$'),
  role text not null default 'member' check (role in ('admin', 'member')),
  -- The token itself is shown once, to whoever invited; only its digest stays, and no client can read even that.
  token_digest text not null unique check (token_digest ~ '^[0-9a-f]{64}$'),
  invited_by uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null default now() + interval '14 days',
  accepted_at timestamptz,
  accepted_by uuid references auth.users (id) on delete set null,
  revoked_at timestamptz
);

create index workspace_invites_workspace_idx on public.workspace_invites (workspace_id, created_at desc);

create table public.workspace_domains (
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  domain text not null unique check (
    char_length(domain) between 3 and 253
    and domain ~ '^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*\.[a-z]{2,63}$'
  ),
  added_by uuid references auth.users (id) on delete set null,
  added_at timestamptz not null default now(),
  primary key (workspace_id, domain)
);

-- An explicit removal requires a new invitation, even if the old member still has a confirmed team address.
create table private.workspace_removals (
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  user_id uuid not null references auth.users (id) on delete cascade,
  removed_at timestamptz not null default clock_timestamp(),
  primary key (workspace_id, user_id)
);
alter table private.workspace_removals enable row level security;
revoke all on private.workspace_removals from public, anon, authenticated, service_role;

-- Task numbers per workspace and key prefix (key_counters holds each account's own).
create table private.workspace_key_counters (
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  prefix text not null,
  last integer not null,
  primary key (workspace_id, prefix)
);
alter table private.workspace_key_counters enable row level security;
revoke all on private.workspace_key_counters from public, anon, authenticated;

/* ---------- helpers ---------- */

-- The workspaces the signed-in account is in, and those it manages: one lookup per statement in the policies.
create function private.my_workspaces() returns uuid[]
language sql stable security definer set search_path = '' as $$
  select coalesce(array_agg(m.workspace_id), '{}') from public.workspace_members m where m.user_id = auth.uid()
$$;

create function private.my_admin_workspaces() returns uuid[]
language sql stable security definer set search_path = '' as $$
  select coalesce(array_agg(m.workspace_id), '{}') from public.workspace_members m
  where m.user_id = auth.uid() and m.role in ('owner', 'admin')
$$;

create function private.workspace_role(ws uuid, who uuid) returns text
language sql stable security definer set search_path = '' as $$
  select m.role from public.workspace_members m where m.workspace_id = ws and m.user_id = who
$$;

create function private.is_workspace_member(ws uuid, who uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.workspace_members m where m.workspace_id = ws and m.user_id = who)
$$;

-- Whether a row of `actor` may point at a parent owned by `owner` in workspace `ws` (null: personal).
create function private.can_reference(owner uuid, ws uuid, actor uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select case when ws is null then owner = actor else private.is_workspace_member(ws, actor) end
$$;

-- A person's or an agent's planner session (the restrictive policies' rule), for the functions below.
create function private.planner_or_agent() returns boolean
language sql stable security definer set search_path = '' as $$
  select private.planner_session_ok() or private.agent_ok()
$$;

-- The account's email address, only once it's confirmed (Google sign-in confirms it), lowercase.
create function private.verified_email(who uuid) returns text
language sql stable security definer set search_path = '' as $$
  select lower(u.email) from auth.users u where u.id = who and u.email_confirmed_at is not null and u.email like '%_@_%'
$$;

-- A second, verified address for team admission. It grants no right to sign in to the account.
create table private.work_emails (
  user_id uuid primary key references auth.users(id) on delete cascade,
  email text not null unique
);

create table private.work_email_codes (
  user_id uuid not null references auth.users(id) on delete cascade,
  email text not null,
  digest text not null,
  requested_at timestamptz not null,
  attempts integer not null default 0,
  consumed boolean not null default false,
  primary key (user_id, requested_at)
);
create index work_email_codes_by_address on private.work_email_codes (email, requested_at);
create index work_email_codes_by_time on private.work_email_codes (requested_at);

alter table private.work_emails enable row level security;
alter table private.work_email_codes enable row level security;
revoke all on private.work_emails, private.work_email_codes from public, anon, authenticated, service_role;

-- A confirmed login address takes precedence if it becomes another account's primary address.
create function private.workspace_addresses(who uuid) returns table (email text, is_work boolean)
language sql stable security definer set search_path = '' as $$
  select p.email, false from (select private.verified_email(who) as email) p where p.email is not null
  union all
  select e.email, true from private.work_emails e
  where e.user_id = who and not exists (
    select 1 from auth.users u where u.email_confirmed_at is not null and lower(u.email) = e.email
  )
$$;

create function private.get_work_email() returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  v_user uuid := auth.uid();
begin
  if v_user is null or not private.planner_session_ok() then
    raise exception 'Sign in to manage your work email.' using errcode = '42501';
  end if;
  return jsonb_build_object(
    'user_id', v_user,
    'email', (select e.email from private.workspace_addresses(v_user) e where e.is_work),
    'pending_email', (
      select c.email from private.work_email_codes c
      where c.user_id = v_user and not c.consumed and c.attempts < 5
        and c.requested_at > now() - interval '15 minutes'
      order by c.requested_at desc limit 1
    )
  );
end $$;

-- Only the mail function can set the expected proof. It authenticates the caller with get_work_email().
create function private.issue_work_email_code(account uuid, target_email text, code_digest text) returns text
language plpgsql security definer set search_path = '' as $$
declare
  v_email text := lower(btrim(coalesce(target_email, '')));
  v_now timestamptz;
begin
  if char_length(v_email) > 254 or
     v_email !~ '^[a-z0-9._+!#$%&''*=/^?{|}~-]{1,64}@[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*\.[a-z]{2,63}$' then
    raise exception 'Enter a valid work email address.' using errcode = '22023';
  end if;
  if code_digest is null or code_digest !~ '^[0-9a-f]{64}$' then
    raise exception 'Invalid verification proof.' using errcode = '22023';
  end if;
  if exists (select 1 from private.workspace_addresses(account) e where e.email = v_email) then
    raise exception 'This email is already confirmed on your account.' using errcode = '22023';
  end if;
  perform pg_advisory_xact_lock(hashtextextended('work-email-account:' || account::text, 0));
  perform pg_advisory_xact_lock(hashtextextended('work-email-address:' || v_email, 0));
  v_now := clock_timestamp();
  if exists (select 1 from private.work_email_codes c
             where c.user_id = account and c.requested_at > v_now - interval '1 minute')
     or (select count(*) from private.work_email_codes c
         where c.user_id = account and c.requested_at > v_now - interval '1 hour') >= 5
     or (select count(*) from private.work_email_codes c
         where c.email = v_email and c.requested_at > v_now - interval '1 hour') >= 5 then
    raise exception 'Too many codes requested. Try again later.' using errcode = 'PT429';
  end if;
  delete from private.work_email_codes where requested_at <= v_now - interval '1 day';
  update private.work_email_codes set consumed = true where user_id = account and not consumed;
  insert into private.work_email_codes (user_id, email, digest, requested_at) values (account, v_email, code_digest, v_now);
  return v_email;
end $$;

create function private.confirm_work_email(target_email text, code text) returns text
language plpgsql security definer set search_path = '' as $$
declare
  v_user uuid := auth.uid();
  v_code text := case when char_length(coalesce(code, '')) <= 20
    then upper(regexp_replace(coalesce(code, ''), '[-[:space:]]', '', 'g')) else '' end;
  v_pending private.work_email_codes;
begin
  if v_user is null or not private.planner_session_ok() then
    raise exception 'Sign in to manage your work email.' using errcode = '42501';
  end if;
  perform pg_advisory_xact_lock(hashtextextended('work-email-account:' || v_user::text, 0));
  select * into v_pending from private.work_email_codes c
  where c.user_id = v_user and not c.consumed
  order by c.requested_at desc limit 1;
  if not found or v_pending.email is distinct from lower(btrim(target_email))
     or v_pending.requested_at <= clock_timestamp() - interval '15 minutes' or v_pending.attempts >= 5 then
    return 'expired';
  end if;
  -- Return errors as values so the attempt increment is committed on a wrong code.
  update private.work_email_codes set attempts = attempts + 1
  where user_id = v_user and requested_at = v_pending.requested_at;
  if v_code !~ '^[A-HJ-NP-Z2-9]{10}$' or encode(sha256(convert_to(v_code, 'UTF8')), 'hex') <> v_pending.digest then
    return case when v_pending.attempts = 4 then 'expired' else 'wrong' end;
  end if;
  update private.work_email_codes set consumed = true
  where user_id = v_user and requested_at = v_pending.requested_at;
  if exists (select 1 from auth.users u where u.email_confirmed_at is not null and lower(u.email) = v_pending.email) then
    return 'in_use';
  end if;
  begin
    insert into private.work_emails (user_id, email) values (v_user, v_pending.email)
    on conflict (user_id) do update set email = excluded.email;
  exception when unique_violation then
    return 'in_use';
  end;
  return 'verified';
end $$;

create function private.remove_work_email() returns void
language plpgsql security definer set search_path = '' as $$
declare
  v_user uuid := auth.uid();
begin
  if v_user is null or not private.planner_session_ok() then
    raise exception 'Sign in to manage your work email.' using errcode = '42501';
  end if;
  perform pg_advisory_xact_lock(hashtextextended('work-email-account:' || v_user::text, 0));
  delete from private.work_emails where user_id = v_user;
  update private.work_email_codes set consumed = true where user_id = v_user and not consumed;
end $$;

-- The exposed functions carry the caller's privileges into the narrow, checked private functions.
create function public.get_work_email() returns jsonb
language sql stable set search_path = '' as $$ select private.get_work_email() $$;
create function public.confirm_work_email(target_email text, code text) returns text
language sql set search_path = '' as $$ select private.confirm_work_email(target_email, code) $$;
create function public.remove_work_email() returns void
language sql set search_path = '' as $$ select private.remove_work_email() $$;
create function public.issue_work_email_code(account uuid, target_email text, code_digest text) returns text
language sql set search_path = '' as $$ select private.issue_work_email_code(account, target_email, code_digest) $$;

revoke execute on function private.workspace_addresses(uuid), private.get_work_email(), private.confirm_work_email(text, text),
  private.remove_work_email(), private.issue_work_email_code(uuid, text, text), public.get_work_email(),
  public.confirm_work_email(text, text), public.remove_work_email(), public.issue_work_email_code(uuid, text, text)
  from public, anon, authenticated, service_role;
grant execute on function private.get_work_email(), private.confirm_work_email(text, text), private.remove_work_email(),
  public.get_work_email(), public.confirm_work_email(text, text), public.remove_work_email() to authenticated;
grant usage on schema private to service_role;
grant execute on function private.issue_work_email_code(uuid, text, text), public.issue_work_email_code(uuid, text, text)
  to service_role;

-- How a member is shown: the account's display name, or the local part of the address the team sees.
create function private.member_name(who uuid, visible_email text) returns text
language sql stable security definer set search_path = '' as $$
  select left(coalesce(
    nullif(btrim(regexp_replace(u.raw_user_meta_data ->> 'full_name', '[[:cntrl:]]', '', 'g')), ''),
    nullif(btrim(regexp_replace(u.raw_user_meta_data ->> 'name', '[[:cntrl:]]', '', 'g')), ''),
    nullif(split_part(visible_email, '@', 1), ''),
    'Member'), 120)
  from auth.users u where u.id = who
$$;

-- The workspace's rows may change while one of its owners' Cloud may write (the owner pays for the team).
create function private.workspace_writable(ws uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select not coalesce((select s.enforce from private.billing_switch s), false)
      or exists (
        select 1 from public.workspace_members m join public.billing b on b.user_id = m.user_id
        where m.workspace_id = ws and m.role = 'owner'
          and (b.comped or b.trial_ends_at > now() or b.status in ('active', 'trialing', 'past_due'))
      )
$$;

-- A free key for a task entering a workspace: its own, unless the workspace has it already, else the area's next.
create function private.workspace_task_key(ws uuid, current_key text, area uuid) returns text
language plpgsql security definer set search_path = '' as $$
declare
  v_prefix text;
  v_n integer;
begin
  if current_key is not null and current_key ~ '^[A-Z][A-Z0-9]{1,7}-[1-9][0-9]{0,8}$'
     and not exists (select 1 from public.tasks t where t.workspace_id = ws and t.key = current_key) then
    insert into private.workspace_key_counters as c (workspace_id, prefix, last)
      values (ws, split_part(current_key, '-', 1), split_part(current_key, '-', 2)::integer)
      on conflict (workspace_id, prefix) do update set last = greatest(c.last, excluded.last);
    return current_key;
  end if;
  select a.key into v_prefix from public.areas a where a.id = area and a.workspace_id = ws;
  if v_prefix is null then
    raise exception 'A task in a team workspace needs one of its areas.' using errcode = '23514';
  end if;
  loop
    insert into private.workspace_key_counters as c (workspace_id, prefix, last) values (ws, v_prefix, 1)
      on conflict (workspace_id, prefix) do update set last = c.last + 1
      returning c.last into v_n;
    exit when not exists (select 1 from public.tasks t where t.workspace_id = ws and t.key = v_prefix || '-' || v_n);
  end loop;
  return v_prefix || '-' || v_n;
end $$;

/* ---------- 2. shared rows ---------- */

alter table public.areas add column workspace_id uuid references public.workspaces (id) on delete cascade;
alter table public.projects add column workspace_id uuid references public.workspaces (id) on delete cascade;
alter table public.tasks
  add column workspace_id uuid references public.workspaces (id) on delete cascade,
  -- Who does it among the people: a member of the task's workspace, or for a personal task its owner.
  add column assignee_id uuid references auth.users (id) on delete set null;
alter table public.subtasks add column workspace_id uuid references public.workspaces (id) on delete cascade;
alter table public.edges add column workspace_id uuid references public.workspaces (id) on delete cascade;
alter table public.reports add column workspace_id uuid references public.workspaces (id) on delete cascade;
alter table public.attachments add column workspace_id uuid references public.workspaces (id) on delete cascade;

create index areas_workspace_idx on public.areas (workspace_id) where workspace_id is not null;
create index projects_workspace_idx on public.projects (workspace_id) where workspace_id is not null;
create index tasks_workspace_idx on public.tasks (workspace_id, assignee_id) where workspace_id is not null;
create index tasks_assignee_idx on public.tasks (assignee_id) where assignee_id is not null;
create index subtasks_workspace_idx on public.subtasks (workspace_id) where workspace_id is not null;
create index edges_workspace_idx on public.edges (workspace_id) where workspace_id is not null;
create index reports_workspace_idx on public.reports (workspace_id) where workspace_id is not null;
create index attachments_workspace_idx on public.attachments (workspace_id) where workspace_id is not null;

-- Keys: unique per account for personal rows, per workspace for shared ones.
alter table public.areas drop constraint areas_user_id_key_key;
create unique index areas_own_key on public.areas (user_id, key) where workspace_id is null;
create unique index areas_workspace_key on public.areas (workspace_id, key) where workspace_id is not null;
alter table public.tasks drop constraint tasks_user_id_key_key;
create unique index tasks_own_key on public.tasks (user_id, key) where workspace_id is null;
create unique index tasks_workspace_key on public.tasks (workspace_id, key) where workspace_id is not null;

-- References to areas, projects and tasks become plain foreign keys with the same delete rules; the triggers below
-- check whose they are.
alter table public.projects
  drop constraint projects_user_id_area_id_fkey,
  drop constraint projects_user_id_after_project_id_fkey,
  add constraint projects_area_id_fkey foreign key (area_id) references public.areas (id) on delete cascade,
  add constraint projects_after_project_id_fkey foreign key (after_project_id) references public.projects (id) on delete set null;
alter table public.tasks
  drop constraint tasks_user_id_area_id_fkey,
  drop constraint tasks_user_id_project_id_fkey,
  drop constraint tasks_related_project_fkey,
  add constraint tasks_area_id_fkey foreign key (area_id) references public.areas (id) on delete set null,
  add constraint tasks_project_id_fkey foreign key (project_id) references public.projects (id) on delete set null,
  add constraint tasks_related_project_fkey foreign key (related_project_id) references public.projects (id) on delete set null;
alter table public.subtasks
  drop constraint subtasks_user_id_task_id_fkey,
  add constraint subtasks_task_id_fkey foreign key (task_id) references public.tasks (id) on delete cascade;
alter table public.events
  drop constraint events_user_id_area_id_fkey,
  add constraint events_area_id_fkey foreign key (area_id) references public.areas (id) on delete set null;
alter table public.sessions
  drop constraint sessions_user_id_task_id_fkey,
  add constraint sessions_task_id_fkey foreign key (task_id) references public.tasks (id) on delete cascade;
alter table public.edges
  drop constraint edges_user_id_from_task_id_fkey,
  drop constraint edges_user_id_to_task_id_fkey,
  add constraint edges_from_task_id_fkey foreign key (from_task_id) references public.tasks (id) on delete cascade,
  add constraint edges_to_task_id_fkey foreign key (to_task_id) references public.tasks (id) on delete cascade;
alter table public.launch_requests
  drop constraint launch_requests_user_id_task_id_fkey,
  add constraint launch_requests_task_id_fkey foreign key (task_id) references public.tasks (id) on delete cascade;
alter table public.reports
  drop constraint reports_user_id_task_id_fkey,
  add constraint reports_task_id_fkey foreign key (task_id) references public.tasks (id) on delete cascade;
alter table public.attachments
  drop constraint attachments_user_id_task_id_fkey,
  add constraint attachments_task_id_fkey foreign key (task_id) references public.tasks (id) on delete cascade;
alter table public.folder_requests
  drop constraint folder_requests_user_id_area_id_fkey,
  drop constraint folder_requests_user_id_project_id_fkey,
  drop constraint folder_requests_user_id_task_id_fkey,
  add constraint folder_requests_area_id_fkey foreign key (area_id) references public.areas (id) on delete cascade,
  add constraint folder_requests_project_id_fkey foreign key (project_id) references public.projects (id) on delete cascade,
  add constraint folder_requests_task_id_fkey foreign key (task_id) references public.tasks (id) on delete cascade;
alter table public.task_note_requests
  drop constraint task_note_requests_user_id_task_id_fkey,
  add constraint task_note_requests_task_id_fkey foreign key (task_id) references public.tasks (id) on delete cascade;

create index events_area_ref_idx on public.events (area_id) where area_id is not null;
create index sessions_task_ref_idx on public.sessions (task_id);
create index edges_to_ref_idx on public.edges (to_task_id);
create index reports_task_ref_idx on public.reports (task_id);
create index attachments_task_ref_idx on public.attachments (task_id);
create index launch_requests_task_ref_idx on public.launch_requests (task_id);
create index folder_requests_refs_idx on public.folder_requests (task_id, project_id, area_id);
create index task_note_requests_task_ref_idx on public.task_note_requests (task_id);

-- Nobody but the database changes who wrote a row, or which workspace an area is in (share_area does that). The
-- database's own functions run as their owner, so this only stops statements a client sends.
create function private.keep_authorship() returns trigger
language plpgsql set search_path = '' as $$
begin
  if current_user in ('authenticated', 'anon') then
    if new.user_id is distinct from old.user_id then
      raise exception 'A row keeps its author.' using errcode = '42501';
    end if;
    if tg_table_name = 'areas' and new.workspace_id is distinct from old.workspace_id then
      raise exception 'Share an area with a team workspace through share_area.' using errcode = '42501';
    end if;
  end if;
  return new;
end $$;

-- An area in a workspace is created by its owners and admins (the policies), with a key unique there.
-- A shared area's tasks belong to the team: deleting the area deletes them (a personal area's go to the Inbox).
create function private.area_delete_tasks() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  delete from public.tasks t where t.area_id = old.id and t.workspace_id = old.workspace_id;
  return old;
end $$;

-- A project lives in its area's workspace, and only points after a project of the same place. A parent that isn't
-- there is going away in this statement (a deletion's cascade) or is refused by the foreign key: nothing to check.
create function private.project_scope() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  v_owner uuid;
  v_ws uuid;
  a_owner uuid;
  a_ws uuid;
begin
  select a.user_id, a.workspace_id into a_owner, a_ws from public.areas a where a.id = new.area_id;
  if not found then
    a_ws := case when tg_op = 'UPDATE' then old.workspace_id end;
  elsif a_ws is null and a_owner <> new.user_id then
    raise exception 'A project can only be in an area of its own account.' using errcode = '23503';
  end if;
  if a_ws is not null and (tg_op = 'INSERT' or old.workspace_id is null or new.user_id <> old.user_id)
     and not private.is_workspace_member(a_ws, new.user_id) then
    raise exception 'Only the workspace''s members add to it.' using errcode = '42501';
  end if;
  if tg_op = 'UPDATE' and old.workspace_id is not null and a_ws is distinct from old.workspace_id then
    raise exception 'A project in a team workspace stays in it: move it to another of its areas.' using errcode = '42501';
  end if;
  new.workspace_id := a_ws;
  if new.after_project_id is not null then
    select p.user_id, p.workspace_id into v_owner, v_ws from public.projects p where p.id = new.after_project_id;
    if found and (v_ws is distinct from a_ws or (a_ws is null and v_owner <> new.user_id)) then
      new.after_project_id := null;
    end if;
  end if;
  -- Computers are personal: a shared project names none.
  if a_ws is not null then
    new.device_id := null;
  end if;
  return new;
end $$;

-- When a project enters a workspace, what pointed at it from outside lets go.
create function private.project_workspace_follows() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  update public.tasks t set related_project_id = null
    where t.related_project_id = new.id and t.workspace_id is distinct from new.workspace_id;
  update public.projects p set after_project_id = null
    where p.after_project_id = new.id and p.workspace_id is distinct from new.workspace_id;
  return null;
end $$;

-- A task lives in its project's area, in that area's workspace; the project it's about and who it's assigned to come
-- from the same place.
create function private.task_scope() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  v_owner uuid;
  v_ws uuid;
  v_area uuid;
  r_owner uuid;
  r_ws uuid;
begin
  if new.project_id is not null then
    select p.area_id into v_area from public.projects p where p.id = new.project_id;
    if found then
      new.area_id := v_area;
    end if;
  end if;
  if new.area_id is not null then
    select a.user_id, a.workspace_id into v_owner, v_ws from public.areas a where a.id = new.area_id;
    if not found then
      v_ws := case when tg_op = 'UPDATE' then old.workspace_id end;
    elsif v_ws is null and v_owner <> new.user_id then
      raise exception 'A task can only be in an area of its own account.' using errcode = '23503';
    end if;
  end if;
  if tg_op = 'UPDATE' and old.workspace_id is not null and v_ws is distinct from old.workspace_id then
    raise exception 'A task in a team workspace stays in it: move it to another of its areas, or delete it.' using errcode = '42501';
  end if;
  if v_ws is not null and (tg_op = 'INSERT' or old.workspace_id is null or new.user_id <> old.user_id)
     and not private.is_workspace_member(v_ws, new.user_id) then
    raise exception 'Only the workspace''s members add to it.' using errcode = '42501';
  end if;
  new.workspace_id := v_ws;
  if new.related_project_id is not null then
    select p.user_id, p.workspace_id into r_owner, r_ws from public.projects p where p.id = new.related_project_id;
    if found and (r_ws is distinct from v_ws or (v_ws is null and r_owner <> new.user_id)) then
      if tg_op = 'INSERT' or new.related_project_id is distinct from old.related_project_id then
        raise exception 'A task can only be about a project of the same place.' using errcode = '23503';
      end if;
      -- Moved elsewhere: the link to a project left behind goes.
      new.related_project_id := null;
    end if;
  end if;
  if v_ws is null then
    if new.assignee_id is not null and new.assignee_id <> new.user_id then
      raise exception 'A personal task can only be assigned to its owner.' using errcode = '23514';
    end if;
  else
    if new.assignee_id is not null and (tg_op = 'INSERT' or new.assignee_id is distinct from old.assignee_id)
       and not private.is_workspace_member(v_ws, new.assignee_id) then
      raise exception 'Assign the task to a member of its workspace.' using errcode = '23514';
    end if;
    -- Computers are personal: a shared task names none.
    new.device_id := null;
    if tg_op = 'UPDATE' and old.workspace_id is null then
      new.key := private.workspace_task_key(v_ws, new.key, new.area_id);
    end if;
  end if;
  return new;
end $$;

-- Sub-tasks, reports and images belong where their task does.
create function private.task_child_scope() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  v_owner uuid;
  v_ws uuid;
begin
  select t.user_id, t.workspace_id into v_owner, v_ws from public.tasks t where t.id = new.task_id;
  if not found then
    if tg_op = 'UPDATE' then new.workspace_id := old.workspace_id; end if;
    return new;
  end if;
  if v_ws is null and v_owner <> new.user_id then
    raise exception 'That task belongs to another account.' using errcode = '23503';
  end if;
  if v_ws is not null and (tg_op = 'INSERT' or new.user_id <> old.user_id) and not private.is_workspace_member(v_ws, new.user_id) then
    raise exception 'Only the workspace''s members add to it.' using errcode = '42501';
  end if;
  new.workspace_id := v_ws;
  return new;
end $$;

-- A dependency joins two tasks of the same place.
create function private.edge_scope() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  f_owner uuid;
  f_ws uuid;
  t_owner uuid;
  t_ws uuid;
begin
  select t.user_id, t.workspace_id into f_owner, f_ws from public.tasks t where t.id = new.from_task_id;
  select t.user_id, t.workspace_id into t_owner, t_ws from public.tasks t where t.id = new.to_task_id;
  if f_owner is null or t_owner is null then
    if tg_op = 'UPDATE' then new.workspace_id := old.workspace_id; end if;
    return new;
  end if;
  if f_ws is distinct from t_ws or (f_ws is null and (f_owner <> new.user_id or t_owner <> new.user_id)) then
    raise exception 'A dependency joins tasks of the same place.' using errcode = '23503';
  end if;
  if f_ws is not null and (tg_op = 'INSERT' or new.user_id <> old.user_id) and not private.is_workspace_member(f_ws, new.user_id) then
    raise exception 'Only the workspace''s members add to it.' using errcode = '42501';
  end if;
  new.workspace_id := f_ws;
  return new;
end $$;

-- What stays personal (activities, sessions, requests to computers) may point at a shared area, project or task only
-- while its account is a member of that workspace, and at a personal one only of its own. (One that isn't there the
-- foreign key refuses.)
create function private.personal_references() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  v_row jsonb := to_jsonb(new);
  v_owner uuid;
  v_ws uuid;
begin
  if v_row ->> 'area_id' is not null then
    select a.user_id, a.workspace_id into v_owner, v_ws from public.areas a where a.id = (v_row ->> 'area_id')::uuid;
    if found and not private.can_reference(v_owner, v_ws, new.user_id) then
      raise exception 'That area belongs to another account.' using errcode = '23503';
    end if;
  end if;
  if v_row ->> 'project_id' is not null then
    select p.user_id, p.workspace_id into v_owner, v_ws from public.projects p where p.id = (v_row ->> 'project_id')::uuid;
    if found and not private.can_reference(v_owner, v_ws, new.user_id) then
      raise exception 'That project belongs to another account.' using errcode = '23503';
    end if;
  end if;
  if v_row ->> 'task_id' is not null then
    select t.user_id, t.workspace_id into v_owner, v_ws from public.tasks t where t.id = (v_row ->> 'task_id')::bigint;
    if found and not private.can_reference(v_owner, v_ws, new.user_id) then
      raise exception 'That task belongs to another account.' using errcode = '23503';
    end if;
  end if;
  return new;
end $$;

-- When a task enters a workspace, its sub-tasks, reports and images follow; a dependency on a task left behind goes.
create function private.task_workspace_follows() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  delete from public.edges e
    where (e.from_task_id = new.id or e.to_task_id = new.id)
      and exists (
        select 1 from public.tasks o
        where o.id = case when e.from_task_id = new.id then e.to_task_id else e.from_task_id end
          and o.workspace_id is distinct from new.workspace_id
      );
  update public.edges e set workspace_id = new.workspace_id where e.from_task_id = new.id or e.to_task_id = new.id;
  update public.subtasks x set workspace_id = new.workspace_id where x.task_id = new.id;
  update public.reports x set workspace_id = new.workspace_id where x.task_id = new.id;
  update public.attachments x set workspace_id = new.workspace_id where x.task_id = new.id;
  return null;
end $$;

-- A project's tasks always live in the project's area: all of them, whoever wrote them.
create or replace function private.project_area_follows() returns trigger
language plpgsql set search_path = '' as $$
begin
  update public.tasks set area_id = new.area_id where project_id = new.id and area_id is distinct from new.area_id;
  return null;
end $$;

-- Keys: a shared task always gets the workspace's next key of its area; a personal one as before.
create or replace function private.assign_task_key() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  v_prefix text;
  v_n integer;
begin
  if new.workspace_id is not null then
    new.key := private.workspace_task_key(new.workspace_id, null, new.area_id);
    return new;
  end if;
  if new.key is null or new.key = '' then
    v_prefix := coalesce((select a.key from public.areas a where a.id = new.area_id and a.user_id = new.user_id and a.workspace_id is null), 'INB');
    insert into public.key_counters as c (user_id, prefix, last) values (new.user_id, v_prefix, 1)
      on conflict (user_id, prefix) do update set last = c.last + 1
      returning c.last into v_n;
    new.key := v_prefix || '-' || v_n;
  else
    v_prefix := split_part(new.key, '-', 1);
    v_n := split_part(new.key, '-', 2)::integer;
    insert into public.key_counters as c (user_id, prefix, last) values (new.user_id, v_prefix, v_n)
      on conflict (user_id, prefix) do update set last = greatest(c.last, excluded.last);
  end if;
  return new;
end $$;

-- Live refresh for every member when a shared row changes.
create function private.bump_shared_version() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  v_user uuid;
  v_ws uuid;
begin
  if tg_op = 'DELETE' then v_user := old.user_id; v_ws := old.workspace_id;
  else v_user := new.user_id; v_ws := new.workspace_id; end if;
  if v_ws is not null then
    insert into public.user_state as s (user_id, version)
      select m.user_id, 1 from public.workspace_members m where m.workspace_id = v_ws
      on conflict (user_id) do update set version = s.version + 1;
  end if;
  if exists (select 1 from auth.users u where u.id = v_user) then
    insert into public.user_state as s (user_id, version) values (v_user, 1)
      on conflict (user_id) do update set version = s.version + 1;
  end if;
  return null;
end $$;

-- Billing per row: personal rows follow the account's own Cloud, shared ones the workspace owners'.
create function private.require_cloud_row() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if pg_trigger_depth() = 1 and auth.uid() is not null then
    if new.workspace_id is null then
      if not private.cloud_writable() then
        raise exception 'PacedMind Cloud is read-only: subscribe to keep working in it, or move your data to this computer.'
          using errcode = 'PT402';
      end if;
    elsif not private.workspace_writable(new.workspace_id) then
      raise exception 'This team workspace is read-only: its owner''s PacedMind Cloud has ended.' using errcode = 'PT402';
    end if;
  end if;
  return new;
end $$;

do $$
declare
  t text;
begin
  foreach t in array array['areas', 'projects', 'tasks', 'subtasks', 'edges', 'reports', 'attachments'] loop
    execute format('drop trigger %I on public.%I', t || '_require_cloud', t);
    execute format('create trigger %I before insert or update on public.%I for each row execute function private.require_cloud_row()',
      t || '_require_cloud_row', t);
    execute format('drop trigger %I on public.%I', t || '_bump', t);
    execute format('create trigger %I after insert or update or delete on public.%I for each row execute function private.bump_shared_version()',
      t || '_bump', t);
    execute format('create trigger %I before update on public.%I for each row execute function private.keep_authorship()',
      t || '_0_keep_authorship', t);
  end loop;
end $$;

-- Before-triggers run in name order: the scope comes first (a "0" sorts before letters), then keys and billing.
create trigger projects_0_scope before insert or update on public.projects
  for each row execute function private.project_scope();
create trigger tasks_0_scope before insert or update on public.tasks
  for each row execute function private.task_scope();
create trigger subtasks_0_scope before insert or update on public.subtasks
  for each row execute function private.task_child_scope();
create trigger reports_0_scope before insert or update on public.reports
  for each row execute function private.task_child_scope();
create trigger attachments_0_scope before insert or update on public.attachments
  for each row execute function private.task_child_scope();
create trigger edges_0_scope before insert or update on public.edges
  for each row execute function private.edge_scope();
create trigger projects_workspace_follows after update of workspace_id on public.projects
  for each row when (new.workspace_id is distinct from old.workspace_id) execute function private.project_workspace_follows();
create trigger tasks_workspace_follows after update of workspace_id on public.tasks
  for each row when (new.workspace_id is distinct from old.workspace_id) execute function private.task_workspace_follows();
create trigger areas_delete_tasks before delete on public.areas
  for each row when (old.workspace_id is not null) execute function private.area_delete_tasks();

create trigger events_0_references before insert or update of area_id on public.events
  for each row execute function private.personal_references();
create trigger sessions_0_references before insert or update of task_id on public.sessions
  for each row execute function private.personal_references();
create trigger launch_requests_0_references before insert or update of task_id on public.launch_requests
  for each row execute function private.personal_references();
create trigger folder_requests_0_references before insert or update of area_id, project_id, task_id on public.folder_requests
  for each row execute function private.personal_references();
create trigger task_note_requests_0_references before insert or update of task_id on public.task_note_requests
  for each row execute function private.personal_references();

/* ---------- 3. who reads and writes what ---------- */

do $$
declare
  t text;
  v_read text := '(workspace_id is null and (select auth.uid()) = user_id) or workspace_id = any ((select private.my_workspaces())::uuid[])';
  v_add text := '(select auth.uid()) = user_id and (workspace_id is null or workspace_id = any ((select private.my_workspaces())::uuid[]))';
  v_admin text := '(workspace_id is null and (select auth.uid()) = user_id) or workspace_id = any ((select private.my_admin_workspaces())::uuid[])';
  v_author text := '(select auth.uid()) = user_id and (workspace_id is null or workspace_id = any ((select private.my_workspaces())::uuid[]))';
begin
  drop policy "Own areas" on public.areas;
  create policy "Own and workspace areas" on public.areas for select to authenticated using (
    (workspace_id is null and (select auth.uid()) = user_id) or workspace_id = any ((select private.my_workspaces())::uuid[]));
  -- Shared areas are created, changed and deleted by the workspace's owners and admins.
  create policy "Add own areas, or workspace areas as an admin" on public.areas for insert to authenticated with check (
    (select auth.uid()) = user_id and (workspace_id is null or workspace_id = any ((select private.my_admin_workspaces())::uuid[])));
  execute format('create policy "Change own areas, or workspace areas as an admin" on public.areas for update to authenticated using (%s) with check (%s)', v_admin, v_admin);
  execute format('create policy "Delete own areas, or workspace areas as an admin" on public.areas for delete to authenticated using (%s)', v_admin);

  -- Members work on everything inside a shared area.
  foreach t in array array['projects', 'tasks', 'subtasks', 'edges'] loop
    execute format('drop policy %I on public.%I', 'Own ' || t, t);
    execute format('create policy %I on public.%I for select to authenticated using (%s)', 'Own and workspace ' || t, t, v_read);
    execute format('create policy %I on public.%I for insert to authenticated with check (%s)', 'Add own and workspace ' || t, t, v_add);
    execute format('create policy %I on public.%I for update to authenticated using (%s) with check (%s)', 'Change own and workspace ' || t, t, v_read, v_read);
    execute format('create policy %I on public.%I for delete to authenticated using (%s)', 'Delete own and workspace ' || t, t, v_read);
  end loop;

  -- What agents hand back is read by the whole team and changed by whoever's session wrote it.
  foreach t in array array['reports', 'attachments'] loop
    execute format('drop policy %I on public.%I', 'Own ' || t, t);
    execute format('create policy %I on public.%I for select to authenticated using (%s)', 'Own and workspace ' || t, t, v_read);
    execute format('create policy %I on public.%I for insert to authenticated with check (%s)', 'Add own ' || t, t, v_author);
    execute format('create policy %I on public.%I for update to authenticated using (%s) with check (%s)', 'Change own ' || t, t, v_author, v_author);
    execute format('create policy %I on public.%I for delete to authenticated using (%s)', 'Delete own ' || t, t, v_author);
  end loop;
end $$;

-- The workspace tables: read by members (invites by owners and admins only, without their tokens), written only
-- through the functions below.
revoke all on public.workspaces, public.workspace_members, public.workspace_invites, public.workspace_domains from anon;
revoke insert, update, delete, truncate, references, trigger on public.workspaces, public.workspace_members,
  public.workspace_invites, public.workspace_domains from authenticated;
revoke select on public.workspace_invites from authenticated;
grant select (id, workspace_id, email, role, invited_by, created_at, expires_at, accepted_at, accepted_by, revoked_at)
  on public.workspace_invites to authenticated;

alter table public.workspaces enable row level security;
alter table public.workspace_members enable row level security;
alter table public.workspace_invites enable row level security;
alter table public.workspace_domains enable row level security;

create policy "Workspaces you're in" on public.workspaces for select to authenticated
  using (id = any ((select private.my_workspaces())::uuid[]));
create policy "Members of your workspaces" on public.workspace_members for select to authenticated
  using (workspace_id = any ((select private.my_workspaces())::uuid[]));
create policy "Invites of workspaces you manage" on public.workspace_invites for select to authenticated
  using (workspace_id = any ((select private.my_admin_workspaces())::uuid[]));
create policy "Domains of your workspaces" on public.workspace_domains for select to authenticated
  using (workspace_id = any ((select private.my_workspaces())::uuid[]));

do $$
declare
  t text;
begin
  foreach t in array array['workspaces', 'workspace_members', 'workspace_invites', 'workspace_domains'] loop
    execute format('create policy "Two-factor session" on public.%I as restrictive for all to authenticated '
      'using ((select private.planner_session_ok()) or (select private.agent_ok())) '
      'with check ((select private.planner_session_ok()) or (select private.agent_ok()))', t);
  end loop;
end $$;

-- Live refresh for the members (and whoever just joined or left) when a workspace's people change.
create function private.bump_workspace() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  v_ws uuid;
  v_user uuid;
begin
  if tg_table_name = 'workspaces' then
    v_ws := case when tg_op = 'DELETE' then old.id else new.id end;
  else
    v_ws := case when tg_op = 'DELETE' then old.workspace_id else new.workspace_id end;
  end if;
  if tg_table_name = 'workspace_members' then
    v_user := case when tg_op = 'DELETE' then old.user_id else new.user_id end;
  end if;
  insert into public.user_state as s (user_id, version)
    select m.user_id, 1 from public.workspace_members m where m.workspace_id = v_ws
      and m.user_id is distinct from v_user
      and exists (select 1 from auth.users u where u.id = m.user_id)
    union
    select u.id, 1 from auth.users u where u.id = v_user
    on conflict (user_id) do update set version = s.version + 1;
  return null;
end $$;

create trigger workspaces_bump after update on public.workspaces
  for each row execute function private.bump_workspace();
create trigger workspace_members_bump after insert or update or delete on public.workspace_members
  for each row execute function private.bump_workspace();
create trigger workspace_invites_bump after insert or update or delete on public.workspace_invites
  for each row execute function private.bump_workspace();
create trigger workspace_domains_bump after insert or update or delete on public.workspace_domains
  for each row execute function private.bump_workspace();

-- Someone who leaves (or is removed) keeps nothing pointing into the workspace: their assignments there are cleared,
-- their waiting requests about its work and their activities' links to its areas go. Their sessions stay theirs.
create function private.member_left() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  update public.tasks t set assignee_id = null where t.workspace_id = old.workspace_id and t.assignee_id = old.user_id;
  delete from public.launch_requests r
    where r.user_id = old.user_id and r.status = 'pending'
      and r.task_id in (select t.id from public.tasks t where t.workspace_id = old.workspace_id);
  delete from public.task_note_requests r
    where r.user_id = old.user_id and r.status in ('pending', 'dispatched')
      and r.task_id in (select t.id from public.tasks t where t.workspace_id = old.workspace_id);
  delete from public.folder_requests r
    where r.user_id = old.user_id and r.status = 'pending'
      and (r.task_id in (select t.id from public.tasks t where t.workspace_id = old.workspace_id)
        or r.project_id in (select p.id from public.projects p where p.workspace_id = old.workspace_id)
        or r.area_id in (select a.id from public.areas a where a.workspace_id = old.workspace_id));
  update public.events e set area_id = null
    where e.user_id = old.user_id and e.area_id in (select a.id from public.areas a where a.workspace_id = old.workspace_id);
  return null;
end $$;

create trigger workspace_members_left after delete on public.workspace_members
  for each row execute function private.member_left();

-- Deletes a workspace with everything shared in it, tasks first, so nothing on the way down points at a row that's
-- already gone.
create function private.delete_workspace(ws uuid) returns void
language plpgsql security definer set search_path = '' as $$
begin
  delete from public.tasks t where t.workspace_id = ws;
  delete from public.projects p where p.workspace_id = ws;
  delete from public.areas a where a.workspace_id = ws;
  delete from public.workspaces w where w.id = ws;
end $$;

/* ---------- 4. what the app calls ---------- */

-- Creates a workspace with the caller as its owner, who pays for it: only while the caller's own Cloud may write.
create function public.create_workspace(ws_name text, ws_slug text default null) returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  v_user uuid := auth.uid();
  v_name text := btrim(coalesce(ws_name, ''));
  v_base text;
  v_slug text;
  v_id uuid;
  v_email text;
  i integer := 1;
begin
  if v_user is null or not private.planner_or_agent() then
    raise exception 'Sign in to PacedMind Cloud first.' using errcode = '42501';
  end if;
  if char_length(v_name) not between 1 and 80 or v_name ~ '[[:cntrl:]]' then
    raise exception 'Give the workspace a name of at most 80 characters.' using errcode = '22023';
  end if;
  if not private.cloud_writable() then
    raise exception 'PacedMind Cloud is read-only: subscribe to keep working in it, or move your data to this computer.'
      using errcode = 'PT402';
  end if;
  if (select count(*) from public.workspace_members m where m.user_id = v_user and m.role = 'owner') >= 10 then
    raise exception 'You own ten workspaces already.' using errcode = '54000';
  end if;
  v_base := lower(coalesce(nullif(btrim(ws_slug), ''), v_name));
  v_base := btrim(regexp_replace(v_base, '[^a-z0-9]+', '-', 'g'), '-');
  v_base := btrim(left(v_base, 32), '-');
  if v_base = '' then v_base := 'team'; end if;
  v_slug := v_base;
  while exists (select 1 from public.workspaces w where w.slug = v_slug) loop
    if nullif(btrim(ws_slug), '') is not null then
      raise exception 'Another workspace uses the address %.', v_slug using errcode = '23505';
    end if;
    i := i + 1;
    v_slug := v_base || '-' || i;
  end loop;
  select e.email into v_email from private.workspace_addresses(v_user) e order by e.is_work desc limit 1;
  v_email := coalesce(v_email, (select lower(u.email) from auth.users u where u.id = v_user), '');
  insert into public.workspaces (name, slug, created_by) values (v_name, v_slug, v_user) returning id into v_id;
  insert into public.workspace_members (workspace_id, user_id, role, name, email, joined_via)
    values (v_id, v_user, 'owner', private.member_name(v_user, v_email), v_email, 'created');
  return v_id;
end $$;

create function public.rename_workspace(ws uuid, ws_name text) returns void
language plpgsql security definer set search_path = '' as $$
declare
  v_name text := btrim(coalesce(ws_name, ''));
begin
  if not private.planner_or_agent() or coalesce(private.workspace_role(ws, auth.uid()), '') not in ('owner', 'admin') then
    raise exception 'Only the workspace''s owners and admins rename it.' using errcode = '42501';
  end if;
  if char_length(v_name) not between 1 and 80 or v_name ~ '[[:cntrl:]]' then
    raise exception 'Give the workspace a name of at most 80 characters.' using errcode = '22023';
  end if;
  update public.workspaces set name = v_name where id = ws;
end $$;

-- Invites an email address; answers the token once, for the link the person who invites sends themselves.
create function public.invite_member(ws uuid, invite_email text, invite_role text default 'member') returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_email text := lower(btrim(coalesce(invite_email, '')));
  v_role text := coalesce(nullif(btrim(invite_role), ''), 'member');
  v_token text;
  v_id uuid;
  v_expires timestamptz;
begin
  perform 1 from public.workspaces w where w.id = ws and private.planner_or_agent() for update;
  if not found or coalesce(private.workspace_role(ws, auth.uid()), '') not in ('owner', 'admin') then
    raise exception 'Only the workspace''s owners and admins invite people.' using errcode = '42501';
  end if;
  if char_length(v_email) > 320 or v_email !~ '^[^@[:space:]]+@[a-z0-9.-]+\.[a-z]{2,63}$' then
    raise exception 'That isn''t an email address.' using errcode = '22023';
  end if;
  if v_role not in ('admin', 'member') then
    raise exception 'Invite people as admin or member; make an owner from the members.' using errcode = '22023';
  end if;
  if exists (select 1 from public.workspace_members m
             cross join lateral private.workspace_addresses(m.user_id) e
             where m.workspace_id = ws and e.email = v_email) then
    raise exception 'They are a member already.' using errcode = '23505';
  end if;
  if (select count(*) from public.workspace_invites i
      where i.workspace_id = ws and i.accepted_at is null and i.revoked_at is null and i.expires_at > now()) >= 100 then
    raise exception 'A hundred invitations are waiting already.' using errcode = '54000';
  end if;
  -- One open invitation per address: a new one replaces the old link.
  update public.workspace_invites i set revoked_at = now()
    where i.workspace_id = ws and i.email = v_email and i.accepted_at is null and i.revoked_at is null;
  v_token := replace(gen_random_uuid()::text || gen_random_uuid()::text, '-', '');
  insert into public.workspace_invites (workspace_id, email, role, token_digest, invited_by, created_at)
    values (ws, v_email, v_role, encode(sha256(convert_to(v_token, 'UTF8')), 'hex'), auth.uid(), clock_timestamp())
    returning id, expires_at into v_id, v_expires;
  return jsonb_build_object('id', v_id, 'token', v_token, 'email', v_email, 'role', v_role, 'expires_at', v_expires);
end $$;

create function public.revoke_invite(invite uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare
  v_ws uuid;
begin
  select i.workspace_id into v_ws from public.workspace_invites i where i.id = invite;
  if v_ws is null or not private.planner_or_agent() or coalesce(private.workspace_role(v_ws, auth.uid()), '') not in ('owner', 'admin') then
    raise exception 'Only the workspace''s owners and admins withdraw invitations.' using errcode = '42501';
  end if;
  update public.workspace_invites i set revoked_at = now()
    where i.id = invite and i.accepted_at is null and i.revoked_at is null;
end $$;

-- What an invitation link is, for the person who opened it (signed in): the workspace, the role, whether it's still
-- open and whether it's for the signed-in account's confirmed address.
create function public.invite_details(token text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_inv public.workspace_invites;
begin
  if auth.uid() is null or not private.planner_session_ok() then
    raise exception 'Sign in first.' using errcode = '42501';
  end if;
  select * into v_inv from public.workspace_invites i
    where i.token_digest = encode(sha256(convert_to(coalesce(token, ''), 'UTF8')), 'hex');
  if not found then
    return jsonb_build_object('status', 'unknown');
  end if;
  return jsonb_build_object(
    'status', case when v_inv.accepted_at is not null then 'accepted'
                   when v_inv.revoked_at is not null or exists (
                     select 1 from private.workspace_removals r where r.workspace_id = v_inv.workspace_id
                       and r.user_id = auth.uid() and r.removed_at >= v_inv.created_at
                   ) then 'revoked'
                   when v_inv.expires_at <= now() then 'expired' else 'open' end,
    'workspace', (select w.name from public.workspaces w where w.id = v_inv.workspace_id),
    'workspace_id', v_inv.workspace_id,
    'role', v_inv.role,
    'email', v_inv.email,
    'invited_by', (select m.name from public.workspace_members m where m.workspace_id = v_inv.workspace_id and m.user_id = v_inv.invited_by),
    'expires_at', v_inv.expires_at,
    'matches', exists (select 1 from private.workspace_addresses(auth.uid()) e where e.email = v_inv.email),
    'confirmed', exists (select 1 from private.workspace_addresses(auth.uid())),
    'member', private.is_workspace_member(v_inv.workspace_id, auth.uid())
  );
end $$;

-- Accepts an invitation with either of the person's confirmed addresses.
create function public.accept_invite(token text) returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  v_user uuid := auth.uid();
  v_inv public.workspace_invites;
  v_digest text := encode(sha256(convert_to(coalesce(token, ''), 'UTF8')), 'hex');
begin
  if v_user is null or not private.planner_session_ok() then
    raise exception 'Sign in to PacedMind Cloud to accept the invitation.' using errcode = '42501';
  end if;
  perform 1 from public.workspaces w join public.workspace_invites i on i.workspace_id = w.id
  where i.token_digest = v_digest for update of w;
  select * into v_inv from public.workspace_invites i where i.token_digest = v_digest for update;
  if not found or v_inv.revoked_at is not null or v_inv.expires_at <= now()
     or (v_inv.accepted_at is not null and v_inv.accepted_by is distinct from v_user)
     or exists (select 1 from private.workspace_removals r where r.workspace_id = v_inv.workspace_id
                and r.user_id = v_user and r.removed_at >= v_inv.created_at) then
    raise exception 'This invitation has expired or was withdrawn. Ask for a new one.' using errcode = 'P0002';
  end if;
  if not exists (select 1 from private.workspace_addresses(v_user)) then
    raise exception 'Confirm your email address first.' using errcode = '42501';
  end if;
  if not exists (select 1 from private.workspace_addresses(v_user) e where e.email = v_inv.email) then
    raise exception 'This invitation is for another email address. Confirm it as your work email first.' using errcode = '42501';
  end if;
  insert into public.workspace_members (workspace_id, user_id, role, name, email, joined_via)
    values (v_inv.workspace_id, v_user, v_inv.role, private.member_name(v_user, v_inv.email), v_inv.email, 'invite')
    on conflict (workspace_id, user_id) do nothing;
  delete from private.workspace_removals r where r.workspace_id = v_inv.workspace_id and r.user_id = v_user;
  update public.workspace_invites i set accepted_at = coalesce(i.accepted_at, now()), accepted_by = v_user where i.id = v_inv.id;
  return v_inv.workspace_id;
end $$;

-- Email domains that aren't one organization's: anyone can have an address there.
create function private.public_email_domain(domain text) returns boolean
language sql immutable set search_path = '' as $$
  select domain = any (array[
    'gmail.com', 'googlemail.com', 'outlook.com', 'hotmail.com', 'live.com', 'msn.com', 'yahoo.com', 'ymail.com',
    'icloud.com', 'me.com', 'mac.com', 'aol.com', 'proton.me', 'protonmail.com', 'pm.me', 'gmx.com', 'gmx.de', 'gmx.net',
    'web.de', 'mail.com', 'yandex.com', 'yandex.ru', 'zoho.com', 'fastmail.com', 'hey.com', 'tutanota.com', 'tuta.io',
    'wp.pl', 'o2.pl', 'onet.pl', 'interia.pl', 'op.pl', 'gazeta.pl', 'tlen.pl', 'poczta.fm', 'vp.pl', 'int.pl', 'onet.eu'
  ])
$$;

-- Lets everyone whose confirmed address is at the domain join as a member. Only for the domain of the caller's own
-- confirmed address, and never a public mail provider's.
create function public.add_workspace_domain(ws uuid, domain_name text) returns void
language plpgsql security definer set search_path = '' as $$
declare
  v_domain text := lower(btrim(ltrim(btrim(coalesce(domain_name, '')), '@')));
begin
  if not private.planner_or_agent() or coalesce(private.workspace_role(ws, auth.uid()), '') not in ('owner', 'admin') then
    raise exception 'Only the workspace''s owners and admins add domains.' using errcode = '42501';
  end if;
  if char_length(v_domain) not between 3 and 253
     or v_domain !~ '^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*\.[a-z]{2,63}$' then
    raise exception 'That isn''t a domain like example.com.' using errcode = '22023';
  end if;
  if private.public_email_domain(v_domain) then
    raise exception 'Anyone can have an address at %: invite people instead.', v_domain using errcode = '22023';
  end if;
  if not exists (select 1 from private.workspace_addresses(auth.uid()) e where split_part(e.email, '@', 2) = v_domain) then
    raise exception 'Add the domain of your own confirmed email address.' using errcode = '42501';
  end if;
  if exists (select 1 from public.workspace_domains d where d.domain = v_domain and d.workspace_id <> ws) then
    raise exception 'Another workspace uses that domain.' using errcode = '23505';
  end if;
  insert into public.workspace_domains (workspace_id, domain, added_by) values (ws, v_domain, auth.uid())
    on conflict (workspace_id, domain) do nothing;
end $$;

create function public.remove_workspace_domain(ws uuid, domain_name text) returns void
language plpgsql security definer set search_path = '' as $$
begin
  if not private.planner_or_agent() or coalesce(private.workspace_role(ws, auth.uid()), '') not in ('owner', 'admin') then
    raise exception 'Only the workspace''s owners and admins remove domains.' using errcode = '42501';
  end if;
  delete from public.workspace_domains d where d.workspace_id = ws and d.domain = lower(btrim(ltrim(btrim(coalesce(domain_name, '')), '@')));
end $$;

-- The workspaces the signed-in person may join through their confirmed address's domain, and isn't in.
create function public.joinable_workspaces() returns table (id uuid, name text, slug text, domain text)
language plpgsql stable security definer set search_path = '' as $$
begin
  if auth.uid() is null or not private.planner_session_ok() then
    return;
  end if;
  return query
    select distinct on (w.id) w.id, w.name, w.slug, d.domain
    from private.workspace_addresses(auth.uid()) e
    join public.workspace_domains d on d.domain = split_part(e.email, '@', 2)
    join public.workspaces w on w.id = d.workspace_id
    where not private.is_workspace_member(w.id, auth.uid())
      and not exists (select 1 from private.workspace_removals r where r.workspace_id = w.id and r.user_id = auth.uid())
    order by w.id, e.is_work desc;
end $$;

-- Joins a workspace through the domain: a person's own sign-in, as a member.
create function public.join_workspace(ws uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare
  v_user uuid := auth.uid();
  v_email text;
begin
  if v_user is null or not private.planner_session_ok() then
    raise exception 'Sign in to PacedMind Cloud to join.' using errcode = '42501';
  end if;
  perform 1 from public.workspaces w where w.id = ws for update;
  if exists (select 1 from private.workspace_removals r where r.workspace_id = ws and r.user_id = v_user) then
    raise exception 'An administrator removed you from this team. Ask for a new invitation.' using errcode = '42501';
  end if;
  select e.email into v_email from private.workspace_addresses(v_user) e
  join public.workspace_domains d on d.workspace_id = ws and d.domain = split_part(e.email, '@', 2)
  order by e.is_work desc limit 1;
  if v_email is null then
    raise exception 'Your confirmed email address doesn''t let you join that workspace: ask for an invitation.' using errcode = '42501';
  end if;
  insert into public.workspace_members (workspace_id, user_id, role, name, email, joined_via)
    values (ws, v_user, 'member', private.member_name(v_user, v_email), v_email, 'domain')
    on conflict (workspace_id, user_id) do nothing;
end $$;

-- Owners and admins change members' roles; only an owner makes or unmakes owners, and the last owner stays one.
create function public.set_member_role(ws uuid, member uuid, new_role text) returns void
language plpgsql security definer set search_path = '' as $$
declare
  v_mine text;
  v_theirs text;
begin
  perform 1 from public.workspaces w where w.id = ws and private.planner_or_agent() for update;
  v_mine := private.workspace_role(ws, auth.uid());
  v_theirs := private.workspace_role(ws, member);
  if not private.planner_or_agent() or v_mine is null or v_mine not in ('owner', 'admin') then
    raise exception 'Only the workspace''s owners and admins change roles.' using errcode = '42501';
  end if;
  if v_theirs is null then
    raise exception 'They aren''t a member of the workspace.' using errcode = 'P0002';
  end if;
  if new_role is null or new_role not in ('owner', 'admin', 'member') then
    raise exception 'A role is owner, admin or member.' using errcode = '22023';
  end if;
  if (new_role = 'owner' or v_theirs = 'owner') and v_mine <> 'owner' then
    raise exception 'Only an owner changes who owns the workspace.' using errcode = '42501';
  end if;
  if v_theirs = 'owner' and new_role <> 'owner'
     and (select count(*) from public.workspace_members m where m.workspace_id = ws and m.role = 'owner') = 1 then
    raise exception 'The workspace needs an owner: make someone else an owner first.' using errcode = '42501';
  end if;
  update public.workspace_members m set role = new_role where m.workspace_id = ws and m.user_id = member;
end $$;

-- Removes a member, or with the caller's own id leaves. The last owner can't leave while others are in it; the last
-- member leaving deletes the workspace and everything shared in it.
create function public.remove_member(ws uuid, member uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare
  v_mine text;
  v_theirs text;
  v_self boolean := member = auth.uid();
begin
  perform 1 from public.workspaces w where w.id = ws and private.planner_or_agent() for update;
  v_mine := private.workspace_role(ws, auth.uid());
  v_theirs := private.workspace_role(ws, member);
  if not private.planner_or_agent() or v_mine is null or (not v_self and v_mine not in ('owner', 'admin')) then
    raise exception 'Only the workspace''s owners and admins remove people.' using errcode = '42501';
  end if;
  if v_theirs is null then
    raise exception 'They aren''t a member of the workspace.' using errcode = 'P0002';
  end if;
  if v_theirs = 'owner' and not v_self and v_mine <> 'owner' then
    raise exception 'Only an owner removes an owner.' using errcode = '42501';
  end if;
  if v_theirs = 'owner' and (select count(*) from public.workspace_members m where m.workspace_id = ws and m.role = 'owner') = 1 then
    if exists (select 1 from public.workspace_members m where m.workspace_id = ws and m.user_id <> member) then
      raise exception 'The workspace needs an owner: make someone else an owner first.' using errcode = '42501';
    end if;
    perform private.delete_workspace(ws);
    return;
  end if;
  if not v_self then
    insert into private.workspace_removals (workspace_id, user_id) values (ws, member)
    on conflict (workspace_id, user_id) do update set removed_at = excluded.removed_at;
  end if;
  delete from public.workspace_members m where m.workspace_id = ws and m.user_id = member;
end $$;

-- Shares one of the caller's own areas with a workspace they manage, with its projects and tasks (and their
-- sub-tasks, dependencies, reports and images). Links to work left outside the area are dropped; a task key the
-- workspace has already changes to the area's next one. Answers what moved.
create function public.share_area(area uuid, ws uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_area public.areas;
  v_projects integer;
  v_tasks integer;
begin
  if not private.planner_or_agent() then
    raise exception 'Sign in to PacedMind Cloud first.' using errcode = '42501';
  end if;
  select * into v_area from public.areas a where a.id = share_area.area for update;
  if not found or v_area.user_id <> auth.uid() or v_area.workspace_id is not null then
    raise exception 'Share an area of your own that isn''t in a workspace yet.' using errcode = '42501';
  end if;
  if private.workspace_role(ws, auth.uid()) is null or coalesce(private.workspace_role(ws, auth.uid()), '') not in ('owner', 'admin') then
    raise exception 'Only the workspace''s owners and admins add areas to it.' using errcode = '42501';
  end if;
  if exists (select 1 from public.areas a where a.workspace_id = ws and a.key = v_area.key) then
    raise exception 'The workspace has an area with the key % already: rename one of them first.', v_area.key using errcode = '23505';
  end if;
  -- What links the area's work with work outside it stays behind.
  delete from public.edges e
    where (e.from_task_id in (select t.id from public.tasks t where t.area_id = v_area.id))
       <> (e.to_task_id in (select t.id from public.tasks t where t.area_id = v_area.id));
  update public.tasks t set related_project_id = null
    where t.related_project_id in (select p.id from public.projects p where p.area_id = v_area.id)
      and t.area_id is distinct from v_area.id;
  update public.tasks t set related_project_id = null
    where t.area_id = v_area.id and t.related_project_id in (select p.id from public.projects p where p.area_id <> v_area.id);
  update public.projects p set after_project_id = null
    where (p.area_id = v_area.id) <> (p.after_project_id in (select q.id from public.projects q where q.area_id = v_area.id));
  update public.areas a set workspace_id = ws where a.id = v_area.id;
  update public.projects p set workspace_id = ws where p.area_id = v_area.id;
  get diagnostics v_projects = row_count;
  update public.tasks t set workspace_id = ws where t.area_id = v_area.id;
  get diagnostics v_tasks = row_count;
  return jsonb_build_object('area', v_area.id, 'workspace', ws, 'projects', v_projects, 'tasks', v_tasks);
end $$;

/* ---------- 5. accounts: deleting one, and its copies ---------- */

-- Deleting an account (by itself, or by the project's owner in Supabase): workspaces only it was in go with it; a
-- workspace it alone owned gets a new owner (its longest-standing admin, else member); what it wrote in workspaces
-- stays there under one of their owners. Its reports and images go with its sessions, as before.
create function private.handle_deleted_user() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  r record;
  v_owner uuid;
begin
  for r in
    select m.workspace_id from public.workspace_members m
    where m.user_id = old.id
      and not exists (select 1 from public.workspace_members o where o.workspace_id = m.workspace_id and o.user_id <> old.id)
  loop
    perform private.delete_workspace(r.workspace_id);
  end loop;
  for r in
    select m.workspace_id from public.workspace_members m
    where m.user_id = old.id and m.role = 'owner'
      and not exists (select 1 from public.workspace_members o where o.workspace_id = m.workspace_id and o.role = 'owner' and o.user_id <> old.id)
  loop
    update public.workspace_members m set role = 'owner'
      where m.workspace_id = r.workspace_id and m.user_id = (
        select x.user_id from public.workspace_members x where x.workspace_id = r.workspace_id and x.user_id <> old.id
        order by (x.role = 'admin') desc, x.joined_at, x.user_id limit 1);
  end loop;
  for r in
    select distinct x.workspace_id from (
      select a.workspace_id from public.areas a where a.user_id = old.id and a.workspace_id is not null
      union select p.workspace_id from public.projects p where p.user_id = old.id and p.workspace_id is not null
      union select t.workspace_id from public.tasks t where t.user_id = old.id and t.workspace_id is not null
      union select s.workspace_id from public.subtasks s where s.user_id = old.id and s.workspace_id is not null
      union select e.workspace_id from public.edges e where e.user_id = old.id and e.workspace_id is not null
    ) x
  loop
    select m.user_id into v_owner from public.workspace_members m
      where m.workspace_id = r.workspace_id and m.user_id <> old.id
      order by (m.role = 'owner') desc, (m.role = 'admin') desc, m.joined_at, m.user_id limit 1;
    if v_owner is null then
      perform private.delete_workspace(r.workspace_id);
      continue;
    end if;
    update public.areas set user_id = v_owner where user_id = old.id and workspace_id = r.workspace_id;
    update public.projects set user_id = v_owner where user_id = old.id and workspace_id = r.workspace_id;
    update public.tasks set user_id = v_owner where user_id = old.id and workspace_id = r.workspace_id;
    update public.subtasks set user_id = v_owner where user_id = old.id and workspace_id = r.workspace_id;
    update public.edges set user_id = v_owner where user_id = old.id and workspace_id = r.workspace_id;
  end loop;
  return old;
end $$;

create trigger on_auth_user_deleted before delete on auth.users
  for each row execute function private.handle_deleted_user();

create or replace function public.delete_account() returns void
language plpgsql security definer set search_path = '' as $$
begin
  if not ((private.session_ok() and private.recent_mfa(300)) or private.recent_primary_auth(300)) then
    raise exception 'Confirm your identity again before deleting your account.' using errcode = '42501';
  end if;
  if exists (
    select 1 from public.billing b
    where b.user_id = auth.uid() and b.subscription_id is not null and not b.cancel_at_period_end
      and b.status in ('active', 'trialing', 'past_due', 'unpaid')
  ) then
    raise exception 'Cancel your subscription in Manage billing first: it would go on renewing.' using errcode = '42501';
  end if;
  if exists (
    select 1 from public.workspace_members m
    where m.user_id = auth.uid() and m.role = 'owner'
      and not exists (select 1 from public.workspace_members o where o.workspace_id = m.workspace_id and o.role = 'owner' and o.user_id <> m.user_id)
      and exists (select 1 from public.workspace_members x where x.workspace_id = m.workspace_id and x.user_id <> m.user_id)
  ) then
    raise exception 'You own a team workspace with other members: make one of them an owner first.' using errcode = '42501';
  end if;
  delete from auth.users where id = auth.uid();
end $$;

-- A copy holds the account's personal data only; putting one back replaces only that. Its sessions on shared tasks
-- stay as they are.
create or replace function public.save_account_copy(reason text) returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  v_user uuid := auth.uid();
  v_data jsonb;
  v_id uuid;
begin
  if v_user is null or not private.planner_session_ok() then
    raise exception 'Sign in again to keep a copy of your data.' using errcode = '42501';
  end if;
  if save_account_copy.reason is null or save_account_copy.reason not in ('sample', 'empty', 'restore') then
    raise exception 'A copy is kept before sample data, starting empty or putting a copy back.' using errcode = '22023';
  end if;
  if not exists (select 1 from public.projects x where x.user_id = v_user and x.workspace_id is null)
    and not exists (select 1 from public.tasks x where x.user_id = v_user and x.workspace_id is null)
    and not exists (select 1 from public.events x where x.user_id = v_user) then
    return null;
  end if;
  v_data := jsonb_build_object(
    'areas', (select coalesce(jsonb_agg(to_jsonb(x) order by x.sort, x.id), '[]') from public.areas x where x.user_id = v_user and x.workspace_id is null),
    'projects', (select coalesce(jsonb_agg(to_jsonb(x) order by x.sort, x.id), '[]') from public.projects x where x.user_id = v_user and x.workspace_id is null),
    'tasks', (select coalesce(jsonb_agg(to_jsonb(x) order by x.id), '[]') from public.tasks x where x.user_id = v_user and x.workspace_id is null),
    'subtasks', (select coalesce(jsonb_agg(to_jsonb(x) order by x.id), '[]') from public.subtasks x where x.user_id = v_user and x.workspace_id is null),
    'events', (select coalesce(jsonb_agg(to_jsonb(x) order by x.id), '[]') from public.events x where x.user_id = v_user),
    'sessions', (select coalesce(jsonb_agg(to_jsonb(x) order by x.started_at, x.id), '[]') from public.sessions x
      where x.user_id = v_user and exists (select 1 from public.tasks t where t.id = x.task_id and t.workspace_id is null)),
    'session_events', (select coalesce(jsonb_agg(to_jsonb(x) order by x.id), '[]') from public.session_events x
      where x.user_id = v_user and exists (
        select 1 from public.sessions s join public.tasks t on t.id = s.task_id
        where s.id = x.session_id and t.workspace_id is null)),
    'reports', (select coalesce(jsonb_agg(to_jsonb(x) order by x.id), '[]') from public.reports x where x.user_id = v_user and x.workspace_id is null),
    'attachments', (select coalesce(jsonb_agg(to_jsonb(x) order by x.created_at, x.id), '[]') from public.attachments x where x.user_id = v_user and x.workspace_id is null),
    'edges', (select coalesce(jsonb_agg(to_jsonb(x) order by x.id), '[]') from public.edges x where x.user_id = v_user and x.workspace_id is null),
    'key_counters', (select coalesce(jsonb_agg(to_jsonb(x) order by x.prefix), '[]') from public.key_counters x where x.user_id = v_user)
  );
  insert into public.account_copies (user_id, reason, areas, projects, tasks, events, data)
  values (v_user, save_account_copy.reason, jsonb_array_length(v_data -> 'areas'), jsonb_array_length(v_data -> 'projects'),
    jsonb_array_length(v_data -> 'tasks'), jsonb_array_length(v_data -> 'events'), v_data)
  returning id into v_id;
  delete from public.account_copies c where c.user_id = v_user and c.id not in (
    select k.id from public.account_copies k where k.user_id = v_user order by k.created_at desc, k.id desc limit 10
  );
  return v_id;
end $$;

create or replace function public.restore_account_copy(copy_id uuid) returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  v_user uuid := auth.uid();
  v_data jsonb;
  v_kept uuid;
  v_devices uuid[];
  v_table text;
begin
  if v_user is null or not private.planner_session_ok() then
    raise exception 'Sign in again to put a copy back.' using errcode = '42501';
  end if;
  select c.data into v_data from public.account_copies c where c.id = restore_account_copy.copy_id and c.user_id = v_user;
  if v_data is null then
    raise exception 'That copy isn''t there any more.' using errcode = 'P0002';
  end if;
  v_kept := public.save_account_copy('restore');

  -- Deleting tasks takes their sub-tasks, sessions, reports, images and dependencies along; areas take their projects.
  -- Only personal rows: what the account wrote in team workspaces stays.
  delete from public.google_calendar_connections x where x.user_id = v_user;
  delete from public.tasks x where x.user_id = v_user and x.workspace_id is null;
  delete from public.events x where x.user_id = v_user;
  delete from public.projects x where x.user_id = v_user and x.workspace_id is null;
  delete from public.areas x where x.user_id = v_user and x.workspace_id is null;
  delete from public.key_counters x where x.user_id = v_user;

  -- A copy's rows are the account's own and personal, whatever it says.
  foreach v_table in array array['areas', 'projects', 'tasks', 'subtasks', 'reports', 'attachments', 'edges'] loop
    v_data := jsonb_set(v_data, array[v_table], coalesce((
      select jsonb_agg(case when e ? 'workspace_id' then e - 'workspace_id' else e end order by o)
      from jsonb_array_elements(coalesce(v_data -> v_table, '[]')) with ordinality as x (e, o)
    ), '[]'));
  end loop;
  v_data := jsonb_set(v_data, '{tasks}', coalesce((
    select jsonb_agg(case when e ->> 'assignee_id' is not null then jsonb_set(e, '{assignee_id}', to_jsonb(v_user)) else e end order by o)
    from jsonb_array_elements(coalesce(v_data -> 'tasks', '[]')) with ordinality as x (e, o)
  ), '[]'));
  select coalesce(array_agg(d.id), '{}') into v_devices from public.devices d where d.user_id = v_user;
  foreach v_table in array array['projects', 'tasks', 'sessions', 'attachments'] loop
    v_data := jsonb_set(v_data, array[v_table], coalesce((
      select jsonb_agg(case when e ->> 'device_id' is not null and not ((e ->> 'device_id')::uuid = any (v_devices))
        then jsonb_set(e, '{device_id}', 'null'::jsonb) else e end order by o)
      from jsonb_array_elements(coalesce(v_data -> v_table, '[]')) with ordinality as x (e, o)
    ), '[]'));
  end loop;
  foreach v_table in array array['areas', 'projects', 'tasks', 'subtasks', 'events', 'sessions', 'session_events',
    'reports', 'attachments', 'edges'] loop
    perform private.put_back(v_table, v_data -> v_table, v_user);
  end loop;
  -- Keys go on from where they were, also past tasks deleted before the copy was made.
  insert into public.key_counters as c (user_id, prefix, last)
    select v_user, r.prefix, r.last
    from jsonb_populate_recordset(null::public.key_counters, coalesce(v_data -> 'key_counters', '[]')) r
  on conflict (user_id, prefix) do update set last = greatest(c.last, excluded.last);
  return v_kept;
end $$;

/* ---------- privileges ---------- */

revoke execute on function
  private.my_workspaces(), private.my_admin_workspaces(), private.workspace_role(uuid, uuid), private.is_workspace_member(uuid, uuid),
  private.can_reference(uuid, uuid, uuid), private.planner_or_agent(), private.verified_email(uuid), private.member_name(uuid, text),
  private.workspace_writable(uuid), private.workspace_task_key(uuid, text, uuid), private.keep_authorship(),
  private.area_delete_tasks(), private.project_scope(), private.task_scope(), private.task_child_scope(), private.edge_scope(),
  private.personal_references(), private.task_workspace_follows(), private.bump_shared_version(), private.require_cloud_row(),
  private.bump_workspace(), private.member_left(), private.public_email_domain(text), private.handle_deleted_user(),
  private.project_workspace_follows(), private.delete_workspace(uuid)
  from public, anon, authenticated;
-- The policies call these two as the signed-in account.
grant execute on function private.my_workspaces(), private.my_admin_workspaces() to authenticated;

revoke execute on function
  public.create_workspace(text, text), public.rename_workspace(uuid, text), public.invite_member(uuid, text, text),
  public.revoke_invite(uuid), public.invite_details(text), public.accept_invite(text), public.add_workspace_domain(uuid, text),
  public.remove_workspace_domain(uuid, text), public.joinable_workspaces(), public.join_workspace(uuid),
  public.set_member_role(uuid, uuid, text), public.remove_member(uuid, uuid), public.share_area(uuid, uuid)
  from public, anon;
grant execute on function
  public.create_workspace(text, text), public.rename_workspace(uuid, text), public.invite_member(uuid, text, text),
  public.revoke_invite(uuid), public.invite_details(text), public.accept_invite(text), public.add_workspace_domain(uuid, text),
  public.remove_workspace_domain(uuid, text), public.joinable_workspaces(), public.join_workspace(uuid),
  public.set_member_role(uuid, uuid, text), public.remove_member(uuid, uuid), public.share_area(uuid, uuid)
  to authenticated;
