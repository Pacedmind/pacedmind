-- Copies of an account's data, kept in the account, so that starting it over can be undone. Settings → Data saves
-- one before Load sample data or Start empty deletes what's there, and before a copy is put back (which replaces
-- what's there in turn); it lists them and puts one back. A copy holds the account's areas, projects, tasks with
-- their sub-tasks, sessions, session events, reports, images' records and dependencies, activities and task key
-- counters, as rows. Settings and preferences stay through a reset, so a copy leaves them out. The newest ten stay.
-- Only the functions below write copies, and only from a person's own sign-in: agents signed in with OAuth neither
-- read them nor put one back. The account reads and deletes its own.

create table public.account_copies (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users (id) on delete cascade,
  created_at timestamptz not null default now(),
  -- What replaced the data: the sample data, starting empty, or another copy put back.
  reason text not null check (reason in ('sample', 'empty', 'restore')),
  -- What it holds, for the list in Settings.
  areas integer not null check (areas >= 0),
  projects integer not null check (projects >= 0),
  tasks integer not null check (tasks >= 0),
  events integer not null check (events >= 0),
  data jsonb not null check (jsonb_typeof(data) = 'object'),
  unique (user_id, id)
);

create index account_copies_user_idx on public.account_copies (user_id, created_at desc);

revoke all on public.account_copies from anon;
revoke insert, update, delete, truncate, references, trigger on public.account_copies from authenticated;
grant delete on public.account_copies to authenticated;

alter table public.account_copies enable row level security;

create policy "Own copies" on public.account_copies for select to authenticated
  using ((select auth.uid()) = user_id);
create policy "Delete own copies" on public.account_copies for delete to authenticated
  using ((select auth.uid()) = user_id);
create policy "Two-factor session" on public.account_copies as restrictive for all to authenticated
  using ((select private.planner_session_ok())) with check ((select private.planner_session_ok()));

-- Saves a copy of the signed-in account's data and answers its id, or null when there's nothing to keep (no
-- projects, tasks or activities: just areas, which every account has).
create function public.save_account_copy(reason text) returns uuid
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
  if not exists (select 1 from public.projects x where x.user_id = v_user)
    and not exists (select 1 from public.tasks x where x.user_id = v_user)
    and not exists (select 1 from public.events x where x.user_id = v_user) then
    return null;
  end if;
  v_data := jsonb_build_object(
    'areas', (select coalesce(jsonb_agg(to_jsonb(x) order by x.sort, x.id), '[]') from public.areas x where x.user_id = v_user),
    'projects', (select coalesce(jsonb_agg(to_jsonb(x) order by x.sort, x.id), '[]') from public.projects x where x.user_id = v_user),
    'tasks', (select coalesce(jsonb_agg(to_jsonb(x) order by x.id), '[]') from public.tasks x where x.user_id = v_user),
    'subtasks', (select coalesce(jsonb_agg(to_jsonb(x) order by x.id), '[]') from public.subtasks x where x.user_id = v_user),
    'events', (select coalesce(jsonb_agg(to_jsonb(x) order by x.id), '[]') from public.events x where x.user_id = v_user),
    'sessions', (select coalesce(jsonb_agg(to_jsonb(x) order by x.started_at, x.id), '[]') from public.sessions x where x.user_id = v_user),
    'session_events', (select coalesce(jsonb_agg(to_jsonb(x) order by x.id), '[]') from public.session_events x where x.user_id = v_user),
    'reports', (select coalesce(jsonb_agg(to_jsonb(x) order by x.id), '[]') from public.reports x where x.user_id = v_user),
    'attachments', (select coalesce(jsonb_agg(to_jsonb(x) order by x.created_at, x.id), '[]') from public.attachments x where x.user_id = v_user),
    'edges', (select coalesce(jsonb_agg(to_jsonb(x) order by x.id), '[]') from public.edges x where x.user_id = v_user),
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

-- Puts one table's rows from a copy back into the account, with their ids, under the account's own user_id whatever
-- the copy says. Columns the copy doesn't have (added since) get their defaults. Only restore_account_copy calls it,
-- with a table it names itself.
create function private.put_back(p_table text, p_rows jsonb, p_user uuid) returns integer
language plpgsql security definer set search_path = '' as $$
declare
  v_columns text;
  v_values text;
  v_count integer;
begin
  if p_rows is null or jsonb_typeof(p_rows) <> 'array' or jsonb_array_length(p_rows) = 0 then
    return 0;
  end if;
  select string_agg(format('%I', a.attname), ', ' order by a.attnum),
         string_agg(case when a.attname = 'user_id' then '$2' else format('r.%I', a.attname) end, ', ' order by a.attnum)
    into v_columns, v_values
  from pg_catalog.pg_attribute a
  where a.attrelid = format('public.%I', p_table)::regclass and a.attnum > 0 and not a.attisdropped
    and a.attgenerated = '' and a.attidentity <> 'a'
    and (a.attname = 'user_id' or (p_rows -> 0) ? a.attname);
  execute format('insert into public.%I (%s) select %s from jsonb_populate_recordset(null::public.%I, $1) r',
    p_table, v_columns, v_values, p_table)
    using p_rows, p_user;
  get diagnostics v_count = row_count;
  return v_count;
end $$;

-- Puts a copy back: what the account holds now becomes a copy first (answered, or null when there was nothing to
-- keep), then the account's areas, projects, tasks and activities are replaced by the copy's, with their ids and keys,
-- in one transaction. What ran on a computer that has been signed out since keeps no computer.
create function public.restore_account_copy(copy_id uuid) returns uuid
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
  delete from public.tasks x where x.user_id = v_user;
  delete from public.events x where x.user_id = v_user;
  delete from public.projects x where x.user_id = v_user;
  delete from public.areas x where x.user_id = v_user;
  delete from public.key_counters x where x.user_id = v_user;

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

revoke execute on function public.save_account_copy(text), public.restore_account_copy(uuid) from public, anon;
grant execute on function public.save_account_copy(text), public.restore_account_copy(uuid) to authenticated;
revoke execute on function private.put_back(text, jsonb, uuid) from public, anon, authenticated;
