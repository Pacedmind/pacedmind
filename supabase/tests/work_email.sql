-- A work address proves team admission on an existing account. It is neither a login nor an agent credential.
begin;
do $test$
declare
  v_owner uuid := gen_random_uuid();
  v_member uuid := gen_random_uuid();
  v_other uuid := gen_random_uuid();
  s_owner uuid := gen_random_uuid();
  s_member uuid := gen_random_uuid();
  s_other uuid := gen_random_uuid();
  c_owner text;
  c_member text;
  c_other text;
  v_team uuid;
  v_domain_team uuid;
  v_shared uuid;
  v_private uuid;
  v_invite text;
  v_old_invite text;
  v_new_invite text;
  v_code text := 'ABCDEFGHJK';
  v_digest text := encode(sha256(convert_to(v_code, 'UTF8')), 'hex');
begin
  insert into auth.users (instance_id, id, aud, role, email, encrypted_password, email_confirmed_at,
                          raw_app_meta_data, raw_user_meta_data, created_at, updated_at)
  values
    ('00000000-0000-0000-0000-000000000000', v_owner, 'authenticated', 'authenticated',
     'owner-personal@home.invalid', '', now(), '{}', '{}', now(), now()),
    ('00000000-0000-0000-0000-000000000000', v_member, 'authenticated', 'authenticated',
     'member-personal@home.invalid', '', now(), '{}', '{}', now(), now()),
    ('00000000-0000-0000-0000-000000000000', v_other, 'authenticated', 'authenticated',
     'other-personal@home.invalid', '', now(), '{}', '{}', now(), now());
  insert into auth.sessions (id, user_id, created_at, updated_at, aal)
  values (s_owner, v_owner, now(), now(), 'aal1'), (s_member, v_member, now(), now(), 'aal1'),
         (s_other, v_other, now(), now(), 'aal1');
  c_owner := jsonb_build_object('sub', v_owner, 'role', 'authenticated', 'aal', 'aal1', 'session_id', s_owner)::text;
  c_member := jsonb_build_object('sub', v_member, 'role', 'authenticated', 'aal', 'aal1', 'session_id', s_member)::text;
  c_other := jsonb_build_object('sub', v_other, 'role', 'authenticated', 'aal', 'aal1', 'session_id', s_other)::text;

  if has_function_privilege('anon', 'public.get_work_email()', 'EXECUTE')
     or has_function_privilege('authenticated', 'public.issue_work_email_code(uuid,text,text)', 'EXECUTE')
     or has_function_privilege('authenticated', 'private.issue_work_email_code(uuid,text,text)', 'EXECUTE')
     or has_table_privilege('authenticated', 'private.work_emails', 'INSERT')
     or has_table_privilege('authenticated', 'private.work_email_codes', 'SELECT') then
    raise exception 'The verification proof or its issuer is reachable by a client';
  end if;

  set local role service_role;
  if public.issue_work_email_code(v_owner, ' OWNER@team-email.invalid ', v_digest) <> 'owner@team-email.invalid' then
    raise exception 'The sender did not receive the normalized destination';
  end if;
  perform public.issue_work_email_code(v_member, 'member@team-email.invalid', v_digest);
  begin
    perform public.issue_work_email_code(v_member, 'different@team-email.invalid', v_digest);
    raise exception 'Changing the address bypassed the account cooldown';
  exception when sqlstate 'PT429' then null; end;
  reset role;

  perform set_config('request.jwt.claims', c_other, true);
  set local role authenticated;
  if public.get_work_email() ->> 'pending_email' is not null
     or public.confirm_work_email('member@team-email.invalid', v_code) <> 'expired' then
    raise exception 'Another account could read or redeem a pending code';
  end if;
  reset role;

  perform set_config('request.jwt.claims', c_owner, true);
  set local role authenticated;
  if public.confirm_work_email('owner@team-email.invalid', 'abcde-fghjk') <> 'verified' then
    raise exception 'A valid formatted code did not verify the address';
  end if;
  v_team := public.create_workspace('Team invitation');
  v_domain_team := public.create_workspace('Team domain');
  select id into v_shared from public.areas where user_id = v_owner and key = 'WRK';
  select id into v_private from public.areas where user_id = v_owner and key = 'PER';
  perform public.share_area(v_shared, v_team);
  v_invite := public.invite_member(v_team, 'member@team-email.invalid') ->> 'token';
  v_old_invite := public.invite_member(v_domain_team, 'member@team-email.invalid') ->> 'token';
  perform public.add_workspace_domain(v_domain_team, 'team-email.invalid');
  reset role;

  perform set_config('request.jwt.claims', c_member, true);
  set local role authenticated;
  if public.get_work_email() ->> 'pending_email' is distinct from 'member@team-email.invalid'
     or (public.invite_details(v_invite) ->> 'matches')::boolean
     or exists (select 1 from public.joinable_workspaces() where id = v_domain_team) then
    raise exception 'An unverified work email matched an invitation or admitted a domain member';
  end if;
  begin
    perform public.accept_invite(v_invite);
    raise exception 'An unverified work email accepted an invitation';
  exception when insufficient_privilege then null; end;
  if public.confirm_work_email('other@team-email.invalid', v_code) <> 'expired'
     or public.confirm_work_email('member@team-email.invalid', 'ZZZZZZZZZZ') <> 'wrong'
     or public.confirm_work_email('member@team-email.invalid', v_code) <> 'verified'
     or public.confirm_work_email('member@team-email.invalid', v_code) <> 'expired' then
    raise exception 'The address, code or single-use check failed';
  end if;
  if not (public.invite_details(v_invite) ->> 'matches')::boolean
     or public.accept_invite(v_invite) <> v_team
     or not exists (select 1 from public.joinable_workspaces() where id = v_domain_team) then
    raise exception 'The verified work email did not match the invitation and domain';
  end if;
  perform public.join_workspace(v_domain_team);
  if (select count(*) from public.workspace_members
      where user_id = v_member and email = 'member@team-email.invalid' and name = 'member') <> 2
     or not exists (select 1 from public.areas where id = v_shared)
     or exists (select 1 from public.areas where id = v_private) then
    raise exception 'Wrong membership address or the selected area was not isolated';
  end if;
  reset role;
  if (select email from auth.users where id = v_member) is distinct from 'member-personal@home.invalid' then
    raise exception 'Work verification changed the sign-in address';
  end if;

  perform set_config('request.jwt.claims', c_owner, true);
  set local role authenticated;
  perform public.remove_member(v_domain_team, v_member);
  reset role;
  perform set_config('request.jwt.claims', c_member, true);
  set local role authenticated;
  if exists (select 1 from public.joinable_workspaces() where id = v_domain_team)
     or public.invite_details(v_old_invite) ->> 'status' is distinct from 'revoked' then
    raise exception 'A removed member could still see an admission route';
  end if;
  begin
    perform public.join_workspace(v_domain_team);
    raise exception 'A removed member could rejoin using their confirmed work domain';
  exception when insufficient_privilege then null; end;
  begin
    perform public.accept_invite(v_old_invite);
    raise exception 'A removed member could rejoin using an older invitation';
  exception when no_data_found then null; end;
  reset role;
  perform set_config('request.jwt.claims', c_owner, true);
  set local role authenticated;
  v_new_invite := public.invite_member(v_domain_team, 'member@team-email.invalid') ->> 'token';
  reset role;
  perform set_config('request.jwt.claims', c_member, true);
  set local role authenticated;
  if public.accept_invite(v_new_invite) <> v_domain_team then raise exception 'A fresh invitation did not restore membership'; end if;
  reset role;

  set local role service_role;
  perform public.issue_work_email_code(v_other, 'member@team-email.invalid', v_digest);
  reset role;
  perform set_config('request.jwt.claims', c_other, true);
  set local role authenticated;
  if public.confirm_work_email('member@team-email.invalid', v_code) <> 'in_use' then
    raise exception 'One work email was verified on two accounts';
  end if;
  reset role;

  perform set_config('request.jwt.claims', (c_member::jsonb || jsonb_build_object('client_id', gen_random_uuid()))::text, true);
  set local role authenticated;
  begin
    perform public.get_work_email();
    raise exception 'An OAuth agent read private work-email settings';
  exception when insufficient_privilege then null; end;
  begin
    perform public.remove_work_email();
    raise exception 'An OAuth agent removed the work email';
  exception when insufficient_privilege then null; end;
  reset role;

  perform set_config('request.jwt.claims', c_member, true);
  set local role authenticated;
  perform public.remove_work_email();
  if public.get_work_email() ->> 'email' is not null then raise exception 'The removed address is still verified'; end if;
  perform public.remove_member(v_domain_team, v_member);
  if exists (select 1 from public.joinable_workspaces() where id = v_domain_team) then
    raise exception 'The removed address still authorizes admission';
  end if;
  reset role;

  update private.work_email_codes set requested_at = clock_timestamp() - interval '2 minutes' where user_id = v_other;
  set local role service_role;
  perform public.issue_work_email_code(v_other, 'other@team-email.invalid', v_digest);
  reset role;
  perform set_config('request.jwt.claims', c_other, true);
  set local role authenticated;
  for attempt in 1..4 loop
    if public.confirm_work_email('other@team-email.invalid', 'ZZZZZZZZZZ') <> 'wrong' then
      raise exception 'Incorrect response before the attempt limit';
    end if;
  end loop;
  if public.confirm_work_email('other@team-email.invalid', 'ZZZZZZZZZZ') <> 'expired'
     or public.confirm_work_email('other@team-email.invalid', v_code) <> 'expired' then
    raise exception 'An exhausted code was accepted';
  end if;
  reset role;
  update private.work_email_codes set requested_at = clock_timestamp() - interval '3 minutes' where
    user_id = v_other and email = 'other@team-email.invalid';
  set local role service_role;
  perform public.issue_work_email_code(v_other, 'late@team-email.invalid', v_digest);
  reset role;
  update private.work_email_codes set requested_at = clock_timestamp() - interval '16 minutes' where
    user_id = v_other and email = 'late@team-email.invalid';
  set local role authenticated;
  if public.confirm_work_email('late@team-email.invalid', v_code) <> 'expired' then
    raise exception 'An expired code was accepted';
  end if;
  reset role;

  set local role service_role;
  perform public.issue_work_email_code(v_other, 'owner-personal@home.invalid', v_digest);
  reset role;
  set local role authenticated;
  if public.confirm_work_email('owner-personal@home.invalid', v_code) <> 'in_use' then
    raise exception 'Another account''s sign-in address was also verified as work email';
  end if;
  reset role;

  update private.work_email_codes set requested_at = clock_timestamp() - interval '2 minutes'
  where user_id = v_member;
  insert into private.work_email_codes (user_id, email, digest, requested_at, consumed)
  select v_owner, 'limited@team-email.invalid', v_digest, clock_timestamp() - n * interval '5 minutes', true
  from generate_series(1, 5) n;
  set local role service_role;
  begin
    perform public.issue_work_email_code(v_member, ' LIMITED@TEAM-EMAIL.INVALID ', v_digest);
    raise exception 'Using another account or email casing bypassed the destination quota';
  exception when sqlstate 'PT429' then null; end;
  reset role;
end $test$;
rollback;
