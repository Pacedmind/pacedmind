-- Checks the database's security rules with two made-up accounts, then rolls everything back: the block
-- always ends with an exception whose message lists the results, so nothing it creates is kept.
-- Run it in the SQL editor (or through the Supabase MCP execute_sql) after changing policies or grants.
-- Every line should match its "(want …)" or say "refused"/"rejected"/"blocked"; a line starting with FAIL
-- or ERROR is a problem.
do $test$
declare
  a uuid := gen_random_uuid(); b uuid := gen_random_uuid();
  -- sa and sb: sessions an hour old that verified an authenticator from yesterday. sa_new: a session that
  -- verified an authenticator added after it started (what a stolen session could do). sa2: another sign-in of
  -- account a (the web app, or a second computer).
  sa uuid := gen_random_uuid(); sb uuid := gen_random_uuid(); sa_new uuid := gen_random_uuid(); sb2 uuid := gen_random_uuid();
  sa2 uuid := gen_random_uuid();
  fa uuid := gen_random_uuid(); fa_new uuid := gen_random_uuid(); fb uuid := gen_random_uuid();
  area_a uuid; area_b uuid; dev uuid; dev2 uuid; dev_b uuid; tid bigint; tid2 bigint; tkey text; req uuid; rid bigint;
  req_nc uuid; req_fc uuid; req_ch uuid;
  ask_id uuid; ask2 uuid; ask3 uuid;
  area_del uuid; t_del bigint; t_moved bigint; code text; proj_b uuid; req_ag uuid; freq uuid;
  sid text := '0123456789abcdef';
  n int; out text := '';
  now_s bigint := extract(epoch from now())::bigint;
  claims_aal1 text; claims_aal2_old text; claims_aal2_fresh text; claims_bad_session text; claims_new_factor text;
  claims_a2_old text; claims_a2_fresh text; claims_b_old text; claims_b_fresh text;
  -- Agents signed in with OAuth (the hosted MCP server): clients oc_a, oc_x and oc_c, and their sign-ins (see 29).
  oc_a uuid := gen_random_uuid(); oc_x uuid := gen_random_uuid(); oc_c uuid := gen_random_uuid(); login uuid; ok boolean;
  sg uuid := gen_random_uuid(); sg_early uuid := gen_random_uuid(); sg_late uuid := gen_random_uuid(); sg_x uuid := gen_random_uuid();
  sg_b uuid := gen_random_uuid(); sc1 uuid := gen_random_uuid(); sc2 uuid := gen_random_uuid();
begin
  insert into auth.users (instance_id, id, aud, role, email, encrypted_password, email_confirmed_at, raw_app_meta_data, raw_user_meta_data, created_at, updated_at)
  values ('00000000-0000-0000-0000-000000000000', a, 'authenticated', 'authenticated', 'rls-test-a@example.invalid', '', now(), '{}', '{}', now() - interval '2 days', now()),
         ('00000000-0000-0000-0000-000000000000', b, 'authenticated', 'authenticated', 'rls-test-b@example.invalid', '', now(), '{}', '{}', now() - interval '2 days', now());
  insert into auth.mfa_factors (id, user_id, friendly_name, factor_type, status, created_at, updated_at, secret)
  values (fa, a, 'test a old', 'totp', 'verified', now() - interval '1 day', now(), 'x'),
         (fa_new, a, 'test a new', 'totp', 'verified', now() - interval '10 minutes', now(), 'x'),
         (fb, b, 'test b old', 'totp', 'verified', now() - interval '1 day', now(), 'x');
  insert into auth.sessions (id, user_id, created_at, updated_at, aal, factor_id)
  values (sa, a, now() - interval '1 hour', now(), 'aal2', fa),
         (sa_new, a, now() - interval '1 hour', now(), 'aal2', fa_new),
         (sb, b, now() - interval '1 hour', now(), 'aal2', fb),
         (sb2, b, now() - interval '1 hour', now(), 'aal2', fb),
         (sa2, a, now() - interval '1 hour', now(), 'aal2', fa);
  select id into area_a from public.areas where user_id = a and key = 'WRK';
  select id into area_b from public.areas where user_id = b and key = 'WRK';
  select count(*) into n from public.areas where user_id = a; out := out || '[setup] default areas for new user=' || n || E'\n';

  claims_aal1 := json_build_object('sub', a, 'role', 'authenticated', 'aal', 'aal1', 'session_id', sa, 'amr', json_build_array(json_build_object('method', 'password', 'timestamp', now_s)))::text;
  claims_aal2_old := json_build_object('sub', a, 'role', 'authenticated', 'aal', 'aal2', 'session_id', sa, 'amr', json_build_array(json_build_object('method', 'totp', 'timestamp', now_s - 3600)))::text;
  claims_aal2_fresh := json_build_object('sub', a, 'role', 'authenticated', 'aal', 'aal2', 'session_id', sa, 'amr', json_build_array(json_build_object('method', 'totp', 'timestamp', now_s - 30)))::text;
  claims_bad_session := json_build_object('sub', a, 'role', 'authenticated', 'aal', 'aal2', 'session_id', gen_random_uuid(), 'amr', json_build_array(json_build_object('method', 'totp', 'timestamp', now_s)))::text;
  claims_new_factor := json_build_object('sub', a, 'role', 'authenticated', 'aal', 'aal2', 'session_id', sa_new, 'amr', json_build_array(json_build_object('method', 'totp', 'timestamp', now_s - 30)))::text;
  claims_a2_old := json_build_object('sub', a, 'role', 'authenticated', 'aal', 'aal2', 'session_id', sa2, 'amr', json_build_array(json_build_object('method', 'totp', 'timestamp', now_s - 3600)))::text;
  claims_a2_fresh := json_build_object('sub', a, 'role', 'authenticated', 'aal', 'aal2', 'session_id', sa2, 'amr', json_build_array(json_build_object('method', 'totp', 'timestamp', now_s - 30)))::text;
  claims_b_old := json_build_object('sub', b, 'role', 'authenticated', 'aal', 'aal2', 'session_id', sb, 'amr', json_build_array(json_build_object('method', 'totp', 'timestamp', now_s - 3600)))::text;
  claims_b_fresh := json_build_object('sub', b, 'role', 'authenticated', 'aal', 'aal2', 'session_id', sb, 'amr', json_build_array(json_build_object('method', 'totp', 'timestamp', now_s - 30)))::text;

  -- 1. password only (aal1) reads nothing
  begin
    perform set_config('request.jwt.claims', claims_aal1, true); set local role authenticated;
    select count(*) into n from public.areas; out := out || '1 aal1 sees areas=' || n || ' (want 0)' || E'\n';
    reset role;
  exception when others then out := out || '1 ERROR ' || sqlerrm || E'\n'; end;

  -- 2. aal2 sees own rows only
  begin
    perform set_config('request.jwt.claims', claims_aal2_old, true); set local role authenticated;
    select count(*) into n from public.areas; out := out || '2 aal2 sees areas=' || n || ' (want 5)' || E'\n';
    select count(*) into n from public.areas where user_id = b; out := out || '2b aal2 sees other account areas=' || n || ' (want 0)' || E'\n';
    reset role;
  exception when others then out := out || '2 ERROR ' || sqlerrm || E'\n'; end;

  -- 2c. an area's icon is the name of one the app draws, never markup or other text
  begin
    perform set_config('request.jwt.claims', claims_aal2_old, true); set local role authenticated;
    update public.areas set icon = 'briefcase' where id = area_a;
    select count(*) into n from public.areas where id = area_a and icon = 'briefcase'; out := out || '2c icon saved=' || n || ' (want 1)' || E'\n';
    reset role;
  exception when others then out := out || '2c ERROR ' || sqlerrm || E'\n'; end;
  begin
    perform set_config('request.jwt.claims', claims_aal2_old, true); set local role authenticated;
    update public.areas set icon = '<svg onload=alert(1)>' where id = area_a;
    out := out || '2d FAIL an icon that is not a name accepted' || E'\n';
    reset role;
  exception when others then out := out || '2d icon that is not a name rejected: ' || left(sqlerrm, 60) || E'\n'; end;

  -- 2e. an area's picture is base64 of a small PNG (a 1 by 1 one here), never markup, other data or anything big
  begin
    perform set_config('request.jwt.claims', claims_aal2_old, true); set local role authenticated;
    update public.areas set picture = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=' where id = area_a;
    select count(*) into n from public.areas where id = area_a and picture is not null; out := out || '2e picture saved=' || n || ' (want 1)' || E'\n';
    reset role;
  exception when others then out := out || '2e ERROR ' || sqlerrm || E'\n'; end;
  begin
    perform set_config('request.jwt.claims', claims_aal2_old, true); set local role authenticated;
    update public.areas set picture = 'PHN2ZyBvbmxvYWQ9YWxlcnQoMSk+' where id = area_a;
    out := out || '2f FAIL a picture that is not a PNG accepted' || E'\n';
    reset role;
  exception when others then out := out || '2f picture that is not a PNG rejected: ' || left(sqlerrm, 60) || E'\n'; end;
  begin
    perform set_config('request.jwt.claims', claims_aal2_old, true); set local role authenticated;
    update public.areas set picture = 'iVBORw0KGgo' || repeat('A', 40000) where id = area_a;
    out := out || '2g FAIL a picture over the size accepted' || E'\n';
    reset role;
  exception when others then out := out || '2g picture over the size rejected: ' || left(sqlerrm, 60) || E'\n'; end;

  -- 3. unknown/revoked session id reads nothing
  begin
    perform set_config('request.jwt.claims', claims_bad_session, true); set local role authenticated;
    select count(*) into n from public.areas; out := out || '3 revoked session sees areas=' || n || ' (want 0)' || E'\n';
    reset role;
  exception when others then out := out || '3 ERROR ' || sqlerrm || E'\n'; end;

  -- 4. a task can't point at another account's area
  begin
    perform set_config('request.jwt.claims', claims_aal2_old, true); set local role authenticated;
    insert into public.tasks (key, area_id, title, created_at, updated_at) values ('', area_b, 'x', '2026-09-25T10:00:00', '2026-09-25T10:00:00');
    out := out || '4 FAIL cross-account reference allowed' || E'\n';
    reset role;
  exception when others then out := out || '4 cross-account area blocked: ' || left(sqlerrm, 90) || E'\n'; end;

  -- 4b. nor say it's about another account's project
  insert into public.projects (user_id, area_id, name) values (b, area_b, 'Theirs') returning id into proj_b;
  begin
    perform set_config('request.jwt.claims', claims_aal2_old, true); set local role authenticated;
    insert into public.tasks (key, area_id, related_project_id, title, created_at, updated_at)
      values ('', area_a, proj_b, 'x', '2026-09-25T10:00:00', '2026-09-25T10:00:00');
    out := out || '4b FAIL task related to another account''s project accepted' || E'\n';
    reset role;
  exception when others then out := out || '4b cross-account related project blocked: ' || left(sqlerrm, 80) || E'\n'; end;

  -- 5. own task gets a key
  begin
    perform set_config('request.jwt.claims', claims_aal2_old, true); set local role authenticated;
    insert into public.tasks (key, area_id, title, created_at, updated_at) values ('', area_a, 'First', '2026-09-25T10:00:00', '2026-09-25T10:00:00') returning id, key into tid, tkey;
    out := out || '5 own task key=' || tkey || ' (want WRK-1)' || E'\n';
    reset role;
  exception when others then out := out || '5 ERROR ' || sqlerrm || E'\n'; end;

  -- 6. injection-shaped key rejected
  begin
    perform set_config('request.jwt.claims', claims_aal2_old, true); set local role authenticated;
    insert into public.tasks (key, area_id, title, created_at, updated_at) values ('X" & calc & "-1', area_a, 'x', '2026-09-25T10:00:00', '2026-09-25T10:00:00');
    out := out || '6 FAIL bad key accepted' || E'\n';
    reset role;
  exception when others then out := out || '6 bad key rejected: ' || left(sqlerrm, 80) || E'\n'; end;

  -- 7. settings only take planning keys
  begin
    perform set_config('request.jwt.claims', claims_aal2_old, true); set local role authenticated;
    insert into public.settings (key, value) values ('claudeCommand', '"calc.exe"');
    out := out || '7 FAIL command setting accepted' || E'\n';
    reset role;
  exception when others then out := out || '7 command setting rejected: ' || left(sqlerrm, 80) || E'\n'; end;

  -- 8. writes to bookkeeping and devices are refused
  begin
    perform set_config('request.jwt.claims', claims_aal2_old, true); set local role authenticated;
    insert into public.devices (name, platform) values ('evil', 'windows');
    out := out || '8 FAIL direct device insert allowed' || E'\n';
    reset role;
  exception when others then out := out || '8 direct device insert refused: ' || left(sqlerrm, 70) || E'\n'; end;
  begin
    perform set_config('request.jwt.claims', claims_aal2_old, true); set local role authenticated;
    update public.user_state set version = 0;
    out := out || '8b FAIL user_state writable' || E'\n';
    reset role;
  exception when others then out := out || '8b user_state write refused: ' || left(sqlerrm, 70) || E'\n'; end;
  begin
    perform set_config('request.jwt.claims', claims_aal2_old, true); set local role authenticated;
    truncate public.tasks;
    out := out || '8c FAIL truncate allowed' || E'\n';
    reset role;
  exception when others then out := out || '8c truncate refused: ' || left(sqlerrm, 70) || E'\n'; end;

  -- 9. register a device, then a launch request needs a fresh second factor
  begin
    perform set_config('request.jwt.claims', claims_aal2_old, true); set local role authenticated;
    dev := public.register_device('Test PC', 'windows');
    out := out || '9 device registered' || E'\n';
    if public.register_device('Test PC', 'windows') = dev then out := out || '9a registering again from the same session returns the same computer' || E'\n';
    else out := out || '9a FAIL second registration made another computer' || E'\n'; end if;
    reset role;
  exception when others then out := out || '9 ERROR ' || sqlerrm || E'\n'; end;
  begin
    perform set_config('request.jwt.claims', claims_aal2_old, true); set local role authenticated;
    insert into public.launch_requests (device_id, task_id, agent) values (dev, tid, 'claude');
    out := out || '9b FAIL launch request without fresh 2FA accepted' || E'\n';
    reset role;
  exception when others then out := out || '9b stale 2FA refused: ' || left(sqlerrm, 80) || E'\n'; end;
  begin
    perform set_config('request.jwt.claims', claims_aal2_fresh, true); set local role authenticated;
    insert into public.launch_requests (device_id, task_id, agent) values (dev, tid, 'claude') returning id into req;
    select count(*) into n from public.launch_requests where status = 'pending' and expires_at between now() + interval '9 minutes' and now() + interval '11 minutes';
    out := out || '9c fresh 2FA request pending=' || n || ' (want 1)' || E'\n';
    reset role;
  exception when others then out := out || '9c ERROR ' || sqlerrm || E'\n'; end;
  begin
    perform set_config('request.jwt.claims', claims_aal2_fresh, true); set local role authenticated;
    insert into public.launch_requests (device_id, task_id, agent, status) values (dev, tid, 'claude', 'launched');
    out := out || '9d FAIL client-set status accepted' || E'\n';
    reset role;
  exception when others then out := out || '9d client-set status refused: ' || left(sqlerrm, 70) || E'\n'; end;

  -- 14. a code from an authenticator added after the session started doesn't count as fresh
  begin
    perform set_config('request.jwt.claims', claims_new_factor, true); set local role authenticated;
    insert into public.launch_requests (device_id, task_id, agent) values (dev, tid, 'claude');
    out := out || '14 FAIL request accepted with an authenticator added in this session' || E'\n';
    reset role;
  exception when others then out := out || '14 new authenticator refused: ' || left(sqlerrm, 80) || E'\n'; end;

  -- 15. a decided request can't be set back to waiting
  begin
    perform set_config('request.jwt.claims', claims_aal2_old, true); set local role authenticated;
    update public.launch_requests set status = 'denied', decided_at = now() where id = req;
    update public.launch_requests set status = 'pending' where id = req;
    out := out || '15 FAIL request set back to pending' || E'\n';
    reset role;
  exception when others then out := out || '15 re-pending refused: ' || left(sqlerrm, 70) || E'\n'; end;

  -- 10. anon reads nothing
  begin
    perform set_config('request.jwt.claims', json_build_object('role', 'anon')::text, true); set local role anon;
    select count(*) into n from public.tasks;
    out := out || '10 FAIL anon read tasks=' || n || E'\n';
    reset role;
  exception when others then out := out || '10 anon refused: ' || left(sqlerrm, 60) || E'\n'; end;

  -- 11. delete_account needs a fresh code
  begin
    perform set_config('request.jwt.claims', claims_aal2_old, true); set local role authenticated;
    perform public.delete_account();
    out := out || '11 FAIL delete_account without fresh 2FA' || E'\n';
    reset role;
  exception when others then out := out || '11 delete_account refused: ' || left(sqlerrm, 60) || E'\n'; end;

  -- 16. another live session of the same account can't take over a computer's entry
  begin
    perform set_config('request.jwt.claims', json_build_object('sub', b, 'role', 'authenticated', 'aal', 'aal2', 'session_id', sb,
      'amr', json_build_array(json_build_object('method', 'totp', 'timestamp', now_s - 3600)))::text, true);
    set local role authenticated;
    dev_b := public.register_device('B PC', 'windows');
    reset role;
    perform set_config('request.jwt.claims', json_build_object('sub', b, 'role', 'authenticated', 'aal', 'aal2', 'session_id', sb2,
      'amr', json_build_array(json_build_object('method', 'totp', 'timestamp', now_s - 3600)))::text, true);
    set local role authenticated;
    perform public.claim_device(dev_b);
    out := out || '16 FAIL a live computer was claimed by another session' || E'\n';
    reset role;
  exception when others then out := out || '16 takeover refused: ' || left(sqlerrm, 70) || E'\n'; end;

  -- 17. reports and images: kept for your own sessions, checked shapes, invisible to other accounts
  begin
    perform set_config('request.jwt.claims', claims_aal2_old, true); set local role authenticated;
    insert into public.sessions (id, task_id, agent, device_id, status, started_at) values ('0123456789abcdef', tid, 'claude', dev, 'finished', '2026-09-25T10:00:00');
    insert into public.reports (session_id, task_id, outcome, summary, created_at) values ('0123456789abcdef', tid, 'partial', 'Half done', '2026-09-25T11:00:00') returning id into rid;
    insert into public.attachments (id, task_id, session_id, report_id, device_id, file, mime, bytes, created_at)
      values ('00112233445566ff', tid, '0123456789abcdef', rid, dev, '00112233445566ff.png', 'image/png', 100, '2026-09-25T11:00:00');
    select count(*) into n from public.reports; out := out || '17 own report stored, reports=' || n || ' (want 1)' || E'\n';
    select count(*) into n from public.attachments; out := out || '17a own image stored, images=' || n || ' (want 1)' || E'\n';
    reset role;
  exception when others then out := out || '17 ERROR ' || sqlerrm || E'\n'; end;
  begin
    perform set_config('request.jwt.claims', claims_aal1, true); set local role authenticated;
    select count(*) into n from public.reports; out := out || '17b aal1 sees reports=' || n || ' (want 0)' || E'\n';
    select count(*) into n from public.attachments; out := out || '17c aal1 sees images=' || n || ' (want 0)' || E'\n';
    reset role;
  exception when others then out := out || '17b ERROR ' || sqlerrm || E'\n'; end;
  begin
    perform set_config('request.jwt.claims', json_build_object('sub', b, 'role', 'authenticated', 'aal', 'aal2', 'session_id', sb,
      'amr', json_build_array(json_build_object('method', 'totp', 'timestamp', now_s - 3600)))::text, true);
    set local role authenticated;
    select count(*) into n from public.reports; out := out || '17d other account sees reports=' || n || ' (want 0)' || E'\n';
    select count(*) into n from public.attachments; out := out || '17e other account sees images=' || n || ' (want 0)' || E'\n';
    reset role;
  exception when others then out := out || '17d ERROR ' || sqlerrm || E'\n'; end;
  -- 17u-w. what a session's agent used: a small JSON object, nothing else
  begin
    perform set_config('request.jwt.claims', claims_aal2_old, true); set local role authenticated;
    update public.sessions set usage = '{"conversations": {"c1": {"input": 10, "cacheRead": 5, "cacheWrite": 0, "output": 2}}, "costUsd": 0.01, "activeSeconds": 3, "models": ["m"], "at": "2026-09-25T10:00:00.000Z"}'
      where id = '0123456789abcdef';
    get diagnostics n = row_count; out := out || '17u session usage saved=' || n || ' (want 1)' || E'\n';
    reset role;
  exception when others then out := out || '17u ERROR ' || sqlerrm || E'\n'; end;
  begin
    perform set_config('request.jwt.claims', claims_aal2_old, true); set local role authenticated;
    update public.sessions set usage = jsonb_build_object('x', repeat('a', 9000)) where id = '0123456789abcdef';
    out := out || '17v FAIL an oversized usage accepted' || E'\n';
    reset role;
  exception when others then out := out || '17v oversized usage rejected: ' || left(sqlerrm, 60) || E'\n'; end;
  begin
    perform set_config('request.jwt.claims', claims_aal2_old, true); set local role authenticated;
    update public.sessions set usage = '[1, 2]' where id = '0123456789abcdef';
    out := out || '17w FAIL a usage that is not an object accepted' || E'\n';
    reset role;
  exception when others then out := out || '17w usage that is not an object rejected: ' || left(sqlerrm, 60) || E'\n'; end;
  -- 17x-y. a report's diff: a small JSON object, nothing else
  begin
    perform set_config('request.jwt.claims', claims_aal2_old, true); set local role authenticated;
    insert into public.reports (session_id, task_id, summary, created_at, diff) values ('0123456789abcdef', tid, 'With a diff', '2026-09-25T12:00:00',
      '{"base": "abc1234", "head": "def5678", "commits": [], "files": [{"path": "a.ts", "status": "modified", "added": 3, "removed": 1}], "added": 3, "removed": 1}');
    select count(*) into n from public.reports where diff is not null; out := out || '17x report diff saved=' || n || ' (want 1)' || E'\n';
    reset role;
  exception when others then out := out || '17x ERROR ' || sqlerrm || E'\n'; end;
  begin
    perform set_config('request.jwt.claims', claims_aal2_old, true); set local role authenticated;
    insert into public.reports (session_id, task_id, summary, created_at, diff)
      values ('0123456789abcdef', tid, 'Too big', '2026-09-25T12:00:00', jsonb_build_object('x', repeat('a', 100001)));
    out := out || '17y FAIL an oversized diff accepted' || E'\n';
    reset role;
  exception when others then out := out || '17y oversized diff rejected: ' || left(sqlerrm, 60) || E'\n'; end;
  begin
    perform set_config('request.jwt.claims', json_build_object('sub', b, 'role', 'authenticated', 'aal', 'aal2', 'session_id', sb,
      'amr', json_build_array(json_build_object('method', 'totp', 'timestamp', now_s - 3600)))::text, true);
    set local role authenticated;
    insert into public.reports (session_id, task_id, summary, created_at) values ('0123456789abcdef', tid, 'Not mine', '2026-09-25T11:00:00');
    out := out || '17f FAIL report on another account''s session accepted' || E'\n';
    reset role;
  exception when others then out := out || '17f report on another account''s session blocked: ' || left(sqlerrm, 70) || E'\n'; end;

  -- 18. what reaches a computer is held to safe shapes
  begin
    perform set_config('request.jwt.claims', claims_aal2_old, true); set local role authenticated;
    insert into public.attachments (id, task_id, file, mime, bytes, created_at) values ('00112233445566fe', tid, '../../evil.png', 'image/png', 100, '2026-09-25T11:00:00');
    out := out || '18 FAIL image file outside its folder accepted' || E'\n';
    reset role;
  exception when others then out := out || '18 image path rejected: ' || left(sqlerrm, 70) || E'\n'; end;
  begin
    perform set_config('request.jwt.claims', claims_aal2_old, true); set local role authenticated;
    update public.sessions set url = 'javascript:alert(1)' where id = '0123456789abcdef';
    out := out || '18a FAIL non-https session link accepted' || E'\n';
    reset role;
  exception when others then out := out || '18a session link rejected: ' || left(sqlerrm, 70) || E'\n'; end;
  begin
    perform set_config('request.jwt.claims', claims_aal2_old, true); set local role authenticated;
    insert into public.projects (area_id, name, codex_env) values (area_a, 'Cloud', 'env" & calc & "');
    out := out || '18b FAIL shell characters in a Codex environment accepted' || E'\n';
    reset role;
  exception when others then out := out || '18b Codex environment rejected: ' || left(sqlerrm, 70) || E'\n'; end;
  -- A project's repository is host/path only: never a URL that could carry a token, a computer's path or markup.
  begin
    perform set_config('request.jwt.claims', claims_aal2_old, true); set local role authenticated;
    insert into public.projects (area_id, name, repo) values (area_a, 'Repo', 'github.com/owner/repo#packages/web');
    select count(*) into n from public.projects where repo = 'github.com/owner/repo#packages/web'; out := out || '18g repository saved=' || n || ' (want 1)' || E'\n';
    reset role;
  exception when others then out := out || '18g ERROR ' || sqlerrm || E'\n'; end;
  begin
    perform set_config('request.jwt.claims', claims_aal2_old, true); set local role authenticated;
    insert into public.projects (area_id, name, repo) values (area_a, 'Repo', 'https://ghp_secret@github.com/owner/repo.git');
    out := out || '18h FAIL a repository URL with a token accepted' || E'\n';
    reset role;
  exception when others then out := out || '18h repository URL rejected: ' || left(sqlerrm, 70) || E'\n'; end;
  begin
    perform set_config('request.jwt.claims', claims_aal2_old, true); set local role authenticated;
    insert into public.projects (area_id, name, repo) values (area_a, 'Repo', 'C:/Users/me/code/app');
    out := out || '18i FAIL a folder as a repository accepted' || E'\n';
    reset role;
  exception when others then out := out || '18i folder as a repository rejected: ' || left(sqlerrm, 70) || E'\n'; end;
  begin
    perform set_config('request.jwt.claims', claims_aal2_old, true); set local role authenticated;
    update public.tasks set run_in = 'shell' where id = tid;
    out := out || '18c FAIL unknown run-in accepted' || E'\n';
    reset role;
  exception when others then out := out || '18c run-in rejected: ' || left(sqlerrm, 70) || E'\n'; end;
  -- Model settings are data, never arbitrary shell arguments; existing task RLS protects them.
  begin
    perform set_config('request.jwt.claims', claims_aal2_old, true); set local role authenticated;
    update public.tasks set model_settings = '{"agent":"codex","model":"account-model","effort":"high","speed":"priority"}' where id = tid;
    select count(*) into n from public.tasks where id = tid and model_settings->>'model' = 'account-model';
    out := out || '18m model settings saved=' || n || ' (want 1)' || E'\n';
    reset role;
  exception when others then out := out || '18m ERROR ' || sqlerrm || E'\n'; end;
  begin
    perform set_config('request.jwt.claims', claims_aal2_old, true); set local role authenticated;
    update public.tasks set model_settings = '{"agent":"codex","model":"x; whoami"}' where id = tid;
    out := out || '18n FAIL model shell characters accepted' || E'\n';
    reset role;
  exception when check_violation then out := out || '18n model shell characters rejected (want rejected)' || E'\n'; end;
  begin
    perform set_config('request.jwt.claims', claims_aal2_old, true); set local role authenticated;
    update public.tasks set model_settings = '{}' where id = tid;
    out := out || '18o FAIL incomplete model settings accepted' || E'\n';
    reset role;
  exception when check_violation then out := out || '18o incomplete model settings rejected (want rejected)' || E'\n'; end;
  -- A task's needs are names only (what it needs from the computer its session runs on), at most ten.
  begin
    perform set_config('request.jwt.claims', claims_aal2_old, true); set local role authenticated;
    update public.tasks set needs = '{supabase,"Google Drive",claude.ai-gmail}' where id = tid;
    select count(*) into n from public.tasks where id = tid and cardinality(needs) = 3; out := out || '18j needs saved=' || n || ' (want 1)' || E'\n';
    reset role;
  exception when others then out := out || '18j ERROR ' || sqlerrm || E'\n'; end;
  begin
    perform set_config('request.jwt.claims', claims_aal2_old, true); set local role authenticated;
    update public.tasks set needs = '{"x; rm -rf ~"}' where id = tid;
    out := out || '18k FAIL a need with shell characters accepted' || E'\n';
    reset role;
  exception when others then out := out || '18k need with shell characters rejected: ' || left(sqlerrm, 60) || E'\n'; end;
  begin
    perform set_config('request.jwt.claims', claims_aal2_old, true); set local role authenticated;
    update public.tasks set needs = (select array_agg('n' || i) from generate_series(1, 11) i) where id = tid;
    out := out || '18l FAIL eleven needs accepted' || E'\n';
    reset role;
  exception when others then out := out || '18l eleven needs rejected: ' || left(sqlerrm, 60) || E'\n'; end;
  -- 18m-n. an area's repository: host/path only, never an address with credentials
  begin
    perform set_config('request.jwt.claims', claims_aal2_old, true); set local role authenticated;
    update public.areas set repo = 'github.com/owner/name' where id = area_a;
    get diagnostics n = row_count; out := out || '18m area repository saved=' || n || ' (want 1)' || E'\n';
    reset role;
  exception when others then out := out || '18m ERROR ' || sqlerrm || E'\n'; end;
  begin
    perform set_config('request.jwt.claims', claims_aal2_old, true); set local role authenticated;
    update public.areas set repo = 'https://user:secret@github.com/owner/name' where id = area_a;
    out := out || '18n FAIL an address with credentials accepted as an area repository' || E'\n';
    reset role;
  exception when others then out := out || '18n area repository with credentials rejected: ' || left(sqlerrm, 60) || E'\n'; end;
  begin
    perform set_config('request.jwt.claims', claims_aal2_old, true); set local role authenticated;
    update public.devices set agents = '{"claude": {"cli": true}}', checked_at = now() where id = dev;
    get diagnostics n = row_count; out := out || '18d computer''s agents updated=' || n || ' (want 1)' || E'\n';
    reset role;
  exception when others then out := out || '18d ERROR ' || sqlerrm || E'\n'; end;
  begin
    perform set_config('request.jwt.claims', claims_aal2_old, true); set local role authenticated;
    update public.devices set user_id = b where id = dev;
    out := out || '18e FAIL a computer moved to another account' || E'\n';
    reset role;
  exception when others then out := out || '18e computer''s owner refused: ' || left(sqlerrm, 60) || E'\n'; end;
  begin
    perform set_config('request.jwt.claims', claims_aal2_old, true); set local role authenticated;
    update public.sessions set url = 'https://chatgpt.com/codex/tasks/task_e_0123' where id = '0123456789abcdef';
    get diagnostics n = row_count; out := out || '18f https session link saved=' || n || ' (want 1)' || E'\n';
    reset role;
  exception when others then out := out || '18f ERROR ' || sqlerrm || E'\n'; end;

  -- 19. anon reads no reports or images
  begin
    perform set_config('request.jwt.claims', json_build_object('role', 'anon')::text, true); set local role anon;
    select count(*) into n from public.reports;
    out := out || '19 FAIL anon read reports=' || n || E'\n';
    reset role;
  exception when others then out := out || '19 anon refused: ' || left(sqlerrm, 60) || E'\n'; end;

  -- 20. the account's first computer is its default, and there is only ever one
  begin
    perform set_config('request.jwt.claims', claims_a2_old, true); set local role authenticated;
    dev2 := public.register_device('Second PC', 'macos');
    select count(*) into n from public.devices where is_default; out := out || '20 defaults after a second computer=' || n || ' (want 1)' || E'\n';
    select count(*) into n from public.devices where id = dev and is_default; out := out || '20a the first computer is the default=' || n || ' (want 1)' || E'\n';
    update public.devices set is_default = true where id = dev2;
    select count(*) into n from public.devices where is_default; out := out || '20b defaults after picking another=' || n || ' (want 1)' || E'\n';
    select count(*) into n from public.devices where id = dev2 and is_default; out := out || '20c the one picked is the default=' || n || ' (want 1)' || E'\n';
    reset role;
  exception when others then out := out || '20 ERROR ' || sqlerrm || E'\n'; end;
  begin
    perform set_config('request.jwt.claims', claims_a2_old, true); set local role authenticated;
    begin
      update public.devices set is_default = true;
    exception when others then null;
    end;
    select count(*) into n from public.devices where is_default; out := out || '20d defaults after asking for every computer=' || n || ' (want 1)' || E'\n';
    reset role;
  exception when others then out := out || '20d ERROR ' || sqlerrm || E'\n'; end;

  -- 21. another sign-in of the account (the web app, another computer) may rename a computer and pick the default,
  --     but only the computer itself reports when it was seen, what it found, its version, its flows and its setting
  begin
    perform set_config('request.jwt.claims', claims_a2_old, true); set local role authenticated;
    update public.devices set name = 'Renamed PC' where id = dev;
    get diagnostics n = row_count; out := out || '21 another sign-in renamed the computer=' || n || ' (want 1)' || E'\n';
    reset role;
  exception when others then out := out || '21 ERROR ' || sqlerrm || E'\n'; end;
  begin
    perform set_config('request.jwt.claims', claims_a2_old, true); set local role authenticated;
    update public.devices set agents = '{"claude": {"cli": {"version": "9.9.9"}}}' where id = dev;
    out := out || '21a FAIL another sign-in changed what the computer found' || E'\n';
    reset role;
  exception when others then out := out || '21a another sign-in''s agents refused: ' || left(sqlerrm, 60) || E'\n'; end;
  begin
    perform set_config('request.jwt.claims', claims_a2_old, true); set local role authenticated;
    -- clock_timestamp: now() is the same all through this one transaction.
    update public.devices set last_seen_at = clock_timestamp() + interval '1 minute' where id = dev;
    out := out || '21b FAIL another sign-in made the computer look online' || E'\n';
    reset role;
  exception when others then out := out || '21b another sign-in''s last seen refused: ' || left(sqlerrm, 60) || E'\n'; end;
  begin
    perform set_config('request.jwt.claims', claims_a2_old, true); set local role authenticated;
    update public.devices set app_version = '9.9.9' where id = dev;
    out := out || '21c FAIL another sign-in changed the computer''s version' || E'\n';
    reset role;
  exception when others then out := out || '21c another sign-in''s version refused: ' || left(sqlerrm, 60) || E'\n'; end;
  begin
    perform set_config('request.jwt.claims', claims_a2_old, true); set local role authenticated;
    update public.devices set flows_on = array[gen_random_uuid()] where id = dev;
    out := out || '21d FAIL another sign-in changed the computer''s flows' || E'\n';
    reset role;
  exception when others then out := out || '21d another sign-in''s flows refused: ' || left(sqlerrm, 60) || E'\n'; end;
  begin
    perform set_config('request.jwt.claims', claims_a2_old, true); set local role authenticated;
    update public.devices set remote_start = 'auto' where id = dev;
    out := out || '21e FAIL another sign-in changed the computer''s setting for requests' || E'\n';
    reset role;
  exception when others then out := out || '21e another sign-in''s setting refused: ' || left(sqlerrm, 60) || E'\n'; end;
  begin
    perform set_config('request.jwt.claims', claims_a2_old, true); set local role authenticated;
    update public.devices set other_sessions = '[{"harness": "claude-cli", "ref": "x", "title": "Not yours"}]' where id = dev;
    out := out || '21k FAIL another sign-in changed the computer''s sessions' || E'\n';
    reset role;
  exception when others then out := out || '21k another sign-in''s sessions refused: ' || left(sqlerrm, 60) || E'\n'; end;
  begin
    perform set_config('request.jwt.claims', claims_aal2_old, true); set local role authenticated;
    update public.devices set other_sessions = '{"not": "a list"}' where id = dev;
    out := out || '21l FAIL sessions that aren''t a list accepted' || E'\n';
    reset role;
  exception when others then out := out || '21l sessions that aren''t a list rejected: ' || left(sqlerrm, 60) || E'\n'; end;
  begin
    perform set_config('request.jwt.claims', claims_aal2_old, true); set local role authenticated;
    update public.devices set other_sessions = (select jsonb_agg(jsonb_build_object('ref', i)) from generate_series(1, 31) i) where id = dev;
    out := out || '21m FAIL more than 30 sessions accepted' || E'\n';
    reset role;
  exception when others then out := out || '21m more than 30 sessions rejected: ' || left(sqlerrm, 60) || E'\n'; end;
  begin
    perform set_config('request.jwt.claims', claims_aal2_old, true); set local role authenticated;
    update public.devices set app_version = '0.2.0', flows_on = array[gen_random_uuid()], last_seen_at = now(), remote_start = 'ask', checked_at = now(),
      other_sessions = '[{"harness": "codex-cli", "ref": "abc", "title": "Mine", "state": "idle"}]'
      where id = dev;
    get diagnostics n = row_count; out := out || '21f the computer reported on itself=' || n || ' (want 1)' || E'\n';
    reset role;
  exception when others then out := out || '21f ERROR ' || sqlerrm || E'\n'; end;
  begin
    perform set_config('request.jwt.claims', claims_aal2_old, true); set local role authenticated;
    update public.devices set platform = 'linux' where id = dev;
    out := out || '21g FAIL a computer''s platform changed' || E'\n';
    reset role;
  exception when others then out := out || '21g platform refused: ' || left(sqlerrm, 60) || E'\n'; end;
  begin
    perform set_config('request.jwt.claims', claims_a2_old, true); set local role authenticated;
    update public.devices set auth_session_id = sa2 where id = dev;
    out := out || '21h FAIL a computer''s sign-in taken over by an update' || E'\n';
    reset role;
  exception when others then out := out || '21h sign-in refused: ' || left(sqlerrm, 60) || E'\n'; end;
  begin
    perform set_config('request.jwt.claims', claims_a2_old, true); set local role authenticated;
    update public.devices set revoked_at = null where id = dev2;
    out := out || '21i FAIL a computer''s sign-out changed by an update' || E'\n';
    reset role;
  exception when others then out := out || '21i sign-out refused: ' || left(sqlerrm, 60) || E'\n'; end;
  begin
    perform set_config('request.jwt.claims', claims_b_old, true); set local role authenticated;
    update public.devices set name = 'Not yours', is_default = true where id = dev;
    get diagnostics n = row_count; out := out || '21j other account renamed the computer=' || n || ' (want 0)' || E'\n';
    reset role;
  exception when others then out := out || '21j ERROR ' || sqlerrm || E'\n'; end;

  -- 22. what a computer reports is held to plain shapes
  begin
    perform set_config('request.jwt.claims', claims_aal2_old, true); set local role authenticated;
    update public.devices set app_version = '1.0.0 && calc' where id = dev;
    out := out || '22 FAIL a version with shell characters accepted' || E'\n';
    reset role;
  exception when others then out := out || '22 version rejected: ' || left(sqlerrm, 70) || E'\n'; end;
  begin
    perform set_config('request.jwt.claims', claims_aal2_old, true); set local role authenticated;
    update public.devices set flows_on = (select array_agg(gen_random_uuid()) from generate_series(1, 201)) where id = dev;
    out := out || '22a FAIL 201 flows accepted' || E'\n';
    reset role;
  exception when others then out := out || '22a 201 flows rejected: ' || left(sqlerrm, 70) || E'\n'; end;
  begin
    perform set_config('request.jwt.claims', claims_a2_old, true); set local role authenticated;
    update public.devices set name = E'PC\r\ncalc' where id = dev;
    out := out || '22b FAIL a name with a line break accepted' || E'\n';
    reset role;
  exception when others then out := out || '22b name rejected: ' || left(sqlerrm, 70) || E'\n'; end;

  -- 23. resuming a session or sending it back with changes goes only to the computer it ran on, for its own task and
  --     agent, with a fresh code, and each kind has its own shape
  begin
    perform set_config('request.jwt.claims', claims_aal2_old, true); set local role authenticated;
    insert into public.tasks (key, area_id, title, created_at, updated_at) values ('', area_a, 'Second', '2026-09-25T10:00:00', '2026-09-25T10:00:00') returning id into tid2;
    reset role;
  exception when others then out := out || '23 ERROR ' || sqlerrm || E'\n'; end;
  begin
    perform set_config('request.jwt.claims', claims_a2_fresh, true); set local role authenticated;
    insert into public.launch_requests (device_id, task_id, agent, kind, surface) values (dev, tid, 'claude', 'start', 'desktop');
    get diagnostics n = row_count; out := out || '23a start in the app accepted=' || n || ' (want 1)' || E'\n';
    insert into public.launch_requests (device_id, task_id, agent, kind, target_session_id) values (dev, tid, 'claude', 'resume', sid);
    get diagnostics n = row_count; out := out || '23b resume on the computer it ran on accepted=' || n || ' (want 1)' || E'\n';
    insert into public.launch_requests (device_id, task_id, agent, kind, target_session_id, changes) values (dev, tid, 'claude', 'changes', sid, E'  Make the button blue.\n');
    select count(*) into n from public.launch_requests where kind = 'changes' and changes = 'Make the button blue.' and status = 'pending';
    out := out || '23c changes accepted and trimmed=' || n || ' (want 1)' || E'\n';
    reset role;
  exception when others then out := out || '23a ERROR ' || sqlerrm || E'\n'; end;
  begin
    perform set_config('request.jwt.claims', claims_a2_fresh, true); set local role authenticated;
    insert into public.launch_requests (device_id, task_id, agent, kind, target_session_id) values (dev2, tid, 'claude', 'resume', sid);
    out := out || '23d FAIL resume sent to a computer the session didn''t run on' || E'\n';
    reset role;
  exception when others then out := out || '23d resume on another computer refused: ' || left(sqlerrm, 60) || E'\n'; end;
  begin
    perform set_config('request.jwt.claims', claims_a2_fresh, true); set local role authenticated;
    insert into public.launch_requests (device_id, task_id, agent, kind, target_session_id, changes) values (dev2, tid, 'claude', 'changes', sid, 'Blue');
    out := out || '23e FAIL changes sent to a computer the session didn''t run on' || E'\n';
    reset role;
  exception when others then out := out || '23e changes on another computer refused: ' || left(sqlerrm, 60) || E'\n'; end;
  begin
    perform set_config('request.jwt.claims', claims_a2_fresh, true); set local role authenticated;
    insert into public.launch_requests (device_id, task_id, agent, kind, target_session_id) values (dev, tid2, 'claude', 'resume', sid);
    out := out || '23f FAIL a session resumed under another task' || E'\n';
    reset role;
  exception when others then out := out || '23f another task refused: ' || left(sqlerrm, 60) || E'\n'; end;
  begin
    perform set_config('request.jwt.claims', claims_a2_fresh, true); set local role authenticated;
    insert into public.launch_requests (device_id, task_id, agent, kind, target_session_id) values (dev, tid, 'codex', 'resume', sid);
    out := out || '23g FAIL a Claude session resumed as Codex' || E'\n';
    reset role;
  exception when others then out := out || '23g another agent refused: ' || left(sqlerrm, 60) || E'\n'; end;
  begin
    perform set_config('request.jwt.claims', claims_a2_fresh, true); set local role authenticated;
    insert into public.launch_requests (device_id, task_id, agent, kind, target_session_id) values (dev, tid, 'claude', 'start', sid);
    out := out || '23h FAIL a start naming a session accepted' || E'\n';
    reset role;
  exception when others then out := out || '23h start with a session refused: ' || left(sqlerrm, 60) || E'\n'; end;
  begin
    perform set_config('request.jwt.claims', claims_a2_fresh, true); set local role authenticated;
    insert into public.launch_requests (device_id, task_id, agent, kind, changes) values (dev, tid, 'claude', 'start', 'Blue');
    out := out || '23i FAIL a start with changes accepted' || E'\n';
    reset role;
  exception when others then out := out || '23i start with changes refused: ' || left(sqlerrm, 60) || E'\n'; end;
  begin
    perform set_config('request.jwt.claims', claims_a2_fresh, true); set local role authenticated;
    insert into public.launch_requests (device_id, task_id, agent, kind, target_session_id, changes) values (dev, tid, 'claude', 'resume', sid, 'Blue');
    out := out || '23j FAIL a resume with changes accepted' || E'\n';
    reset role;
  exception when others then out := out || '23j resume with changes refused: ' || left(sqlerrm, 60) || E'\n'; end;
  begin
    perform set_config('request.jwt.claims', claims_a2_fresh, true); set local role authenticated;
    insert into public.launch_requests (device_id, task_id, agent, kind) values (dev, tid, 'claude', 'resume');
    out := out || '23k FAIL a resume without a session accepted' || E'\n';
    reset role;
  exception when others then out := out || '23k resume without a session refused: ' || left(sqlerrm, 60) || E'\n'; end;
  begin
    perform set_config('request.jwt.claims', claims_a2_fresh, true); set local role authenticated;
    insert into public.launch_requests (device_id, task_id, agent, kind, target_session_id, changes) values (dev, tid, 'claude', 'changes', sid, E' \n ');
    out := out || '23l FAIL blank changes accepted' || E'\n';
    reset role;
  exception when others then out := out || '23l blank changes refused: ' || left(sqlerrm, 60) || E'\n'; end;
  begin
    perform set_config('request.jwt.claims', claims_a2_fresh, true); set local role authenticated;
    insert into public.launch_requests (device_id, task_id, agent, kind, target_session_id, changes) values (dev, tid, 'claude', 'changes', sid, repeat('x', 20001));
    out := out || '23m FAIL 20001 characters of changes accepted' || E'\n';
    reset role;
  exception when others then out := out || '23m long changes refused: ' || left(sqlerrm, 60) || E'\n'; end;
  begin
    perform set_config('request.jwt.claims', claims_a2_fresh, true); set local role authenticated;
    insert into public.launch_requests (device_id, task_id, agent, kind) values (dev, tid, 'claude', 'shell');
    out := out || '23n FAIL an unknown kind accepted' || E'\n';
    reset role;
  exception when others then out := out || '23n unknown kind refused: ' || left(sqlerrm, 60) || E'\n'; end;
  begin
    perform set_config('request.jwt.claims', claims_a2_fresh, true); set local role authenticated;
    insert into public.launch_requests (device_id, task_id, agent, surface) values (dev, tid, 'claude', 'shell');
    out := out || '23o FAIL an unknown surface accepted' || E'\n';
    reset role;
  exception when others then out := out || '23o unknown surface refused: ' || left(sqlerrm, 60) || E'\n'; end;
  begin
    perform set_config('request.jwt.claims', claims_a2_old, true); set local role authenticated;
    insert into public.launch_requests (device_id, task_id, agent, kind, target_session_id) values (dev, tid, 'claude', 'resume', sid);
    out := out || '23p FAIL resume without a fresh code accepted' || E'\n';
    reset role;
  exception when others then out := out || '23p resume with a stale code refused: ' || left(sqlerrm, 60) || E'\n'; end;
  begin
    perform set_config('request.jwt.claims', claims_new_factor, true); set local role authenticated;
    insert into public.launch_requests (device_id, task_id, agent, kind, target_session_id, changes) values (dev, tid, 'claude', 'changes', sid, 'Blue');
    out := out || '23q FAIL changes with an authenticator added in this session accepted' || E'\n';
    reset role;
  exception when others then out := out || '23q changes with a new authenticator refused: ' || left(sqlerrm, 50) || E'\n'; end;
  begin
    perform set_config('request.jwt.claims', claims_a2_fresh, true); set local role authenticated;
    insert into public.launch_requests (device_id, task_id, agent, kind, target_session_id, status) values (dev, tid, 'claude', 'resume', sid, 'launched');
    out := out || '23r FAIL client-set status on a resume accepted' || E'\n';
    reset role;
  exception when others then out := out || '23r client-set status refused: ' || left(sqlerrm, 60) || E'\n'; end;
  begin
    perform set_config('request.jwt.claims', claims_a2_fresh, true); set local role authenticated;
    update public.launch_requests set status = 'launched', decided_at = now() where kind = 'resume';
    update public.launch_requests set status = 'pending' where kind = 'resume';
    out := out || '23s FAIL a decided resume set back to pending' || E'\n';
    reset role;
  exception when others then out := out || '23s re-pending a resume refused: ' || left(sqlerrm, 60) || E'\n'; end;

  -- 24. another account can't aim a request at this account's sessions or computers (test 16's computer of b went
  --     with its block, so b signs one in here)
  begin
    perform set_config('request.jwt.claims', claims_b_old, true); set local role authenticated;
    dev_b := public.register_device('B PC', 'windows');
    reset role;
  exception when others then out := out || '24 ERROR ' || sqlerrm || E'\n'; end;
  begin
    perform set_config('request.jwt.claims', claims_b_fresh, true); set local role authenticated;
    insert into public.launch_requests (device_id, task_id, agent, kind, target_session_id) values (dev_b, tid, 'claude', 'resume', sid);
    out := out || '24 FAIL another account''s session resumed on its own computer' || E'\n';
    reset role;
  exception when others then out := out || '24 other account''s session refused: ' || left(sqlerrm, 60) || E'\n'; end;
  begin
    perform set_config('request.jwt.claims', claims_b_fresh, true); set local role authenticated;
    insert into public.launch_requests (device_id, task_id, agent, kind, target_session_id, changes) values (dev, tid, 'claude', 'changes', sid, 'Blue');
    out := out || '24a FAIL changes sent to another account''s computer' || E'\n';
    reset role;
  exception when others then out := out || '24a other account''s computer refused: ' || left(sqlerrm, 60) || E'\n'; end;
  begin
    perform set_config('request.jwt.claims', claims_b_old, true); set local role authenticated;
    select count(*) into n from public.launch_requests; out := out || '24b other account sees requests=' || n || ' (want 0)' || E'\n';
    reset role;
  exception when others then out := out || '24b ERROR ' || sqlerrm || E'\n'; end;

  -- 30. a computer can take requests from elsewhere without a fresh code, when it says so itself: only its own sign-in
  --     switches the code off, and the requests still come only from a live two-factor session of the account. The
  --     database records whether each came with a code. (The computer switches the code back on, and the requests
  --     made here are deleted at the end, so the later checks see the computer as before.)
  begin
    perform set_config('request.jwt.claims', claims_a2_old, true); set local role authenticated;
    select count(*) into n from public.devices where id = dev and remote_code; out := out || '30 a computer asks for a code at first=' || n || ' (want 1)' || E'\n';
    update public.devices set remote_code = false where id = dev;
    out := out || '30a FAIL another sign-in switched the computer''s code off' || E'\n';
    reset role;
  exception when others then out := out || '30a another sign-in switching the code off refused: ' || left(sqlerrm, 60) || E'\n'; end;
  begin
    perform set_config('request.jwt.claims', claims_aal2_old, true); set local role authenticated;
    update public.devices set remote_code = false where id = dev;
    get diagnostics n = row_count; out := out || '30b the computer switched its code off itself=' || n || ' (want 1)' || E'\n';
    reset role;
  exception when others then out := out || '30b ERROR ' || sqlerrm || E'\n'; end;
  begin
    perform set_config('request.jwt.claims', claims_a2_old, true); set local role authenticated;
    insert into public.launch_requests (device_id, task_id, agent) values (dev, tid, 'claude') returning id, fresh_code into req_nc, ok;
    out := out || '30c request without a code accepted, fresh_code=' || ok || ' (want false)' || E'\n';
    reset role;
  exception when others then out := out || '30c ERROR ' || sqlerrm || E'\n'; end;
  begin
    perform set_config('request.jwt.claims', claims_a2_fresh, true); set local role authenticated;
    insert into public.launch_requests (device_id, task_id, agent) values (dev, tid, 'claude') returning id, fresh_code into req_fc, ok;
    out := out || '30d request with a fresh code accepted, fresh_code=' || ok || ' (want true)' || E'\n';
    reset role;
  exception when others then out := out || '30d ERROR ' || sqlerrm || E'\n'; end;
  begin
    perform set_config('request.jwt.claims', claims_a2_old, true); set local role authenticated;
    insert into public.launch_requests (device_id, task_id, agent, kind, target_session_id, changes) values (dev, tid, 'claude', 'changes', sid, 'Blue')
      returning id into req_ch;
    get diagnostics n = row_count; out := out || '30e changes without a code accepted=' || n || ' (want 1)' || E'\n';
    reset role;
  exception when others then out := out || '30e ERROR ' || sqlerrm || E'\n'; end;
  begin
    perform set_config('request.jwt.claims', claims_a2_old, true); set local role authenticated;
    insert into public.launch_requests (device_id, task_id, agent) values (dev2, tid, 'claude');
    out := out || '30f FAIL a computer that asks for a code took a request without one' || E'\n';
    reset role;
  exception when others then out := out || '30f another computer still asks for a code: ' || left(sqlerrm, 60) || E'\n'; end;
  begin
    perform set_config('request.jwt.claims', claims_a2_old, true); set local role authenticated;
    insert into public.launch_requests (device_id, task_id, agent, fresh_code) values (dev, tid, 'claude', true);
    out := out || '30g FAIL a request said itself that it came with a code' || E'\n';
    reset role;
  exception when others then out := out || '30g a request''s own fresh_code refused: ' || left(sqlerrm, 60) || E'\n'; end;
  begin
    perform set_config('request.jwt.claims', claims_a2_old, true); set local role authenticated;
    insert into public.launch_requests (device_id, task_id, agent, agent_session) values (dev, tid, 'claude', gen_random_uuid());
    out := out || '30ga FAIL a request named an agent''s sign-in itself' || E'\n';
    reset role;
  exception when others then out := out || '30ga a request''s own agent sign-in refused: ' || left(sqlerrm, 60) || E'\n'; end;
  begin
    perform set_config('request.jwt.claims', claims_a2_old, true); set local role authenticated;
    update public.launch_requests set fresh_code = true where id = req_nc;
    out := out || '30h FAIL a request''s fresh_code changed afterwards' || E'\n';
    reset role;
  exception when others then out := out || '30h changing fresh_code refused: ' || left(sqlerrm, 60) || E'\n'; end;
  begin
    perform set_config('request.jwt.claims', claims_aal1, true); set local role authenticated;
    insert into public.launch_requests (device_id, task_id, agent) values (dev, tid, 'claude');
    out := out || '30i FAIL a password-only session asked a computer that takes requests without a code' || E'\n';
    reset role;
  exception when others then out := out || '30i password-only session refused: ' || left(sqlerrm, 60) || E'\n'; end;
  begin
    perform set_config('request.jwt.claims', json_build_object('sub', a, 'role', 'authenticated', 'aal', 'aal2', 'session_id', sa2, 'client_id', gen_random_uuid(),
      'amr', json_build_array(json_build_object('method', 'totp', 'timestamp', now_s - 3600)))::text, true);
    set local role authenticated;
    insert into public.launch_requests (device_id, task_id, agent) values (dev, tid, 'claude');
    out := out || '30j FAIL an agent''s sign-in asked a computer that takes requests without a code' || E'\n';
    reset role;
  exception when others then out := out || '30j agent''s sign-in refused: ' || left(sqlerrm, 60) || E'\n'; end;
  begin
    perform set_config('request.jwt.claims', claims_b_old, true); set local role authenticated;
    insert into public.launch_requests (device_id, task_id, agent) values (dev, tid, 'claude');
    out := out || '30k FAIL another account asked a computer that takes requests without a code' || E'\n';
    reset role;
  exception when others then out := out || '30k another account refused: ' || left(sqlerrm, 60) || E'\n'; end;
  begin
    perform set_config('request.jwt.claims', claims_aal2_old, true); set local role authenticated;
    update public.devices set remote_code = true where id = dev;
    get diagnostics n = row_count; out := out || '30l the computer switched its code back on=' || n || ' (want 1)' || E'\n';
    reset role;
  exception when others then out := out || '30l ERROR ' || sqlerrm || E'\n'; end;
  begin
    perform set_config('request.jwt.claims', claims_a2_old, true); set local role authenticated;
    insert into public.launch_requests (device_id, task_id, agent) values (dev, tid, 'claude');
    out := out || '30m FAIL the computer asks for a code again but took a request without one' || E'\n';
    reset role;
  exception when others then out := out || '30m code back on, request without one refused: ' || left(sqlerrm, 50) || E'\n'; end;
  begin
    perform set_config('request.jwt.claims', claims_aal2_old, true); set local role authenticated;
    delete from public.launch_requests where id in (req_nc, req_fc, req_ch);
    get diagnostics n = row_count; out := out || '30n requests made for these checks deleted=' || n || ' (want 3)' || E'\n';
    reset role;
  exception when others then out := out || '30n ERROR ' || sqlerrm || E'\n'; end;

  -- 26. what a running session waits for you to answer: only its computer asks, an answer comes once, from that computer
  --     or from elsewhere with a fresh code, before the agent stops waiting; only the computer withdraws it
  begin
    perform set_config('request.jwt.claims', claims_aal2_old, true); set local role authenticated;
    insert into public.session_asks (session_id, device_id, kind, tool, text, expires_at)
      values (sid, dev, 'permission', 'Bash', 'npm test', now() + interval '10 minutes') returning id into ask_id;
    insert into public.session_asks (session_id, device_id, kind, text, expires_at)
      values (sid, dev, 'question', 'ISO or US?', now() + interval '30 minutes') returning id into ask2;
    out := out || '26 the session''s computer asked' || E'\n';
    reset role;
  exception when others then out := out || '26 ERROR ' || sqlerrm || E'\n'; end;
  begin
    perform set_config('request.jwt.claims', claims_a2_old, true); set local role authenticated;
    insert into public.session_asks (session_id, device_id, kind, text, expires_at) values (sid, dev, 'question', 'Fake?', now() + interval '5 minutes');
    out := out || '26a FAIL another sign-in asked for the session''s computer' || E'\n';
    reset role;
  exception when others then out := out || '26a another sign-in asking refused: ' || left(sqlerrm, 60) || E'\n'; end;
  begin
    perform set_config('request.jwt.claims', claims_aal2_old, true); set local role authenticated;
    insert into public.session_asks (session_id, device_id, kind, text, expires_at) values (sid, dev, 'question', 'Long?', now() + interval '2 hours');
    out := out || '26b FAIL an ask open for two hours accepted' || E'\n';
    reset role;
  exception when others then out := out || '26b ask open too long rejected: ' || left(sqlerrm, 60) || E'\n'; end;
  begin
    perform set_config('request.jwt.claims', claims_a2_old, true); set local role authenticated;
    update public.session_asks set status = 'answered', answer = 'allow' where id = ask_id;
    out := out || '26c FAIL answered from elsewhere without a fresh code' || E'\n';
    reset role;
  exception when others then out := out || '26c answer from elsewhere without a fresh code refused: ' || left(sqlerrm, 50) || E'\n'; end;
  begin
    perform set_config('request.jwt.claims', claims_a2_fresh, true); set local role authenticated;
    update public.session_asks set status = 'answered', answer = 'maybe' where id = ask_id;
    out := out || '26d FAIL a permission answered with something other than allow or deny' || E'\n';
    reset role;
  exception when others then out := out || '26d permission answer that isn''t allow or deny rejected: ' || left(sqlerrm, 40) || E'\n'; end;
  begin
    perform set_config('request.jwt.claims', claims_a2_fresh, true); set local role authenticated;
    update public.session_asks set status = 'answered', answer = 'allow' where id = ask_id;
    select count(*) into n from public.session_asks where id = ask_id and status = 'answered' and answered_via = 'elsewhere';
    out := out || '26e answered from elsewhere with a fresh code=' || n || ' (want 1)' || E'\n';
    reset role;
  exception when others then out := out || '26e ERROR ' || sqlerrm || E'\n'; end;
  begin
    perform set_config('request.jwt.claims', claims_aal2_old, true); set local role authenticated;
    update public.session_asks set status = 'answered', answer = 'deny' where id = ask_id;
    out := out || '26f FAIL answered twice' || E'\n';
    reset role;
  exception when others then out := out || '26f answering twice refused: ' || left(sqlerrm, 50) || E'\n'; end;
  begin
    perform set_config('request.jwt.claims', claims_a2_fresh, true); set local role authenticated;
    update public.session_asks set status = 'withdrawn' where id = ask2;
    out := out || '26g FAIL another sign-in withdrew the computer''s question' || E'\n';
    reset role;
  exception when others then out := out || '26g withdrawing from elsewhere refused: ' || left(sqlerrm, 50) || E'\n'; end;
  begin
    perform set_config('request.jwt.claims', claims_aal2_old, true); set local role authenticated;
    update public.session_asks set status = 'answered', answer = 'ISO' where id = ask2;
    select count(*) into n from public.session_asks where id = ask2 and status = 'answered' and answered_via = 'computer';
    out := out || '26h the computer answered without a fresh code=' || n || ' (want 1)' || E'\n';
    reset role;
  exception when others then out := out || '26h ERROR ' || sqlerrm || E'\n'; end;
  -- As the owner (the table's trigger refuses any other change to a waiting ask): the agent stopped waiting five minutes ago.
  insert into public.session_asks (user_id, session_id, device_id, kind, text, asked_at, expires_at)
    values (a, sid, dev, 'question', 'Later?', now() - interval '10 minutes', now() - interval '5 minutes') returning id into ask3;
  begin
    perform set_config('request.jwt.claims', claims_aal2_old, true); set local role authenticated;
    update public.session_asks set status = 'answered', answer = 'Now' where id = ask3;
    out := out || '26i FAIL answered after the agent stopped waiting' || E'\n';
    reset role;
  exception when others then out := out || '26i answer after the agent stopped waiting refused: ' || left(sqlerrm, 40) || E'\n'; end;
  begin
    perform set_config('request.jwt.claims', claims_aal2_old, true); set local role authenticated;
    update public.session_asks set answer = 'Changed' where id = ask3;
    out := out || '26n FAIL an answer changed without answering' || E'\n';
    reset role;
  exception when others then out := out || '26n changing the answer alone refused: ' || left(sqlerrm, 40) || E'\n'; end;
  begin
    perform set_config('request.jwt.claims', claims_b_fresh, true); set local role authenticated;
    select count(*) into n from public.session_asks; out := out || '26j other account sees asks=' || n || ' (want 0)' || E'\n';
    update public.session_asks set status = 'answered', answer = 'deny' where id = ask3;
    get diagnostics n = row_count; out := out || '26k other account answered=' || n || ' (want 0)' || E'\n';
    reset role;
  exception when others then out := out || '26j ERROR ' || sqlerrm || E'\n'; end;
  begin
    perform set_config('request.jwt.claims', claims_aal1, true); set local role authenticated;
    select count(*) into n from public.session_asks; out := out || '26l password-only session sees asks=' || n || ' (want 0)' || E'\n';
    reset role;
  exception when others then out := out || '26l ERROR ' || sqlerrm || E'\n'; end;
  begin
    perform set_config('request.jwt.claims', json_build_object('role', 'anon')::text, true); set local role anon;
    select count(*) into n from public.session_asks;
    out := out || '26m FAIL anon read asks=' || n || E'\n';
    reset role;
  exception when others then out := out || '26m anon refused: ' || left(sqlerrm, 60) || E'\n'; end;

  -- 27. web push: the account's own key pair and browsers, only the push services' addresses
  begin
    perform set_config('request.jwt.claims', claims_aal2_old, true); set local role authenticated;
    insert into public.push_keys (public_key, private_key)
      values (repeat('A', 87), repeat('B', 43));
    insert into public.push_subscriptions (endpoint, p256dh, auth, label)
      values ('https://fcm.googleapis.com/fcm/send/abc:APA91b-test', repeat('C', 87), repeat('D', 22), 'Chrome on Android');
    insert into public.push_subscriptions (endpoint, p256dh, auth, label)
      values ('https://wns2-par02p.notify.windows.com/w/?token=BQYAAAB-abc%3d', repeat('C', 87), repeat('D', 22), 'Edge on Windows');
    insert into public.push_subscriptions (endpoint, p256dh, auth, label)
      values ('https://web.push.apple.com/QGuQyavXutnMei-abc', repeat('C', 87), repeat('D', 22), 'Safari on iPhone');
    select count(*) into n from public.push_subscriptions; out := out || '27 own browsers added=' || n || ' (want 3)' || E'\n';
    reset role;
  exception when others then out := out || '27 ERROR ' || sqlerrm || E'\n'; end;
  begin
    perform set_config('request.jwt.claims', claims_aal2_old, true); set local role authenticated;
    insert into public.push_subscriptions (endpoint, p256dh, auth) values ('https://evil.example.com/push', repeat('C', 87), repeat('D', 22));
    out := out || '27a FAIL a push address that isn''t a push service accepted' || E'\n';
    reset role;
  exception when others then out := out || '27a push address outside the push services rejected: ' || left(sqlerrm, 40) || E'\n'; end;
  begin
    perform set_config('request.jwt.claims', claims_aal2_old, true); set local role authenticated;
    insert into public.push_subscriptions (endpoint, p256dh, auth) values ('https://fcm.googleapis.com.evil.example/x', repeat('C', 87), repeat('D', 22));
    out := out || '27b FAIL a look-alike push address accepted' || E'\n';
    reset role;
  exception when others then out := out || '27b look-alike push address rejected: ' || left(sqlerrm, 40) || E'\n'; end;
  begin
    perform set_config('request.jwt.claims', claims_b_old, true); set local role authenticated;
    select count(*) into n from public.push_keys; out := out || '27c other account sees push keys=' || n || ' (want 0)' || E'\n';
    select count(*) into n from public.push_subscriptions; out := out || '27d other account sees browsers=' || n || ' (want 0)' || E'\n';
    reset role;
  exception when others then out := out || '27c ERROR ' || sqlerrm || E'\n'; end;
  begin
    perform set_config('request.jwt.claims', claims_aal1, true); set local role authenticated;
    select count(*) into n from public.push_keys; out := out || '27e password-only session sees push keys=' || n || ' (want 0)' || E'\n';
    reset role;
  exception when others then out := out || '27e ERROR ' || sqlerrm || E'\n'; end;
  begin
    perform set_config('request.jwt.claims', claims_aal2_old, true); set local role authenticated;
    update public.push_keys set private_key = repeat('Z', 43);
    out := out || '27f FAIL push keys changed in place' || E'\n';
    reset role;
  exception when others then out := out || '27f changing push keys refused: ' || left(sqlerrm, 40) || E'\n'; end;

  -- 28. billing: the account reads its own plan and nobody writes it; once Cloud has ended (the switch on, the trial
  --     over, no subscription) reads and deletes work and inserts and updates are refused with PT402; comped and paid
  --     accounts write; an account whose subscription would renew can't be deleted.
  begin
    perform set_config('request.jwt.claims', claims_aal2_old, true); set local role authenticated;
    select count(*) into n from public.billing; out := out || '28 own billing rows=' || n || ' (want 1)' || E'\n';
    select count(*) into n from public.billing where user_id = b; out := out || '28a other account''s billing=' || n || ' (want 0)' || E'\n';
    reset role;
  exception when others then out := out || '28 ERROR ' || sqlerrm || E'\n'; end;
  begin
    perform set_config('request.jwt.claims', claims_aal1, true); set local role authenticated;
    select count(*) into n from public.billing; out := out || '28b password-only session sees billing=' || n || ' (want 0)' || E'\n';
    reset role;
  exception when others then out := out || '28b ERROR ' || sqlerrm || E'\n'; end;
  begin
    perform set_config('request.jwt.claims', json_build_object('role', 'anon')::text, true); set local role anon;
    select count(*) into n from public.billing;
    out := out || '28c FAIL anon read billing=' || n || E'\n';
    reset role;
  exception when others then out := out || '28c anon refused: ' || left(sqlerrm, 60) || E'\n'; end;
  begin
    perform set_config('request.jwt.claims', claims_aal2_old, true); set local role authenticated;
    update public.billing set comped = true;
    out := out || '28d FAIL an account comped itself' || E'\n';
    reset role;
  exception when others then out := out || '28d changing own billing refused: ' || left(sqlerrm, 50) || E'\n'; end;
  begin
    perform set_config('request.jwt.claims', claims_aal2_old, true); set local role authenticated;
    insert into public.billing (user_id, trial_ends_at, comped) values (a, now() + interval '1 year', true);
    out := out || '28e FAIL an account wrote its own billing row' || E'\n';
    reset role;
  exception when others then out := out || '28e inserting billing refused: ' || left(sqlerrm, 50) || E'\n'; end;
  begin
    perform set_config('request.jwt.claims', claims_aal2_old, true); set local role authenticated;
    delete from public.billing;
    out := out || '28f FAIL an account deleted its billing row' || E'\n';
    reset role;
  exception when others then out := out || '28f deleting billing refused: ' || left(sqlerrm, 50) || E'\n'; end;
  -- Simulate pre-launch inside this rolled-back test, even when billing is already live.
  update private.billing_switch set enforce = false;
  begin
    perform set_config('request.jwt.claims', claims_aal2_old, true); set local role authenticated;
    out := out || '28r plan before launch: enforced=' || (public.cloud_plan() ->> 'enforced') || ' (want false), writable='
      || (public.cloud_plan() ->> 'writable') || ' (want true)' || E'\n';
    reset role;
  exception when others then out := out || '28r ERROR ' || sqlerrm || E'\n'; end;
  begin
    perform set_config('request.jwt.claims', claims_aal1, true); set local role authenticated;
    out := out || '28s password-only session gets a plan=' || (public.cloud_plan() is not null) || ' (want false)' || E'\n';
    reset role;
  exception when others then out := out || '28s ERROR ' || sqlerrm || E'\n'; end;
  begin
    perform set_config('request.jwt.claims', json_build_object('role', 'anon')::text, true); set local role anon;
    perform public.cloud_plan();
    out := out || '28t FAIL anon read a plan' || E'\n';
    reset role;
  exception when others then out := out || '28t anon refused: ' || left(sqlerrm, 60) || E'\n'; end;

  -- Staged as the owner, with no claims (auth.uid() null, as for the service role): Cloud ends for a.
  perform set_config('request.jwt.claims', '', true);
  insert into public.areas (user_id, name, key, color) values (a, 'Billing test', 'BIL', '#68AAB9') returning id into area_del;
  insert into public.tasks (user_id, key, area_id, title, created_at, updated_at)
    values (a, '', area_del, 'Moves out of its area', '2026-09-28T10:00:00', '2026-09-28T10:00:00') returning id into t_moved;
  insert into public.tasks (user_id, key, area_id, title, created_at, updated_at)
    values (a, '', area_a, 'Deleted while read-only', '2026-09-28T10:00:00', '2026-09-28T10:00:00') returning id into t_del;
  update private.billing_switch set enforce = true;
  update public.billing set trial_ends_at = now() - interval '1 minute', status = 'canceled' where user_id = a;
  out := out || '[setup] staged writes without a session while Cloud ended' || E'\n';

  begin
    perform set_config('request.jwt.claims', claims_aal2_old, true); set local role authenticated;
    select count(*) into n from public.tasks; out := out || '28g read-only account still reads tasks=' || (n > 0) || ' (want true)' || E'\n';
    out := out || '28g plan once Cloud ended: enforced=' || (public.cloud_plan() ->> 'enforced') || ' (want true), writable='
      || (public.cloud_plan() ->> 'writable') || ' (want false)' || E'\n';
    reset role;
  exception when others then out := out || '28g ERROR ' || sqlerrm || E'\n'; end;
  begin
    perform set_config('request.jwt.claims', claims_aal2_old, true); set local role authenticated;
    insert into public.tasks (key, area_id, title, created_at, updated_at) values ('', area_a, 'Blocked', '2026-09-28T10:00:00', '2026-09-28T10:00:00');
    out := out || '28h FAIL a read-only account added a task' || E'\n';
    reset role;
  exception when others then get stacked diagnostics code = returned_sqlstate; out := out || '28h adding a task refused with ' || code || ' (want PT402)' || E'\n'; end;
  begin
    perform set_config('request.jwt.claims', claims_aal2_old, true); set local role authenticated;
    update public.tasks set title = 'Changed' where id = tid;
    out := out || '28i FAIL a read-only account changed a task' || E'\n';
    reset role;
  exception when others then get stacked diagnostics code = returned_sqlstate; out := out || '28i changing a task refused with ' || code || ' (want PT402)' || E'\n'; end;
  begin
    perform set_config('request.jwt.claims', claims_aal2_old, true); set local role authenticated;
    delete from public.tasks where id = t_del; get diagnostics n = row_count;
    out := out || '28j read-only account deleted tasks=' || n || ' (want 1)' || E'\n';
    -- Deleting an area sets its tasks' area to null: an update nested in the delete, which goes through.
    delete from public.areas where id = area_del; get diagnostics n = row_count;
    out := out || '28k read-only account deleted areas=' || n || ' (want 1)' || E'\n';
    select count(*) into n from public.tasks where id = t_moved and area_id is null; out := out || '28k task left without its area=' || n || ' (want 1)' || E'\n';
    reset role;
  exception when others then out := out || '28j ERROR ' || sqlerrm || E'\n'; end;
  begin
    perform set_config('request.jwt.claims', claims_aal2_old, true); set local role authenticated;
    update public.devices set last_seen_at = now() where id = dev; get diagnostics n = row_count;
    out := out || '28l read-only account''s computer still reports in=' || n || ' (want 1)' || E'\n';
    reset role;
  exception when others then out := out || '28l ERROR ' || sqlerrm || E'\n'; end;
  begin
    perform set_config('request.jwt.claims', claims_aal2_fresh, true); set local role authenticated;
    insert into public.launch_requests (device_id, task_id, agent) values (dev, tid, 'claude');
    out := out || '28m FAIL a read-only account asked a computer to start a session' || E'\n';
    reset role;
  exception when others then get stacked diagnostics code = returned_sqlstate; out := out || '28m starting a session refused with ' || code || ' (want PT402)' || E'\n'; end;
  begin
    perform set_config('request.jwt.claims', claims_aal2_old, true); set local role authenticated;
    insert into public.preferences (topic, text, updated_at) values ('Time and schedule', 'Blocked', '2026-09-29T10:00:00');
    out := out || '28ma FAIL a read-only account added a preference' || E'\n';
    reset role;
  exception when others then get stacked diagnostics code = returned_sqlstate; out := out || '28ma adding a preference refused with ' || code || ' (want PT402)' || E'\n'; end;
  begin
    perform set_config('request.jwt.claims', claims_aal2_old, true); set local role authenticated;
    insert into public.folder_requests (device_id, area_id, folder) values (dev, area_a, '/home/me/code');
    out := out || '28mb FAIL a read-only account asked for a folder' || E'\n';
    reset role;
  exception when others then get stacked diagnostics code = returned_sqlstate; out := out || '28mb asking for a folder refused with ' || code || ' (want PT402)' || E'\n'; end;
  begin
    perform set_config('request.jwt.claims', claims_b_old, true); set local role authenticated;
    update public.areas set name = name where user_id = b; get diagnostics n = row_count;
    out := out || '28n another account in its trial still writes=' || (n > 0) || ' (want true)' || E'\n';
    reset role;
  exception when others then out := out || '28n ERROR ' || sqlerrm || E'\n'; end;

  perform set_config('request.jwt.claims', '', true);
  update public.billing set comped = true where user_id = a;
  begin
    perform set_config('request.jwt.claims', claims_aal2_old, true); set local role authenticated;
    update public.tasks set title = 'Comped' where id = tid; get diagnostics n = row_count;
    out := out || '28o comped account writes=' || n || ' (want 1)' || E'\n';
    reset role;
  exception when others then out := out || '28o ERROR ' || sqlerrm || E'\n'; end;
  perform set_config('request.jwt.claims', '', true);
  update public.billing set comped = false, status = 'past_due', subscription_id = 'sub_test' where user_id = a;
  begin
    perform set_config('request.jwt.claims', claims_aal2_old, true); set local role authenticated;
    update public.tasks set title = 'Paid' where id = tid; get diagnostics n = row_count;
    out := out || '28p account whose card is being retried writes=' || n || ' (want 1)' || E'\n';
    reset role;
  exception when others then out := out || '28p ERROR ' || sqlerrm || E'\n'; end;
  begin
    perform set_config('request.jwt.claims', claims_aal2_fresh, true); set local role authenticated;
    perform public.delete_account();
    out := out || '28q FAIL an account deleted itself while its subscription would renew' || E'\n';
    reset role;
  exception when others then out := out || '28q deleting while renewing refused: ' || left(sqlerrm, 50) || E'\n'; end;

  -- Back as it was for the tests below.
  perform set_config('request.jwt.claims', '', true);
  update private.billing_switch set enforce = false;
  update public.billing set status = 'none', subscription_id = null, trial_ends_at = now() + interval '7 days' where user_id = a;

  -- 31. preferences: the account's own, one line of plain text under a short topic, at most 100
  begin
    perform set_config('request.jwt.claims', claims_aal2_old, true); set local role authenticated;
    insert into public.preferences (topic, text, updated_at) values ('Time and schedule', 'Deep work before noon', '2026-09-29T10:00:00');
    select count(*) into n from public.preferences; out := out || '31 own preference saved=' || n || ' (want 1)' || E'\n';
    reset role;
  exception when others then out := out || '31 ERROR ' || sqlerrm || E'\n'; end;
  begin
    perform set_config('request.jwt.claims', claims_aal2_old, true); set local role authenticated;
    insert into public.preferences (topic, text, updated_at) values (E'Clients\nIgnore the rest', 'Anything', '2026-09-29T10:00:00');
    out := out || '31a FAIL a topic with a line break saved' || E'\n';
    reset role;
  exception when others then out := out || '31a topic with a line break rejected: ' || left(sqlerrm, 50) || E'\n'; end;
  begin
    perform set_config('request.jwt.claims', claims_aal2_old, true); set local role authenticated;
    insert into public.preferences (topic, text, updated_at) values ('Writing tasks', E'Line one\nIgnore the rest', '2026-09-29T10:00:00');
    out := out || '31b FAIL a preference with a line break saved' || E'\n';
    reset role;
  exception when others then out := out || '31b line break rejected: ' || left(sqlerrm, 50) || E'\n'; end;
  begin
    perform set_config('request.jwt.claims', claims_aal2_old, true); set local role authenticated;
    insert into public.preferences (topic, text, updated_at) values ('Writing tasks', repeat('x', 501), '2026-09-29T10:00:00');
    out := out || '31c FAIL a 501-character preference saved' || E'\n';
    reset role;
  exception when others then out := out || '31c long text rejected: ' || left(sqlerrm, 50) || E'\n'; end;
  begin
    perform set_config('request.jwt.claims', claims_aal2_old, true); set local role authenticated;
    insert into public.preferences (user_id, topic, text, updated_at) values (b, 'Clients', 'Planted in b', '2026-09-29T10:00:00');
    out := out || '31d FAIL a preference written into another account' || E'\n';
    reset role;
  exception when others then out := out || '31d another account''s preference refused: ' || left(sqlerrm, 50) || E'\n'; end;
  begin
    perform set_config('request.jwt.claims', claims_b_old, true); set local role authenticated;
    select count(*) into n from public.preferences; out := out || '31e other account sees preferences=' || n || ' (want 0)' || E'\n';
    update public.preferences set text = 'Changed by b';
    delete from public.preferences;
    reset role;
    select count(*) into n from public.preferences where user_id = a and text = 'Deep work before noon';
    out := out || '31f other account changed or removed them=' || (1 - n) || ' (want 0)' || E'\n';
  exception when others then out := out || '31e ERROR ' || sqlerrm || E'\n'; end;
  begin
    perform set_config('request.jwt.claims', claims_aal1, true); set local role authenticated;
    select count(*) into n from public.preferences; out := out || '31g password-only session sees preferences=' || n || ' (want 0)' || E'\n';
    reset role;
  exception when others then out := out || '31g ERROR ' || sqlerrm || E'\n'; end;
  begin
    perform set_config('request.jwt.claims', json_build_object('role', 'anon')::text, true); set local role anon;
    select count(*) into n from public.preferences; out := out || '31h anon sees preferences=' || n || ' (want 0)' || E'\n';
    reset role;
  exception when others then out := out || '31h anon refused: ' || left(sqlerrm, 50) || E'\n'; end;
  begin
    perform set_config('request.jwt.claims', claims_aal2_old, true); set local role authenticated;
    insert into public.preferences (topic, text, updated_at)
      select 'Clients', 'Filler ' || i, '2026-09-29T10:00:00' from generate_series(1, 99) i;
    select count(*) into n from public.preferences; out := out || '31i up to the limit=' || n || ' (want 100)' || E'\n';
    reset role;
  exception when others then out := out || '31i ERROR ' || sqlerrm || E'\n'; end;
  begin
    perform set_config('request.jwt.claims', claims_aal2_old, true); set local role authenticated;
    insert into public.preferences (topic, text, updated_at) values ('Clients', 'One too many', '2026-09-29T10:00:00');
    out := out || '31j FAIL a 101st preference saved' || E'\n';
    reset role;
  exception when others then out := out || '31j 101st refused: ' || left(sqlerrm, 50) || E'\n'; end;
  delete from public.preferences where user_id = a and text like 'Filler %';

  -- 29. agents signed in with OAuth count only once a two-factor session approved that very request, and only when the
  --     sign-in that came of it is the only one it can be
  insert into auth.oauth_clients (id, registration_type, redirect_uris, grant_types, client_name, client_type, token_endpoint_auth_method)
  values (oc_a, 'dynamic', 'http://localhost:1/callback', 'authorization_code,refresh_token', 'Test agent', 'public', 'none'),
         (oc_x, 'dynamic', 'http://localhost:2/callback', 'authorization_code,refresh_token', 'Other agent', 'public', 'none'),
         (oc_c, 'dynamic', 'http://localhost:3/callback', 'authorization_code,refresh_token', 'Raced agent', 'public', 'none');
  insert into auth.oauth_authorizations (id, authorization_id, client_id, user_id, redirect_uri, scope, status, created_at, expires_at)
  values (gen_random_uuid(), 'authz-test-a', oc_a, a, 'http://localhost:1/callback', 'email', 'pending', now(), now() + interval '3 minutes'),
         (gen_random_uuid(), 'authz-test-old', oc_a, a, 'http://localhost:1/callback', 'email', 'pending', now() - interval '10 minutes', now() - interval '1 minute'),
         (gen_random_uuid(), 'authz-test-b', oc_a, b, 'http://localhost:1/callback', 'email', 'pending', now(), now() + interval '3 minutes'),
         (gen_random_uuid(), 'authz-test-c', oc_c, a, 'http://localhost:3/callback', 'email', 'pending', now(), now() + interval '3 minutes');
  -- sg: the sign-in that comes of authz-test-a; sg_early started before the approval, sg_late after its request expired,
  -- sg_x is another client's, sg_b another account's; sc1 and sc2 two sign-ins of the raced client in its window.
  insert into auth.sessions (id, user_id, created_at, updated_at, aal, oauth_client_id)
  values (sg, a, now() + interval '5 seconds', now(), 'aal1', oc_a),
         (sg_early, a, now() - interval '1 minute', now(), 'aal1', oc_a),
         (sg_late, a, now() + interval '4 minutes', now(), 'aal1', oc_a),
         (sg_x, a, now() + interval '5 seconds', now(), 'aal1', oc_x),
         (sg_b, b, now() + interval '5 seconds', now(), 'aal1', oc_a),
         (sc1, a, now() + interval '10 seconds', now(), 'aal1', oc_c),
         (sc2, a, now() + interval '20 seconds', now(), 'aal1', oc_c);
  begin
    perform set_config('request.jwt.claims', json_build_object('sub', a, 'role', 'authenticated', 'aal', 'aal1', 'session_id', sg, 'client_id', oc_a,
      'amr', json_build_array(json_build_object('method', 'oauth_provider/authorization_code', 'timestamp', now_s)))::text, true);
    set local role authenticated;
    select count(*) into n from public.areas; out := out || '29 agent before any approval sees areas=' || n || ' (want 0)' || E'\n';
    select public.claim_agent_login() into ok; out := out || '29a agent claims without an approval=' || ok || ' (want false)' || E'\n';
    reset role;
  exception when others then out := out || '29 ERROR ' || sqlerrm || E'\n'; end;
  begin
    perform set_config('request.jwt.claims', claims_aal1, true); set local role authenticated;
    perform public.approve_agent_login('authz-test-a');
    out := out || '29b FAIL a password-only session approved an agent' || E'\n';
    reset role;
  exception when others then out := out || '29b password-only approval refused: ' || left(sqlerrm, 50) || E'\n'; end;
  begin
    perform set_config('request.jwt.claims', claims_aal2_old, true); set local role authenticated;
    perform public.approve_agent_login('authz-test-old');
    out := out || '29c FAIL an expired sign-in request approved' || E'\n';
    reset role;
  exception when others then out := out || '29c expired request refused: ' || left(sqlerrm, 50) || E'\n'; end;
  begin
    perform set_config('request.jwt.claims', claims_aal2_old, true); set local role authenticated;
    perform public.approve_agent_login('authz-test-b');
    out := out || '29d FAIL another account''s sign-in request approved' || E'\n';
    reset role;
  exception when others then out := out || '29d other account''s request refused: ' || left(sqlerrm, 50) || E'\n'; end;
  begin
    perform set_config('request.jwt.claims', claims_aal2_old, true); set local role authenticated;
    select (public.approve_agent_login('authz-test-a') ->> 'login')::uuid into login;
    select count(*) into n from public.agent_logins where id = login and client_name = 'Test agent' and session_id is null;
    out := out || '29e approval saved with its client=' || n || ' (want 1)' || E'\n';
    select count(*) into n from public.approve_agent_login('authz-test-a') r
      where r ->> 'redirect_uri' = 'http://localhost:1/callback' and (r ->> 'login')::uuid = login;
    out := out || '29ea approving again keeps the one approval and names where it goes back to=' || n || ' (want 1)' || E'\n';
    select count(*) into n from public.agent_logins; out := out || '29eb approvals=' || n || ' (want 1)' || E'\n';
    reset role;
  exception when others then out := out || '29e ERROR ' || sqlerrm || E'\n'; end;
  begin
    perform set_config('request.jwt.claims', claims_aal2_old, true); set local role authenticated;
    insert into public.agent_logins (request_id, client_id, request_expires_at) values ('x', oc_a, now());
    out := out || '29f FAIL an approval written directly' || E'\n';
    reset role;
  exception when others then out := out || '29f writing approvals directly refused: ' || left(sqlerrm, 50) || E'\n'; end;
  begin
    perform set_config('request.jwt.claims', json_build_object('sub', a, 'role', 'authenticated', 'aal', 'aal1', 'session_id', sg, 'client_id', oc_a)::text, true);
    set local role authenticated;
    select public.claim_agent_login() into ok; out := out || '29fa sign-in before its request was used claims it=' || ok || ' (want false)' || E'\n';
    reset role;
  exception when others then out := out || '29fa ERROR ' || sqlerrm || E'\n'; end;
  -- Supabase exchanges the request's code for the agent's sign-in (sg) and deletes the request.
  delete from auth.oauth_authorizations where authorization_id = 'authz-test-a';
  begin
    perform set_config('request.jwt.claims', json_build_object('sub', a, 'role', 'authenticated', 'aal', 'aal1', 'session_id', sg_x, 'client_id', oc_x)::text, true);
    set local role authenticated;
    select public.claim_agent_login() into ok; out := out || '29g another client claims the approval=' || ok || ' (want false)' || E'\n';
    perform set_config('request.jwt.claims', json_build_object('sub', a, 'role', 'authenticated', 'aal', 'aal1', 'session_id', sg_early, 'client_id', oc_a)::text, true);
    select public.claim_agent_login() into ok; out := out || '29h a sign-in older than the approval claims it=' || ok || ' (want false)' || E'\n';
    perform set_config('request.jwt.claims', json_build_object('sub', a, 'role', 'authenticated', 'aal', 'aal1', 'session_id', sg_late, 'client_id', oc_a)::text, true);
    select public.claim_agent_login() into ok; out := out || '29ha a sign-in after the request expired claims it=' || ok || ' (want false)' || E'\n';
    perform set_config('request.jwt.claims', json_build_object('sub', b, 'role', 'authenticated', 'aal', 'aal1', 'session_id', sg_b, 'client_id', oc_a)::text, true);
    select public.claim_agent_login() into ok; out := out || '29i another account''s agent claims it=' || ok || ' (want false)' || E'\n';
    select count(*) into n from public.areas; out := out || '29j that agent sees areas=' || n || ' (want 0)' || E'\n';
    reset role;
  exception when others then out := out || '29g ERROR ' || sqlerrm || E'\n'; end;
  begin
    perform set_config('request.jwt.claims', json_build_object('sub', a, 'role', 'authenticated', 'aal', 'aal1', 'session_id', sg, 'client_id', oc_a)::text, true);
    set local role authenticated;
    select public.claim_agent_login() into ok; out := out || '29k approved agent claims its sign-in=' || ok || ' (want true)' || E'\n';
    select public.claim_agent_login() into ok; out := out || '29l claiming again=' || ok || ' (want true)' || E'\n';
    select count(*) into n from public.areas; out := out || '29m approved agent sees areas=' || n || ' (want 5)' || E'\n';
    insert into public.tasks (key, area_id, title, created_at, updated_at) values ('', area_a, 'agent test task', '2026-09-28T10:00:00', '2026-09-28T10:00:00');
    select count(*) into n from public.tasks where title = 'agent test task'; out := out || '29n approved agent adds a task=' || n || ' (want 1)' || E'\n';
    select count(*) into n from public.devices; out := out || '29o approved agent reads computers=' || sign(n) || ' (want 1)' || E'\n';
    update public.devices set name = 'renamed by agent';
    select count(*) into n from public.devices where name = 'renamed by agent'; out := out || '29p agent renamed computers=' || n || ' (want 0)' || E'\n';
    select count(*) into n from public.push_keys; out := out || '29q agent sees push keys=' || n || ' (want 0)' || E'\n';
    select count(*) into n from public.launch_requests; out := out || '29r agent sees session requests=' || n || ' (want 0)' || E'\n';
    select count(*) into n from public.session_asks; out := out || '29s agent sees what agents wait for=' || n || ' (want 0)' || E'\n';
    select count(*) into n from public.agent_logins; out := out || '29t agent sees approvals=' || n || ' (want 0)' || E'\n';
    select count(*) into n from public.preferences; out := out || '29ta approved agent reads preferences=' || n || ' (want 1)' || E'\n';
    insert into public.preferences (topic, text, source, updated_at) values ('Agents and sessions', 'Codex for refactors', 'agent', '2026-09-29T10:00:00');
    select count(*) into n from public.preferences where source = 'agent'; out := out || '29tb approved agent adds a preference=' || n || ' (want 1)' || E'\n';
    reset role;
  exception when others then out := out || '29k ERROR ' || sqlerrm || E'\n'; end;
  begin
    perform set_config('request.jwt.claims', json_build_object('sub', a, 'role', 'authenticated', 'aal', 'aal1', 'session_id', sg, 'client_id', oc_a)::text, true);
    set local role authenticated;
    insert into public.launch_requests (device_id, task_id, agent) values (dev, tid, 'claude');
    out := out || '29u FAIL an agent asked a computer to start a session' || E'\n';
    reset role;
  exception when others then out := out || '29u agent''s session request refused: ' || left(sqlerrm, 50) || E'\n'; end;
  -- 29ua-uh. once the computer takes requests without a code (its own setting), an agent may ask it for a new session:
  --          marked as an agent's, never with a fresh code, and the agent reads only its own requests
  begin
    perform set_config('request.jwt.claims', claims_aal2_old, true); set local role authenticated;
    update public.devices set remote_code = false where id = dev;
    get diagnostics n = row_count; out := out || '29ua the computer switched its code off=' || n || ' (want 1)' || E'\n';
    reset role;
  exception when others then out := out || '29ua ERROR ' || sqlerrm || E'\n'; end;
  begin
    perform set_config('request.jwt.claims', json_build_object('sub', a, 'role', 'authenticated', 'aal', 'aal1', 'session_id', sg, 'client_id', oc_a)::text, true);
    set local role authenticated;
    insert into public.launch_requests (device_id, task_id, agent, requested_via) values (dev, tid, 'claude', 'web') returning id into req_ag;
    select count(*) into n from public.launch_requests where id = req_ag and requested_via = 'agent' and not fresh_code;
    out := out || '29ub agent asked a computer that takes requests without a code, marked as an agent''s=' || n || ' (want 1)' || E'\n';
    select count(*) into n from public.launch_requests; out := out || '29uc agent reads only its own requests=' || n || ' (want 1)' || E'\n';
    update public.launch_requests set status = 'denied' where id = req_ag;
    get diagnostics n = row_count; out := out || '29ud agent settled its own request=' || n || ' (want 0)' || E'\n';
    reset role;
  exception when others then out := out || '29ub ERROR ' || sqlerrm || E'\n'; end;
  begin
    perform set_config('request.jwt.claims', json_build_object('sub', a, 'role', 'authenticated', 'aal', 'aal1', 'session_id', sg, 'client_id', oc_a)::text, true);
    set local role authenticated;
    insert into public.launch_requests (device_id, task_id, agent, kind, target_session_id, changes) values (dev, tid, 'claude', 'changes', sid, 'Red');
    out := out || '29ue FAIL an agent sent a session back with changes' || E'\n';
    reset role;
  exception when others then out := out || '29ue agent sending changes refused: ' || left(sqlerrm, 50) || E'\n'; end;
  begin
    perform set_config('request.jwt.claims', claims_aal2_old, true); set local role authenticated;
    update public.devices set remote_code = true where id = dev;
    delete from public.launch_requests where id = req_ag;
    get diagnostics n = row_count; out := out || '29uf code back on, the agent''s request deleted=' || n || ' (want 1)' || E'\n';
    reset role;
  exception when others then out := out || '29uf ERROR ' || sqlerrm || E'\n'; end;
  begin
    perform set_config('request.jwt.claims', json_build_object('sub', a, 'role', 'authenticated', 'aal', 'aal1', 'session_id', sg, 'client_id', oc_a)::text, true);
    set local role authenticated;
    insert into public.launch_requests (device_id, task_id, agent) values (dev, tid, 'claude');
    out := out || '29ug FAIL an agent asked a computer that asks for a code' || E'\n';
    reset role;
  exception when others then out := out || '29ug code back on, agent refused: ' || left(sqlerrm, 50) || E'\n'; end;

  -- 32. a folder asked for from elsewhere: a suggestion to one signed-in computer of the account, which alone settles it,
  --     once; an agent's is marked as one, and the agent reads its own only
  begin
    perform set_config('request.jwt.claims', json_build_object('sub', a, 'role', 'authenticated', 'aal', 'aal1', 'session_id', sg, 'client_id', oc_a)::text, true);
    set local role authenticated;
    insert into public.folder_requests (device_id, area_id, folder, requested_via) values (dev, area_a, '/home/me/code/work', 'web') returning id into freq;
    select count(*) into n from public.folder_requests where id = freq and requested_via = 'agent' and status = 'pending';
    out := out || '32 agent asked a computer for a folder, marked as an agent''s=' || n || ' (want 1)' || E'\n';
    update public.folder_requests set status = 'done' where id = freq;
    get diagnostics n = row_count; out := out || '32a agent settled it=' || n || ' (want 0)' || E'\n';
    reset role;
  exception when others then out := out || '32 ERROR ' || sqlerrm || E'\n'; end;
  begin
    perform set_config('request.jwt.claims', claims_aal2_old, true); set local role authenticated;
    insert into public.folder_requests (device_id, area_id, task_id, folder) values (dev, area_a, tid, '/home/me/code');
    out := out || '32b FAIL a folder request for two things at once' || E'\n';
    reset role;
  exception when others then out := out || '32b two targets rejected: ' || left(sqlerrm, 50) || E'\n'; end;
  begin
    perform set_config('request.jwt.claims', claims_aal2_old, true); set local role authenticated;
    insert into public.folder_requests (device_id, area_id, folder) values (dev, area_a, E'/home/me\ncode');
    out := out || '32c FAIL a folder with a line break' || E'\n';
    reset role;
  exception when others then out := out || '32c line break rejected: ' || left(sqlerrm, 50) || E'\n'; end;
  begin
    perform set_config('request.jwt.claims', claims_aal2_old, true); set local role authenticated;
    insert into public.folder_requests (device_id, area_id, folder) values (gen_random_uuid(), area_a, '/home/me/code');
    out := out || '32d FAIL a folder asked of a computer that isn''t the account''s' || E'\n';
    reset role;
  exception when others then out := out || '32d unknown computer refused: ' || left(sqlerrm, 50) || E'\n'; end;
  begin
    perform set_config('request.jwt.claims', claims_a2_old, true); set local role authenticated;
    update public.folder_requests set status = 'done' where id = freq;
    out := out || '32e FAIL another sign-in of the account settled a computer''s folder request' || E'\n';
    reset role;
  exception when others then out := out || '32e another sign-in settling refused: ' || left(sqlerrm, 50) || E'\n'; end;
  begin
    perform set_config('request.jwt.claims', claims_b_old, true); set local role authenticated;
    select count(*) into n from public.folder_requests; out := out || '32f other account sees folder requests=' || n || ' (want 0)' || E'\n';
    insert into public.folder_requests (device_id, area_id, folder) values (dev, area_a, '/home/them');
    out := out || '32g FAIL another account asked this account''s computer for a folder' || E'\n';
    reset role;
  exception when others then out := out || '32g other account refused: ' || left(sqlerrm, 50) || E'\n'; end;
  begin
    perform set_config('request.jwt.claims', claims_aal1, true); set local role authenticated;
    insert into public.folder_requests (device_id, area_id, folder) values (dev, area_a, '/home/me/code');
    out := out || '32h FAIL a password-only session asked for a folder' || E'\n';
    reset role;
  exception when others then out := out || '32h password-only session refused: ' || left(sqlerrm, 50) || E'\n'; end;
  begin
    perform set_config('request.jwt.claims', claims_aal2_old, true); set local role authenticated;
    update public.folder_requests set status = 'done', note = 'Set' where id = freq;
    get diagnostics n = row_count; out := out || '32i the computer settled it=' || n || ' (want 1)' || E'\n';
    reset role;
  exception when others then out := out || '32i ERROR ' || sqlerrm || E'\n'; end;
  begin
    perform set_config('request.jwt.claims', claims_aal2_old, true); set local role authenticated;
    update public.folder_requests set status = 'refused' where id = freq;
    out := out || '32j FAIL a folder request decided twice' || E'\n';
    reset role;
  exception when others then out := out || '32j deciding again refused: ' || left(sqlerrm, 50) || E'\n'; end;
  begin
    perform set_config('request.jwt.claims', json_build_object('sub', a, 'role', 'authenticated', 'aal', 'aal1', 'session_id', sg, 'client_id', oc_a)::text, true);
    set local role authenticated;
    perform public.register_device('agent computer', 'linux');
    out := out || '29v FAIL an agent registered a computer' || E'\n';
    reset role;
  exception when others then out := out || '29v agent registering a computer refused: ' || left(sqlerrm, 50) || E'\n'; end;
  begin
    perform set_config('request.jwt.claims', json_build_object('sub', a, 'role', 'authenticated', 'aal', 'aal1', 'session_id', sg, 'client_id', oc_a)::text, true);
    set local role authenticated;
    perform public.approve_agent_login('authz-test-c');
    out := out || '29w FAIL an agent approved another agent' || E'\n';
    reset role;
  exception when others then out := out || '29w agent approving agents refused: ' || left(sqlerrm, 50) || E'\n'; end;
  -- An agent's own OAuth sign-in that verified a code (aal2, fresh totp) still isn't a person's two-factor session.
  update auth.sessions set aal = 'aal2', factor_id = fa where id = sg;
  begin
    perform set_config('request.jwt.claims', json_build_object('sub', a, 'role', 'authenticated', 'aal', 'aal2', 'session_id', sg, 'client_id', oc_a,
      'amr', json_build_array(json_build_object('method', 'totp', 'timestamp', now_s - 10)))::text, true);
    set local role authenticated;
    perform public.delete_account();
    out := out || '29x FAIL an agent deleted the account' || E'\n';
    reset role;
  exception when others then out := out || '29x agent with a verified code deleting the account refused: ' || left(sqlerrm, 40) || E'\n'; end;
  begin
    perform set_config('request.jwt.claims', json_build_object('sub', a, 'role', 'authenticated', 'aal', 'aal2', 'session_id', sg, 'client_id', oc_a,
      'amr', json_build_array(json_build_object('method', 'totp', 'timestamp', now_s - 10)))::text, true);
    set local role authenticated;
    insert into public.launch_requests (device_id, task_id, agent) values (dev, tid, 'claude');
    out := out || '29xa FAIL an agent with a verified code asked a computer to start a session' || E'\n';
    reset role;
  exception when others then out := out || '29xa agent with a verified code starting a session refused: ' || left(sqlerrm, 30) || E'\n'; end;
  begin
    perform set_config('request.jwt.claims', json_build_object('sub', a, 'role', 'authenticated', 'aal', 'aal2', 'session_id', sg, 'client_id', oc_a,
      'amr', json_build_array(json_build_object('method', 'totp', 'timestamp', now_s - 10)))::text, true);
    set local role authenticated;
    perform public.approve_agent_login('authz-test-c');
    out := out || '29xb FAIL an agent with a verified code approved an agent' || E'\n';
    reset role;
  exception when others then out := out || '29xb agent with a verified code approving refused: ' || left(sqlerrm, 40) || E'\n'; end;
  update auth.sessions set aal = 'aal1', factor_id = null where id = sg;
  -- Raced: two sign-ins of the same client in the window of one approval. Neither counts, and both are signed out.
  begin
    perform set_config('request.jwt.claims', claims_aal2_old, true); set local role authenticated;
    perform public.approve_agent_login('authz-test-c');
    reset role;
  exception when others then out := out || '29y ERROR ' || sqlerrm || E'\n'; end;
  delete from auth.oauth_authorizations where authorization_id = 'authz-test-c';
  begin
    perform set_config('request.jwt.claims', json_build_object('sub', a, 'role', 'authenticated', 'aal', 'aal1', 'session_id', sc1, 'client_id', oc_c)::text, true);
    set local role authenticated;
    select public.claim_agent_login() into ok; out := out || '29y one of two raced sign-ins claims the approval=' || ok || ' (want false)' || E'\n';
    reset role;
  exception when others then out := out || '29y ERROR ' || sqlerrm || E'\n'; end;
  select count(*) into n from auth.sessions where id in (sc1, sc2); out := out || '29ya raced sign-ins left=' || n || ' (want 0)' || E'\n';
  select count(*) into n from public.agent_logins where client_id = oc_c; out := out || '29yb raced approval left=' || n || ' (want 0)' || E'\n';
  begin
    perform set_config('request.jwt.claims', claims_b_old, true); set local role authenticated;
    select count(*) into n from public.agent_logins; out := out || '29z another account sees approvals=' || n || ' (want 0)' || E'\n';
    perform public.revoke_agent_login(login);
    out := out || '29za FAIL another account disconnected the agent' || E'\n';
    reset role;
  exception when others then out := out || '29za other account disconnecting refused: ' || left(sqlerrm, 50) || E'\n'; end;
  begin
    perform set_config('request.jwt.claims', claims_aal2_old, true); set local role authenticated;
    select count(*) into n from public.connected_agents() c where c.claimed_at is not null;
    out := out || '29zb connected agents while it is signed in=' || n || ' (want 1)' || E'\n';
    perform public.revoke_agent_login(login);
    perform set_config('request.jwt.claims', json_build_object('sub', a, 'role', 'authenticated', 'aal', 'aal1', 'session_id', sg, 'client_id', oc_a)::text, true);
    select count(*) into n from public.areas; out := out || '29zc disconnected agent sees areas=' || n || ' (want 0)' || E'\n';
    reset role;
  exception when others then out := out || '29zb ERROR ' || sqlerrm || E'\n'; end;
  select count(*) into n from auth.sessions where id in (sg, sg_early, sg_late);
  out := out || '29zd sign-ins of the disconnected agent left=' || n || ' (want 0)' || E'\n';
  begin
    perform set_config('request.jwt.claims', json_build_object('sub', a, 'role', 'authenticated', 'aal', 'aal1', 'session_id', sg_x, 'client_id', oc_x)::text, true);
    set local role authenticated;
    perform public.connected_agents();
    out := out || '29ze FAIL an agent read the connected agents' || E'\n';
    reset role;
  exception when others then out := out || '29ze agent reading connected agents refused: ' || left(sqlerrm, 50) || E'\n'; end;

  -- 25. a computer that signs out stops being the default, can't become it again, and takes no requests
  begin
    perform set_config('request.jwt.claims', claims_aal2_old, true); set local role authenticated;
    update public.devices set is_default = true where id = dev2;
    perform public.revoke_device(dev2);
    select count(*) into n from public.devices where is_default; out := out || '25 defaults after signing the default out=' || n || ' (want 0)' || E'\n';
    reset role;
  exception when others then out := out || '25 ERROR ' || sqlerrm || E'\n'; end;
  begin
    perform set_config('request.jwt.claims', claims_aal2_old, true); set local role authenticated;
    update public.devices set is_default = true where id = dev2;
    out := out || '25a FAIL a signed-out computer became the default' || E'\n';
    reset role;
  exception when others then out := out || '25a signed-out default refused: ' || left(sqlerrm, 60) || E'\n'; end;
  begin
    perform set_config('request.jwt.claims', claims_aal2_fresh, true); set local role authenticated;
    insert into public.launch_requests (device_id, task_id, agent) values (dev2, tid, 'claude');
    out := out || '25b FAIL a request for a signed-out computer accepted' || E'\n';
    reset role;
  exception when others then out := out || '25b signed-out computer refused: ' || left(sqlerrm, 60) || E'\n'; end;

  -- 12. revoking the device ends its session at once
  begin
    perform set_config('request.jwt.claims', claims_aal2_old, true); set local role authenticated;
    perform public.revoke_device(dev);
    select count(*) into n from public.areas;
    out := out || '12 after revoking own device, areas visible=' || n || ' (want 0)' || E'\n';
    reset role;
  exception when others then out := out || '12 ERROR ' || sqlerrm || E'\n'; end;
  select count(*) into n from auth.sessions where id = sa; out := out || '12b auth session rows left=' || n || ' (want 0)' || E'\n';

  -- 13. delete_account with a fresh code removes the account and everything in it
  begin
    perform set_config('request.jwt.claims', json_build_object('sub', b, 'role', 'authenticated', 'aal', 'aal2', 'session_id', sb,
      'amr', json_build_array(json_build_object('method', 'totp', 'timestamp', now_s - 10)))::text, true);
    set local role authenticated;
    perform public.delete_account();
    reset role;
    select count(*) into n from public.areas where user_id = b; out := out || '13 after delete_account, areas left=' || n || ' (want 0)' || E'\n';
    select count(*) into n from auth.users where id = b; out := out || '13b account rows left=' || n || ' (want 0)' || E'\n';
  exception when others then out := out || '13 ERROR ' || sqlerrm || E'\n'; end;

  -- Task-note request behavioral checks live in task_notes.sql; keep its RLS boundary in the main audit too.
  select count(*) into n from pg_policies where schemaname = 'public' and tablename = 'task_note_requests' and permissive = 'RESTRICTIVE';
  out := out || '26 task-note restrictive policies=' || n || ' (want 3)' || E'\n';
  select count(*) into n from pg_class where oid = 'public.task_note_requests'::regclass and relrowsecurity;
  out := out || '26b task-note RLS=' || n || ' (want 1)' || E'\n';
  raise exception E'RESULTS (rolled back)\n%', out;
end
$test$;
