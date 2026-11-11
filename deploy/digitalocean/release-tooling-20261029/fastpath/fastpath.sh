#!/usr/bin/env bash
# Production run fast path (FM-388; DEPLOYMENT.md "Production run fast path"): activate a release whose Node
# side equals the running one by switching `current` and reloading PHP-FPM on each host. No Node restart,
# no compatibility gate, no job wait, no load balancer withdrawal.
#
# Run from the run's folder (rel.tar.gz + release.json, as release.sh fetch leaves them), on fm-agents-1:
#   NEW=<full release id> OLD=<full rollback target id> bash fastpath.sh <step>
# Steps, in order:
#   decide    compare the rollback target's archive with rel.tar.gz (exit 3: use the full procedure)
#   (install on compat+worker and publish the channel with the run's release.sh install / release.sh publish,
#    exactly as for a full release)
#   web-install  the run's web_install.py on the six web nodes in parallel; installs only (NOT web_rollout.sh,
#                which restarts Node)
#   tools     copy release-node-fingerprint.py + switch-release-files.py to /root/fm-fastpath on all 8 hosts
#   check     switch-release-files.py --check on all 8 hosts; any refusal = full procedure, nothing switched
#   switch    compatibility, then the six web nodes one at a time, then the worker; stops at the first failure
#   verify    every host's current, readiness 10/10, served sha256 of the changed files over HTTPS
#   watch     5xx on every host's NGINX since ACTIVATED=HH:MM:SS vs the 30 min before, compat Node 500s/kills
#   rollback  the same switch back (OLD <- NEW) in the same order; republish the channel with the run's rollback/
set -uo pipefail
step=${1:?step}
: "${NEW:?full release id}" "${OLD:?full rollback target id}"
[[ ${#NEW} == 40 && ${#OLD} == 40 ]] || { echo "NEW and OLD must be full ids"; exit 2; }
HERE=$(cd "$(dirname "$0")" && pwd)
# The tools come from canonical (kept current by fm-clone-sync); this folder holds a copy for other machines.
TOOLS=${TOOLS:-/srv/agents/work/firstmeasure/deploy/digitalocean}
[[ -f $TOOLS/switch-release-files.py ]] || TOOLS=$HERE
OLD_ARCHIVE=${OLD_ARCHIVE:-old-${OLD:0:8}.tar.gz}
B=/var/tmp/fm-prod-release-20261020
COMPAT=$(fm-prod-host list | awk '$1=="compat"{print $2}')
WORKER=$(fm-prod-host list | awk '$1=="worker"{print $2}')
WEB=${WEB:-$(fm-prod-host list | awk '$1=="web"{print $2}')}
ORDER="$COMPAT $WEB $WORKER"
on() { local h=$1; shift; ssh -T -o ConnectTimeout=15 "root@$h" "$@"; }

case $step in
decide)
  [[ -f rel.tar.gz ]] || { echo "rel.tar.gz missing: run release.sh fetch first"; exit 2; }
  if [[ ! -f $OLD_ARCHIVE ]]; then
    fm-dev-host worker "cat $B/release-${OLD:0:8}.tar.gz" > "$OLD_ARCHIVE.part" && fm-dev-host worker "cat $B/release-${OLD:0:8}.tar.json" > "$OLD_ARCHIVE.json" || { echo "fetch the rollback target's archive into $OLD_ARCHIVE"; exit 2; }
    python3 -c "import json,hashlib,sys; m=json.load(open('$OLD_ARCHIVE.json')); h=hashlib.sha256(open('$OLD_ARCHIVE.part','rb').read()).hexdigest(); assert m['release_id']=='$OLD' and m['sha256']==h, (m['release_id'], h)" && mv "$OLD_ARCHIVE.part" "$OLD_ARCHIVE" || exit 2
  fi
  python3 "$TOOLS/release-node-fingerprint.py" compare "$OLD_ARCHIVE" rel.tar.gz > fastpath-decide.json; rc=$?
  python3 -c "import json; d=json.load(open('fastpath-decide.json')); print('FAST PATH' if d['fast_path'] else 'FULL PROCEDURE', '| server same:', d['server']['running']==d['server']['new'], '| dependencies same:', d['dependencies_same'], '| configuration same:', d['configuration_same'], '| changed:', d['changed'], '| Node files changed:', d['changed_node_count'], d['changed_node'][:10], '| unclassified readers:', d['unclassified_readers']); print('static:', *d['changed_static'], sep='\n  ')"
  exit $rc ;;
web-install)
  [[ -f web_install.py ]] && grep -q "$NEW" web_install.py || { echo "web_install.py for $NEW missing in $(pwd)"; exit 2; }
  for h in $WEB; do (on "$h" 'python3 -' < web_install.py 2>&1 | tail -1 | cut -c1-200 | sed "s/^/$h /") & done; wait
  for h in $WEB; do on "$h" "ls /opt/firstmeasure/releases/$NEW/.release-artifact.json >/dev/null" || { echo "STOP: $h not installed"; exit 2; }; done
  echo WEB_INSTALLED ;;
tools)
  for h in $ORDER; do
    on "$h" 'mkdir -p /root/fm-fastpath && chmod 700 /root/fm-fastpath'
    for f in release-node-fingerprint.py switch-release-files.py; do on "$h" "cat > /root/fm-fastpath/$f" < "$TOOLS/$f"; done
    want=$(cd "$TOOLS" && sha256sum release-node-fingerprint.py switch-release-files.py | awk '{print $1}' | tr '\n' ' ')
    got=$(on "$h" 'cd /root/fm-fastpath && sha256sum release-node-fingerprint.py switch-release-files.py' | awk '{print $1}' | tr '\n' ' ')
    [[ $want == "$got" ]] && echo "$h tools ok" || { echo "STOP: $h tools differ"; exit 2; }
  done ;;
check)
  bad=0
  for h in $ORDER; do
    out=$(on "$h" "python3 /root/fm-fastpath/switch-release-files.py --check $NEW $OLD" 2>&1); rc=$?
    echo "$h rc=$rc $(echo "$out" | tail -1 | cut -c1-300)"
    [[ $rc == 0 ]] || { bad=1; echo "$out" | head -5 | sed "s/^/  $h /"; }
  done
  [[ $bad == 0 ]] && echo CHECK_OK || { echo "CHECK_REFUSED: use the full procedure; nothing was switched"; exit 3; } ;;
switch)
  echo "ACTIVATED=$(date -u +%H:%M:%S)  (pass this to watch)"
  for h in $ORDER; do
    out=$(on "$h" "python3 /root/fm-fastpath/switch-release-files.py $NEW $OLD" 2>&1); rc=$?
    echo "$(date -u +%T) $h rc=$rc $(echo "$out" | tail -1 | cut -c1-400)"
    [[ $rc == 0 ]] || { echo "STOP: $h failed (it switched itself back). Hosts before it run $NEW: verify, or roll them back."; echo "$out" | sed "s/^/  /"; exit 1; }
  done
  echo "SWITCH_DONE $(date -u +%T)" ;;
verify)
  for h in $ORDER; do echo "$h $(on "$h" 'readlink -f /opt/firstmeasure/current | xargs basename')"; done
  for i in $(seq 1 10); do curl -s "https://app.1m8.ai/v1/health/ready?x=$RANDOM$i" | python3 -c "import json,sys; d=json.load(sys.stdin); print(d['ok'], d['release_id'][:8], d['instance_id'])"; done | sort | uniq -c
  echo "(readiness reports the release Node started in: $OLD on switched hosts; a pool node that booted since reports ${NEW:0:8})"
  python3 "$HERE/served.py" rel.tar.gz fastpath-decide.json ;;
watch)
  : "${ACTIVATED:?HH:MM:SS UTC from switch}"
  for h in $COMPAT $WEB; do echo "$h $(on "$h" "python3 - $ACTIVATED ${DAY:-}" < "$HERE/rates.py")"; done
  on "$COMPAT" "J=\$(journalctl -u firstmeasure-legacy --since '$(date -u +%F) $ACTIVATED' -o cat --no-pager); echo compat since $ACTIVATED: kills=\$(echo \"\$J\" | grep -cE 'missed its|exited \\(slot') node_500=\$(echo \"\$J\" | grep '\"statusCode\":500' | grep -vc trackAcq) pool_timeouts=\$(echo \"\$J\" | grep -c 'timeout exceeded when trying to connect') pid=\$(systemctl show firstmeasure-legacy -p MainPID --value)" ;;
rollback)
  for h in $ORDER; do
    out=$(on "$h" "python3 /root/fm-fastpath/switch-release-files.py $OLD $NEW" 2>&1); rc=$?
    echo "$(date -u +%T) $h rc=$rc $(echo "$out" | tail -1 | cut -c1-300)"
  done
  echo "Now republish the channel with the rollback target's archive (the run's rollback/release.sh publish), then verify." ;;
*) echo "unknown step $step"; exit 2 ;;
esac
