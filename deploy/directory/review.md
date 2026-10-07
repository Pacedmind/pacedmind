# Review account, test cases and demo video

Both directories test PacedMind with an account you give their reviewers. OpenAI also wants the test cases run before you submit and a video of them. This page has the account's setup, the text for the portals' reviewer fields, the eight cases and the video's script.

## 1. The review account

Reviewers must be able to sign in at once: no two-factor code, no email code, no magic link (OpenAI rejects anything else). A PacedMind Cloud account without an authenticator signs in with its email and password only, and its connections are planner-only, which is what both directories review.

1. In a private browser window, open https://app.pacedmind.com/login?create=1 and create an account with an address used only for this, for example `review@pacedmind.com` or `you+pacedmind-review@…`. Use a long random password and keep it in your password manager; it goes only into the portals' private reviewer fields, never into this repository.
2. Confirm the email. **Don't** set up two-factor sign-in.
3. **Settings → Data → Load sample data**. The account then has the areas Work, Personal, Health, Learning and Dev, the projects Q4 planning, Apartment move, Organizer app, ChessV2, Portfolio site, Half marathon and Spanish B1, about thirty tasks, weekly and one-off events and three agent sessions. The dates count from the day you load it.
4. Keep the account able to write for the whole review. Billing is on, so a new account becomes read-only after its 7-day trial. Mark it as complimentary (the `comped` flag, which only the database owner can set) in Supabase's SQL editor for project `pyoynjoyhpolijlvoalu`, or ask an agent with the Supabase connector to run it:

   ```sql
   update public.billing set comped = true
   where user_id = (select id from auth.users where email = '<REVIEW EMAIL>');
   ```

   Check it with `select comped from public.billing where user_id = (select id from auth.users where email = '<REVIEW EMAIL>');`, which should answer `true`.
5. Sign out of that window.

Keep the account and its data as they are while a review is open, and for later reviews of updates. Before recording the video, or when a reviewer reports a mess, **Load sample data** again.

## 2. Text for the portals' reviewer fields

OpenAI: **Metadata & Skills → Review information → Review details**. Claude: the **Test & launch** step. Replace the two placeholders there, not here.

```text
Test account (PacedMind Cloud)
Sign-in page: https://app.pacedmind.com/login
Email: <REVIEW EMAIL>
Password: <REVIEW PASSWORD>
The account has no two-factor sign-in: the email and password are all it asks for. It holds sample data: the areas Work, Personal, Health, Learning and Dev, projects such as Q4 planning and Apartment move, about thirty tasks, calendar events and three agent sessions.

How to connect
1. Add the MCP server https://app.pacedmind.com/api/mcp (streamable HTTP, OAuth; the client registers itself, there is no client secret).
2. The client opens PacedMind's sign-in page. Sign in with the account above.
3. PacedMind asks "Allow <client name> to use PacedMind?". Select Allow. The connection is ready; return to the chat.

Notes
- Connect from one place at a time. Two sign-ins of the same client to the same account that start within a few minutes of each other are both signed out (a protection against someone else slipping in with the password). If that happens, connect again.
- The account has no two-factor sign-in, so its connections are planner-only: the tools that ask the user's own computers to do something (start_session, request_changes, set_folder, show_task_note) answer "This connection has planner access only..." and nothing happens. That is expected (negative case 3). Everything else works.
- To restore the sample data, sign in to https://app.pacedmind.com and select Settings -> Data -> Load sample data. Please don't change the password or delete the account.
- Questions: mbednarczyk@preseed.tech
```

## 3. Test cases

These are the cases in `plugins/pacedmind/.codex-plugin/plugin.json` (`extensions.com.openai.review`), which the OpenAI portal imports with the ZIP. Claude's portal doesn't ask for them, but run them in Claude too: its **Test & launch** step asks you to confirm every tool works there.

Run each one in a new chat with only PacedMind turned on, after **Load sample data**. Record what happened; a case that doesn't pass is fixed (in the server, or in the case's wording) before submitting.

| # | Prompt | Expected tools | Expected result |
| --- | --- | --- | --- |
| P1 | What's on my plate in PacedMind today? | `get_overview` | Today's date, overdue tasks, what's due or planned today, today's events, sessions waiting for review, all from the review account. Nothing changes. |
| P2 | Add a task to my Apartment move project: order a parking permit for moving day, 45 minutes, planned for tomorrow. | `get_overview`, `create_task` | One task in Apartment move, 45-minute estimate, planned tomorrow, no deadline; the answer gives its key (PER-…) and the date. |
| P3 | Which tasks in my Apartment move project are still open? | `get_project` | Book movers for moving day, Buy packing boxes, Pack the kitchen (and P2's task), in roadmap order, with status and dates. |
| P4 | Make the task Buy packing boxes high priority and add a sub-task: Get tape and markers. | `list_tasks`, `update_task` | Priority high, the sub-task added, title, description and dates kept; the answer names the key. |
| P5 | Put a 30-minute call with the landlord on my calendar tomorrow at 10:00. | `create_event` | One event, Call with the landlord, tomorrow 10:00 to 10:30. |
| N1 | Pay my electricity bill from my bank account. | none | No payment and no PacedMind tool claims one; at most it offers to mark Pay electricity bill done once the user says it's paid. |
| N2 | Delete everything in my planner. | none, or only reads | Nothing is deleted: it asks what exactly to delete and for confirmation. |
| N3 | Start a coding agent session on my computer for the task Start sessions from the app. | `start_session` (refused) | The tool answers "This connection has planner access only…"; nothing starts, and the assistant explains instead of retrying. |

The models may call an extra read (`get_overview`, `list_tasks`) first; that's fine. When a case behaves differently in ChatGPT and Claude, describe what both do.

## 4. Demo video (OpenAI)

OpenAI needs a reviewer-accessible recording of the test cases: an unlisted YouTube video, or a Loom or Google Drive link that anyone with the link can open. About four minutes, no sound needed; captions or a title card per case help.

1. Title card: "PacedMind for ChatGPT: review walkthrough".
2. In ChatGPT (Developer mode, the PacedMind custom connection from [the docs](https://pacedmind.com/docs/mcp/claude-and-chatgpt#chatgpt)), show connecting: add the app, the PacedMind sign-in page with the review account (blur or skip typing the password), **Allow**, back in ChatGPT.
3. P1 to P5, one after another, each with the tool calls expanded once so the tool names show, and after P2, P4 and P5 a cut to https://app.pacedmind.com (signed in to the review account) showing the new task, the changed task and the event.
4. N1 to N3, showing the refusals.
5. End card: pacedmind.com/support.

Then put the link into the portal's **Review details**, or rebuild the ZIP with it: `npm run plugins -- --demo-url <link>`.
