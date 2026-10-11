#!/bin/sh
# Publishes the domain-verification token from OpenAI's plugin portal (MCPs → Connect → domain verification) at
# https://app.pacedmind.com/.well-known/openai-apps-challenge, which src/app/.well-known/openai-apps-challenge serves
# from ORGANIZER_OPENAI_APPS_CHALLENGE. Run from the repository (Git Bash on Windows):
#
#   deploy/openai-challenge.sh pacedmind <token>       (an ssh alias, or ubuntu@<server>)
#   deploy/openai-challenge.sh pacedmind --remove      once the portal no longer needs it
#
# It sets the one line in /srv/pacedmind/web.env, keeps the others, and restarts pacedmind-web (a few seconds
# without the app); Caddy isn't touched. deploy.sh rewrites web.env only when SUPABASE_URL is passed to it, which
# would drop the token: run this again after such a deploy. PACEDMIND_KEY picks the SSH key, as in deploy.sh.
set -eu

SERVER=${1:?"usage: deploy/openai-challenge.sh pacedmind <token> | --remove"}
TOKEN=${2:?"usage: deploy/openai-challenge.sh pacedmind <token> | --remove"}
KEY=${PACEDMIND_KEY:-$HOME/.ssh/pacedmind_vps}
[ -n "${PACEDMIND_KEY:-}" ] || [ -f "$KEY" ] || KEY=
remote() {
  if [ -n "$KEY" ]; then ssh -i "$KEY" -o BatchMode=yes "$SERVER" "$@"; else ssh -o BatchMode=yes "$SERVER" "$@"; fi
}

if [ "$TOKEN" = "--remove" ]; then
  line=
else
  # A token the environment file passes on as it is: the portal's are letters, digits and a few marks.
  case "$TOKEN" in
    *[!A-Za-z0-9._~:=+/-]*) echo "The token has characters this script won't pass on; set ORGANIZER_OPENAI_APPS_CHALLENGE by hand." >&2; exit 1 ;;
  esac
  line="ORGANIZER_OPENAI_APPS_CHALLENGE=$TOKEN"
fi

echo "> Updating web.env and restarting the app"
# The file keeps provision.sh's owner and mode (root:pacedmind, 640).
printf '%s\n' "$line" | remote 'set -e
  f=/srv/pacedmind/web.env
  read -r line || true
  new=$(mktemp)
  { sudo grep -v "^ORGANIZER_OPENAI_APPS_CHALLENGE=" "$f" || true; if [ -n "$line" ]; then printf "%s\n" "$line"; fi; } > "$new"
  sudo install -m 640 -o root -g pacedmind "$new" "$f"
  rm -f "$new"
  sudo systemctl restart pacedmind-web'

url=https://app.pacedmind.com/.well-known/openai-apps-challenge
for i in 1 2 3 4 5 6 7 8 9 10; do
  got=$(curl -s "$url" || true)
  if [ -z "$line" ] && [ "$(curl -s -o /dev/null -w '%{http_code}' "$url")" = 404 ]; then echo "Removed: $url answers 404."; exit 0; fi
  if [ -n "$line" ] && [ "$got" = "$TOKEN" ]; then echo "Published: $url answers the token."; exit 0; fi
  sleep 2
done
echo "$url doesn't answer as expected yet: check 'systemctl status pacedmind-web' on the server." >&2
exit 1
