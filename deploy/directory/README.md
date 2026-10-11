# Listing PacedMind in OpenAI's and Claude's directories

PacedMind Cloud's MCP server (`https://app.pacedmind.com/api/mcp`) and PacedMind's skills go to three listings:

| Where | What | Sheet |
| --- | --- | --- |
| OpenAI's plugin directory (ChatGPT and Codex) | A ZIP: the remote server and the six skills | [openai.md](openai.md) |
| Claude's Connectors Directory | The remote server | [anthropic.md](anthropic.md#1-mcp-connector) |
| Claude's plugin directory (Claude Code, Cowork) | `plugins/pacedmind` on GitHub: the server and the skills | [anthropic.md](anthropic.md#2-plugin-bundle) |

Shared by all three: the [review account, test cases and demo video](review.md), and the [tools with their annotations](tools.md).

## What's in the repository

- `plugins/pacedmind/`: the plugin. `.claude-plugin/plugin.json` for Claude, `.codex-plugin/plugin.json` for OpenAI (with the listing, the review cases and the release notes), `.mcp.json` (the remote server), `skills/` and `LICENSE` (copies, by `npm run plugins`), `assets/` (icons, by `npm run icons`), `README.md`.
- `.claude-plugin/marketplace.json`: the repository as a Claude Code marketplace, so `/plugin marketplace add Pacedmind/pacedmind` works before the directory lists it.
- `npm run plugins`: copies the skills and license in, checks both directories' limits, and writes `dist/plugins/pacedmind-openai-<version>.zip`. `-- --check` only checks (CI).
- `npm run directory:tools`: writes [tools.md](tools.md) from the server's tool list. `-- --check` only checks (CI).
- `deploy/openai-challenge.sh`: publishes OpenAI's domain-verification token.
- The public pages the listings link to: https://pacedmind.com/docs/mcp/claude-and-chatgpt (`docs/content/docs/mcp/claude-and-chatgpt.mdx`) and https://pacedmind.com/support (`site/app/support/page.tsx`), with the existing privacy policy and terms.

## In order

1. **Land and publish** this work: master, GitHub (Claude reads the plugin from there) and pacedmind.com's site and docs (`SITE_ONLY=1 deploy/deploy.sh pacedmind` after building `site/` and `docs/`). The web app itself needs no deploy for this.
2. **Review account**: create it, load the sample data, mark it complimentary ([review.md](review.md#1-the-review-account)).
3. **Run the eight cases** with that account, in Claude (custom connector) and in ChatGPT (Developer mode), and **record the video** in ChatGPT ([review.md](review.md#4-demo-video-openai)).
4. **OpenAI**: verify the publisher, then upload, connect, verify the domain, paste the justifications, the reviewer text and the video, submit ([openai.md](openai.md)).
5. **Claude**: the connector, then the plugin ([anthropic.md](anthropic.md)).
6. After approval: publish (OpenAI's **Publish plugin**, Claude's **Publish**), remove the challenge token, and put the real listing links into the docs page (`docs/content/docs/mcp/claude-and-chatgpt.mdx`).

## Keeping them current

- A changed or new tool: the directories rescan the server (OpenAI daily; **Rescan** right after a deploy). Run `npm run directory:tools` and paste new justifications into OpenAI's portal. A new tool also needs a sentence in `scripts/directory-tools.mts`.
- Changed skills, listing text or icons: `npm run plugins`, raise `version` in `plugins/pacedmind/.claude-plugin/plugin.json`, `plugins/pacedmind/.codex-plugin/plugin.json` and `.claude-plugin/marketplace.json`, merge to master (Claude picks it up), and upload the new ZIP to OpenAI.
- The server's URL is part of both listings: changing it needs both directories' support.
