-- Signing in through your organisation (supabase/migrations/*_issuer_sign_in.sql). Run as postgres after all
-- migrations. Assertions fail the transaction on a regression; all fixtures are rolled back on success.
-- This exercises PostgreSQL rules only; the token's signature and the session it makes are the app's
-- (tests/sso.test.ts) and Supabase Auth's.
begin;
do $test$
declare
  issuer text := 'https://issuer.example.invalid';
  person text := '6f0c1b9e-3c3a-4d55-9a57-1f1d1e7b0a01';
  other_person text := '6f0c1b9e-3c3a-4d55-9a57-1f1d1e7b0a02';
  account uuid := gen_random_uuid(); other_account uuid := gen_random_uuid(); unconfirmed uuid := gen_random_uuid();
  trusted uuid := gen_random_uuid(); plain uuid := gen_random_uuid(); old_session uuid := gen_random_uuid();
  agent uuid := gen_random_uuid(); foreign_session uuid := gen_random_uuid();
  factor uuid := gen_random_uuid(); client uuid := gen_random_uuid(); device uuid := gen_random_uuid();
  own_area uuid; task bigint; answer jsonb; obj text; ok boolean; n integer; op text;
  trusted_claims text; plain_claims text;
  epoch bigint := extract(epoch from now())::bigint;
  checks integer := 0;
begin
  insert into auth.users (instance_id, id, aud, role, email, encrypted_password, email_confirmed_at,
    raw_app_meta_data, raw_user_meta_data, created_at, updated_at)
  values ('00000000-0000-0000-0000-000000000000', account, 'authenticated', 'authenticated',
    'person@org.example.invalid', '', now(), '{}', '{}', now(), now()),
    ('00000000-0000-0000-0000-000000000000', other_account, 'authenticated', 'authenticated',
    'someone-else@org.example.invalid', '', now(), '{}', '{}', now(), now()),
    ('00000000-0000-0000-0000-000000000000', unconfirmed, 'authenticated', 'authenticated',
    'squatted@org.example.invalid', 'a password of theirs', null, '{}', '{}', now(), now());
  -- The account already uses PacedMind's own authenticator: an aal1 session of it is not a two-factor session.
  insert into auth.mfa_factors(id, user_id, friendly_name, factor_type, status, created_at, updated_at, secret)
    values (factor, account, 'Phone', 'totp', 'verified', now() - interval '1 day', now(), 'x');
  insert into auth.sessions(id, user_id, created_at, updated_at, aal)
    values (trusted, account, now(), now(), 'aal1'), (plain, account, now(), now(), 'aal1'),
      (old_session, account, now() - interval '1 hour', now(), 'aal1'),
      (foreign_session, other_account, now(), now(), 'aal1');
  select id into own_area from public.areas where user_id = account and key = 'WRK';

  -- 1. Only the server's secret key reaches the functions that make and mark these sessions; no client reads or
  --    writes the state behind them.
  foreach op in array array['anon', 'authenticated'] loop
    foreach obj in array array['public.issuer_claim_token(text, timestamptz)', 'public.issuer_link_account(text, text, text)',
        'public.issuer_mark_session(uuid, uuid, text, text, timestamptz)'] loop
      if has_function_privilege(op, obj, 'EXECUTE') then raise exception '% may call %', op, obj; end if;
      checks := checks + 1;
    end loop;
    foreach obj in array array['private.issuer_identities', 'private.issuer_tokens', 'private.issuer_sessions'] loop
      if has_table_privilege(op, obj, 'SELECT') or has_table_privilege(op, obj, 'INSERT')
        or has_table_privilege(op, obj, 'UPDATE') or has_table_privilege(op, obj, 'DELETE') then
        raise exception '% may touch %', op, obj;
      end if;
      checks := checks + 1;
    end loop;
  end loop;
  if has_function_privilege('anon', 'public.issuer_session()', 'EXECUTE')
    or not has_function_privilege('authenticated', 'public.issuer_session()', 'EXECUTE')
    or not has_function_privilege('service_role', 'public.issuer_mark_session(uuid, uuid, text, text, timestamptz)', 'EXECUTE') then
    raise exception 'Wrong grants on the issuer functions';
  end if;
  checks := checks + 1;
  perform set_config('request.jwt.claims', jsonb_build_object('sub', account, 'role', 'authenticated', 'session_id', plain, 'aal', 'aal1')::text, true);
  set local role authenticated;
  begin
    perform public.issuer_mark_session(plain, account, issuer, person, now());
    raise exception 'A signed-in browser marked its own session';
  exception when insufficient_privilege then checks := checks + 1; end;
  begin
    insert into private.issuer_sessions(session_id, user_id, issuer, subject, verified_at) values (plain, account, issuer, person, now());
    raise exception 'A signed-in browser wrote the session marker';
  exception when insufficient_privilege then checks := checks + 1; end;
  reset role;

  -- 2. Each token signs in once; expired or overlong ones are refused outright.
  set local role service_role;
  if not public.issuer_claim_token('6a1d3c2e-0000-4000-8000-000000000001', now() + interval '2 minutes') then
    raise exception 'A new token was refused';
  end if;
  if public.issuer_claim_token('6a1d3c2e-0000-4000-8000-000000000001', now() + interval '2 minutes') then
    raise exception 'A token signed in twice';
  end if;
  checks := checks + 2;
  foreach answer in array array[jsonb_build_object('jti', 'x y', 'in', 60), jsonb_build_object('jti', 'late', 'in', -1),
      jsonb_build_object('jti', 'forever', 'in', 3600)] loop
    begin
      perform public.issuer_claim_token(answer ->> 'jti', now() + make_interval(secs => (answer ->> 'in')::int));
      raise exception 'Accepted token %', answer;
    exception when invalid_parameter_value then checks := checks + 1; end;
  end loop;

  -- 3. Accounts: none with the email asks the app to create one; a confirmed one is linked; the link then wins over
  --    the email and never moves; an unconfirmed one is never linked; an account takes one person per issuer.
  if public.issuer_link_account(issuer, person, 'nobody@org.example.invalid') <> jsonb_build_object('user_id', null) then
    raise exception 'An unknown email did not ask for a new account';
  end if;
  reset role;
  if exists (select 1 from private.issuer_identities) then raise exception 'An unknown email left a link'; end if;
  set local role service_role;
  if public.issuer_link_account(issuer, person, 'Person@Org.example.invalid') <> jsonb_build_object('user_id', account) then
    raise exception 'The account with that email was not linked';
  end if;
  if public.issuer_link_account(issuer, person, 'someone-else@org.example.invalid') <> jsonb_build_object('user_id', account) then
    raise exception 'A link moved to another account';
  end if;
  if public.issuer_link_account(issuer, other_person, 'person@org.example.invalid') <> jsonb_build_object('refused', 'account_linked') then
    raise exception 'A second person of the issuer took a linked account';
  end if;
  if public.issuer_link_account(issuer, other_person, 'squatted@org.example.invalid') <> jsonb_build_object('refused', 'account_unconfirmed') then
    raise exception 'An unconfirmed account was linked';
  end if;
  begin
    perform public.issuer_link_account(issuer, person, 'not an email');
    raise exception 'Linked a malformed email';
  exception when invalid_parameter_value then checks := checks + 1; end;
  checks := checks + 5;

  -- 4. Marking: only a brand-new, live session of the linked account, with a recent check, once.
  foreach op in array array[
    format('select public.issuer_mark_session(%L, %L, %L, %L, now())', foreign_session, account, issuer, person),
    format('select public.issuer_mark_session(%L, %L, %L, %L, now())', foreign_session, other_account, issuer, person),
    format('select public.issuer_mark_session(%L, %L, %L, %L, now())', old_session, account, issuer, person),
    format('select public.issuer_mark_session(%L, %L, %L, %L, now())', gen_random_uuid(), account, issuer, person)
  ] loop
    begin
      execute op;
      raise exception 'Marked a session it must not: %', op;
    exception when insufficient_privilege then checks := checks + 1; end;
  end loop;
  begin
    perform public.issuer_mark_session(trusted, account, issuer, person, now() - interval '10 minutes');
    raise exception 'Marked with a stale check';
  exception when invalid_parameter_value then checks := checks + 1; end;
  perform public.issuer_mark_session(trusted, account, issuer, person, now() + interval '30 seconds');
  reset role;
  if (select verified_at from private.issuer_sessions where session_id = trusted) > now() then
    raise exception 'A check was recorded in the future';
  end if;
  set local role service_role;
  begin
    perform public.issuer_mark_session(trusted, account, issuer, person, now());
    raise exception 'Marked the same session twice';
  exception when unique_violation then checks := checks + 1; end;
  checks := checks + 1;
  reset role;

  -- 5. The marked session is a two-factor session for planning, computers and fresh codes; the account's other
  --    aal1 session is not.
  insert into auth.oauth_clients(id, registration_type, redirect_uris, grant_types, client_name, client_type, token_endpoint_auth_method)
    values (client, 'dynamic', 'http://localhost:1/callback', 'authorization_code,refresh_token', 'Agent', 'public', 'none');
  insert into auth.oauth_authorizations(id, authorization_id, client_id, user_id, redirect_uri, scope, status, created_at, expires_at)
    values (gen_random_uuid(), 'issuer-consent', client, account, 'http://localhost:1/callback', 'email', 'pending', now(), now() + interval '3 minutes');
  trusted_claims := jsonb_build_object('sub', account, 'role', 'authenticated', 'session_id', trusted, 'aal', 'aal1',
    'amr', jsonb_build_array(jsonb_build_object('method', 'otp', 'timestamp', epoch)))::text;
  plain_claims := (trusted_claims::jsonb || jsonb_build_object('session_id', plain))::text;
  perform set_config('request.jwt.claims', trusted_claims, true);
  set local role authenticated;
  if not (private.session_ok() and private.planner_session_ok() and private.computer_session_ok()
          and public.can_control_computers() and private.recent_mfa(300)) then
    raise exception 'The session made through the issuer is not a two-factor session';
  end if;
  if public.issuer_session() is null then raise exception 'The app cannot see its own session is made through the issuer'; end if;
  select count(*) into n from public.areas;
  if n <> 5 then raise exception 'The session made through the issuer cannot read its planner'; end if;
  insert into public.tasks(key, area_id, title, created_at, updated_at)
    values ('', own_area, 'Through the issuer', '2026-11-26T10:00:00', '2026-11-26T10:00:00') returning id into task;
  device := public.register_device('Work laptop', 'macos');
  insert into public.launch_requests(device_id, task_id, agent) values (device, task, 'claude');
  if not (select fresh_code from public.launch_requests where device_id = device) then
    raise exception 'A fresh round-trip through the issuer did not count as a fresh code';
  end if;
  if not (select mfa_approved from public.agent_logins
          where id = (public.approve_agent_login('issuer-consent') ->> 'login')::uuid) then
    raise exception 'An approval from the issuer session lost its two-factor assurance';
  end if;
  checks := checks + 6;
  perform set_config('request.jwt.claims', plain_claims, true);
  if private.session_ok() or private.planner_session_ok() or private.computer_session_ok() or private.recent_mfa(300)
    or public.issuer_session() is not null then
    raise exception 'Another aal1 session of the account borrowed the issuer''s trust';
  end if;
  select count(*) into n from public.tasks;
  if n <> 0 then raise exception 'An unmarked aal1 session read an enrolled account'; end if;
  checks := checks + 2;
  -- Another account's token naming the marked session gets nothing from it.
  perform set_config('request.jwt.claims', (trusted_claims::jsonb || jsonb_build_object('sub', other_account))::text, true);
  if private.session_ok() or public.issuer_session() is not null then raise exception 'Another account used the marked session'; end if;
  checks := checks + 1;
  reset role;

  -- 6. The check goes stale after five minutes: still a two-factor session, no longer a fresh code.
  update private.issuer_sessions set verified_at = now() - interval '6 minutes' where session_id = trusted;
  perform set_config('request.jwt.claims', trusted_claims, true);
  set local role authenticated;
  if private.recent_mfa(300) or not private.session_ok() then raise exception 'Issuer freshness is wrong'; end if;
  begin
    perform public.delete_account();
    raise exception 'A stale issuer check deleted the account';
  exception when insufficient_privilege then checks := checks + 1; end;
  checks := checks + 1;
  reset role;

  -- 7. An agent's OAuth sign-in is never the person's session, even when it names the marked session.
  insert into auth.sessions(id, user_id, created_at, updated_at, aal, oauth_client_id) values (agent, account, now(), now(), 'aal1', client);
  perform set_config('request.jwt.claims', (trusted_claims::jsonb || jsonb_build_object('client_id', client))::text, true);
  set local role authenticated;
  if private.session_ok() or private.planner_session_ok() or private.recent_mfa(300) or public.issuer_session() is not null then
    raise exception 'An OAuth token borrowed the issuer session';
  end if;
  checks := checks + 1;
  reset role;

  -- 8. The trust ends with the session, and with the link.
  set local role service_role;
  perform public.issuer_mark_session(plain, account, issuer, person, now());
  reset role;
  perform set_config('request.jwt.claims', plain_claims, true);
  set local role authenticated;
  if not private.session_ok() then raise exception 'Fixture: the second session was not marked'; end if;
  reset role;
  delete from auth.sessions where id = plain;
  set local role authenticated;
  if private.session_ok() or public.issuer_session() is not null then raise exception 'An ended session stayed trusted'; end if;
  reset role;
  delete from private.issuer_identities where user_id = account;
  if exists (select 1 from private.issuer_sessions) then raise exception 'Unlinking left session markers'; end if;
  perform set_config('request.jwt.claims', trusted_claims, true);
  set local role authenticated;
  if private.session_ok() or public.can_control_computers() then raise exception 'An unlinked session stayed trusted'; end if;
  reset role;
  checks := checks + 3;

  raise notice 'Issuer sign-in: % assertions passed (fixtures rolled back).', checks;
end $test$;
rollback;
