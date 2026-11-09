-- Keep a task's creator separate from the account that owns its row after an account deletion.
alter table public.tasks add column author_id uuid references auth.users (id) on delete set null;
update public.tasks set author_id = user_id;
create index tasks_author_idx on public.tasks (author_id) where author_id is not null;

create function private.keep_task_author() returns trigger
language plpgsql set search_path = '' as $$
begin
  if tg_op = 'INSERT' then
    new.author_id := new.user_id;
  elsif current_user in ('authenticated', 'anon') and new.author_id is distinct from old.author_id then
    raise exception 'A task keeps its creator.' using errcode = '42501';
  end if;
  return new;
end $$;

create trigger tasks_1_author before insert or update of author_id on public.tasks
  for each row execute function private.keep_task_author();
revoke execute on function private.keep_task_author() from public, anon, authenticated, service_role;

-- The default follows the Google identity. A row overrides it with a small PNG or initials.
create table private.profile_avatars (
  user_id uuid primary key references auth.users (id) on delete cascade,
  source text not null,
  picture text,
  check (
    (source = 'initials' and picture is null) or
    (source = 'custom' and picture is not null and octet_length(picture) <= 32768
      and octet_length(picture) % 4 = 0 and picture ~ '^iVBORw0KGgo[A-Za-z0-9+/]*={0,2}$')
  )
);
alter table private.profile_avatars enable row level security;
revoke all on private.profile_avatars from public, anon, authenticated, service_role;

-- Only the owner or a current teammate can read an avatar. Only the owner can read the Google
-- picture when they have chosen a different avatar.
create function private.get_profile_avatar(person uuid) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  viewer uuid := auth.uid();
  preference text;
  png text;
  google_url text;
begin
  if viewer is null or person is null or not private.planner_session_ok() then return null; end if;
  if person <> viewer and not exists (
    select 1 from public.workspace_members mine
    join public.workspace_members teammate using (workspace_id)
    where mine.user_id = viewer and teammate.user_id = person
  ) then return null; end if;

  select a.source, a.picture into preference, png from private.profile_avatars a where a.user_id = person;
  preference := coalesce(preference, 'google');
  if preference = 'google' or person = viewer then
    select candidate.url into google_url
    from auth.identities i
    cross join lateral (values (i.identity_data ->> 'avatar_url'), (i.identity_data ->> 'picture')) candidate(url)
    where i.user_id = person and i.provider = 'google'
      and char_length(candidate.url) <= 2048 and candidate.url ~ '^https://lh[0-9]+[.]googleusercontent[.]com/'
    order by i.last_sign_in_at desc nulls last
    limit 1;
  end if;
  return jsonb_build_object('source', preference, 'picture', png, 'google_url', google_url);
end $$;

create function private.set_profile_avatar(choice text, png text) returns void
language plpgsql security definer set search_path = '' as $$
declare
  viewer uuid := auth.uid();
begin
  if viewer is null or not private.planner_session_ok() then
    raise exception 'Sign in to manage your profile picture.' using errcode = '42501';
  end if;
  if choice = 'google' then
    delete from private.profile_avatars where user_id = viewer;
  else
    insert into private.profile_avatars (user_id, source, picture) values (viewer, choice, png)
      on conflict (user_id) do update set source = excluded.source, picture = excluded.picture;
  end if;
end $$;

create function public.get_profile_avatar(person uuid) returns jsonb
language sql stable set search_path = '' as $$ select private.get_profile_avatar(person) $$;
create function public.set_profile_avatar(choice text, png text default null) returns void
language sql set search_path = '' as $$ select private.set_profile_avatar(choice, png) $$;

revoke execute on function private.get_profile_avatar(uuid), private.set_profile_avatar(text, text),
  public.get_profile_avatar(uuid), public.set_profile_avatar(text, text) from public, anon, authenticated, service_role;
grant execute on function private.get_profile_avatar(uuid), private.set_profile_avatar(text, text),
  public.get_profile_avatar(uuid), public.set_profile_avatar(text, text) to authenticated;
