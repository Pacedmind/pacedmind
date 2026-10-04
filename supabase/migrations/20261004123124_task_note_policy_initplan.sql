-- The caller's session is constant for the statement, so read it once rather than for every receipt.
alter policy "Two-factor session, or the agent's own" on public.task_note_requests
  using ((select private.computer_session_ok())
    or ((select private.agent_computer_ok())
      and agent_session = (select nullif(auth.jwt() ->> 'session_id', '')::uuid)));
