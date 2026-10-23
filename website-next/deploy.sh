#!/usr/bin/env bash
# Publish website-next to the hidden preview on the 1m8.ai website droplet.
# Usage: bash website-next/deploy.sh   (from the FirstMeasure checkout)
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
KEY="$HOME/.ssh/id_ed25519_firstmeasure_cluster_v2"
HOST=root@104.248.225.27
ROOT=/var/www/firstmate-website-next
REL="$(date -u +%Y%m%dT%H%M%SZ)"
SSH="ssh -i $KEY -o IdentitiesOnly=yes -o BatchMode=yes $HOST"
tar -C "$HERE" --exclude=./.data --exclude=./BRIEF.md --exclude=./deploy.sh -czf - . \
  | $SSH "set -e; mkdir -p $ROOT/releases/$REL; tar -xzf - -C $ROOT/releases/$REL; chown -R website-deploy:website-deploy $ROOT/releases/$REL; \
          ln -sfn $ROOT/releases/$REL $ROOT/current.tmp && mv -T $ROOT/current.tmp $ROOT/current; \
          ls -1dt $ROOT/releases/* | tail -n +6 | xargs -r rm -rf; echo published $REL"
