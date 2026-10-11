# Hosting PacedMind

The web app is the same Next.js app as the desktop one, run with `ORGANIZER_MODE=web`: every browser signs in with its own account, and the data is in Supabase. It never opens terminals. Agent sessions started in the browser are queued, and the desktop app signed in to the same account opens them.

The web app is live at `https://app.pacedmind.com` since 2026-09-25. Every deploy rebuilds it from the checkout it runs in, so deploy from one with current master (step 3).

The server is an OVH VPS with Ubuntu 26.04. It only accepts SSH keys. Give it a name in `~/.ssh/config` once, with its address (the one pacedmind.com's DNS records point at, step 0) and the key, kept outside the repository and not in Desktop or Downloads, where macOS asks before a program may read:

```
Host pacedmind
    HostName <server>
    User ubuntu
    IdentityFile ~/.ssh/pacedmind_vps
    IdentitiesOnly yes
```

The commands below use that name, so `ssh pacedmind` reaches the server from any terminal or agent on the computer. Without it, write `ubuntu@<server>` instead: the scripts pass `PACEDMIND_KEY`, by default `~/.ssh/pacedmind_vps` when it exists, else ssh's own config decides. Caddy serves HTTPS and proxies to the app on 127.0.0.1:3000; the public site and the docs are static files next to it.

| Address | What |
| --- | --- |
| `https://app.pacedmind.com` | the web app |
| `https://pacedmind.com` | the public site (`site/out`) |
| `https://pacedmind.com/docs` | the docs (the docs app's static build) |
| `https://pacedmind.com/download/windows`, `/download/mac` | the current desktop installers (step 4) |
| `https://pacedmind.com/github.json` | the repository's star count on GitHub, for the site's header (step 3) |
| `https://stats.pacedmind.com` | the visitor statistics' dashboard, Umami (step 5) |
| `https://www.pacedmind.com` | redirects to `pacedmind.com` |

## 0. DNS

`pacedmind.com` uses OVH's DNS (ns111/dns111.ovh.net). In the OVH Control Panel, Domain names > pacedmind.com > DNS zone:

| Name | Type | Target |
| --- | --- | --- |
| (empty, the domain itself) | A | the server's IPv4 address (replaces OVH's default) |
| `www` | A | the server's IPv4 address (replaces OVH's default) |
| `app` | A | the server's IPv4 address (new) |
| `stats` | A | the server's IPv4 address (new, for step 5) |
| (empty), `www`, `app`, `stats` | AAAA | the server's IPv6 address |

Also turn off OVH's web redirection for the domain (it's the `1|www.pacedmind.com` TXT record). Leave the MX and SPF records alone: they carry the domain's email. Caddy can only get HTTPS certificates once these records point at the server.

## 1. Supabase

In the project's dashboard (Authentication > URL Configuration):

- Site URL: `https://app.pacedmind.com`. Email links depend on it: Supabase sends a link back to any address on the Site URL's own host (the web app's `/auth/callback?next=…`) and to loopback addresses (the desktop app's `http://127.0.0.1:4319/auth/callback?next=…`, development's 4320). Anything else has to match a redirect URL, and an entry without a wildcard doesn't match the `?next=…` those links carry.
- Redirect URLs: the three exact callback URLs from SECURITY.md's checklist, with no wildcards.

Apply the schema (`supabase/migrations`) with `npx supabase link --project-ref <ref>` and `npx supabase db push`, or through the Supabase MCP server. Before real users sign up, set up custom SMTP (Authentication > Emails): the built-in sender is rate-limited and meant for testing. The domain already has OVH email, so an address like `noreply@pacedmind.com` through OVH's SMTP server works.

## 2. Set up the server (once)

```bash
ssh pacedmind 'sudo sh -s' < deploy/provision.sh
```

It installs Node, npm and Caddy from Ubuntu's repositories and creates the `pacedmind` user with `/srv/pacedmind/{app,site,docs}` and `/srv/pacedmind/web.env`.

## 3. Deploy

Build the static parts first if they should go up too (`npm run build` in `site/` and `docs/`), then, from the repository in Git Bash:

```bash
SUPABASE_URL=https://pyoynjoyhpolijlvoalu.supabase.co SUPABASE_PUBLISHABLE_KEY=sb_publishable_... deploy/deploy.sh pacedmind
```

It uploads the working tree, builds the app on the server, switches `/srv/pacedmind/app` to the new build (the previous one stays in `app.old`), restarts `pacedmind-web`, and uploads `site/out` and `docs/out` when they exist, each replacing the live folder in one step (the previous one stays in `site.old` or `docs.old`). Then it installs `Caddyfile` and `app.caddy` in `/etc/caddy`, once `caddy validate` has accepted them, and restarts Caddy if either changed (never a reload: after one, Caddy 2.6.2 stops answering browsers that use HTTP/3); the previous config stays in `/etc/caddy/Caddyfile.old`. Last, it installs `pacedmind-github.timer`, which copies the repository's star count from GitHub every ten minutes (`github-stars.mjs`, in `/usr/local/lib/pacedmind`) to `/srv/pacedmind/github/github.json`, served as `pacedmind.com/github.json` for the site's header, so visitors' browsers never contact GitHub; if that step fails, the deploy only warns and the page keeps the count from its build (`journalctl -u pacedmind-github` says why). The Supabase variables are only needed the first time (they're kept in `web.env`).

When several sessions share one checkout, each may have unfinished work in it: `SITE_ONLY=1` uploads `site/out`, `docs/out` and the Caddy config and keeps the app that runs, and `APP_ONLY=1` rebuilds the app without uploading `site/out` or `docs/out`.

The web upload excludes the entire separate `mobile/` project, including its dependencies, native projects, bundles, local configuration and signing credentials. Mobile binaries are built and distributed separately. The hosted native sign-in callback remains part of `src/app/auth/` and is included in normal web deployments.

Before the web app launched, `APP_PLACEHOLDER=1 deploy/deploy.sh pacedmind` deployed only the site and docs and sent `app.pacedmind.com` to the site (`app-placeholder.caddy`). Now that the app runs, `deploy.sh` refuses that flag, since it would hide the app.

A checkout without the hosted web mode (`src/server/supabase.ts`) refuses to deploy the app: it would put a planner without sign-in on the internet.

Every deploy replaces what's live with the checkout it runs from, so it refuses one that doesn't contain master (it would take work that already landed there off the server) or that has uncommitted changes (they'd go live without being in git). Land the work on master first; `ALLOW_UNLANDED=1` skips the check, for a test.

New migrations go out with `npx supabase db push` before a deploy that needs them.

## 4. Release the desktop app

The site's download buttons lead to `/download/windows` and `/download/mac`, which the Caddyfile sends on to `PacedMind-Windows.exe` and `PacedMind-macOS.dmg` in `/srv/pacedmind/download`. `npm run release` builds each one on its own system and uploads it there, so run it once on a PC and once on a Mac:

```bash
npm run release -- pacedmind         # build, package and upload
npm run release -- --no-upload       # only build and package, into dist/release
```

- **Windows:** `PacedMind-Windows.exe`, an installer made with electron-builder. It installs for the current user where `npm run desktop` does, closes a running PacedMind first and keeps the data. It isn't signed, so SmartScreen asks once before it runs.
- **macOS:** `PacedMind-macOS.dmg`, one app for Apple silicon and Intel, signed with your Developer ID and notarized by Apple, the disk image too. Once, on the Mac: put your **Developer ID Application** certificate in the login keychain (Xcode → Settings → Accounts → Manage Certificates), and store the notarization credentials under the name `PacedMind` with `xcrun notarytool store-credentials PacedMind --apple-id <your Apple ID> --team-id <your team ID>` (it asks for an app-specific password from account.apple.com). Both stay in the keychain. `PACEDMIND_SIGN_IDENTITY` picks a certificate if there are several, and `PACEDMIND_NOTARY_PROFILE` another profile name.
- The upload reaches the server the way `deploy.sh` does: the `pacedmind` name, or `ubuntu@<server>` with `PACEDMIND_KEY`. On each computer, keep the key in `~/.ssh` and `chmod 600` it.

It creates the folder the first time, checks each upload against its checksum before switching to it, and keeps the previous file as `<name>.old`. `deploy.sh` never touches that folder. Until the first release, the buttons end on the site's 404 page. Like a deploy, an upload refuses a checkout that doesn't contain master or has uncommitted changes (`--allow-unlanded` skips that, for a test); `npm run desktop` refuses one that doesn't contain master, since the installed app is shared by every checkout on the computer.

## 5. Visitor statistics (Umami)

Umami counts visits to the site and the docs without cookies, so there's no consent banner. It runs on the VPS from `umami/compose.yml` (Docker, with its own Postgres) on `127.0.0.1:3001`, and only Caddy reaches it:

- `pacedmind.com/stats/script.js` and `/stats/api/send` pass through to Umami, so the tracker is first-party. The site and the docs load it only on `pacedmind.com`, and only once the website's id is set (`SITE.analytics` in `site/lib/site.ts` and `analytics` in `docs/src/lib/shared.ts`, the same id).
- Clicks on the download buttons are counted as `Download` events, with the system (`os`) and where the button is (`place`).
- The dashboard is `https://stats.pacedmind.com`.

Install once, and update later, with the same two commands (Docker comes from Ubuntu's repositories; the secrets are generated on the VPS into the root-only `/opt/umami/.env` and never leave it):

```bash
scp deploy/umami/compose.yml pacedmind:/tmp/umami-compose.yml
ssh pacedmind 'sudo sh -s' < deploy/umami/install.sh
```

Umami's first login is `admin` / `umami`, so change that password before the dashboard goes public. Until then, open it through a tunnel: `ssh -N -L 127.0.0.1:3940:127.0.0.1:3001 pacedmind`, then http://localhost:3940. There, change the password (**Settings → Profile**), and add the website (**Settings → Websites → Add website**: PacedMind, domain `pacedmind.com`). Put its **Website ID** in both configs above. The `stats` DNS records (step 0) must exist before `deploy.sh` installs the Caddyfile with `stats.pacedmind.com` in it, or Caddy can't get its certificate.

- To leave your own visits out, run `localStorage.setItem("umami.disabled", 1)` in the browser's console on pacedmind.com.
- Back up: `sudo docker exec umami-db-1 pg_dump -U umami umami > umami.sql`.

## Firewall (optional)

Only SSH (22), and Caddy's 80 and 443 once deployed, listen on public addresses. To also block everything else, run on the server:

```bash
sudo ufw allow OpenSSH && sudo ufw allow 80,443/tcp && sudo ufw --force enable
```

## Files

- `provision.sh`: the one-time server setup.
- `deploy.sh`: builds and switches the app, uploads the static parts, installs the Caddy config.
- `pacedmind-web.service`: the systemd unit (`HOSTNAME=127.0.0.1`, `PORT=3000`, `ORGANIZER_MODE=web`, `ORGANIZER_PUBLIC_ORIGIN=https://app.pacedmind.com`, `TZ=Europe/Warsaw`).
- `Caddyfile`: the server's whole Caddy config, for Caddy 2.6.2 as Ubuntu ships it: HTTPS, `www` and `http://` to `https://pacedmind.com`, one URL per page (no `.html`, no trailing slash), the site's and the docs' 404 pages with a 404 status, caching, and the docs' Markdown copies, search index and navigation files marked `noindex`. The docs need their own `/docs` block because a docs section has both `views.html` and a `views/` folder. `/download/*` serves the installers from `/srv/pacedmind/download` (step 4). `/stats/script.js` and `/stats/api/send` go to Umami, and `stats.pacedmind.com` is its dashboard (step 5). `/github.json` is the star count (step 3).
- `app.caddy` and `app-placeholder.caddy`: what `app.pacedmind.com` does, the app or a redirect to the site; `deploy.sh` installs one of them as `/etc/caddy/app.caddy`.
- `github-stars.mjs`, `pacedmind-github.service` and `pacedmind-github.timer`: the site's GitHub star count, refreshed every ten minutes as the `pacedmind` user (step 3).
- `umami/compose.yml` and `umami/install.sh`: the visitor statistics (step 5), which `deploy.sh` leaves alone.
- `openai-challenge.sh`: puts the domain-verification token from OpenAI's plugin portal into `web.env` (`ORGANIZER_OPENAI_APPS_CHALLENGE`) and restarts the app, or takes it out with `--remove`.
- `directory/`: listing PacedMind in OpenAI's and Claude's directories: each portal's fields, the review account and test cases, and the tools' annotations.
- `optional-mfa.md`: rolling out optional two-factor setup.

The steps for Google Search Console and Bing Webmaster Tools are in `site/deploy/README.md`.
