-- Task notes only show existing planner tasks. No paths, scripts, URLs or session launches cross this queue.
alter table public.devices add column note_displays jsonb
  check (note_displays is null or (jsonb_typeof(note_displays) = 'object' and octet_length(note_displays::text) <= 16000));
grant update (note_displays) on public.devices to authenticated;

-- Use a separate trigger so future changes to device_reports_itself cannot omit this column.
create function private.device_note_displays() returns trigger
language plpgsql set search_path = '' as $$
begin
  if current_user = 'authenticated' and new.note_displays is distinct from old.note_displays
    and not private.is_own_computer(old.id) then
    raise exception 'Only that computer reports its displays.' using errcode = '42501';
  end if;
  return new;
end $$;
create trigger device_note_displays before update on public.devices
  for each row execute function private.device_note_displays();

create table public.task_note_requests (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  device_id uuid not null,
  task_id bigint not null,
  task_created_at text not null check (task_created_at ~ '^\d{4}-\d{2}-\d{2}T[0-9:.+Z-]{5,25}$'),
  display_id text not null check (display_id ~ '^-?[0-9]{1,20}$'),
  remember boolean not null default false,
  agent_session uuid,
  requested_at timestamptz not null default now(),
  expires_at timestamptz not null default now() + interval '2 minutes',
  status text not null default 'pending' check (status in ('pending', 'dispatched', 'opened', 'failed', 'expired')),
  note text check (char_length(note) <= 500),
  unique (user_id, id),
  foreign key (user_id, device_id) references public.devices(user_id, id) on delete cascade,
  foreign key (user_id, task_id) references public.tasks(user_id, id) on delete cascade
);
create index task_note_requests_device on public.task_note_requests(user_id, device_id, requested_at desc);
create index task_note_requests_task on public.task_note_requests(user_id, task_id);

create function private.task_note_defaults() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  -- Serialize admissions on one computer, including simultaneous requests from different agents.
  perform 1 from public.devices d where d.id = new.device_id and d.user_id = new.user_id and d.revoked_at is null for update;
  if not found then raise exception 'That computer is signed out.' using errcode = '42501'; end if;
  delete from public.task_note_requests where user_id = new.user_id and expires_at < now() - interval '1 day';
  if (select count(*) from public.task_note_requests r where r.user_id = new.user_id and r.device_id = new.device_id
    and r.status in ('pending', 'dispatched') and r.expires_at > now()) >= 24 then
    raise exception 'Too many notes are waiting for that computer.' using errcode = '54000';
  end if;
  new.agent_session := case when private.computer_session_ok() then null else nullif(auth.jwt() ->> 'session_id', '')::uuid end;
  new.requested_at := now(); new.expires_at := now() + interval '2 minutes'; new.status := 'pending'; new.note := null;
  return new;
end $$;

create function private.task_note_settled() returns trigger
language plpgsql set search_path = '' as $$
begin
  if not private.is_own_computer(old.device_id) then
    raise exception 'Only the computer asked can deliver a note.' using errcode = '42501';
  end if;
  if not ((old.status = 'pending' and new.status in ('dispatched', 'failed', 'expired'))
    or (old.status = 'dispatched' and new.status in ('opened', 'failed', 'expired'))) then
    raise exception 'A task note is delivered once.' using errcode = '42501';
  end if;
  if new.status = 'dispatched' and old.expires_at <= now() then
    raise exception 'That task note request has expired.' using errcode = '42501';
  end if;
  return new;
end $$;
create trigger task_note_defaults before insert on public.task_note_requests for each row execute function private.task_note_defaults();
create trigger task_note_settled before update on public.task_note_requests for each row execute function private.task_note_settled();

revoke all on public.task_note_requests from anon, authenticated;
grant select on public.task_note_requests to authenticated;
grant insert (device_id, task_id, task_created_at, display_id, remember) on public.task_note_requests to authenticated;
grant update (status, note) on public.task_note_requests to authenticated;
alter table public.task_note_requests enable row level security;
create policy "Own note requests" on public.task_note_requests for all to authenticated
  using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id);
create policy "Two-factor session, or the agent's own" on public.task_note_requests as restrictive for select to authenticated
  using ((select private.computer_session_ok())
    or ((select private.agent_computer_ok()) and agent_session = nullif(auth.jwt() ->> 'session_id', '')::uuid));
create policy "Two-factor session, or an approved agent" on public.task_note_requests as restrictive for insert to authenticated
  with check ((select private.computer_session_ok()) or (select private.agent_computer_ok()));
create policy "Two-factor session updates" on public.task_note_requests as restrictive for update to authenticated
  using ((select private.computer_session_ok()) and private.is_own_computer(device_id))
  with check ((select private.computer_session_ok()) and private.is_own_computer(device_id));
