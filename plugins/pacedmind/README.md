# PacedMind

![PacedMind](assets/logo.png)

[PacedMind](https://pacedmind.com) is a personal planner for tasks, projects and your calendar, made for people who work with AI agents. This plugin brings it into Claude and Codex: ask what's on your plate, capture well-described tasks, plan or reschedule your day, organize projects, and follow the Claude Code and Codex sessions working on your tasks.

## What it adds

- **The PacedMind MCP server** (`pacedmind`), PacedMind Cloud's remote server at `https://app.pacedmind.com/api/mcp`, over streamable HTTP. Its tools read and change your areas, projects, tasks, calendar events and planning preferences, and report on agent sessions. The [tool reference](https://pacedmind.com/docs/mcp/tools) describes each one.
- **Six skills** that teach the assistant to use those tools well:
  - `pacedmind`: how the planner is organized and how to write tasks you can act on later;
  - `pacedmind-intake`: adding a task with only the questions that matter, following your saved preferences;
  - `pacedmind-planning`: planning a day or week and moving things around;
  - `pacedmind-projects`: setting up a project and breaking it down into tasks;
  - `pacedmind-review`: Inbox triage and the weekly review;
  - `pacedmind-agent-session`: working as an agent on a task PacedMind started.

The plugin has no hooks, commands or local programs. It runs nothing on your computer.

## Requirements and sign-in

You need a [PacedMind Cloud](https://pacedmind.com) account. The first time a tool is used, your client opens PacedMind's sign-in page in the browser: sign in, then select **Allow** to approve the connection. No password, token or key is stored in the plugin or in your settings files; your client keeps its own OAuth sign-in. You can disconnect it at any time in PacedMind under **Settings → Connected agents**.

The connection only acts on your own account's planner. It can't change your computers' settings, answer questions for you or delete your account. Asking one of your computers to start an agent session also requires two-factor sign-in and that computer's own approval settings.

If you already connected PacedMind by hand (for example with `claude mcp add ... pacedmind`), remove that entry or keep only one of the two, so the tools aren't listed twice.

## What it sends

Tool calls go only to `https://app.pacedmind.com` (PacedMind Cloud), with the arguments the assistant passes, such as a task's title or a date. Answers contain your planner data: tasks, projects, areas, events, preferences, summaries of your computers and agent sessions with their reports. Nothing else is fetched or sent. What PacedMind keeps and why is in the [privacy policy](https://pacedmind.com/privacy).

## Try it

- "What's on my plate today?"
- "Add a task to call the dentist tomorrow at 9:00."
- "I'm sick today: move everything to tomorrow."
- "Break the website redesign down into tasks in a new project."

## Support

- Setup and usage: [PacedMind in Claude and ChatGPT](https://pacedmind.com/docs/mcp/claude-and-chatgpt)
- Help: [pacedmind.com/support](https://pacedmind.com/support) or mbednarczyk@preseed.tech
- Source code and issues: [github.com/Pacedmind/pacedmind](https://github.com/Pacedmind/pacedmind)

## License

PacedMind, including this plugin, is licensed under the [GNU Affero General Public License v3.0](LICENSE). The PacedMind name and logo are trademarks; see [TRADEMARKS.md](https://github.com/Pacedmind/pacedmind/blob/master/TRADEMARKS.md).
