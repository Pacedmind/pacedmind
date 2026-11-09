-- Team members can read chosen profile pictures, and task attribution survives ordinary changes.
begin;
do $test$
declare
  owner uuid := gen_random_uuid(); member uuid := gen_random_uuid(); outsider uuid := gen_random_uuid();
  owner_session uuid := gen_random_uuid(); member_session uuid := gen_random_uuid(); outsider_session uuid := gen_random_uuid();
  owner_claims text; member_claims text; outsider_claims text;
  ws uuid; area uuid; task bigint; invite text;
  google_photo text := 'https://lh3.googleusercontent.com/a/member=s96-c';
  png text := 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+X2ioAAAAASUVORK5CYII=';
  avatar jsonb;
begin
  insert into auth.users (instance_id, id, aud, role, email, encrypted_password, email_confirmed_at, raw_app_meta_data, raw_user_meta_data, created_at, updated_at)
  values
    ('00000000-0000-0000-0000-000000000000', owner, 'authenticated', 'authenticated', 'owner@people.invalid', '', now(), '{}', '{}', now(), now()),
    ('00000000-0000-0000-0000-000000000000', member, 'authenticated', 'authenticated', 'member@people.invalid', '', now(), '{}', '{}', now(), now()),
    ('00000000-0000-0000-0000-000000000000', outsider, 'authenticated', 'authenticated', 'outsider@people.invalid', '', now(), '{}',
      '{"avatar_url":"https://lh3.googleusercontent.com/a/forged"}', now(), now());
  insert into auth.sessions (id, user_id, created_at, updated_at, aal)
  values (owner_session, owner, now(), now(), 'aal1'), (member_session, member, now(), now(), 'aal1'),
    (outsider_session, outsider, now(), now(), 'aal1');
  insert into auth.identities (user_id, provider, provider_id, identity_data, last_sign_in_at)
  values (member, 'google', member::text, jsonb_build_object('picture', google_photo), now()),
    (outsider, 'google', outsider::text, '{"picture":"https://lh3.googleusercontent.com.bad.invalid/a/forged"}', now());

  owner_claims := jsonb_build_object('sub', owner, 'role', 'authenticated', 'aal', 'aal1', 'session_id', owner_session)::text;
  member_claims := jsonb_build_object('sub', member, 'role', 'authenticated', 'aal', 'aal1', 'session_id', member_session)::text;
  outsider_claims := jsonb_build_object('sub', outsider, 'role', 'authenticated', 'aal', 'aal1', 'session_id', outsider_session)::text;
  if has_function_privilege('anon', 'public.get_profile_avatar(uuid)', 'EXECUTE')
     or has_table_privilege('authenticated', 'private.profile_avatars', 'SELECT') then
    raise exception 'Profile data was exposed outside the authorized functions';
  end if;

  perform set_config('request.jwt.claims', owner_claims, true); set local role authenticated;
  ws := public.create_workspace('People test');
  select id into strict area from public.areas where key = 'WRK' and user_id = owner;
  perform public.share_area(area, ws);
  insert into public.tasks (key, area_id, title, created_at, updated_at, author_id)
  values ('', area, 'Shared task', '2026-11-09T12:00:00', '2026-11-09T12:00:00', member) returning id into task;
  if (select author_id from public.tasks where id = task) is distinct from owner then
    raise exception 'The creator could be forged on task insertion';
  end if;
  if public.get_profile_avatar(member) is not null then raise exception 'A nonmember profile was visible'; end if;
  invite := public.invite_member(ws, 'member@people.invalid') ->> 'token';
  perform public.set_profile_avatar('initials');
  reset role;

  perform set_config('request.jwt.claims', member_claims, true); set local role authenticated;
  perform public.accept_invite(invite);
  update public.tasks set assignee_id = member where id = task;
  if not found or (select author_id from public.tasks where id = task) is distinct from owner then
    raise exception 'Assigning a teammate changed task attribution';
  end if;
  begin
    update public.tasks set author_id = member where id = task;
    raise exception 'A teammate could change the author';
  exception when insufficient_privilege then null; end;
  if public.get_profile_avatar(member) ->> 'google_url' is distinct from google_photo then
    raise exception 'The Google identity did not supply the default photo';
  end if;
  reset role;

  perform set_config('request.jwt.claims', owner_claims, true); set local role authenticated;
  if public.get_profile_avatar(member) ->> 'google_url' is distinct from google_photo then
    raise exception 'The default avatar was hidden from a teammate';
  end if;
  reset role;

  perform set_config('request.jwt.claims', member_claims, true); set local role authenticated;
  perform public.set_profile_avatar('custom', png);
  reset role;
  perform set_config('request.jwt.claims', owner_claims, true); set local role authenticated;
  avatar := public.get_profile_avatar(member);
  if avatar ->> 'source' is distinct from 'custom' or avatar ->> 'picture' is distinct from png or avatar ->> 'google_url' is not null then
    raise exception 'The custom avatar did not replace the Google photo for teammates';
  end if;
  reset role;

  perform set_config('request.jwt.claims', outsider_claims, true); set local role authenticated;
  if public.get_profile_avatar(member) is not null or public.get_profile_avatar(outsider) ->> 'google_url' is not null then
    raise exception 'An outsider or untrusted image URL passed the profile check';
  end if;
  reset role;

  perform set_config('request.jwt.claims', member_claims, true); set local role authenticated;
  perform public.set_profile_avatar('initials');
  reset role;
  perform set_config('request.jwt.claims', owner_claims, true); set local role authenticated;
  avatar := public.get_profile_avatar(member);
  if avatar ->> 'source' is distinct from 'initials' or avatar ->> 'picture' is not null or avatar ->> 'google_url' is not null then
    raise exception 'Choosing initials still exposed a photo';
  end if;
  reset role;
  perform set_config('request.jwt.claims', member_claims, true); set local role authenticated;
  perform public.set_profile_avatar('google');
  if public.get_profile_avatar(member) ->> 'google_url' is distinct from google_photo then
    raise exception 'Returning to the Google photo did not clear the override';
  end if;
  reset role;

  perform set_config('request.jwt.claims', '{}', true);
  delete from auth.users where id = owner;
  if not exists (select 1 from public.tasks where id = task and user_id = member and author_id is null and assignee_id = member)
     or exists (select 1 from private.profile_avatars where user_id = owner) then
    raise exception 'Deleting the author lost work, misattributed it or kept private profile data';
  end if;
end $test$;
rollback;
