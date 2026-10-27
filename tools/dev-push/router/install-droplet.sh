#!/usr/bin/env bash
# Keeps the dev push router running on the dev sync droplet (docs/architecture/dev-lanes.md). Run as `dev` from the
# router's checkout (~/dev-push/app):
#   tools/dev-push/router/install-droplet.sh            install / update the supervisor
#   tools/dev-push/router/install-droplet.sh update <ref>  move the router's code to <ref> (a commit or origin branch) and restart
# The dev account has no lingering systemd session, so cron supervises: every minute it starts the router unless the
# running one holds its lock. A reboot or crash costs at most a minute. Never needs sudo.
set -euo pipefail
HOME_DIR=${DEV_PUSH_HOME:-$HOME/dev-push}
APP=$HOME_DIR/app
NODE_BIN=$HOME/.local/node/bin
mkdir -p "$HOME_DIR/state"
[ -f "$HOME_DIR/config.json" ] || echo '{}' > "$HOME_DIR/config.json"

restart() { pkill -f "tools/dev-push/router/server.mjs$" || true; pkill -f "tools/dev-push/router/server.mjs serve" || true; }

if [ "${1:-}" = update ]; then
  ref=${2:?ref}
  git -C "$APP" fetch -q origin "$ref" 2>/dev/null && target=FETCH_HEAD || target=$ref
  git -C "$APP" checkout -q -B router "$target"
  echo "router code at $(git -C "$APP" log --oneline -1)"
  restart
fi

line="* * * * * cd $APP && PATH=$NODE_BIN:/usr/local/bin:/usr/bin:/bin flock -n $HOME_DIR/router.lock node tools/dev-push/router/server.mjs serve >> $HOME_DIR/state/router.out 2>&1"
( crontab -l 2>/dev/null | grep -v 'tools/dev-push/router/server.mjs' ; echo "$line" ) | crontab -
# Keep the output log bounded.
if [ -f "$HOME_DIR/state/router.out" ] && [ "$(stat -c %s "$HOME_DIR/state/router.out")" -gt 52428800 ]; then mv "$HOME_DIR/state/router.out" "$HOME_DIR/state/router.out.1"; fi
echo "supervisor installed; the router starts within a minute (state: $HOME_DIR/state, log: state/router.log)"
