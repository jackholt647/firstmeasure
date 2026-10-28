#!/usr/bin/env bash
# Gives the agent droplet its own desktop: XFCE, Google Chrome and the Chrome Remote Desktop host, as a
# headless session for the `agent` user. Run as root after bootstrap.sh. The one-time authorization
# (Google's headless setup command plus a PIN) is Jack's: docs/architecture/agent-droplet.md, "Its own desktop".
set -euo pipefail
export DEBIAN_FRONTEND=noninteractive
AGENT=agent
AGENT_HOME=$(getent passwd $AGENT | cut -d: -f6)
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT

apt-get update -q
apt-get install -yq --no-install-recommends xfce4 xfce4-terminal xfce4-taskmanager thunar dbus-x11 xfonts-base \
  fonts-noto fonts-noto-color-emoji at-spi2-core xdg-utils
# No display manager: Remote Desktop starts its own X session.
systemctl disable --now lightdm gdm3 2>/dev/null || true

if ! command -v google-chrome >/dev/null; then
  wget -q -O "$TMP/chrome.deb" https://dl.google.com/linux/direct/google-chrome-stable_current_amd64.deb
  apt-get install -yq "$TMP/chrome.deb"
fi
if [ ! -x /opt/google/chrome-remote-desktop/start-host ]; then
  wget -q -O "$TMP/crd.deb" https://dl.google.com/linux/direct/chrome-remote-desktop_current_amd64.deb
  apt-get install -yq "$TMP/crd.deb"
fi

echo "exec /etc/X11/Xsession /usr/bin/xfce4-session" > /etc/chrome-remote-desktop-session
# Older host packages gate access by this group; current ones do not create it.
getent group chrome-remote-desktop >/dev/null && usermod -aG chrome-remote-desktop $AGENT

# Chrome in the desktop session keeps its own profile (logins agents use often, which Jack signs into over
# Remote Desktop) and listens for DevTools on 127.0.0.1:9222 so agents on the droplet can drive it.
install -d -o $AGENT -g $AGENT "$AGENT_HOME/.config/autostart"
cat > /usr/local/bin/fm-desktop-chrome <<'EOF'
#!/usr/bin/env bash
# Chrome for the droplet's desktop session: own profile, DevTools on 127.0.0.1:9222.
exec google-chrome --user-data-dir="$HOME/.config/chrome-agents" --remote-debugging-port=9222 \
  --no-first-run --no-default-browser-check "$@"
EOF
chmod 755 /usr/local/bin/fm-desktop-chrome
cat > "$AGENT_HOME/.config/autostart/fm-desktop-chrome.desktop" <<'EOF'
[Desktop Entry]
Type=Application
Name=Chrome (agents profile)
Exec=/usr/local/bin/fm-desktop-chrome
X-GNOME-Autostart-enabled=true
EOF
cat > /usr/share/applications/fm-desktop-chrome.desktop <<'EOF'
[Desktop Entry]
Type=Application
Name=Chrome (agents profile)
Exec=/usr/local/bin/fm-desktop-chrome %U
Icon=google-chrome
Categories=Network;WebBrowser;
EOF
chown -R $AGENT:$AGENT "$AGENT_HOME/.config"
echo "desktop ready; waiting for Jack's Remote Desktop authorization"
