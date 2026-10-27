#!/usr/bin/env bash
# measure-internal dev lane, host side (dev legacy only). Driven by lane.mjs; see
# docs/architecture/dev-lanes.md. Never edit releases by hand: every release is
# built from one commit's public/measure/internal and checked file by file.
#
#   lane-host.sh status
#   lane-host.sh deploy <payload dir>     payload/lane-manifest.json + payload/public/measure/internal/...
#   lane-host.sh rollback [<sha>]         previous release, or the named one
#   lane-host.sh install                  serve /measure/internal/ from the lane (nginx)
#   lane-host.sh uninstall                serve it from the platform release again
set -euo pipefail

LANE=/opt/firstmeasure/lanes/measure-internal
PLATFORM=/opt/firstmeasure/current
SITE=/etc/nginx/sites-available/firstmeasure-development
LANE_CONF=/etc/nginx/conf.d/firstmeasure-lanes.conf
KEEP=12
HOST_HEADER=dev.1m8.ai

say() { printf '%s\n' "$*" >&2; }
die() { say "lane-host: $*"; exit 1; }

[ "$(hostname)" = firstmeasure-development-compatibility ] || die "not the dev legacy host ($(hostname))"
mkdir -p "$LANE/releases" "$LANE/records" "$LANE/incoming"
exec 9>"$LANE/.lock"
flock -w 120 9 || die "another lane deploy holds $LANE/.lock"

current_sha() { [ -L "$LANE/current" ] && basename "$(readlink "$LANE/current")" || true; }
previous_sha() { [ -L "$LANE/previous" ] && basename "$(readlink "$LANE/previous")" || true; }
serving() { [ -f "$LANE_CONF" ] && grep -q '^ *~\^/measure/internal/ ' "$LANE_CONF" && grep -q 'root \$fm_public_root;' "$SITE" && echo lane || echo platform; }

swap_link() { # swap_link <name> <target>: atomic rename over the old link
  ln -sfn "$2" "$LANE/.$1.tmp"
  mv -T "$LANE/.$1.tmp" "$LANE/$1"
}

# Sibling paths the editor's relative includes reach (portal, v1, includes,
# libraries, storage, ...) point into whatever platform release is current.
link_siblings() {
  local pub=$1/public e name
  for e in "$PLATFORM"/public/* "$PLATFORM"/public/.[!.]*; do
    [ -e "$e" ] || continue
    name=$(basename "$e")
    [ "$name" = measure ] && continue
    ln -sfn "$PLATFORM/public/$name" "$pub/$name"
  done
  for e in "$PLATFORM"/public/measure/*; do
    [ -e "$e" ] || continue
    name=$(basename "$e")
    [ "$name" = internal ] && continue
    ln -sfn "$PLATFORM/public/measure/$name" "$pub/measure/$name"
  done
}

probe() { # probe <path> -> "<status> <lane header>"
  curl -s -o /dev/null -m 20 -H "Host: $HOST_HEADER" -w '%{http_code} %header{x-firstmate-lane}' "http://127.0.0.1$1" || echo "000 "
}

# Readiness: a static file comes back with the release's bytes and lane header,
# and the PHP entry points answer as they did before the switch (never 5xx).
ready() { # ready <sha> <static probe> <expected sha256> <before statuses>
  local sha=$1 file=$2 want=$3 before=$4 got status header i=0
  [ "$(serving)" = lane ] || return 0
  while :; do
    got=$(curl -s -m 20 -H "Host: $HOST_HEADER" "http://127.0.0.1/measure/internal/$file" | sha256sum | cut -d' ' -f1)
    read -r status header <<<"$(probe "/measure/internal/$file")"
    [ "$status" = 200 ] && [ "$header" = "measure-internal $sha" ] && [ "$got" = "$want" ] && break
    i=$((i+1)); [ $i -ge 5 ] && { say "probe $file: $status '$header' sha256 $got"; return 1; }
    sleep 1
  done
  local after; after=$(php_statuses)
  [ "$after" = "$before" ] && return 0
  say "PHP entry points before: $before"; say "PHP entry points after:  $after"
  case "$after" in *' 5'??*|5??*) return 1;; esac
  return 0
}
php_statuses() {
  local out="" p
  for p in /measure/internal/ /measure/internal/editor.php /measure/internal/backend_login.php; do
    out="$out$(probe "$p" | cut -d' ' -f1) "
  done
  printf '%s' "${out% }"
}

record() { # record <json>: one file per release activation, newest last
  local f="$LANE/records/$(date -u +%Y%m%dT%H%M%SZ)-$2.json"
  printf '%s\n' "$1" >"$f"
  printf 'LANE-RECORD %s\n' "$1"
}

prune() {
  local cur prev keep=0 d
  cur=$(current_sha); prev=$(previous_sha)
  for d in $(ls -1t "$LANE/releases"); do
    case "$d" in *.building) continue;; esac
    keep=$((keep+1))
    [ "$d" = "$cur" ] || [ "$d" = "$prev" ] || [ $keep -le $KEEP ] || rm -rf "${LANE:?}/releases/$d"
  done
  find "$LANE/records" -name '*.json' -mtime +30 -delete 2>/dev/null || true
}

cmd_status() {
  local cur; cur=$(current_sha)
  printf 'LANE-STATUS {"lane":"measure-internal","current":"%s","previous":"%s","serving":"%s","platform_release":"%s","releases":%s}\n' \
    "$cur" "$(previous_sha)" "$(serving)" "$(basename "$(readlink -f "$PLATFORM")")" \
    "$(ls -1t "$LANE/releases" | grep -v building | head -20 | python3 -c 'import sys,json;print(json.dumps(sys.stdin.read().split()))')"
}

cmd_deploy() {
  local payload=$1 started; started=$(date +%s%3N)
  local manifest=$payload/lane-manifest.json
  [ -f "$manifest" ] || die "no manifest"
  local sha; sha=$(python3 -c 'import json,sys;print(json.load(open(sys.argv[1]))["sha"])' "$manifest")
  [[ "$sha" =~ ^[0-9a-f]{40}$ ]] || die "bad sha $sha"
  local cur prev; cur=$(current_sha)
  if [ "$cur" = "$sha" ]; then
    say "measure-internal $sha is already live"
    record "{\"lane\":\"measure-internal\",\"sha\":\"$sha\",\"status\":\"unchanged\",\"previous\":\"$(previous_sha)\"}" "$sha"
    return 0
  fi

  # Build: hard links from the live release for unchanged files, the payload
  # for the rest, then every file is checked against the commit's hashes.
  local build=$LANE/releases/$sha.building
  rm -rf "$build"; mkdir -p "$build/public/measure"
  if [ -n "$cur" ] && [ -d "$LANE/releases/$cur/public/measure/internal" ]; then
    cp -al "$LANE/releases/$cur/public/measure/internal" "$build/public/measure/internal"
  else
    mkdir -p "$build/public/measure/internal"
  fi
  python3 - "$manifest" "$payload" "$build" <<'PY'
import hashlib, json, os, shutil, sys
manifest, payload, build = sys.argv[1:4]
m = json.load(open(manifest))
want = m["files"]
root = os.path.join(build, "public/measure/internal")
src = os.path.join(payload, "public/measure/internal")
for rel in m.get("sent", []):
    dest = os.path.join(root, rel)
    if os.path.lexists(dest): os.unlink(dest)
    os.makedirs(os.path.dirname(dest), exist_ok=True)
    shutil.copy2(os.path.join(src, rel), dest)
have = set()
for d, dirs, files in os.walk(root):
    for f in files:
        have.add(os.path.relpath(os.path.join(d, f), root).replace(os.sep, "/"))
for rel in sorted(have - set(want)):
    os.unlink(os.path.join(root, rel))
for d, dirs, files in sorted(os.walk(root, topdown=False)):
    if d != root and not os.listdir(d): os.rmdir(d)
bad = []
for rel, digest in want.items():
    p = os.path.join(root, rel)
    if not os.path.isfile(p) or os.path.islink(p):
        bad.append(rel); continue
    h = hashlib.sha256()
    with open(p, "rb") as fh:
        for chunk in iter(lambda: fh.read(1 << 20), b""): h.update(chunk)
    if h.hexdigest() != digest: bad.append(rel)
if bad:
    print("LANE-NEED-FULL " + json.dumps(bad[:20]))
    sys.exit(3)
PY
  chown -R firstmeasure:firstmeasure "$build/public/measure/internal"
  find "$build/public/measure/internal" -type d -exec chmod 755 {} +
  find "$build/public/measure/internal" -type f -exec chmod 644 {} +
  link_siblings "$build"

  # Gate on the host: PHP lint of the changed PHP files.
  local f lint_failed=""
  while IFS= read -r f; do
    [ -n "$f" ] || continue
    php -l "$build/public/measure/internal/$f" >/dev/null 2>"$LANE/incoming/lint.err" || lint_failed="$lint_failed $f"
  done < <(python3 -c 'import json,sys;print("\n".join(json.load(open(sys.argv[1])).get("php_lint",[])))' "$manifest")
  if [ -n "$lint_failed" ]; then
    rm -rf "$build"
    die "PHP lint failed:$lint_failed"
  fi

  rm -rf "${LANE:?}/releases/$sha"
  mv "$build" "$LANE/releases/$sha"

  local probe_file probe_sha before
  probe_file=$(python3 -c 'import json,sys;print(json.load(open(sys.argv[1]))["probe"])' "$manifest")
  probe_sha=$(python3 -c 'import json,sys;m=json.load(open(sys.argv[1]));print(m["files"][m["probe"]])' "$manifest")
  before=$(php_statuses)

  [ -n "$cur" ] && swap_link previous "releases/$cur"
  swap_link current "releases/$sha"
  local status=live
  if ! ready "$sha" "$probe_file" "$probe_sha" "$before"; then
    status=rolled-back
    if [ -n "$cur" ]; then swap_link current "releases/$cur"; swap_link previous "releases/$sha"; fi
    say "readiness failed; measure-internal is back on ${cur:-nothing}"
  fi
  local ended; ended=$(date +%s%3N)
  local tree; tree=$(python3 -c 'import json,sys,hashlib;m=json.load(open(sys.argv[1]));print(hashlib.sha256("".join(k+" "+v+"\n" for k,v in sorted(m["files"].items())).encode()).hexdigest())' "$manifest")
  record "{\"lane\":\"measure-internal\",\"sha\":\"$sha\",\"status\":\"$status\",\"previous\":\"$cur\",\"serving\":\"$(serving)\",\"platform_release\":\"$(basename "$(readlink -f "$PLATFORM")")\",\"files\":$(python3 -c 'import json,sys;print(len(json.load(open(sys.argv[1]))["files"]))' "$manifest"),\"sent\":$(python3 -c 'import json,sys;print(len(json.load(open(sys.argv[1])).get("sent",[])))' "$manifest"),\"tree_sha256\":\"$tree\",\"host_ms\":$((ended-started)),\"activated_at\":\"$(date -u +%FT%TZ)\"}" "$sha"
  prune
  [ "$status" = live ]
}

cmd_rollback() {
  local to=${1:-$(previous_sha)} cur; cur=$(current_sha)
  [ -n "$to" ] && [ -d "$LANE/releases/$to" ] || die "no release to roll back to (${to:-none})"
  link_siblings "$LANE/releases/$to"
  swap_link current "releases/$to"
  [ -n "$cur" ] && swap_link previous "releases/$cur"
  record "{\"lane\":\"measure-internal\",\"sha\":\"$to\",\"status\":\"live\",\"previous\":\"$cur\",\"rollback\":true,\"activated_at\":\"$(date -u +%FT%TZ)\"}" "$to"
}

write_lane_conf() { # write_lane_conf lane|platform
  local line='    ~^/measure/internal/ /opt/firstmeasure/lanes/measure-internal/current/public;'
  [ "$1" = lane ] || line="#$line"
  cat >"$LANE_CONF.tmp" <<EOF
# Dev lanes (docs/architecture/dev-lanes.md, tools/dev-push/lanes/measure-internal/).
# The site's root is \$fm_public_root. To serve the editor from the platform
# release again, comment out the /measure/internal/ line and run nginx -s reload
# (or: lane.mjs uninstall).
map \$uri \$fm_public_root {
    volatile;
    default /opt/firstmeasure/current/public;
$line
}
map \$realpath_root \$fm_lane_header {
    volatile;
    default "";
    "~^/opt/firstmeasure/lanes/measure-internal/releases/(?<fm_lane_sha>[0-9a-f]{40})/public\$" "measure-internal \$fm_lane_sha";
}
add_header X-FirstMate-Lane \$fm_lane_header always;
EOF
  mv "$LANE_CONF.tmp" "$LANE_CONF"
}

reload_or_restore() { # reload_or_restore <backup dir>
  if nginx -t 2>"$LANE/incoming/nginx-t.err"; then
    systemctl reload nginx; return 0
  fi
  cat "$LANE/incoming/nginx-t.err" >&2
  cp -a "$1/site" "$SITE"
  if [ -f "$1/lane.conf" ]; then cp -a "$1/lane.conf" "$LANE_CONF"; else rm -f "$LANE_CONF"; fi
  nginx -t && systemctl reload nginx
  die "nginx -t failed; configuration restored"
}

cmd_install() {
  local cur; cur=$(current_sha)
  [ -n "$cur" ] || die "deploy a release first"
  local bak; bak=$LANE/nginx-backup/$(date -u +%Y%m%dT%H%M%SZ); mkdir -p "$bak"
  cp -a "$SITE" "$bak/site"; [ -f "$LANE_CONF" ] && cp -a "$LANE_CONF" "$bak/lane.conf"
  local before; before=$(php_statuses)
  link_siblings "$LANE/releases/$cur"
  write_lane_conf lane
  sed -i 's#^\( *\)root /opt/firstmeasure/current/public;#\1root $fm_public_root;#' "$SITE"
  grep -q 'root \$fm_public_root;' "$SITE" || { cp -a "$bak/site" "$SITE"; die "could not set the site root"; }
  reload_or_restore "$bak"
  local probe_file probe_sha
  probe_file=audio/ding.mp3
  probe_sha=$(sha256sum "$LANE/releases/$cur/public/measure/internal/$probe_file" | cut -d' ' -f1)
  if ! ready "$cur" "$probe_file" "$probe_sha" "$before"; then
    write_lane_conf platform; systemctl reload nginx
    die "lane not ready after install; serving the platform copy again"
  fi
  say "measure-internal is served from the lane ($cur)"
}

cmd_uninstall() {
  [ -f "$LANE_CONF" ] || die "lane not installed"
  write_lane_conf platform
  nginx -t && systemctl reload nginx
  say "measure-internal is served from the platform release again"
}

case "${1:-}" in
  status) cmd_status;;
  deploy) cmd_deploy "$2";;
  rollback) cmd_rollback "${2:-}"; cmd_status;;
  install) cmd_install; cmd_status;;
  uninstall) cmd_uninstall; cmd_status;;
  *) die "usage: lane-host.sh status|deploy <payload>|rollback [sha]|install|uninstall";;
esac
