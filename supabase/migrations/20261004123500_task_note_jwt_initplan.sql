-- Wrap the auth call directly so Supabase's policy advisor also recognizes the cached InitPlan.
alter policy "Two-factor session, or the agent's own" on public.task_note_requests
  using ((select private.computer_session_ok())
    or ((select private.agent_computer_ok())
      and agent_session = nullif((select auth.jwt()) ->> 'session_id', '')::uuid));
