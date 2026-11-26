-- Signing in through your organisation: the hosted app verifies a short-lived identity token from one trusted issuer
-- (src/server/sso-token.ts) and then starts an ordinary session for the account. The issuer asked for its own
-- two-factor code before it issued the token, so such a session counts as a two-factor session here: for planning,
-- for computers and, while the issuer's check is under five minutes old, as a fresh code.
--
-- What marks such a session is a row in private.issuer_sessions, keyed by the auth session's id. Only the hosted app's
-- server writes it, with the project's secret key, right after it made the session; no client can read the table,
-- write it or name another session in it, and the row stops counting the moment its session ends.

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
  -- When the issuer issued the token this session came from: the time of its two-factor round-trip.
  verified_at timestamptz not null,
  foreign key (issuer, subject) references private.issuer_identities (issuer, subject) on delete cascade
);
create index issuer_sessions_by_user on private.issuer_sessions (user_id);

alter table private.issuer_identities enable row level security;
alter table private.issuer_tokens enable row level security;
alter table private.issuer_sessions enable row level security;
revoke all on private.issuer_identities, private.issuer_tokens, private.issuer_sessions
  from public, anon, authenticated, service_role;

/* ---------- 2. who counts as signed in through the issuer ---------- */

-- When the issuer last checked the person behind this request, or null: the request's own session, still live, a
-- person's (never an agent's OAuth sign-in), made through the issuer for this very account, whose link still stands.
create function private.issuer_verified_at() returns timestamptz
language sql stable security definer set search_path = '' as $$
  select i.verified_at
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
  select private.issuer_verified_at() is not null
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
-- a session made through the issuer, a round-trip through the issuer that recent (a new session made by it).
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
  ) or coalesce(private.issuer_verified_at() >= now() - make_interval(secs => seconds), false)
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

-- Marks the session the app just made for `account` as made through the issuer. Only a live, brand-new person's
-- session of the linked account, once.
create function public.issuer_mark_session(session uuid, account uuid, issuer text, subject text, verified_at timestamptz)
returns void
language plpgsql security definer set search_path = '' as $$
begin
  if not exists (select 1 from private.issuer_identities l
                 where l.issuer = issuer_mark_session.issuer and l.subject = issuer_mark_session.subject
                   and l.user_id = issuer_mark_session.account) then
    raise exception 'That person is not linked to this account.' using errcode = '42501';
  end if;
  if not exists (select 1 from auth.sessions s
                 where s.id = issuer_mark_session.session and s.user_id = issuer_mark_session.account
                   and s.oauth_client_id is null and s.created_at > now() - interval '5 minutes'
                   and (s.not_after is null or s.not_after > now())) then
    raise exception 'That session is not a new session of this account.' using errcode = '42501';
  end if;
  if verified_at is null or verified_at < now() - interval '5 minutes' or verified_at > now() + interval '1 minute' then
    raise exception 'That check is not recent.' using errcode = '22023';
  end if;
  -- Sessions of this account that have ended leave nothing behind.
  delete from private.issuer_sessions i
    where i.user_id = issuer_mark_session.account
      and not exists (select 1 from auth.sessions s where s.id = i.session_id);
  insert into private.issuer_sessions (session_id, user_id, issuer, subject, verified_at)
    values (issuer_mark_session.session, issuer_mark_session.account, issuer_mark_session.issuer,
            issuer_mark_session.subject, least(issuer_mark_session.verified_at, now()));
end $$;

/* ---------- 5. what a signed-in browser may ask ---------- */

-- For the app: whether this request's own session was made through the issuer, and when the issuer last checked.
create function public.issuer_session() returns timestamptz
language sql stable security definer set search_path = '' as $$
  select private.issuer_verified_at()
$$;

revoke execute on function private.issuer_verified_at(), private.issuer_session_ok(),
  public.issuer_claim_token(text, timestamptz), public.issuer_link_account(text, text, text),
  public.issuer_mark_session(uuid, uuid, text, text, timestamptz), public.issuer_session()
  from public, anon, authenticated, service_role;
grant execute on function public.issuer_session() to authenticated;
grant execute on function public.issuer_claim_token(text, timestamptz), public.issuer_link_account(text, text, text),
  public.issuer_mark_session(uuid, uuid, text, text, timestamptz) to service_role;
