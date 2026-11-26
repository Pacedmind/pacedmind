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
  agent uuid := gen_random_uuid(); foreign_session uuid := gen_random_uuid(); own_aal2 uuid := gen_random_uuid();
  twin uuid := gen_random_uuid(); twin_too uuid := gen_random_uuid();
  factor uuid := gen_random_uuid(); client uuid := gen_random_uuid(); device uuid := gen_random_uuid();
  own_area uuid; task bigint; answer jsonb; obj text; ok boolean; n integer; op text;
  trusted_claims text; plain_claims text;
  -- The random ids the browser carries from the callback to the finish (43 base64url characters, 256 bits).
  h1 text := repeat('A', 43); h2 text := repeat('B', 43); h3 text := repeat('C', 43); h4 text := repeat('D', 43);
  never_begun text := repeat('Z', 43);
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
    'squatted@org.example.invalid', 'a password of theirs', null, '{}', '{}', now(), now()),
    -- Two accounts answering to one address (Auth allows it for its own SSO users): neither is linked by email.
    ('00000000-0000-0000-0000-000000000000', twin, 'authenticated', 'authenticated',
    'twin@org.example.invalid', '', now(), '{}', '{}', now(), now()),
    ('00000000-0000-0000-0000-000000000000', twin_too, 'authenticated', 'authenticated',
    'Twin@org.example.invalid', '', now(), '{}', '{}', now(), now());
  -- The account already uses PacedMind's own authenticator: an aal1 session of it is not a two-factor session.
  insert into auth.mfa_factors(id, user_id, friendly_name, factor_type, status, created_at, updated_at, secret)
    values (factor, account, 'Phone', 'totp', 'verified', now() - interval '1 day', now(), 'x');
  insert into auth.sessions(id, user_id, created_at, updated_at, aal)
    values (trusted, account, now(), now(), 'aal1'), (plain, account, now(), now(), 'aal1'),
      (old_session, account, now() - interval '1 hour', now(), 'aal1'),
      (foreign_session, other_account, now(), now(), 'aal1');
  -- The owner's own two-factor session of the account, from before (PacedMind's code verified in it).
  insert into auth.sessions(id, user_id, created_at, updated_at, aal, factor_id)
    values (own_aal2, account, now() - interval '1 day', now(), 'aal2', factor);
  select id into own_area from public.areas where user_id = account and key = 'WRK';

  -- 1. Only the server's secret key reaches the functions that make and mark these sessions; no client reads or
  --    writes the state behind them.
  foreach op in array array['anon', 'authenticated'] loop
    foreach obj in array array['public.issuer_claim_token(text, timestamptz)', 'public.issuer_link_account(text, text, text)',
        'public.issuer_begin_handoff(text, text, text, text, uuid, timestamptz, text)', 'public.issuer_open_handoff(text)',
        'public.issuer_mark_session(uuid, text)'] loop
      if has_function_privilege(op, obj, 'EXECUTE') then raise exception '% may call %', op, obj; end if;
      checks := checks + 1;
    end loop;
    foreach obj in array array['private.issuer_identities', 'private.issuer_tokens', 'private.issuer_sessions',
        'private.issuer_handoffs'] loop
      if has_table_privilege(op, obj, 'SELECT') or has_table_privilege(op, obj, 'INSERT')
        or has_table_privilege(op, obj, 'UPDATE') or has_table_privilege(op, obj, 'DELETE') then
        raise exception '% may touch %', op, obj;
      end if;
      checks := checks + 1;
    end loop;
  end loop;
  -- Confirming a link is a signed-in person's own act, never the secret key's.
  if has_function_privilege('anon', 'public.issuer_session()', 'EXECUTE')
    or not has_function_privilege('authenticated', 'public.issuer_session()', 'EXECUTE')
    or not has_function_privilege('service_role', 'public.issuer_mark_session(uuid, text)', 'EXECUTE')
    or has_function_privilege('anon', 'public.issuer_confirm_link(text)', 'EXECUTE')
    or has_function_privilege('service_role', 'public.issuer_confirm_link(text)', 'EXECUTE')
    or not has_function_privilege('authenticated', 'public.issuer_confirm_link(text)', 'EXECUTE') then
    raise exception 'Wrong grants on the issuer functions';
  end if;
  checks := checks + 1;
  perform set_config('request.jwt.claims', jsonb_build_object('sub', account, 'role', 'authenticated', 'session_id', plain, 'aal', 'aal1')::text, true);
  set local role authenticated;
  begin
    perform public.issuer_mark_session(plain, h1);
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

  -- 3. Accounts: none with the email asks the app to create one; a confirmed one without an authenticator of its own
  --    is linked; the link then wins over the email and never moves; an account takes one person per issuer; an
  --    unconfirmed one, or an address two accounts answer to, is never linked; an account with its own authenticator
  --    is named but not linked (its owner confirms that, in 4).
  if public.issuer_link_account(issuer, person, 'nobody@org.example.invalid') <> jsonb_build_object('user_id', null) then
    raise exception 'An unknown email did not ask for a new account';
  end if;
  if public.issuer_link_account(issuer, person, 'Person@Org.example.invalid') <> jsonb_build_object('user_id', account) then
    raise exception 'The account with that email was not the one signed in to';
  end if;
  reset role;
  if exists (select 1 from private.issuer_identities) then
    raise exception 'An email linked an account that has its own authenticator, or an unknown email left a link';
  end if;
  set local role service_role;
  if public.issuer_link_account(issuer, other_person, 'someone-else@org.example.invalid') <> jsonb_build_object('user_id', other_account) then
    raise exception 'The account with that email was not linked';
  end if;
  if public.issuer_link_account(issuer, other_person, 'person@org.example.invalid') <> jsonb_build_object('user_id', other_account) then
    raise exception 'A link moved to another account';
  end if;
  if public.issuer_link_account(issuer, person, 'someone-else@org.example.invalid') <> jsonb_build_object('refused', 'account_linked') then
    raise exception 'A second person of the issuer took a linked account';
  end if;
  if public.issuer_link_account(issuer, person, 'squatted@org.example.invalid') <> jsonb_build_object('refused', 'account_unconfirmed') then
    raise exception 'An unconfirmed account was linked';
  end if;
  if public.issuer_link_account(issuer, person, 'twin@org.example.invalid') <> jsonb_build_object('refused', 'account_ambiguous') then
    raise exception 'An address two accounts answer to was linked';
  end if;
  begin
    perform public.issuer_link_account(issuer, person, 'not an email');
    raise exception 'Linked a malformed email';
  exception when invalid_parameter_value then checks := checks + 1; end;
  reset role;
  if (select count(*) from private.issuer_identities) <> 1
    or exists (select 1 from private.issuer_identities where user_id in (account, twin, twin_too, unconfirmed)) then
    raise exception 'A refused sign-in left a link';
  end if;
  checks := checks + 9;

  -- 4. From the callback to the finish: what the browser carries is only a random id, and everything the mark acts on
  --    is what the callback kept. A forged or replayed finish, a session of another account or an old one, and a
  --    person not linked yet get no mark; the owner's own two-factor session links an account with its authenticator.
  set local role service_role;
  perform public.issuer_claim_token('6a1d3c2e-0000-4000-8000-000000000011', now() + interval '2 minutes');
  perform public.issuer_claim_token('6a1d3c2e-0000-4000-8000-000000000012', now() + interval '2 minutes');
  perform public.issuer_claim_token('6a1d3c2e-0000-4000-8000-000000000013', now() + interval '2 minutes');
  foreach op in array array[
    -- A token this server never used up.
    format('select public.issuer_begin_handoff(%L, %L, %L, %L, %L, now(), %L)', h1, '6a1d3c2e-0000-4000-8000-0000000000ff', issuer, person, account, '/today'),
    -- The person goes to their own link's account only, and an account linked to someone else takes nobody new.
    format('select public.issuer_begin_handoff(%L, %L, %L, %L, %L, now(), %L)', h1, '6a1d3c2e-0000-4000-8000-000000000011', issuer, other_person, account, '/today'),
    format('select public.issuer_begin_handoff(%L, %L, %L, %L, %L, now(), %L)', h1, '6a1d3c2e-0000-4000-8000-000000000011', issuer, person, other_account, '/today')
  ] loop
    begin
      execute op;
      raise exception 'Kept a sign-in it must not: %', op;
    exception when insufficient_privilege then checks := checks + 1; end;
  end loop;
  foreach op in array array[
    format('select public.issuer_begin_handoff(%L, %L, %L, %L, %L, now() - interval ''10 minutes'', %L)', h1, '6a1d3c2e-0000-4000-8000-000000000011', issuer, person, account, '/today'),
    format('select public.issuer_begin_handoff(%L, %L, %L, %L, %L, now(), %L)', 'short', '6a1d3c2e-0000-4000-8000-000000000011', issuer, person, account, '/today'),
    format('select public.issuer_open_handoff(%L)', 'not/a/random/id')
  ] loop
    begin
      execute op;
      raise exception 'Accepted %', op;
    exception when invalid_parameter_value then checks := checks + 1; end;
  end loop;
  begin
    perform public.issuer_begin_handoff(h1, '6a1d3c2e-0000-4000-8000-000000000011', issuer, person, account, now(), 'https://elsewhere.example');
    raise exception 'Kept a sign-in that goes to another site';
  exception when check_violation then checks := checks + 1; end;
  -- The issuer's check said 30 seconds ahead: kept as now, never in the future.
  perform public.issuer_begin_handoff(h1, '6a1d3c2e-0000-4000-8000-000000000011', issuer, person, account, now() + interval '30 seconds', '/settings/account');
  begin
    perform public.issuer_begin_handoff(h4, '6a1d3c2e-0000-4000-8000-000000000011', issuer, person, account, now(), '/today');
    raise exception 'One token kept two sign-ins';
  exception when unique_violation then checks := checks + 1; end;
  reset role;
  if exists (select 1 from private.issuer_handoffs where id_digest = convert_to(h1, 'UTF8') or verified_at > now()) then
    raise exception 'The browser''s id was kept as it is, or a check in the future';
  end if;
  set local role service_role;
  -- Not opened yet: nothing to mark.
  begin
    perform public.issuer_mark_session(trusted, h1);
    raise exception 'Marked a sign-in the finish never opened';
  exception when insufficient_privilege then checks := checks + 1; end;
  if public.issuer_open_handoff(h1) <> jsonb_build_object('user_id', account, 'next', '/settings/account', 'linked', false) then
    raise exception 'Opening the sign-in answered %', public.issuer_open_handoff(h1);
  end if;
  if public.issuer_open_handoff(h1) is not null or public.issuer_open_handoff(never_begun) is not null then
    raise exception 'A sign-in opened twice, or one never kept opened';
  end if;
  checks := checks + 3;
  -- The account has its own authenticator and isn't linked: no session of it is marked yet.
  begin
    perform public.issuer_mark_session(trusted, h1);
    raise exception 'Marked a session for a person never linked to the account';
  exception when insufficient_privilege then checks := checks + 1; end;
  reset role;

  -- Only the owner's own live two-factor session of that account confirms the link.
  foreach answer in array array[
    jsonb_build_object('sub', account, 'role', 'authenticated', 'session_id', plain, 'aal', 'aal1'),
    jsonb_build_object('sub', account, 'role', 'authenticated', 'session_id', own_aal2, 'aal', 'aal2', 'client_id', client),
    jsonb_build_object('sub', other_account, 'role', 'authenticated', 'session_id', foreign_session, 'aal', 'aal2'),
    jsonb_build_object('sub', account, 'role', 'authenticated', 'session_id', gen_random_uuid(), 'aal', 'aal2')
  ] loop
    perform set_config('request.jwt.claims', answer::text, true);
    set local role authenticated;
    if public.issuer_confirm_link(h1) or public.issuer_confirm_link(never_begun) then
      raise exception 'Confirmed a link from %', answer;
    end if;
    reset role;
    checks := checks + 1;
  end loop;
  if exists (select 1 from private.issuer_identities where user_id = account) then raise exception 'A refused confirmation linked'; end if;
  perform set_config('request.jwt.claims', jsonb_build_object('sub', account, 'role', 'authenticated', 'session_id', own_aal2, 'aal', 'aal2')::text, true);
  set local role authenticated;
  if not public.issuer_confirm_link(h1) then raise exception 'The owner''s two-factor session did not confirm the link'; end if;
  reset role;
  if not exists (select 1 from private.issuer_identities where subject = person and user_id = account) then
    raise exception 'The confirmed link was not written';
  end if;
  checks := checks + 1;

  -- The finish forged or misdirected: another account's session, an old one, one that doesn't exist, a sign-in id
  -- never kept. None is marked, and the sign-in still waits for its own session.
  set local role service_role;
  foreach op in array array[
    format('select public.issuer_mark_session(%L, %L)', foreign_session, h1),
    format('select public.issuer_mark_session(%L, %L)', old_session, h1),
    format('select public.issuer_mark_session(%L, %L)', gen_random_uuid(), h1),
    format('select public.issuer_mark_session(%L, %L)', trusted, never_begun)
  ] loop
    begin
      execute op;
      raise exception 'Marked a session it must not: %', op;
    exception when insufficient_privilege then checks := checks + 1; end;
  end loop;
  perform public.issuer_mark_session(trusted, h1);
  begin
    perform public.issuer_mark_session(plain, h1);
    raise exception 'One sign-in marked two sessions';
  exception when insufficient_privilege then checks := checks + 1; end;
  reset role;
  if exists (select 1 from private.issuer_handoffs where user_id = account)
    or (select count(*) from private.issuer_sessions) <> 1
    or (select verified_at from private.issuer_sessions where session_id = trusted) > now() then
    raise exception 'The mark is not the one sign-in''s, used up once';
  end if;
  checks := checks + 1;

  -- A sign-in kept too long ago opens no more, and a check that went stale on the way marks nothing.
  set local role service_role;
  perform public.issuer_begin_handoff(h2, '6a1d3c2e-0000-4000-8000-000000000012', issuer, person, account, now(), '/today');
  perform public.issuer_begin_handoff(h3, '6a1d3c2e-0000-4000-8000-000000000013', issuer, person, account, now(), '/today');
  reset role;
  update private.issuer_handoffs set expires_at = now() - interval '1 second' where id_digest = sha256(convert_to(h2, 'UTF8'));
  set local role service_role;
  if public.issuer_open_handoff(h2) is not null then raise exception 'An expired sign-in opened'; end if;
  if public.issuer_open_handoff(h3) is null then raise exception 'Fixture: the sign-in did not open'; end if;
  reset role;
  update private.issuer_handoffs set verified_at = now() - interval '6 minutes' where id_digest = sha256(convert_to(h3, 'UTF8'));
  set local role service_role;
  begin
    perform public.issuer_mark_session(plain, h3);
    raise exception 'Marked with a stale check';
  exception when invalid_parameter_value then checks := checks + 1; end;
  checks := checks + 1;
  reset role;
  delete from private.issuer_handoffs;

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
  perform public.issuer_claim_token('6a1d3c2e-0000-4000-8000-000000000014', now() + interval '2 minutes');
  perform public.issuer_begin_handoff(h4, '6a1d3c2e-0000-4000-8000-000000000014', issuer, person, account, now(), '/today');
  if public.issuer_open_handoff(h4) ->> 'linked' <> 'true' then raise exception 'Fixture: the linked person was not seen as linked'; end if;
  perform public.issuer_mark_session(plain, h4);
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
