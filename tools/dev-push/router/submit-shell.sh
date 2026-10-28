#!/usr/bin/env bash
# Forced command for submit-only keys on the dev sync droplet (docs/architecture/dev-lanes.md): agents on other
# machines may fetch from and push to the router's repository (its hook accepts only queue refs from them) and read
# the router's status; nothing else. Installed by: tools/dev-push/router/install-submit-key.sh "<public key line>" [<from ip>]
REPO=/home/dev/router/firstmeasure.git
cmd=${SSH_ORIGINAL_COMMAND:-}
case "$cmd" in
  "git-upload-pack '$REPO'" | "git-receive-pack '$REPO'" | "git-upload-pack $REPO" | "git-receive-pack $REPO" | "git-upload-pack '$REPO/'" | "git-receive-pack '$REPO/'")
    exec git-shell -c "$cmd" ;;
  "cat ~/dev-push/state/status.json" | "cat /home/dev/dev-push/state/status.json")
    exec cat /home/dev/dev-push/state/status.json ;;
  *)
    echo "dev-push submit-only key: allowed are git fetch/push of dev-sync-droplet:$REPO and the router status. Ship with: node tools/dev-push/submit.mjs --wait" >&2
    exit 1 ;;
esac
