# Claude: the Connectors Directory and the plugin directory

Two submissions in Claude's developer portal, [claude.ai/directory/manage](https://claude.ai/directory/manage), from an account on a paid Claude plan:

1. **MCP connector**: PacedMind Cloud's remote MCP server, for Claude on the web, desktop and mobile (and Claude Code). Guide: [Submit a connector](https://claude.com/docs/connectors/building/submission), [review criteria](https://claude.com/docs/connectors/building/review-criteria), [authentication](https://claude.com/docs/connectors/building/authentication).
2. **Plugin bundle**: `plugins/pacedmind` in the GitHub repository, the server plus PacedMind's six skills, for Claude Code and Cowork. Guide: [Submit your plugin](https://claude.com/docs/plugins/submit), [pre-submission checklist](https://claude.com/docs/plugins/pre-submission-checklist). Claude asks for the connector too when a plugin points at your own server, so do both.

MCP Bundles (`.mcpb`) aren't needed: the directory no longer takes local servers that way, and PacedMind's server is remote. Checked on 7 October 2026.

## What's ready

- Every tool has a `title` and the right `readOnlyHint`/`destructiveHint` ([tools.md](tools.md)); names are under 64 characters; read and write operations are separate tools.
- Authentication: OAuth 2.0 with dynamic client registration, S256 PKCE, refresh tokens (`offline_access`), a 401 with `resource_metadata` before anything else. Checked live on 7 October 2026: a client registered with `https://claude.ai/api/mcp/auth_callback` and authorized with S256 and `resource` lands on PacedMind's consent page; Claude Code (loopback callback) already connects this way.
- `plugins/pacedmind` passes `claude plugin validate`, installs from the repository's marketplace (`.claude-plugin/marketplace.json`) and shows its server as needing sign-in. README over 40 words, `license` and `LICENSE`, no hooks, scripts, launchers, binaries or secrets, every file under 256 KiB. `npm run plugins -- --check` (CI) keeps its skills equal to `skills/`.
- Public documentation: https://pacedmind.com/docs/mcp/claude-and-chatgpt (setup, what it can do, prompts to try, data), with the tool reference at https://pacedmind.com/docs/mcp/tools.

## Before you open the portal

1. The plugin folder, the docs page and the support page are on GitHub's master and live on pacedmind.com.
2. The review account exists and has sample data ([review.md](review.md#1-the-review-account)).
3. Add the server as a custom connector in Claude with the review account and run the cases in [review.md](review.md#3-test-cases); the portal asks you to confirm every tool works.

## 1. MCP connector

**Submit new → MCP connector.**

### Connection

- URL: `https://app.pacedmind.com/api/mcp`
- Users connect to the same URL: **Universal URL**.

### Tools

Synced from the server: 42 tools, 14 read-only and 28 write. Nothing should be flagged; if something is, fix it on the server, deploy and sync again.

### Listing

| Field | Value |
| --- | --- |
| Server name | PacedMind |
| One-liner (≤200) | Plan your tasks, projects and calendar in PacedMind: see what's on your plate, capture tasks, reschedule your day and follow your coding agents' work. |
| Categories (1–5) | Productivity; also Project management and Calendar if the portal offers them |
| Documentation URL | https://pacedmind.com/docs/mcp/claude-and-chatgpt |
| Privacy policy URL | https://pacedmind.com/privacy |
| Support contact | https://pacedmind.com/support (mbednarczyk@preseed.tech) |
| Icon | `plugins/pacedmind/assets/logo.png` (512 px) |
| URL slug | `pacedmind` (permanent once published) |

Description (≤2000; 1,326 characters):

```text
PacedMind is a personal planner for tasks, projects and your calendar, made for people who work with AI agents. Connect it to bring your plan into the conversation:

- See what's on your plate: today's date, overdue work, what's due or planned today, today's events, and agent sessions waiting for your review.
- Capture work as well-described tasks: a project or area, a description, sub-tasks, a "done when" list, an estimate, a priority, a planned day and a real deadline.
- Change and reschedule: update, reprioritize, complete or cancel tasks, move tasks to another day, or move a whole day's plans when something comes up.
- Organize areas and projects, order a project's roadmap and make tasks wait for each other.
- Manage calendar events, and plan a day or week around your free focus time.
- Save how you like to work, such as deep work in the mornings, so every assistant plans your way.
- Follow the Claude Code and Codex sessions working on your tasks and read their reports.

You sign in with your PacedMind Cloud account and approve the connection on PacedMind's own page, and you can disconnect it at any time in PacedMind under Settings → Connected agents. The connection only reads and changes that account's planner. It can't change your computers' settings, answer questions for you or delete your account.
```

### Use cases

- Primary use cases: "Reviewing and planning the user's day or week from their own PacedMind planner: what's overdue, due or planned, and the calendar. Capturing and updating well-described tasks, projects and calendar events from the conversation. Following the Claude Code and Codex sessions that work on the user's tasks and reading their reports."
- Before connecting: a PacedMind Cloud account (pacedmind.com). Nothing to install; the PacedMind desktop app is only needed for agent sessions on the user's computers, which also need two-factor sign-in.
- Data: **reads and writes**.

### Company

- Company: NMD Mikołaj Bednarczyk (PacedMind)
- Website: https://pacedmind.com
- Primary contact: Mikołaj Bednarczyk, mbednarczyk@preseed.tech

### Authentication

**OAuth with dynamic client registration.** Nothing to send to Anthropic: no client ID or secret, no scopes. The server doesn't start without authentication (every tool needs the user's account). Claude Code's loopback callback works too.

### Data handling

- The API: **our own** (first-party; PacedMind's server and database).
- Personal health data: **no**. (Task text is whatever the user writes; the server doesn't ask for health data.)
- Sponsored content: **no**.

### Test & launch

- Paste the reviewer text from [review.md](review.md#2-text-for-the-portals-reviewer-fields) with the real email and password.
- Confirm you ran every tool, as a custom connector in Claude (and, if you like, with the [MCP Inspector](https://modelcontextprotocol.io/docs/tools/inspector)).

### Compliance

Read and select all seven acknowledgments. Each is true of PacedMind: it follows the directory guidelines; it calls only its own first-party API; it makes no financial transactions (it sells nothing through tools); it generates no AI media; its tool descriptions carry no instructions for Claude beyond describing the tools, and task text is data the server never acts on; it collects no conversation data beyond each tool call's arguments; and its documentation is public.

### After submitting

Anthropic scans it and by default lists it as a Community connector; status and feedback appear in the portal. Escalations: `mcp-review@anthropic.com`.

## 2. Plugin bundle

**Submit new → Plugin bundle.** The portal needs your GitHub account connected to claude.ai (in the organization you submit from) with push access to `Pacedmind/pacedmind`.

### Source

- Repository: `Pacedmind/pacedmind`
- Plugin path: `plugins/pacedmind`
- Branch or tag: leave empty (master)
- **Validate**. Expected: no blocking findings. Should one appear, fix it, push, and select **Re-validate**.

### Listing details

Read from `plugins/pacedmind/.claude-plugin/plugin.json` (name `pacedmind`, display name PacedMind, description, author PacedMind) and `plugins/pacedmind/README.md`. To change them, edit those files, push and validate again.

### Data handling

- Reads or stores personal data: it reads and changes the user's own PacedMind planner through its declared MCP server; the plugin itself stores nothing.
- Sends data to services other than its declared connectors: **no** (only `https://app.pacedmind.com`).
- How long data is kept: the plugin keeps nothing. PacedMind Cloud keeps the planner until the user deletes it or the account (https://pacedmind.com/privacy).
- Intended for people under 18: **no**.

### Compliance

Check that the contact email is mbednarczyk@preseed.tech, and select all four acknowledgments.

### Review and submit

- How new versions reach the directory: **GitHub push webhook** (set it up on the next page; it needs admin access to the repository), plus the scheduled check.
- **Submit for review**. Once the scan passes, select **Publish**.

### Releasing a new version

Change `skills/` or the plugin, run `npm run plugins`, raise `version` in both manifests and in `.claude-plugin/marketplace.json`, and merge to master: the directory picks it up.
