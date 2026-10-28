#!/usr/bin/env bash
# Creates the router's repository on the dev sync droplet (docs/architecture/dev-lanes.md): the source of truth for
# canonical, the lane branches, the live shadow branches and the queue. Run as `dev` on the droplet:
#   tools/dev-push/router/install-repo.sh            create it (if missing) and (re)install its guard hook
#   tools/dev-push/router/install-repo.sh seed on    let pushes through unchecked (the one-time seed); `seed off` ends it
# Agents push only refs/heads/queue/<lane>/<agent>-<slug> (create, replace, delete). Everything else is moved by the
# router, which pushes locally with DEV_PUSH_ROUTER=1.
set -euo pipefail
REPO=${DEV_PUSH_REPO:-/home/dev/router/firstmeasure.git}

if [ "${1:-}" = seed ]; then
  if [ "${2:-}" = on ]; then touch "$REPO/allow-direct"; echo "seeding: any push accepted until 'seed off'"; else rm -f "$REPO/allow-direct"; echo "seeding off"; fi
  exit 0
fi

if [ ! -d "$REPO" ]; then
  mkdir -p "$(dirname "$REPO")"
  git init --quiet --bare "$REPO"
  git -C "$REPO" config receive.denyNonFastForwards false
  git -C "$REPO" config core.logAllRefUpdates true
  git -C "$REPO" config gc.auto 0
fi

cat > "$REPO/hooks/pre-receive" <<'HOOK'
#!/usr/bin/env bash
# Only the dev push router moves branches here. Ship with: node tools/dev-push/submit.mjs --wait
[ -f "$GIT_DIR/allow-direct" ] && exit 0
[ "${DEV_PUSH_ROUTER:-}" = 1 ] && exit 0
status=0
while read -r old new ref; do
  case "$ref" in
    refs/heads/queue/platform/*|refs/heads/queue/measure-internal/*|refs/heads/queue/regression/*)
      name=${ref#refs/heads/queue/*/}
      if ! printf '%s' "$name" | grep -Eq '^[a-z0-9][a-z0-9.-]{0,96}$'; then
        echo "dev-push: queue ref names are <agent>-<slug> in lowercase letters, digits, dots and dashes: $ref" >&2; status=1
      fi ;;
    *)
      echo "dev-push: only the router moves $ref. Ship with: node tools/dev-push/submit.mjs --wait (docs/architecture/dev-lanes.md)" >&2; status=1 ;;
  esac
done
exit $status
HOOK
chmod +x "$REPO/hooks/pre-receive"
echo "router repository ready at $REPO"
