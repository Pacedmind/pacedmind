begin;
do $test$
declare
  account uuid := gen_random_uuid(); outsider uuid := gen_random_uuid();
  human uuid := gen_random_uuid(); project uuid; foreign_project uuid; area uuid;
  copy uuid; task bigint; before_task jsonb; changed integer;
begin
  insert into auth.users(instance_id, id, aud, role, email, encrypted_password, email_confirmed_at, raw_app_meta_data, raw_user_meta_data, created_at, updated_at)
    values ('00000000-0000-0000-0000-000000000000', account, 'authenticated', 'authenticated', 'hidden@example.invalid', '', now(), '{}', '{}', now(), now()),
           ('00000000-0000-0000-0000-000000000000', outsider, 'authenticated', 'authenticated', 'hidden-other@example.invalid', '', now(), '{}', '{}', now(), now());
  insert into auth.sessions(id, user_id, created_at, updated_at, aal)
    values(human, account, now(), now(), 'aal1');
  select id into area from public.areas where user_id = account limit 1;
  insert into public.projects(user_id, area_id, name) values(account, area, 'Later') returning id into project;
  insert into public.projects(user_id, area_id, name)
    select outsider, id, 'Private' from public.areas where user_id = outsider limit 1 returning id into foreign_project;
  insert into public.tasks(user_id, project_id, area_id, key, title, due_date, created_at, updated_at)
    values(account, project, area, '', 'Preserved task', '2026-12-01', '2026-10-22T10:00:00', '2026-10-22T10:00:00') returning id into task;
  select to_jsonb(t) into before_task from public.tasks t where id = task;

  perform set_config('request.jwt.claims', jsonb_build_object('sub', account, 'session_id', human, 'role', 'authenticated', 'aal', 'aal1')::text, true);
  set local role authenticated;
  if (select hidden from public.projects where id = project) is distinct from false then raise exception 'Existing projects must start visible'; end if;
  update public.projects set hidden = true where id = project;
  if (select hidden from public.projects where id = project) is distinct from true then raise exception 'Hiding failed'; end if;
  update public.projects set hidden = true where id = foreign_project;
  get diagnostics changed = row_count;
  if changed <> 0 then raise exception 'A project in another account was changed'; end if;
  if (select to_jsonb(t) from public.tasks t where id = task) is distinct from before_task then raise exception 'Hiding changed task data'; end if;

  copy := public.save_account_copy('empty');
  update public.projects set hidden = false where id = project;
  perform public.restore_account_copy(copy);
  if (select hidden from public.projects where id = project) is distinct from true then raise exception 'Copy lost hidden state'; end if;
  if (select to_jsonb(t) from public.tasks t where id = task) is distinct from before_task then raise exception 'Copy lost task data'; end if;
  update public.projects set hidden = false where id = project;
  if (select hidden from public.projects where id = project) is distinct from false then raise exception 'Restoring failed'; end if;
  reset role;
end $test$;
rollback;
