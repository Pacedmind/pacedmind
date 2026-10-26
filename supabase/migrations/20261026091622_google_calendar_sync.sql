-- OAuth secrets are encrypted on the host that owns the connection. Agents never read this table.
alter table public.events add column calendar_data jsonb;
alter table public.events add constraint events_calendar_data_check check (
  calendar_data is null or (jsonb_typeof(calendar_data) = 'object' and octet_length(calendar_data::text) <= 131072)
);
alter table public.events drop constraint events_title_check;
alter table public.events add constraint events_title_check check (char_length(title) between 1 and 16000);

create table public.google_calendar_connections (
  user_id uuid primary key default auth.uid() references auth.users(id) on delete cascade,
  revision bigint not null check (revision > 0),
  owner text not null check (owner ~ '^[a-f0-9]{64}$'),
  payload text not null check (octet_length(payload) between 40 and 33554432),
  lease_until bigint not null default 0 check (lease_until >= 0)
);
alter table public.google_calendar_connections enable row level security;
revoke all on public.google_calendar_connections from public, anon, authenticated;
grant select, insert, update, delete on public.google_calendar_connections to authenticated;
create policy calendar_owner on public.google_calendar_connections to authenticated
  using ((select auth.uid()) = user_id and (select private.planner_session_ok()))
  with check ((select auth.uid()) = user_id and (select private.planner_session_ok()));
create trigger google_calendar_require_cloud before insert or update on public.google_calendar_connections
  for each statement execute function private.require_cloud();

-- A restored snapshot must never be mistaken for edits/deletions to send to Google.
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
  delete from public.google_calendar_connections x where x.user_id = v_user;
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
