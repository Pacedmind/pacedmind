-- Signing in through your organisation: the hosted app verifies a short-lived identity token from one trusted issuer
-- (src/server/sso-token.ts) and then starts an ordinary session for the account. The issuer asked for its own
-- two-factor code before it issued the token, so such a session counts as a two-factor session here: for planning and
-- for computers. It counts as a fresh code only when the round-trip that made it was the fresh check: the app asked the
-- issuer for `max_age`, so the issuer signed only after a code entered that recently, and its `auth_time` (when that
-- code was entered) is under five minutes old. A plain sign-in's `auth_time` may be the start of a session the issuer
-- remembered, with no code at all, so it never counts as a fresh code, however recent.
--
-- What marks such a session is a row in private.issuer_sessions, keyed by the auth session's id. Only the hosted app's
-- server writes it, with the project's secret key, right after it made the session, and only from the sign-in its
-- callback kept on this side (private.issuer_handoffs), never from anything the browser hands back; no client can
-- read the table, write it or name another session in it, and the row stops counting the moment its session ends.

/* ---------- 1. state ---------- */

-- Which account an issuer's person is. The first sign-in links it; a link never moves to another account, and an
-- account is linked to at most one person of each issuer.
create table private.issuer_identities (
  issuer text not null check (char_length(issuer) between 1 and 300 and issuer !~ '[[:cntrl:][:space:]]'),
  subject text not null check (char_length(subject) between 1 and 255 and subject !~ '[[:cntrl:][:space:]]'),
  user_id uuid not null references auth.users (id) on delete cascade,
  linked_at timestamptz not null default now(),
  primary key (issuer, subject),
  unique (issuer, user_id)
);

-- Identity tokens already used, until they expire: each token signs in once.
create table private.issuer_tokens (
  jti text primary key check (char_length(jti) between 1 and 200 and jti !~ '[[:cntrl:][:space:]]'),
  expires_at timestamptz not null
);
create index issuer_tokens_by_expiry on private.issuer_tokens (expires_at);

-- Sessions made through the issuer. No foreign key onto auth.sessions (Supabase owns that table, as for
-- agent_logins.session_id): every check joins the live session instead, so a row whose session ended counts for
-- nothing, and session ids are never reused.
create table private.issuer_sessions (
  session_id uuid primary key,
  user_id uuid not null references auth.users (id) on delete cascade,
  issuer text not null,
  subject text not null,
  -- When the person last passed the issuer's two-factor check (the token's auth_time), never when the token was made.
  verified_at timestamptz not null,
  -- Whether the round-trip was the fresh check (max_age): only then is verified_at a code entered at that time.
  fresh boolean not null,
  foreign key (issuer, subject) references private.issuer_identities (issuer, subject) on delete cascade
);
create index issuer_sessions_by_user on private.issuer_sessions (user_id);

-- A verified sign-in on its way from the callback to /auth/sso/finish. The browser carries only a random id (256
-- bits) in a one-minute cookie, and only its digest is kept here: everything the finish acts on (the account, the
-- issuer's person, when the issuer checked them) comes from this row, written by the server right after the token
-- verified, never from anything the browser sends. Each row finishes one sign-in: opened once, used up by the mark.
create table private.issuer_handoffs (
  id_digest bytea primary key check (octet_length(id_digest) = 32),
  -- The identity token this sign-in used up (issuer_tokens), so one token makes at most one session.
  token_id text not null unique,
  user_id uuid not null references auth.users (id) on delete cascade,
  issuer text not null,
  subject text not null,
  verified_at timestamptz not null,
  fresh boolean not null,
  -- Where the browser goes afterwards; the app checks it again (safeNext) before it goes there.
  next text not null check (char_length(next) <= 300 and next ~ '^/[A-Za-z0-9/_?=&%.~-]*$' and next !~ '^//'),
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  opened_at timestamptz
);
create index issuer_handoffs_by_expiry on private.issuer_handoffs (expires_at);

alter table private.issuer_identities enable row level security;
alter table private.issuer_tokens enable row level security;
alter table private.issuer_sessions enable row level security;
alter table private.issuer_handoffs enable row level security;
revoke all on private.issuer_identities, private.issuer_tokens, private.issuer_sessions, private.issuer_handoffs
  from public, anon, authenticated, service_role;

/* ---------- 2. who counts as signed in through the issuer ---------- */

-- The mark of the session behind this request, or no row: the request's own session, still live, a person's (never an
-- agent's OAuth sign-in), made through the issuer for this very account, whose link still stands.
create function private.issuer_current() returns table (verified_at timestamptz, fresh boolean)
language sql stable security definer set search_path = '' as $$
  select i.verified_at, i.fresh
  from private.issuer_sessions i
  join auth.sessions s on s.id = i.session_id and s.user_id = i.user_id
  join private.issuer_identities l on l.issuer = i.issuer and l.subject = i.subject and l.user_id = i.user_id
  where i.session_id = nullif(auth.jwt() ->> 'session_id', '')::uuid
    and i.user_id = auth.uid()
    and nullif(auth.jwt() ->> 'client_id', '') is null
    and s.oauth_client_id is null
    and (s.not_after is null or s.not_after > now())
$$;

create function private.issuer_session_ok() returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (select 1 from private.issuer_current())
$$;

-- When the person behind this request entered the issuer's code, if the round-trip that made this session was the
-- fresh check (max_age); null otherwise.
create function private.issuer_fresh_at() returns timestamptz
language sql stable security definer set search_path = '' as $$
  select c.verified_at from private.issuer_current() c where c.fresh
$$;

/* ---------- 3. the existing checks honour it ---------- */

-- A person's two-factor session: aal2, or made through the issuer. Never an OAuth sign-in.
create or replace function private.session_ok() returns boolean
language sql stable security definer set search_path = '' as $$
  select (coalesce(auth.jwt() ->> 'aal', '') = 'aal2' or private.issuer_session_ok())
     and nullif(auth.jwt() ->> 'client_id', '') is null
     and exists (
       select 1 from auth.sessions s
       where s.id = nullif(auth.jwt() ->> 'session_id', '')::uuid
         and s.user_id = auth.uid()
         and s.oauth_client_id is null
         and (s.not_after is null or s.not_after > now())
     )
$$;

create or replace function private.planner_session_ok() returns boolean
language sql stable security definer set search_path = '' as $$
  select nullif(auth.jwt() ->> 'client_id', '') is null
    and exists (
      select 1 from auth.sessions s
      where s.id = nullif(auth.jwt() ->> 'session_id', '')::uuid
        and s.user_id = auth.uid() and s.oauth_client_id is null
        and (s.not_after is null or s.not_after > now())
    )
    and (
      auth.jwt() ->> 'aal' = 'aal2'
      or private.issuer_session_ok()
      or (coalesce(auth.jwt() ->> 'aal', 'aal1') = 'aal1' and not exists (
        select 1 from auth.mfa_factors f where f.user_id = auth.uid() and f.status = 'verified'
      ))
    )
$$;

-- Computers need an authenticator older than the sign-in, so a stolen basic session can't enroll its own. A session
-- made through the issuer had the issuer's own code checked before it existed, which nothing in this account can add.
create or replace function private.computer_session_ok() returns boolean
language sql stable security definer set search_path = '' as $$
  select private.session_ok() and (
    private.issuer_session_ok()
    or exists (
      select 1 from auth.sessions s
      join auth.mfa_factors f on f.id = s.factor_id and f.user_id = s.user_id
      where s.id = nullif(auth.jwt() ->> 'session_id', '')::uuid and s.user_id = auth.uid()
        and f.status = 'verified' and f.created_at < s.created_at
    )
  )
$$;

-- A fresh code: one from an authenticator the account had before this sign-in, entered in the last `seconds`; or, for
-- a session made through the issuer by its fresh check (max_age), the issuer's code entered that recently (auth_time).
create or replace function private.recent_mfa(seconds integer) returns boolean
language sql stable security definer set search_path = '' as $$
  select (
    exists (
      select 1
      from jsonb_array_elements(coalesce(auth.jwt() -> 'amr', '[]'::jsonb)) as a (claim)
      where a.claim ->> 'method' in ('totp', 'mfa/totp', 'webauthn', 'mfa/webauthn')
        and (a.claim ->> 'timestamp')::bigint >= extract(epoch from now())::bigint - seconds
    )
    and nullif(auth.jwt() ->> 'client_id', '') is null
    and exists (
      select 1
      from auth.sessions s
      join auth.mfa_factors f on f.id = s.factor_id and f.user_id = s.user_id
      where s.id = nullif(auth.jwt() ->> 'session_id', '')::uuid
        and s.user_id = auth.uid()
        and s.oauth_client_id is null
        and f.status = 'verified'
        and f.created_at < s.created_at
    )
  ) or coalesce(private.issuer_fresh_at() >= now() - make_interval(secs => seconds), false)
$$;

-- An agent approved from a session made through the issuer was approved under the issuer's two-factor check, which
-- stands in for the account's own authenticator as long as the account stays linked.
create or replace function private.agent_computer_ok() returns boolean
language sql stable security definer set search_path = '' as $$
  select private.agent_ok() and exists (
    select 1 from public.agent_logins l
    where l.session_id = nullif(auth.jwt() ->> 'session_id', '')::uuid
      and l.user_id = auth.uid() and l.mfa_approved
  ) and (
    exists (select 1 from auth.mfa_factors f where f.user_id = auth.uid() and f.status = 'verified')
    or exists (select 1 from private.issuer_identities l where l.user_id = auth.uid())
  )
$$;

/* ---------- 4. what the hosted app's server calls ---------- */

-- Uses up an identity token: true the first time, false when it was seen before. Expired ones are forgotten.
create function public.issuer_claim_token(token_id text, expires_at timestamptz) returns boolean
language plpgsql security definer set search_path = '' as $$
begin
  if token_id is null or token_id !~ '^[A-Za-z0-9._:-]{1,200}$' then
    raise exception 'That token id is not valid.' using errcode = '22023';
  end if;
  -- Tokens live two minutes; anything outside a generous window is not a token this app accepts.
  if expires_at is null or expires_at <= now() or expires_at > now() + interval '10 minutes' then
    raise exception 'That token is expired or lives too long.' using errcode = '22023';
  end if;
  delete from private.issuer_tokens t where t.expires_at < now();
  insert into private.issuer_tokens (jti, expires_at) values (token_id, expires_at) on conflict (jti) do nothing;
  return found;
end $$;

-- The account an issuer's person signs in to: their link when there is one (it never moves), else the account with
-- that confirmed email, which this links. Answers {"user_id": …}, {"user_id": null} when no account has the email
-- (the app then creates one and asks again), or {"refused": …}.
--
-- An account with an authenticator of its own is the account the sign-in is for, but isn't linked here: the address
-- alone would then stand in for that authenticator, so whoever controls the mailbox at the issuer would get past it.
-- Its link waits for a two-factor session of the account itself (issuer_confirm_link), and until then the sign-in
-- can't be finished (issuer_mark_session needs the link).
create function public.issuer_link_account(issuer text, subject text, email text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_user uuid;
  v_confirmed timestamptz;
  v_matches integer;
begin
  if issuer is null or subject is null or email is null or email !~ '^[^[:space:][:cntrl:]@]{1,64}@[^[:space:][:cntrl:]@]{1,253}$' then
    raise exception 'That identity is not valid.' using errcode = '22023';
  end if;
  select l.user_id into v_user from private.issuer_identities l
    where l.issuer = issuer_link_account.issuer and l.subject = issuer_link_account.subject;
  if v_user is not null then
    return jsonb_build_object('user_id', v_user);
  end if;
  select count(*) into v_matches from auth.users u where lower(u.email) = lower(issuer_link_account.email);
  if v_matches = 0 then
    return jsonb_build_object('user_id', null);
  end if;
  if v_matches > 1 then
    return jsonb_build_object('refused', 'account_ambiguous');
  end if;
  select u.id, u.email_confirmed_at into v_user, v_confirmed from auth.users u
    where lower(u.email) = lower(issuer_link_account.email);
  -- Someone may have signed up with this address and never confirmed it, keeping a password of their own. Signing in
  -- through the issuer would confirm the address and hand them the account, so such an account isn't linked.
  if v_confirmed is null then
    return jsonb_build_object('refused', 'account_unconfirmed');
  end if;
  if exists (select 1 from private.issuer_identities l
             where l.issuer = issuer_link_account.issuer and l.user_id = v_user) then
    return jsonb_build_object('refused', 'account_linked');
  end if;
  if exists (select 1 from auth.mfa_factors f where f.user_id = v_user and f.status = 'verified') then
    return jsonb_build_object('user_id', v_user);
  end if;
  insert into private.issuer_identities (issuer, subject, user_id)
    values (issuer_link_account.issuer, issuer_link_account.subject, v_user)
    on conflict do nothing;
  -- Two sign-ins of the same person at once: whichever link stands wins, and it is the only answer.
  select l.user_id into v_user from private.issuer_identities l
    where l.issuer = issuer_link_account.issuer and l.subject = issuer_link_account.subject;
  if v_user is null then
    return jsonb_build_object('refused', 'account_linked');
  end if;
  return jsonb_build_object('user_id', v_user);
end $$;

create function private.issuer_handoff_digest(handoff text) returns bytea
language plpgsql immutable set search_path = '' as $$
begin
  if handoff is null or handoff !~ '^[A-Za-z0-9_-]{43}$' then
    raise exception 'That sign-in id is not valid.' using errcode = '22023';
  end if;
  return sha256(convert_to(handoff, 'UTF8'));
end $$;

-- The callback's last step: keeps the verified sign-in under `handoff` for one minute. Only for a token this server
-- just used up and an account the person is linked to or may still be linked to. `verified_at` is the token's
-- auth_time, which for a plain sign-in may be long ago (the issuer's session started hours before); `fresh` says the
-- round-trip was the fresh check, whose code must then be under five minutes old.
create function public.issuer_begin_handoff(handoff text, token_id text, issuer text, subject text, account uuid,
  verified_at timestamptz, fresh boolean, next text) returns void
language plpgsql security definer set search_path = '' as $$
declare
  v_linked uuid;
begin
  if not exists (select 1 from private.issuer_tokens t
                 where t.jti = issuer_begin_handoff.token_id and t.expires_at > now()) then
    raise exception 'That identity token was not used up here.' using errcode = '42501';
  end if;
  if verified_at is null or fresh is null or verified_at > now() + interval '1 minute' then
    raise exception 'That check is not valid.' using errcode = '22023';
  end if;
  if fresh and verified_at < now() - interval '5 minutes' then
    raise exception 'That check is not recent.' using errcode = '22023';
  end if;
  select l.user_id into v_linked from private.issuer_identities l
    where l.issuer = issuer_begin_handoff.issuer and l.subject = issuer_begin_handoff.subject;
  if v_linked is distinct from account and (v_linked is not null or exists (
       select 1 from private.issuer_identities l where l.issuer = issuer_begin_handoff.issuer and l.user_id = account)) then
    raise exception 'That person and that account are linked elsewhere.' using errcode = '42501';
  end if;
  delete from private.issuer_handoffs h where h.expires_at < now();
  insert into private.issuer_handoffs (id_digest, token_id, user_id, issuer, subject, verified_at, fresh, next, expires_at)
    values (private.issuer_handoff_digest(handoff), issuer_begin_handoff.token_id, account, issuer_begin_handoff.issuer,
            issuer_begin_handoff.subject, least(issuer_begin_handoff.verified_at, now()), issuer_begin_handoff.fresh,
            issuer_begin_handoff.next, now() + interval '1 minute');
end $$;

-- The finish's first step: which account the waiting sign-in is for, whether the person is linked to it yet, and
-- where to go. Null unless it is waiting and unopened: a second finish with the same id gets nothing.
create function public.issuer_open_handoff(handoff text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v private.issuer_handoffs;
begin
  update private.issuer_handoffs h set opened_at = now()
    where h.id_digest = private.issuer_handoff_digest(handoff) and h.opened_at is null and h.expires_at > now()
    returning h.* into v;
  if not found then
    return null;
  end if;
  return jsonb_build_object('user_id', v.user_id, 'next', v.next, 'linked', exists (
    select 1 from private.issuer_identities l where l.issuer = v.issuer and l.subject = v.subject and l.user_id = v.user_id));
end $$;

-- For an account with its own authenticator (see issuer_link_account): links the issuer's person to it, but only from
-- the browser's own live two-factor session of that very account, which proves its owner wants this. Called with that
-- session's token, never the secret key. True once the link stands.
create function public.issuer_confirm_link(handoff text) returns boolean
language plpgsql security definer set search_path = '' as $$
declare
  v private.issuer_handoffs;
begin
  select h.* into v from private.issuer_handoffs h
    where h.id_digest = private.issuer_handoff_digest(handoff) and h.opened_at is not null and h.expires_at > now();
  if not found or v.user_id is distinct from auth.uid()
     or coalesce(auth.jwt() ->> 'aal', '') <> 'aal2'
     or nullif(auth.jwt() ->> 'client_id', '') is not null
     or not exists (select 1 from auth.sessions s
                    where s.id = nullif(auth.jwt() ->> 'session_id', '')::uuid and s.user_id = auth.uid()
                      and s.oauth_client_id is null and (s.not_after is null or s.not_after > now())) then
    return false;
  end if;
  insert into private.issuer_identities (issuer, subject, user_id) values (v.issuer, v.subject, v.user_id)
    on conflict do nothing;
  return exists (select 1 from private.issuer_identities l
                 where l.issuer = v.issuer and l.subject = v.subject and l.user_id = v.user_id);
end $$;

-- The finish's last step: marks the session it just made as made through the issuer, using up the waiting sign-in.
-- The account, the person, the time of the check and whether it was the fresh one come from the sign-in the callback
-- kept, never from the caller: the session must be a live person's session of that account, made after the callback
-- (a minute of clock difference) and in the last five minutes, and the person must be linked to the account. A fresh
-- check that went stale on the way still marks the session, which then simply isn't a fresh code (recent_mfa).
create function public.issuer_mark_session(session uuid, handoff text) returns void
language plpgsql security definer set search_path = '' as $$
declare
  v private.issuer_handoffs;
begin
  delete from private.issuer_handoffs h
    where h.id_digest = private.issuer_handoff_digest(handoff) and h.opened_at is not null and h.expires_at > now()
    returning h.* into v;
  if not found then
    raise exception 'That sign-in is not waiting to finish.' using errcode = '42501';
  end if;
  if not exists (select 1 from private.issuer_identities l
                 where l.issuer = v.issuer and l.subject = v.subject and l.user_id = v.user_id) then
    raise exception 'That person is not linked to this account.' using errcode = '42501';
  end if;
  if not exists (select 1 from auth.sessions s
                 where s.id = issuer_mark_session.session and s.user_id = v.user_id
                   and s.oauth_client_id is null and s.created_at >= v.created_at - interval '1 minute'
                   and s.created_at > now() - interval '5 minutes'
                   and (s.not_after is null or s.not_after > now())) then
    raise exception 'That session is not a new session of this account.' using errcode = '42501';
  end if;
  -- Sessions of this account that have ended leave nothing behind.
  delete from private.issuer_sessions i
    where i.user_id = v.user_id
      and not exists (select 1 from auth.sessions s where s.id = i.session_id);
  insert into private.issuer_sessions (session_id, user_id, issuer, subject, verified_at, fresh)
    values (issuer_mark_session.session, v.user_id, v.issuer, v.subject, v.verified_at, v.fresh);
end $$;

/* ---------- 5. what a signed-in browser may ask ---------- */

-- For the app: whether this request's own session was made through the issuer (null if not), when the person last
-- passed the issuer's check, and whether the round-trip that made the session was the fresh check:
-- {"verified_at": …, "fresh": true|false}.
create function public.issuer_session() returns jsonb
language sql stable security definer set search_path = '' as $$
  select jsonb_build_object('verified_at', c.verified_at, 'fresh', c.fresh) from private.issuer_current() c
$$;

revoke execute on function private.issuer_current(), private.issuer_session_ok(), private.issuer_fresh_at(),
  private.issuer_handoff_digest(text),
  public.issuer_claim_token(text, timestamptz), public.issuer_link_account(text, text, text),
  public.issuer_begin_handoff(text, text, text, text, uuid, timestamptz, boolean, text), public.issuer_open_handoff(text),
  public.issuer_confirm_link(text), public.issuer_mark_session(uuid, text), public.issuer_session()
  from public, anon, authenticated, service_role;
grant execute on function public.issuer_session(), public.issuer_confirm_link(text) to authenticated;
grant execute on function public.issuer_claim_token(text, timestamptz), public.issuer_link_account(text, text, text),
  public.issuer_begin_handoff(text, text, text, text, uuid, timestamptz, boolean, text), public.issuer_open_handoff(text),
  public.issuer_mark_session(uuid, text) to service_role;
