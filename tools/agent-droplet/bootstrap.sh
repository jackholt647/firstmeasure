#!/usr/bin/env bash
# Sets up the agent droplet (fm-agents-1). Run as root from a copy of tools/agent-droplet:
#   sudo bash bootstrap.sh            (idempotent; safe to run again after editing these files)
# What it does and why: docs/architecture/agent-droplet.md.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT=/srv/agents
AGENT=agent
AGENT_HOME=$ROOT/home/$AGENT
NODE_MAJOR=22          # dev hosts run Node 22 (v22.23.x) and PHP 8.3
PLAYWRIGHT_VERSION=1.59.1
export DEBIAN_FRONTEND=noninteractive

log() { printf '\n== %s\n' "$*"; }

log "Volume at $ROOT"
VOL_DEV=$(readlink -f /dev/disk/by-id/scsi-0DO_Volume_fm-agents-data 2>/dev/null || true)
if [ -n "$VOL_DEV" ]; then
  UUID=$(blkid -s UUID -o value "$VOL_DEV")
  if systemctl list-unit-files mnt-fm_agents_data.mount >/dev/null 2>&1 && [ -f /etc/systemd/system/mnt-fm_agents_data.mount ]; then
    systemctl disable --now mnt-fm_agents_data.mount || true
    rm -f /etc/systemd/system/mnt-fm_agents_data.mount
    systemctl daemon-reload
    rmdir /mnt/fm_agents_data 2>/dev/null || true
  fi
  mkdir -p $ROOT
  grep -q "$UUID" /etc/fstab || echo "UUID=$UUID $ROOT ext4 defaults,nofail,discard,noatime 0 2" >> /etc/fstab
  systemctl daemon-reload
  mountpoint -q $ROOT || mount $ROOT
fi
mountpoint -q $ROOT || { echo "$ROOT is not mounted; refusing to continue"; exit 1; }

log "Swap"
if ! swapon --show | grep -q /swapfile; then
  fallocate -l 8G /swapfile && chmod 600 /swapfile && mkswap /swapfile >/dev/null && swapon /swapfile
  grep -q /swapfile /etc/fstab || echo "/swapfile none swap sw 0 0" >> /etc/fstab
fi

log "Packages"
apt-get update -q
apt-get -yq -o Dpkg::Options::=--force-confold upgrade
apt-get install -yq git git-lfs tmux jq rsync curl wget ca-certificates gnupg build-essential unzip zip \
  python3 python3-venv python3-pip ripgrep fd-find htop ncdu sqlite3 sshfs fuse3 fail2ban unattended-upgrades \
  php8.3-cli php8.3-common php8.3-curl php8.3-mbstring php8.3-opcache php8.3-pgsql php8.3-readline \
  php8.3-sqlite3 php8.3-xml php8.3-fpm debian-keyring debian-archive-keyring apt-transport-https

if ! node -v 2>/dev/null | grep -q "^v$NODE_MAJOR\."; then
  curl -fsSL https://deb.nodesource.com/setup_$NODE_MAJOR.x | bash -
  apt-get install -yq nodejs
fi

if ! command -v caddy >/dev/null; then
  curl -1sLf https://dl.cloudsmith.io/public/caddy/stable/gpg.key | gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
  curl -1sLf https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt > /etc/apt/sources.list.d/caddy-stable.list
  apt-get update -q && apt-get install -yq caddy
fi

log "Agent user"
mkdir -p $ROOT/home
if ! id $AGENT >/dev/null 2>&1; then
  useradd --create-home --home-dir $AGENT_HOME --shell /bin/bash $AGENT
fi
usermod -aG sudo $AGENT
echo "$AGENT ALL=(ALL) NOPASSWD:ALL" > /etc/sudoers.d/90-agent && chmod 440 /etc/sudoers.d/90-agent
install -d -m 700 -o $AGENT -g $AGENT $AGENT_HOME/.ssh
if [ -f /root/.ssh/authorized_keys ] && [ ! -s $AGENT_HOME/.ssh/authorized_keys ]; then
  grep fm-agents-1 /root/.ssh/authorized_keys > $AGENT_HOME/.ssh/authorized_keys || cp /root/.ssh/authorized_keys $AGENT_HOME/.ssh/authorized_keys
  chown $AGENT:$AGENT $AGENT_HOME/.ssh/authorized_keys && chmod 600 $AGENT_HOME/.ssh/authorized_keys
fi
loginctl enable-linger $AGENT

log "Layout under $ROOT"
for d in work repos logs logs/cleanup logs/experiments cache cache/npm cache/ms-playwright cache/node_modules \
         experiments experiments/index status; do
  install -d -o $AGENT -g $AGENT -m 2775 $ROOT/$d
done
install -d -m 755 /etc/fm-agents /etc/caddy/experiments
chown root:$AGENT /etc/caddy/experiments && chmod 2775 /etc/caddy/experiments
ln -sfn $ROOT/work $AGENT_HOME/code
chown -h $AGENT:$AGENT $AGENT_HOME/code

log "Shared caches and shell environment"
install -m 644 "$HERE/etc/profile.d/fm-agents.sh" /etc/profile.d/fm-agents.sh
grep -q fm-agents.sh /etc/bash.bashrc || printf '\n# FirstMate agent droplet: caches and disk warnings\n[ -r /etc/profile.d/fm-agents.sh ] && . /etc/profile.d/fm-agents.sh\n' >> /etc/bash.bashrc
cat > /etc/npmrc <<EOF
cache=$ROOT/cache/npm
EOF

log "Tools"
for f in "$HERE"/bin/*; do install -m 755 "$f" /usr/local/bin/; done
npm install -g --no-fund --no-audit @openai/codex >/dev/null
PLAYWRIGHT_BROWSERS_PATH=$ROOT/cache/ms-playwright npx -y playwright@$PLAYWRIGHT_VERSION install --with-deps chromium
chown -R $AGENT:$AGENT $ROOT/cache

log "SSH, fail2ban, security updates"
install -m 644 "$HERE/etc/ssh/sshd_config.d/10-fm-agents.conf" /etc/ssh/sshd_config.d/10-fm-agents.conf
sshd -t && systemctl reload ssh
install -m 644 "$HERE/etc/fail2ban/jail.d/fm-agents.conf" /etc/fail2ban/jail.d/fm-agents.conf
systemctl enable --now fail2ban && systemctl restart fail2ban
cat > /etc/apt/apt.conf.d/20auto-upgrades <<'EOF'
APT::Periodic::Update-Package-Lists "1";
APT::Periodic::Unattended-Upgrade "1";
APT::Periodic::AutocleanInterval "7";
EOF
cat > /etc/apt/apt.conf.d/52fm-agents-unattended <<'EOF'
Unattended-Upgrade::Automatic-Reboot "true";
Unattended-Upgrade::Automatic-Reboot-Time "09:30";
Unattended-Upgrade::Remove-Unused-Kernel-Packages "true";
EOF
systemctl enable --now unattended-upgrades

log "Housekeeping timers"
for f in "$HERE"/systemd/*; do install -m 644 "$f" /etc/systemd/system/; done
for c in disk-watch.conf jack-pc.conf experiments.conf; do
  [ -f /etc/fm-agents/$c ] || install -m 644 "$HERE/etc/fm-agents/$c" /etc/fm-agents/$c
done
systemctl daemon-reload
systemctl enable --now fm-disk-watch.timer fm-agents-cleanup.timer fm-experiments-index.timer fm-jack-pc-mount.timer

log "Experimental hosting (Caddy)"
install -m 644 "$HERE/etc/caddy/Caddyfile" /etc/caddy/Caddyfile
usermod -aG $AGENT caddy
[ -f $ROOT/experiments/registry.json ] || { echo '{}' > $ROOT/experiments/registry.json; chown $AGENT:$AGENT $ROOT/experiments/registry.json; }
/usr/local/bin/fm-experiment index >/dev/null
rm -f $ROOT/logs/experiments/access.log
sudo -u caddy caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile >/dev/null
systemctl enable caddy && systemctl restart caddy

log "Jack's PC (reverse tunnel user and mount point)"
if ! id jackpc >/dev/null 2>&1; then useradd --system --create-home --home-dir /var/lib/jackpc --shell /usr/sbin/nologin jackpc; fi
install -d -m 700 -o jackpc -g jackpc /var/lib/jackpc/.ssh
install -d -m 750 -o $AGENT -g $AGENT /mnt/jack-pc
[ -f /etc/fm-agents/jack-pc_ed25519 ] || ssh-keygen -q -t ed25519 -N "" -C "fm-agents-1 sshfs to jack-pc" -f /etc/fm-agents/jack-pc_ed25519
chmod 600 /etc/fm-agents/jack-pc_ed25519
grep -q '^user_allow_other' /etc/fuse.conf || echo user_allow_other >> /etc/fuse.conf

log "Done"
df -h / $ROOT
