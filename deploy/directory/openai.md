# OpenAI: the plugin directory (ChatGPT and Codex)

One submission puts PacedMind in the plugin directory that ChatGPT and Codex share: the remote MCP server and the six skills, as a ZIP. Guide: [Upload and submit your plugin](https://developers.openai.com/plugins/deploy/submission); rules: [plugin guidelines](https://developers.openai.com/plugins/plugin-guidelines) and [submission errors](https://developers.openai.com/plugins/deploy/submission-errors). Checked on 7 October 2026.

## What's ready

| | |
| --- | --- |
| Package | `dist/plugins/pacedmind-openai-1.0.0.zip`, built by `npm run plugins` from `plugins/pacedmind` (Codex format: `.codex-plugin/plugin.json`, `.mcp.json`, `skills/`, `assets/`, `README.md`, `LICENSE`). The script checks every limit on the error page first. |
| Listing | In the ZIP's manifest (`interface`): name, subtitle, description, developer, category, capabilities, the four URLs, three starter prompts, brand colors, light and dark icons. No screenshots: OpenAI allows them only for plugins with a UI. |
| Review | In the ZIP's manifest (`extensions.com.openai.review`): 5 positive and 3 negative cases ([review.md](review.md#3-test-cases)), `commerce: false`. Release notes and a Polish translation under `publication`. Country availability isn't set: choose it in the portal. |
| MCP server | `https://app.pacedmind.com/api/mcp`: streamable HTTP, OAuth 2.1 with dynamic client registration and S256 PKCE (Supabase Auth), protected resource metadata at `/.well-known/oauth-protected-resource/api/mcp`. Every tool has `title`, `readOnlyHint`, `destructiveHint`, `openWorldHint` and `securitySchemes`. Checked live on 7 October 2026: an unauthenticated call answers 401 with `resource_metadata`; registering a client with ChatGPT's redirect URI and authorizing with S256 and `resource` leads to PacedMind's consent page. |
| Annotations | Justifications for all 42 tools: [tools.md](tools.md). |
| Domain proof | `https://app.pacedmind.com/.well-known/openai-apps-challenge` answers the token from `ORGANIZER_OPENAI_APPS_CHALLENGE`; `deploy/openai-challenge.sh` sets it. |

## What only you can do

1. **Verify the publisher.** In [organization settings](https://platform.openai.com/settings/organization/general), complete business verification for NMD Mikołaj Bednarczyk (or individual verification). The directory shows that name, whatever `developerName` says.
2. **Use a project with global data residency.** OpenAI doesn't take plugins with MCP servers from EU-residency projects; create a new project in the organization if needed.
3. **The review account** and **the demo video**: [review.md](review.md).

## Steps in the portal

1. **Upload.** [platform.openai.com/plugins](https://platform.openai.com/plugins) → **Upload new or existing plugin** → choose the verified **Developer identity** → **Upload plugin** → `dist/plugins/pacedmind-openai-1.0.0.zip`. Expect warnings that the developer name comes from the identity; fix anything marked as an error and upload again (`npm run plugins` rebuilds; raise `version` in both manifests and `.claude-plugin/marketplace.json` for a later release).
2. **Metadata & Skills.** Wait for the checks; read **Issues**. Skill scans must finish.
3. **MCPs → pacedmind → Connect.**
   - MCP Server URL: `https://app.pacedmind.com/api/mcp`. Authentication: **OAuth**, client registration: dynamic (DCR). No client ID or secret to enter, no scopes to add.
   - **Domain verification**: copy the token, then from the repository run `deploy/openai-challenge.sh pacedmind <token>` (`pacedmind` is the SSH alias from deploy/README.md; `PACEDMIND_KEY` picks another key, as for deploy.sh). It restarts the web app for a few seconds and checks the URL answers the token. Then verify in the portal.
   - **Authenticate** when asked: sign in with the review account and select **Allow**.
   - Wait for the tool scan: 42 tools. Read **Issues**.
4. **Annotation justifications.** For each tool, paste the three lines from [tools.md](tools.md#justifications). They explain the values; the portal shows the server's own values.
5. **Review information → Review details.**
   - Reviewer credentials and sign-in instructions: the text in [review.md](review.md#2-text-for-the-portals-reviewer-fields), with the real email and password.
   - Video walkthrough URL: the recording's link (or rebuild the ZIP with `--demo-url`).
   - Test cases and release notes come from the ZIP (read-only here).
   - Countries: all, unless you want to limit them.
   - **Save details**.
6. **Submit for review** on the draft, then the attestations. Feedback arrives by email.
7. Once approved: **Publish plugin**. Then remove the token (`deploy/openai-challenge.sh pacedmind --remove`) unless the portal asks for it again, and in `docs/content/docs/mcp/claude-and-chatgpt.mdx` replace the custom-connection note with the listing's real link.

## The listing, field by field

All of it is in the ZIP; this is for checking what the portal shows.

| Field | Value |
| --- | --- |
| Package name | `pacedmind` |
| Version | `1.0.0` |
| Display name | PacedMind |
| Short description | Plan your tasks and calendar |
| Category | Productivity |
| Developer name | NMD Mikołaj Bednarczyk (replaced by the verified identity) |
| Website | https://pacedmind.com |
| Support | https://pacedmind.com/support |
| Privacy policy | https://pacedmind.com/privacy |
| Terms of service | https://pacedmind.com/terms |
| Starter prompts | What's on my plate today? · Add a task to call the dentist tomorrow at 9:00 · Move today's unfinished tasks to Friday |
| Brand colors | `#172F6F` (light, 12.6:1 against white), `#95ABD9` (dark, 7:1 against #212121) |
| Icons | `assets/logo.png` (black tile) and `assets/logo-dark.png` (white tile), 512 px, as logo and composer icon |
| Commerce | No |

The long description is `interface.longDescription` in `plugins/pacedmind/.codex-plugin/plugin.json`. It names no prices, trials or other products, as the guidelines ask; "Requires a PacedMind Cloud account" is the only mention of the plan.

## After publication

- OpenAI rescans the server daily; tool changes go live after the automatic checks, held ones wait for review. After a deploy that changes tools, **MCPs → Issues → Rescan**, and run `npm run directory:tools` to update the justifications.
- New skills, listing text or icons need a new ZIP with a higher `version`.
- Changing the server's URL needs OpenAI support.
