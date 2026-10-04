-- Queue and display metadata boundaries. All fixtures are isolated and rolled back.
begin;
do $test$
declare
  account uuid := gen_random_uuid(); outsider uuid := gen_random_uuid();
  human uuid := gen_random_uuid(); other_human uuid := gen_random_uuid(); factor uuid := gen_random_uuid();
  device uuid := gen_random_uuid(); other_device uuid := gen_random_uuid();
  agent uuid := gen_random_uuid(); client uuid := gen_random_uuid();
  task bigint; foreign_task bigint; request uuid; agent_request uuid; n integer; i integer;
  human_claims text; other_claims text; agent_claims text;
begin
  insert into auth.users(instance_id, id, aud, role, email, encrypted_password, email_confirmed_at, raw_app_meta_data, raw_user_meta_data, created_at, updated_at)
    values ('00000000-0000-0000-0000-000000000000', account, 'authenticated', 'authenticated', 'notes@example.invalid', '', now(), '{}', '{}', now(), now()),
           ('00000000-0000-0000-0000-000000000000', outsider, 'authenticated', 'authenticated', 'notes-other@example.invalid', '', now(), '{}', '{}', now(), now());
  insert into auth.mfa_factors(id, user_id, friendly_name, factor_type, status, created_at, updated_at, secret)
    values(factor, account, 'Notes fixture', 'totp', 'verified', now() - interval '1 day', now(), 'x');
  insert into auth.sessions(id, user_id, created_at, updated_at, aal, factor_id)
    values(human, account, now() - interval '1 hour', now(), 'aal2', factor), (other_human, account, now() - interval '1 hour', now(), 'aal2', factor);
  insert into public.devices(id, user_id, name, platform, auth_session_id)
    values(device, account, 'Notes desktop', 'windows', human), (other_device, account, 'Other desktop', 'macos', other_human);
  insert into public.tasks(user_id, key, title, created_at, updated_at)
    values(account, '', 'Own note', '2026-10-04T10:00:00', '2026-10-04T10:00:00') returning id into task;
  insert into public.tasks(user_id, key, title, created_at, updated_at)
    values(outsider, '', 'Private note', '2026-10-04T10:00:00', '2026-10-04T10:00:00') returning id into foreign_task;
  insert into auth.oauth_clients(id, registration_type, redirect_uris, grant_types, client_name, client_type, token_endpoint_auth_method)
    values(client, 'dynamic', 'http://localhost:1/callback', 'authorization_code,refresh_token', 'Notes MCP', 'public', 'none');
  insert into auth.sessions(id, user_id, created_at, updated_at, aal, oauth_client_id)
    values(agent, account, now(), now(), 'aal1', client);
  insert into public.agent_logins(user_id, request_id, client_id, request_expires_at, session_id, claimed_at, mfa_approved)
    values(account, 'notes-consent', client, now() + interval '2 minutes', agent, now(), true);
  human_claims := jsonb_build_object('sub', account, 'session_id', human, 'role', 'authenticated', 'aal', 'aal2')::text;
  other_claims := jsonb_build_object('sub', account, 'session_id', other_human, 'role', 'authenticated', 'aal', 'aal2')::text;
  agent_claims := jsonb_build_object('sub', account, 'session_id', agent, 'client_id', client, 'role', 'authenticated', 'aal', 'aal1')::text;

  set local role anon;
  begin
    perform 1 from public.task_note_requests;
    raise exception 'Anonymous read was allowed';
  exception when insufficient_privilege then null; end;
  reset role;
  perform set_config('request.jwt.claims', human_claims, true);
  set local role authenticated;
  update public.devices set note_displays = '{"displays":[]}' where id = device;
  get diagnostics n = row_count;
  if n <> 1 then raise exception 'Own display report failed'; end if;
  begin
    update public.devices set note_displays = '{"displays":[]}' where id = other_device;
    raise exception 'Another computer could forge displays';
  exception when insufficient_privilege then null; end;
  insert into public.task_note_requests(device_id, task_id, task_created_at, display_id, remember)
    values(device, task, '2026-10-04T10:00:00', '2', true) returning id into request;
  if (select status <> 'pending' or agent_session is not null or expires_at <> requested_at + interval '2 minutes'
    from public.task_note_requests where id = request) then raise exception 'Queue defaults were not server-owned'; end if;
  begin
    insert into public.task_note_requests(device_id, task_id, task_created_at, display_id)
      values(device, foreign_task, '2026-10-04T10:00:00', '2');
    raise exception 'Cross-account task accepted';
  exception when foreign_key_violation then null; end;
  begin
    update public.task_note_requests set display_id = '3' where id = request;
    raise exception 'Request destination was changed';
  exception when insufficient_privilege then null; end;
  begin
    update public.task_note_requests set status = 'opened' where id = request;
    raise exception 'Opened without dispatch';
  exception when insufficient_privilege then null; end;
  reset role;

  perform set_config('request.jwt.claims', other_claims, true);
  set local role authenticated;
  update public.task_note_requests set status = 'dispatched' where id = request;
  get diagnostics n = row_count;
  if n <> 0 then raise exception 'Another computer delivered the note'; end if;
  reset role;
  perform set_config('request.jwt.claims', agent_claims, true);
  set local role authenticated;
  if not private.agent_computer_ok() then raise exception 'Bad agent fixture'; end if;
  select count(*) into n from public.task_note_requests;
  if n <> 0 then raise exception 'Agent read a human request'; end if;
  insert into public.task_note_requests(device_id, task_id, task_created_at, display_id)
    values(device, task, '2026-10-04T10:00:00', '2') returning id into agent_request;
  if (select agent_session from public.task_note_requests where id = agent_request) <> agent then raise exception 'Agent attribution missing'; end if;
  update public.task_note_requests set status = 'dispatched' where id = agent_request;
  get diagnostics n = row_count;
  if n <> 0 then raise exception 'Agent delivered its own request'; end if;
  update public.devices set note_displays = '{"displays":[]}' where id = device;
  get diagnostics n = row_count;
  if n <> 0 then raise exception 'Agent forged display metadata'; end if;
  reset role;
  update public.agent_logins set mfa_approved = false where session_id = agent;
  set local role authenticated;
  begin
    insert into public.task_note_requests(device_id, task_id, task_created_at, display_id)
      values(device, task, '2026-10-04T10:00:00', '2');
    raise exception 'Planner-only agent controlled a computer';
  exception when insufficient_privilege then null; end;
  reset role;

  perform set_config('request.jwt.claims', human_claims, true);
  set local role authenticated;
  update public.task_note_requests set status = 'dispatched' where id in (request, agent_request);
  get diagnostics n = row_count;
  if n <> 2 then raise exception 'Computer could not claim both requests'; end if;
  update public.task_note_requests set status = 'opened', note = 'Opened on display 2' where id in (request, agent_request);
  begin
    update public.task_note_requests set status = 'dispatched' where id = request;
    raise exception 'Settled note could be delivered twice';
  exception when insufficient_privilege then null; end;
  for i in 1..24 loop
    insert into public.task_note_requests(device_id, task_id, task_created_at, display_id) values(device, task, '2026-10-04T10:00:00', '2');
  end loop;
  begin
    insert into public.task_note_requests(device_id, task_id, task_created_at, display_id) values(device, task, '2026-10-04T10:00:00', '2');
    raise exception 'Unbounded request queue';
  exception when program_limit_exceeded then null; end;
  reset role;
  -- No cross-account leakage even to an otherwise valid signed-in human.
  update auth.sessions set user_id = outsider where id = human;
  perform set_config('request.jwt.claims', (human_claims::jsonb || jsonb_build_object('sub', outsider))::text, true);
  set local role authenticated;
  select count(*) into n from public.task_note_requests;
  if n <> 0 then raise exception 'Cross-account request read'; end if;
  reset role;
end $test$;
rollback;
