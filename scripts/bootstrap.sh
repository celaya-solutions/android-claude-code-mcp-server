#!/data/data/com.termux/files/usr/bin/bash
# Bootstrap: configure Debian rootfs DNS, install Node + Claude Code inside it,
# and create a thin `claude` wrapper in Termux's $PATH.
set -eu
cd "$HOME"
: > bootstrap.log
exec >>bootstrap.log 2>&1
echo "=== bootstrap started at $(date) ==="

ROOT="$PREFIX/var/lib/proot-distro/installed-rootfs/debian"
[ -d "$ROOT" ] || { echo "missing rootfs at $ROOT"; exit 2; }

echo "-- writing DNS + hosts --"
printf 'nameserver 8.8.8.8\nnameserver 1.1.1.1\n' > "$ROOT/etc/resolv.conf"
printf '127.0.0.1 localhost\n' > "$ROOT/etc/hosts"

echo "-- login sanity --"
proot-distro login debian -- bash -lc 'cat /etc/os-release | head -3; id; which apt'

echo "-- apt update + install base packages --"
proot-distro login debian -- bash -lc 'export DEBIAN_FRONTEND=noninteractive; apt-get update -y && apt-get install -y --no-install-recommends ca-certificates curl gnupg git'

echo "-- install Node 24 via NodeSource --"
proot-distro login debian -- bash -lc 'export DEBIAN_FRONTEND=noninteractive; curl -fsSL https://deb.nodesource.com/setup_24.x -o /tmp/ns.sh && bash /tmp/ns.sh && apt-get install -y nodejs && node --version && npm --version'

echo "-- install claude-code globally --"
proot-distro login debian -- bash -lc 'npm install -g @anthropic-ai/claude-code && claude --version'

echo "-- install openssh + gh in Termux --"
yes | pkg install -y openssh gh >/dev/null

echo "-- install gh in Debian (official CLI apt repo) --"
proot-distro login debian -- bash -lc '
  export DEBIAN_FRONTEND=noninteractive
  apt-get install -y --no-install-recommends wget >/dev/null
  install -dm 755 /etc/apt/keyrings
  curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg \
    | tee /etc/apt/keyrings/githubcli-archive-keyring.gpg > /dev/null
  chmod go+r /etc/apt/keyrings/githubcli-archive-keyring.gpg
  printf "deb [arch=%s signed-by=/etc/apt/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main\n" \
    "$(dpkg --print-architecture)" > /etc/apt/sources.list.d/github-cli.list
  apt-get update -y >/dev/null
  apt-get install -y gh >/dev/null
  gh --version | head -1
'

echo "-- configure git identity in both envs (override via GIT_USER_NAME/GIT_USER_EMAIL env) --"
GIT_USER_NAME="${GIT_USER_NAME:-Christopher Celaya}"
GIT_USER_EMAIL="${GIT_USER_EMAIL:-mr.christophercelaya@gmail.com}"
git config --global user.name "$GIT_USER_NAME"
git config --global user.email "$GIT_USER_EMAIL"
git config --global init.defaultBranch main
proot-distro login debian -- bash -lc "git config --global user.name '$GIT_USER_NAME'; git config --global user.email '$GIT_USER_EMAIL'; git config --global init.defaultBranch main"

echo "-- NOTE: gh auth login is interactive; run manually after bootstrap --"
echo "   termux:  gh auth login --web --hostname github.com --git-protocol https"
echo "   debian:  proot-distro login debian -- bash -lc 'gh auth login --web --hostname github.com --git-protocol https && gh auth setup-git'"

echo "-- create termux wrapper for claude --"
cat > "$PREFIX/bin/claude" <<'WRAP'
#!/data/data/com.termux/files/usr/bin/bash
# Transparent wrapper: run `claude` inside the Debian proot,
# with the Termux HOME bind-mounted to /root so paths line up.
# Any additional args are forwarded to claude.
exec proot-distro login debian --bind "$HOME:/root/termux-home" -- bash -lc "cd /root/termux-home && claude \"\$@\"" bash "$@"
WRAP
chmod +x "$PREFIX/bin/claude"

echo "=== bootstrap DONE at $(date) ==="
