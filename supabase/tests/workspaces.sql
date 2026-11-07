-- Team workspaces: who sees and changes what, invitations, domains, roles, keys, assignees, billing, leaving,
-- deleting an account, copies and webhooks. Run as postgres after all migrations (npm run test:sql). Every check
-- raises on a regression; all fixtures are rolled back.
begin;
do $test$
declare
  owner uuid := gen_random_uuid(); member uuid := gen_random_uuid(); outsider uuid := gen_random_uuid();
  joiner uuid := gen_random_uuid(); unconfirmed uuid := gen_random_uuid();
  s_owner uuid := gen_random_uuid(); s_member uuid := gen_random_uuid(); s_outsider uuid := gen_random_uuid();
  s_joiner uuid := gen_random_uuid(); s_unconfirmed uuid := gen_random_uuid();
  c_owner text; c_member text; c_outsider text; c_joiner text; c_unconfirmed text;
  epoch bigint := extract(epoch from now())::bigint;
  ws uuid; ws2 uuid; team_area uuid; owner_area uuid; member_area uuid; outsider_area uuid; shared_later uuid;
  team_project uuid; owner_project uuid;
  t_member bigint; t_owner bigint; t_owner_private bigint; t_member_private bigint; t_shared_later bigint; t bigint;
  k1 text; k2 text; k3 text;
  invite jsonb; invite_x jsonb; details jsonb; hook jsonb; moved jsonb; copy uuid;
  n integer; v text; ok boolean; version_before bigint;
  checks integer := 0;
begin
  insert into auth.users (instance_id, id, aud, role, email, encrypted_password, email_confirmed_at, raw_app_meta_data, raw_user_meta_data, created_at, updated_at)
  values
    ('00000000-0000-0000-0000-000000000000', owner, 'authenticated', 'authenticated', 'owner@acme-team.invalid', '', now(), '{}', '{"full_name":"Olivia Owner"}', now(), now()),
    ('00000000-0000-0000-0000-000000000000', member, 'authenticated', 'authenticated', 'Member@Acme-Team.invalid', '', now(), '{}', '{}', now(), now()),
    ('00000000-0000-0000-0000-000000000000', outsider, 'authenticated', 'authenticated', 'outsider@elsewhere.invalid', '', now(), '{}', '{}', now(), now()),
    ('00000000-0000-0000-0000-000000000000', joiner, 'authenticated', 'authenticated', 'joiner@acme-team.invalid', '', now(), '{}', '{}', now(), now()),
    ('00000000-0000-0000-0000-000000000000', unconfirmed, 'authenticated', 'authenticated', 'late@acme-team.invalid', '', null, '{}', '{}', now(), now());
  insert into auth.sessions (id, user_id, created_at, updated_at, aal)
  values (s_owner, owner, now(), now(), 'aal1'), (s_member, member, now(), now(), 'aal1'), (s_outsider, outsider, now(), now(), 'aal1'),
         (s_joiner, joiner, now(), now(), 'aal1'), (s_unconfirmed, unconfirmed, now(), now(), 'aal1');
  c_owner := jsonb_build_object('sub', owner, 'role', 'authenticated', 'aal', 'aal1', 'session_id', s_owner,
    'amr', jsonb_build_array(jsonb_build_object('method', 'password', 'timestamp', epoch)))::text;
  c_member := jsonb_build_object('sub', member, 'role', 'authenticated', 'aal', 'aal1', 'session_id', s_member)::text;
  c_outsider := jsonb_build_object('sub', outsider, 'role', 'authenticated', 'aal', 'aal1', 'session_id', s_outsider)::text;
  c_joiner := jsonb_build_object('sub', joiner, 'role', 'authenticated', 'aal', 'aal1', 'session_id', s_joiner)::text;
  c_unconfirmed := jsonb_build_object('sub', unconfirmed, 'role', 'authenticated', 'aal', 'aal1', 'session_id', s_unconfirmed)::text;
  select id into owner_area from public.areas where user_id = owner and key = 'WRK';
  select id into member_area from public.areas where user_id = member and key = 'WRK';
  select id into outsider_area from public.areas where user_id = outsider and key = 'WRK';
  select id into shared_later from public.areas where user_id = owner and key = 'PER';

  -- 1. Creating a workspace makes its creator the owner; nobody else sees it.
  perform set_config('request.jwt.claims', c_owner, true); set local role authenticated;
  ws := public.create_workspace('Acme team');
  if (select role from public.workspace_members where workspace_id = ws and user_id = owner) is distinct from 'owner' then
    raise exception 'Creator is not the owner';
  end if;
  if (select slug from public.workspaces where id = ws) <> 'acme-team' then raise exception 'Unexpected slug'; end if;
  if (select name from public.workspace_members where workspace_id = ws and user_id = owner) <> 'Olivia Owner' then
    raise exception 'Member name snapshot missing';
  end if;
  insert into public.areas (name, key, color, workspace_id) values ('Acme', 'ACM', '#6A8DC3', ws) returning id into team_area;
  insert into public.projects (area_id, name) values (team_area, 'Launch') returning id into team_project;
  insert into public.projects (area_id, name) values (owner_area, 'Owner private') returning id into owner_project;
  insert into public.tasks (key, area_id, title, created_at, updated_at)
    values ('', owner_area, 'Owner private task', '2026-11-07T10:00:00', '2026-11-07T10:00:00') returning id into t_owner_private;
  invite := public.invite_member(ws, ' Member@ACME-team.invalid ', 'member');
  invite_x := public.invite_member(ws, 'outsider@elsewhere.invalid', 'admin');
  reset role;
  if (select workspace_id from public.projects where id = team_project) is distinct from ws then raise exception 'Project did not join the workspace'; end if;
  if char_length(invite ->> 'token') <> 64 or invite ->> 'email' <> 'member@acme-team.invalid' then raise exception 'Unexpected invitation %', invite; end if;
  if exists (select 1 from public.workspace_invites where token_digest = invite ->> 'token') then raise exception 'Token stored in clear'; end if;
  checks := checks + 6;

  perform set_config('request.jwt.claims', c_outsider, true); set local role authenticated;
  select count(*) into n from public.workspaces; if n <> 0 then raise exception 'Outsider sees a workspace'; end if;
  select count(*) into n from public.workspace_members; if n <> 0 then raise exception 'Outsider sees members'; end if;
  select count(*) into n from public.areas where workspace_id is not null; if n <> 0 then raise exception 'Outsider sees shared areas'; end if;
  begin
    perform public.invite_member(ws, 'someone@elsewhere.invalid', 'member');
    raise exception 'Outsider invited someone';
  exception when insufficient_privilege then null; end;
  begin
    insert into public.workspace_members (workspace_id, user_id, role, name, email, joined_via) values (ws, outsider, 'owner', 'x', 'x@y.z', 'invite');
    raise exception 'Outsider added themselves';
  exception when insufficient_privilege then null; end;
  -- The invitation for another address is useless to the outsider, and theirs only works for them.
  begin
    perform public.accept_invite(invite ->> 'token');
    raise exception 'Outsider accepted someone else''s invitation';
  exception when insufficient_privilege then null; end;
  details := public.invite_details(invite ->> 'token');
  if (details ->> 'matches')::boolean or details ->> 'status' <> 'open' then raise exception 'Unexpected invitation details %', details; end if;
  reset role;
  checks := checks + 6;

  -- 2. Accepting: only with the invited, confirmed address, never by an agent.
  perform set_config('request.jwt.claims', c_member, true); set local role authenticated;
  select count(*) into n from public.areas where id = team_area; if n <> 0 then raise exception 'Non-member sees the shared area'; end if;
  if public.accept_invite(invite ->> 'token') <> ws then raise exception 'Accepting returned another workspace'; end if;
  if public.accept_invite(invite ->> 'token') <> ws then raise exception 'Accepting twice failed'; end if;
  select count(*) into n from public.workspace_invites; if n <> 0 then raise exception 'Member reads invitations'; end if;
  select count(*) into n from public.workspace_members where workspace_id = ws; if n <> 2 then raise exception 'Member sees % members', n; end if;
  reset role;
  if (select role from public.workspace_members where workspace_id = ws and user_id = member) <> 'member'
     or (select email from public.workspace_members where workspace_id = ws and user_id = member) <> 'member@acme-team.invalid' then
    raise exception 'Member joined with the wrong role or address';
  end if;
  perform set_config('request.jwt.claims', c_owner, true); set local role authenticated;
  begin
    perform token_digest from public.workspace_invites limit 1;
    raise exception 'Owner read an invitation digest';
  exception when insufficient_privilege then null; end;
  select count(*) into n from public.workspace_invites where accepted_at is not null; if n <> 1 then raise exception 'Invitation not marked accepted'; end if;
  reset role;
  checks := checks + 6;

  -- 3. Members work inside the shared area but don't manage it, and never see each other's personal data.
  perform set_config('request.jwt.claims', c_member, true); set local role authenticated;
  select count(*) into n from public.areas where id = team_area; if n <> 1 then raise exception 'Member does not see the shared area'; end if;
  select count(*) into n from public.areas where user_id = owner and workspace_id is null; if n <> 0 then raise exception 'Member sees the owner''s areas'; end if;
  select count(*) into n from public.tasks where id = t_owner_private; if n <> 0 then raise exception 'Member sees the owner''s task'; end if;
  select count(*) into n from public.projects where id = owner_project; if n <> 0 then raise exception 'Member sees the owner''s project'; end if;
  update public.areas set name = 'Renamed by member' where id = team_area;
  get diagnostics n = row_count; if n <> 0 then raise exception 'Member renamed the shared area'; end if;
  delete from public.areas where id = team_area;
  get diagnostics n = row_count; if n <> 0 then raise exception 'Member deleted the shared area'; end if;
  begin
    insert into public.areas (name, key, color, workspace_id) values ('Mine', 'MIN', '#6A8DC3', ws);
    raise exception 'Member created a shared area';
  exception when insufficient_privilege then null; end;
  insert into public.tasks (key, project_id, title, created_at, updated_at)
    values ('', team_project, 'Member task', '2026-11-07T10:00:00', '2026-11-07T10:00:00') returning id, key into t_member, k1;
  insert into public.tasks (key, area_id, title, created_at, updated_at)
    values ('', member_area, 'Member private task', '2026-11-07T10:00:00', '2026-11-07T10:00:00') returning id, key into t_member_private, k3;
  insert into public.subtasks (task_id, title) values (t_member, 'Step one');
  update public.projects set name = 'Launch v1' where id = team_project;
  get diagnostics n = row_count; if n <> 1 then raise exception 'Member could not change a shared project'; end if;
  reset role;
  perform set_config('request.jwt.claims', c_owner, true); set local role authenticated;
  insert into public.tasks (key, area_id, title, created_at, updated_at)
    values ('', team_area, 'Owner task', '2026-11-07T10:00:00', '2026-11-07T10:00:00') returning id, key into t_owner, k2;
  select count(*) into n from public.tasks where id = t_member; if n <> 1 then raise exception 'Owner does not see the member''s task'; end if;
  select count(*) into n from public.subtasks where task_id = t_member; if n <> 1 then raise exception 'Owner does not see shared sub-tasks'; end if;
  select count(*) into n from public.tasks where id = t_member_private; if n <> 0 then raise exception 'Owner sees the member''s personal task'; end if;
  insert into public.edges (from_task_id, to_task_id) values (t_member, t_owner);
  reset role;
  if k1 <> 'ACM-1' or k2 <> 'ACM-2' or k3 <> 'WRK-1' then raise exception 'Unexpected keys % % %', k1, k2, k3; end if;
  if (select workspace_id from public.tasks where id = t_member) is distinct from ws
     or (select workspace_id from public.subtasks where task_id = t_member) is distinct from ws
     or (select workspace_id from public.edges where from_task_id = t_member) is distinct from ws then
    raise exception 'Shared rows did not get the workspace';
  end if;
  if (select user_id from public.tasks where id = t_member) <> member then raise exception 'Author not kept'; end if;
  checks := checks + 14;

  perform set_config('request.jwt.claims', c_outsider, true); set local role authenticated;
  select count(*) into n from public.tasks where workspace_id = ws; if n <> 0 then raise exception 'Outsider sees shared tasks'; end if;
  select count(*) into n from public.subtasks where workspace_id = ws; if n <> 0 then raise exception 'Outsider sees shared sub-tasks'; end if;
  update public.tasks set title = 'Outsider' where id = t_member;
  get diagnostics n = row_count; if n <> 0 then raise exception 'Outsider changed a shared task'; end if;
  begin
    insert into public.tasks (key, area_id, title, created_at, updated_at) values ('', team_area, 'Intruder', '2026-11-07T10:00:00', '2026-11-07T10:00:00');
    raise exception 'Outsider added a task to the workspace';
  exception when insufficient_privilege then null; end;
  begin
    insert into public.sessions (id, task_id, agent, status, started_at) values ('aaaaaaaaaaaaaaaa', t_member, 'claude', 'running', '2026-11-07T10:00:00');
    raise exception 'Outsider started a session on a shared task';
  exception when foreign_key_violation then null; end;
  reset role;
  checks := checks + 5;

  -- 4. References stay inside their place: no pointing at someone's personal rows, nothing leaves a workspace.
  perform set_config('request.jwt.claims', c_member, true); set local role authenticated;
  begin
    insert into public.tasks (key, area_id, title, created_at, updated_at) values ('', owner_area, 'Into owner''s area', '2026-11-07T10:00:00', '2026-11-07T10:00:00');
    raise exception 'Member used the owner''s personal area';
  exception when foreign_key_violation then null; end;
  begin
    insert into public.subtasks (task_id, title) values (t_owner_private, 'Sneak');
    raise exception 'Member added to the owner''s personal task';
  exception when foreign_key_violation then null; end;
  begin
    insert into public.sessions (id, task_id, agent, status, started_at) values ('bbbbbbbbbbbbbbbb', t_owner_private, 'claude', 'running', '2026-11-07T10:00:00');
    raise exception 'Member started a session on the owner''s task';
  exception when foreign_key_violation then null; end;
  begin
    insert into public.edges (from_task_id, to_task_id) values (t_member, t_member_private);
    raise exception 'A dependency crossed into personal work';
  exception when foreign_key_violation then null; end;
  begin
    update public.tasks set area_id = member_area, project_id = null where id = t_member;
    raise exception 'A shared task left the workspace';
  exception when insufficient_privilege then null; end;
  begin
    update public.tasks set user_id = owner where id = t_member;
    raise exception 'A task''s author changed';
  exception when insufficient_privilege then null; end;
  begin
    update public.tasks set related_project_id = owner_project where id = t_member;
    raise exception 'A shared task is about a personal project';
  exception when foreign_key_violation then null; end;
  -- A session of the member's own on a shared task is theirs alone.
  insert into public.sessions (id, task_id, agent, status, started_at) values ('cccccccccccccccc', t_member, 'claude', 'running', '2026-11-07T10:00:00');
  reset role;
  perform set_config('request.jwt.claims', c_owner, true); set local role authenticated;
  select count(*) into n from public.sessions where id = 'cccccccccccccccc'; if n <> 0 then raise exception 'Owner sees the member''s session'; end if;
  begin
    update public.areas set workspace_id = null where id = team_area;
    raise exception 'An area left the workspace directly';
  exception when insufficient_privilege then null; end;
  begin
    update public.areas set workspace_id = ws where id = owner_area;
    raise exception 'An area joined the workspace without share_area';
  exception when insufficient_privilege then null; end;
  reset role;
  checks := checks + 10;

  -- 5. Assignees are members of the task's workspace; a personal task only its owner.
  perform set_config('request.jwt.claims', c_owner, true); set local role authenticated;
  update public.tasks set assignee_id = member where id = t_owner;
  begin
    update public.tasks set assignee_id = outsider where id = t_owner;
    raise exception 'Assigned to a non-member';
  exception when check_violation then null; end;
  begin
    update public.tasks set assignee_id = member where id = t_owner_private;
    raise exception 'A personal task was assigned to someone else';
  exception when check_violation then null; end;
  update public.tasks set assignee_id = owner where id = t_owner_private;
  reset role;
  perform set_config('request.jwt.claims', c_member, true); set local role authenticated;
  select count(*) into n from public.tasks where assignee_id = member; if n <> 1 then raise exception 'Member does not see the task assigned to them'; end if;
  reset role;
  checks := checks + 4;

  -- 6. Roles: nobody escalates themselves; only owners make owners; the last owner stays.
  perform set_config('request.jwt.claims', c_member, true); set local role authenticated;
  begin
    perform public.set_member_role(ws, member, 'admin');
    raise exception 'Member made themselves admin';
  exception when insufficient_privilege then null; end;
  begin
    perform public.set_member_role(ws, owner, 'member');
    raise exception 'Member demoted the owner';
  exception when insufficient_privilege then null; end;
  begin
    update public.workspace_members set role = 'owner' where user_id = member;
    raise exception 'Member changed a role directly';
  exception when insufficient_privilege then null; end;
  begin
    perform public.remove_member(ws, owner);
    raise exception 'Member removed the owner';
  exception when insufficient_privilege then null; end;
  begin
    perform public.share_area(member_area, ws);
    raise exception 'Member shared an area';
  exception when insufficient_privilege then null; end;
  reset role;
  perform set_config('request.jwt.claims', c_owner, true); set local role authenticated;
  perform public.set_member_role(ws, member, 'admin');
  begin
    perform public.set_member_role(ws, owner, 'admin');
    raise exception 'The last owner stepped down';
  exception when insufficient_privilege then null; end;
  begin
    perform public.remove_member(ws, owner);
    raise exception 'The last owner left a workspace with members';
  exception when insufficient_privilege then null; end;
  reset role;
  perform set_config('request.jwt.claims', c_member, true); set local role authenticated;
  begin
    perform public.set_member_role(ws, member, 'owner');
    raise exception 'An admin made themselves owner';
  exception when insufficient_privilege then null; end;
  update public.areas set name = 'Acme (admin)' where id = team_area;
  get diagnostics n = row_count; if n <> 1 then raise exception 'Admin could not rename the shared area'; end if;
  select count(*) into n from public.workspace_invites; if n < 1 then raise exception 'Admin does not see invitations'; end if;
  reset role;
  perform set_config('request.jwt.claims', c_owner, true); set local role authenticated;
  perform public.set_member_role(ws, member, 'member');
  reset role;
  checks := checks + 11;

  -- 7. Sharing an existing area moves its work, keeps its keys, and lets go of links outside it.
  perform set_config('request.jwt.claims', c_owner, true); set local role authenticated;
  insert into public.tasks (key, area_id, title, created_at, updated_at)
    values ('', shared_later, 'Will be shared', '2026-11-07T10:00:00', '2026-11-07T10:00:00') returning id, key into t_shared_later, k1;
  insert into public.edges (from_task_id, to_task_id) values (t_shared_later, t_owner_private);
  insert into public.subtasks (task_id, title) values (t_shared_later, 'Comes along');
  moved := public.share_area(shared_later, ws);
  begin
    perform public.share_area(owner_area, gen_random_uuid());
    raise exception 'Shared into a workspace the owner isn''t in';
  exception when insufficient_privilege then null; end;
  reset role;
  if (moved ->> 'tasks')::int <> 1 or (select workspace_id from public.tasks where id = t_shared_later) is distinct from ws
     or (select key from public.tasks where id = t_shared_later) <> k1
     or (select workspace_id from public.subtasks where task_id = t_shared_later) is distinct from ws
     or exists (select 1 from public.edges where from_task_id = t_shared_later) then
    raise exception 'Sharing an area went wrong: %', moved;
  end if;
  perform set_config('request.jwt.claims', c_member, true); set local role authenticated;
  select count(*) into n from public.tasks where id = t_shared_later; if n <> 1 then raise exception 'Member does not see the shared area''s task'; end if;
  -- A personal task moved into a shared area takes the workspace's next free key.
  update public.tasks set area_id = team_area where id = t_member_private;
  select key into v from public.tasks where id = t_member_private;
  if v <> 'WRK-1' then raise exception 'A free key was not kept: %', v; end if;
  reset role;
  checks := checks + 3;

  -- 8. Domains: only the caller's own confirmed domain, never a public provider's; joining needs a confirmed address.
  perform set_config('request.jwt.claims', c_owner, true); set local role authenticated;
  perform public.add_workspace_domain(ws, '@Acme-Team.invalid');
  begin
    perform public.add_workspace_domain(ws, 'gmail.com');
    raise exception 'A public provider''s domain was added';
  exception when invalid_parameter_value then null; end;
  begin
    perform public.add_workspace_domain(ws, 'elsewhere.invalid');
    raise exception 'Someone else''s domain was added';
  exception when insufficient_privilege then null; end;
  reset role;
  perform set_config('request.jwt.claims', c_unconfirmed, true); set local role authenticated;
  select count(*) into n from public.joinable_workspaces(); if n <> 0 then raise exception 'Unconfirmed address offered a workspace'; end if;
  begin
    perform public.join_workspace(ws);
    raise exception 'Unconfirmed address joined';
  exception when insufficient_privilege then null; end;
  reset role;
  perform set_config('request.jwt.claims', c_outsider, true); set local role authenticated;
  begin
    perform public.join_workspace(ws);
    raise exception 'Another domain joined';
  exception when insufficient_privilege then null; end;
  reset role;
  perform set_config('request.jwt.claims', c_joiner, true); set local role authenticated;
  select count(*) into n from public.joinable_workspaces() j where j.id = ws; if n <> 1 then raise exception 'Domain workspace not offered'; end if;
  perform public.join_workspace(ws);
  select count(*) into n from public.tasks where workspace_id = ws; if n < 3 then raise exception 'Joiner does not see the work'; end if;
  reset role;
  if (select role || joined_via from public.workspace_members where workspace_id = ws and user_id = joiner) <> 'memberdomain' then
    raise exception 'Joined with the wrong role';
  end if;
  checks := checks + 7;

  -- 9. Keys never collide between members, also at the same time in one workspace.
  perform set_config('request.jwt.claims', c_joiner, true); set local role authenticated;
  insert into public.tasks (key, area_id, title, created_at, updated_at)
    select '', team_area, 'Bulk ' || g, '2026-11-07T10:00:00', '2026-11-07T10:00:00' from generate_series(1, 5) g;
  reset role;
  select count(*) - count(distinct key) into n from public.tasks where workspace_id = ws;
  if n <> 0 then raise exception 'Duplicate keys in the workspace'; end if;
  checks := checks + 1;

  -- 10. Live refresh reaches every member.
  select version into version_before from public.user_state where user_id = member;
  perform set_config('request.jwt.claims', c_owner, true); set local role authenticated;
  update public.tasks set title = 'Owner task, renamed' where id = t_owner;
  reset role;
  if (select version from public.user_state where user_id = member) <= version_before then raise exception 'Member''s version did not change'; end if;
  checks := checks + 1;

  -- 11. Webhooks: the member's own, secret shown once, deliveries on assignment; only public https addresses.
  perform set_config('request.jwt.claims', c_member, true); set local role authenticated;
  hook := public.set_webhook(ws, 'https://Hooks.Acme-Team.invalid/pacedmind', array['task.assigned', 'task.status_changed']);
  if char_length(hook ->> 'secret') <> 64 or hook ->> 'url' <> 'https://hooks.acme-team.invalid/pacedmind' then raise exception 'Unexpected webhook %', hook; end if;
  begin
    perform secret from public.member_webhooks;
    raise exception 'Webhook secret readable';
  exception when insufficient_privilege then null; end;
  foreach v in array array['http://hooks.acme-team.invalid/x', 'https://127.0.0.1/x', 'https://localhost/x', 'https://hooks.acme-team.invalid:8443/x',
    'https://user:pass@hooks.acme-team.invalid/x', 'https://metadata.internal/x', 'https://router.lan/x'] loop
    begin
      perform public.set_webhook(ws, v, array['task.assigned']);
      raise exception 'Webhook address accepted: %', v;
    exception when invalid_parameter_value then null; end;
  end loop;
  begin
    perform public.set_webhook(ws, 'https://hooks.acme-team.invalid/x', array['task.deleted']);
    raise exception 'Unknown webhook event accepted';
  exception when invalid_parameter_value then null; end;
  reset role;
  perform set_config('request.jwt.claims', c_outsider, true); set local role authenticated;
  begin
    perform public.set_webhook(ws, 'https://hooks.elsewhere.invalid/x', array['task.created']);
    raise exception 'Outsider added a webhook to the workspace';
  exception when insufficient_privilege then null; end;
  select count(*) into n from public.webhook_deliveries; if n <> 0 then raise exception 'Outsider reads deliveries'; end if;
  reset role;
  perform set_config('request.jwt.claims', c_owner, true); set local role authenticated;
  update public.tasks set assignee_id = null where id = t_owner;
  update public.tasks set assignee_id = member where id = t_owner;
  update public.tasks set status = 'progress' where id = t_owner;
  reset role;
  select count(*) into n from public.webhook_deliveries where user_id = member and event = 'task.assigned' and task_id = t_owner;
  if n <> 1 then raise exception 'Expected one assignment delivery, got %', n; end if;
  select count(*) into n from public.webhook_deliveries where user_id = member and event = 'task.status_changed' and task_id = t_owner;
  if n <> 1 then raise exception 'Expected one status delivery, got %', n; end if;
  if (select payload #>> '{task,assignee,email}' from public.webhook_deliveries where event = 'task.assigned' and task_id = t_owner)
     <> 'member@acme-team.invalid'
     or (select payload ? 'description' or payload -> 'task' ? 'description' from public.webhook_deliveries where event = 'task.assigned' and task_id = t_owner) then
    raise exception 'Unexpected delivery payload';
  end if;
  -- RFC 4231, test case 2.
  if encode(private.hmac_sha256(convert_to('Jefe', 'UTF8'), convert_to('what do ya want for nothing?', 'UTF8')), 'hex')
     <> '5bdcc146bf60754e6a042426089575c75a003f089d2739839dec58b964ec3843' then
    raise exception 'HMAC-SHA256 does not match RFC 4231';
  end if;
  perform set_config('request.jwt.claims', c_member, true); set local role authenticated;
  select count(*) into n from public.webhook_deliveries; if n <> 2 then raise exception 'Member does not see their deliveries'; end if;
  reset role;
  checks := checks + 15;

  -- 12. A copy holds only the account's personal data, and putting it back leaves shared work alone.
  perform set_config('request.jwt.claims', c_member, true); set local role authenticated;
  insert into public.tasks (key, area_id, title, created_at, updated_at)
    values ('', member_area, 'Member personal again', '2026-11-07T10:00:00', '2026-11-07T10:00:00');
  copy := public.save_account_copy('empty');
  reset role;
  if exists (select 1 from jsonb_array_elements((select data -> 'tasks' from public.account_copies where id = copy)) e
             where e ->> 'workspace_id' is not null) then
    raise exception 'A copy holds shared tasks';
  end if;
  perform set_config('request.jwt.claims', c_member, true); set local role authenticated;
  perform public.restore_account_copy(copy);
  reset role;
  if not exists (select 1 from public.tasks where id = t_member) or not exists (select 1 from public.sessions where id = 'cccccccccccccccc') then
    raise exception 'Putting a copy back deleted shared work';
  end if;
  checks := checks + 2;

  -- 13. Billing: shared rows follow the owners' Cloud, personal rows each account's own.
  update private.billing_switch set enforce = true;
  update public.billing set trial_ends_at = now() - interval '1 day', status = 'none', comped = false where user_id in (owner, member);
  perform set_config('request.jwt.claims', c_member, true); set local role authenticated;
  begin
    update public.tasks set title = 'While the owner''s Cloud ended' where id = t_member;
    raise exception 'Wrote to a workspace whose owner''s Cloud ended';
  exception when sqlstate 'PT402' then null; end;
  reset role;
  update public.billing set comped = true where user_id = owner;
  perform set_config('request.jwt.claims', c_member, true); set local role authenticated;
  update public.tasks set title = 'Owner pays' where id = t_member;
  begin
    update public.tasks set title = 'Personal, unpaid' where id in (select id from public.tasks where user_id = member and workspace_id is null limit 1);
    insert into public.tasks (key, area_id, title, created_at, updated_at) values ('', member_area, 'Unpaid', '2026-11-07T10:00:00', '2026-11-07T10:00:00');
    raise exception 'A member whose own Cloud ended wrote personal rows';
  exception when sqlstate 'PT402' then null; end;
  reset role;
  update public.billing set comped = true where user_id = member;
  checks := checks + 3;

  -- 14. Leaving and removal: assignments cleared, access gone, the last member takes the workspace with them.
  perform set_config('request.jwt.claims', c_owner, true); set local role authenticated;
  perform public.remove_member(ws, member);
  reset role;
  if (select assignee_id from public.tasks where id = t_owner) is not null then raise exception 'Removed member stays assigned'; end if;
  if exists (select 1 from public.member_webhooks where user_id = member) then raise exception 'Removed member''s webhooks stay'; end if;
  perform set_config('request.jwt.claims', c_member, true); set local role authenticated;
  select count(*) into n from public.tasks where workspace_id = ws; if n <> 0 then raise exception 'Removed member still sees shared tasks'; end if;
  update public.tasks set title = 'After removal' where id = t_member;
  get diagnostics n = row_count; if n <> 0 then raise exception 'Removed member changed a shared task'; end if;
  reset role;
  if (select user_id from public.tasks where id = t_member) <> member then raise exception 'Removal changed authorship'; end if;
  perform set_config('request.jwt.claims', c_outsider, true); set local role authenticated;
  ws2 := public.create_workspace('Solo');
  insert into public.areas (name, key, color, workspace_id) values ('Solo', 'SOL', '#6A8DC3', ws2);
  perform public.remove_member(ws2, outsider);
  reset role;
  if exists (select 1 from public.workspaces where id = ws2) or exists (select 1 from public.areas where workspace_id = ws2) then
    raise exception 'The last member leaving kept the workspace';
  end if;
  checks := checks + 6;

  -- 15. Deleting an account: the last owner of a workspace with members can't; otherwise their work stays.
  perform set_config('request.jwt.claims', c_owner, true); set local role authenticated;
  begin
    perform public.delete_account();
    raise exception 'The last owner deleted their account';
  exception when insufficient_privilege then null; end;
  perform public.set_member_role(ws, joiner, 'owner');
  perform public.delete_account();
  reset role;
  if exists (select 1 from auth.users where id = owner) then raise exception 'Account not deleted'; end if;
  if (select user_id from public.tasks where id = t_owner) is distinct from joiner
     or (select user_id from public.areas where id = team_area) is distinct from joiner
     or (select user_id from public.tasks where id = t_shared_later) is distinct from joiner then
    raise exception 'Shared work did not stay with an owner';
  end if;
  if exists (select 1 from public.tasks where id = t_owner_private) then raise exception 'Personal work outlived the account'; end if;
  -- The member who was removed before still authored a task: deleting their account keeps it in the workspace.
  delete from auth.users where id = member;
  if (select user_id from public.tasks where id = t_member) is distinct from joiner then raise exception 'A former member''s task was lost'; end if;
  checks := checks + 5;

  raise notice 'Team workspaces: % assertions passed (fixtures rolled back).', checks;
end $test$;
rollback;
