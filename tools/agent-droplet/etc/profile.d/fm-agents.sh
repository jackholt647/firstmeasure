# FirstMate agent droplet: shared caches and the disk warning. Read by login and interactive shells.
export FM_AGENTS_ROOT=/srv/agents
export PLAYWRIGHT_BROWSERS_PATH=/srv/agents/cache/ms-playwright
export npm_config_cache=/srv/agents/cache/npm
# submit.mjs's background GitHub mirror needs a GitHub login this machine does not have.
export DEV_PUSH_NO_MIRROR=1
case $- in
  *i*)
    if [ -z "${FM_DISK_WARNED:-}" ] && [ -s /srv/agents/status/disk-warning.txt ]; then
      printf '\033[1;31m%s\033[0m\n' "$(cat /srv/agents/status/disk-warning.txt)" >&2
      export FM_DISK_WARNED=1
    fi
    ;;
esac
