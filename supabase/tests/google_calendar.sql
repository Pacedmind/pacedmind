begin;
do $test$
declare
  account uuid := gen_random_uuid(); outsider uuid := gen_random_uuid();
  human uuid := gen_random_uuid(); changed integer; saved uuid;
begin
  insert into auth.users(instance_id, id, aud, role, email, encrypted_password, email_confirmed_at, raw_app_meta_data, raw_user_meta_data, created_at, updated_at)
    values ('00000000-0000-0000-0000-000000000000', account, 'authenticated', 'authenticated', 'calendar@example.invalid', '', now(), '{}', '{}', now(), now()),
      ('00000000-0000-0000-0000-000000000000', outsider, 'authenticated', 'authenticated', 'calendar-other@example.invalid', '', now(), '{}', '{}', now(), now());
  insert into auth.sessions(id, user_id, created_at, updated_at, aal) values(human, account, now(), now(), 'aal1');
  insert into public.google_calendar_connections(user_id, revision, owner, payload) values(outsider, 1, repeat('a',64), repeat('x',100));
  perform set_config('request.jwt.claims', jsonb_build_object('sub',account,'session_id',human,'role','authenticated','aal','aal1')::text, true);
  set local role authenticated;
  if exists(select 1 from public.google_calendar_connections) then raise exception 'Another account connection was exposed'; end if;
  insert into public.google_calendar_connections(revision,owner,payload) values(1,repeat('b',64),repeat('y',100));
  update public.google_calendar_connections set revision=2 where revision=1;
  get diagnostics changed = row_count;
  if changed <> 1 then raise exception 'Connection compare-and-swap failed'; end if;
  update public.google_calendar_connections set revision=3 where revision=1;
  get diagnostics changed = row_count;
  if changed <> 0 then raise exception 'Stale connection write was accepted'; end if;
  delete from public.google_calendar_connections where user_id=outsider;
  get diagnostics changed = row_count;
  if changed <> 0 then raise exception 'Another account connection was deleted'; end if;
  insert into public.events(title,start_at,end_at,calendar_data) values('Preserved','2026-10-26T10:00','2026-10-26T11:00','{"timeZone":"Europe/Warsaw","allDay":false}');
  saved := public.save_account_copy('empty');
  perform public.restore_account_copy(saved);
  if exists(select 1 from public.google_calendar_connections) then raise exception 'Restoring data left Google sync active'; end if;
  if (select calendar_data->>'timeZone' from public.events where title='Preserved') <> 'Europe/Warsaw' then raise exception 'Copy lost calendar metadata'; end if;
  -- A valid human token with an OAuth client claim must not be accepted as a human.
  perform set_config('request.jwt.claims', jsonb_build_object('sub',account,'session_id',human,'role','authenticated','aal','aal1','client_id',gen_random_uuid())::text, true);
  begin
    insert into public.google_calendar_connections(revision,owner,payload) values(1,repeat('b',64),repeat('y',100));
    raise exception 'An agent wrote Google credentials';
  exception when insufficient_privilege then null; end;
  reset role;
end $test$;
rollback;
