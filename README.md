# android-claude-code-mcp-server

A Model Context Protocol (MCP) server that gives Claude Code (or any MCP host) a full
toolkit for driving an Android phone from a Mac — install Termux, stand up the real
`claude` CLI inside a Debian proot, reach the phone over SSH + Tailscale, and — via
Shizuku — execute commands at the Android **shell UID** (2000) for elevated UI and
system control without rooting the device.

The project was built end-to-end in one session with Claude Code running on an
unrooted Samsung Galaxy S24 (SM-S921U) against a macOS host. It works on any Android
14 aarch64 device whose bootloader state permits USB debugging.

## What you get

### 1. A legitimate path to run `claude` on the phone

Termux runs on Android's bionic libc; Claude Code ships a glibc-linked native
binary. The bootstrap installs a Debian trixie rootfs via `proot-distro` and puts
`claude` inside it, with a thin wrapper at `$PREFIX/bin/claude` that transparently
enters the proot so users just type `claude` at a Termux prompt.

### 2. SSH transport — no more `adb shell input text`

After the initial install, everything Claude needs to do on the phone happens over
SSH on port 8022. The MCP tools drop `adb`'s fragile `input text` channel entirely
for any post-bootstrap work. Paired with Tailscale, the phone is reachable from
anywhere under a stable hostname.

### 3. Shell-UID via Shizuku

Shizuku is started with USB adb and exposes a binder service. The `rish` helper
(shipped inside the Shizuku APK) connects to that binder from Termux and returns a
shell running as UID 2000 — the same privilege level as `adb shell`. A `droid-sh`
wrapper exposes that cleanly to Termux and the Debian proot:

```
droid-sh "input tap 540 1200"
droid-sh "pm install /sdcard/app.apk"
droid-sh "settings put system screen_brightness 200"
droid-sh "dumpsys activity activities"
droid-sh "am start -n com.android.settings/.Settings"
```

This is the maximum non-root capability on a locked-bootloader Samsung.

### 4. Full GitHub CLI

`gh` is installed in both Termux and the Debian proot with a shared credential
helper, so `git clone`/`push`/`pull`/`gh pr create` over HTTPS all work from any
Claude session on the phone.

## MCP tools (35)

### UI automation — the star of the show

| Tool | What it does |
|---|---|
| `ui_dump` | Snapshots the on-screen accessibility tree via `uiautomator dump`; returns flat node list with text/content-desc/resource-id/bounds. Supports `filter` and `clickableOnly`. |
| `ui_tap` | Taps an element by **selector** (text / textContains / contentDesc / resourceId / className / clickable). Falls back to raw x/y. Prefer this over coordinate taps. |
| `ui_type` | Types text into the currently focused field; optional `pressEnter`. |
| `ui_swipe` | Swipes from (x1,y1) to (x2,y2) over a duration. |
| `ui_wait_for` | Polls the accessibility tree until a selector matches (default 8s timeout). Use after `launch_app` or navigation. |
| `ui_screenshot` | Grabs a PNG; saves to `localPath` OR returns the image inline (base64) so Claude can view it directly. |
| `ui_back`, `ui_home` | Android BACK / HOME keys. |

### App / package / permission

| Tool | What it does |
|---|---|
| `launch_app` | Starts an app by package. Auto-resolves the LAUNCHER activity (avoids Samsung's resolver dialog). Supports URL deep links for VIEW intents (great for `com.android.chrome` + `http://…`). |
| `list_apps` | `pm list packages`, with `thirdPartyOnly` and `filter`. |
| `install_apk_url` | Downloads an APK from a URL, caches it, `adb install -r`. |
| `install_apk` | Installs an APK already on disk. |
| `uninstall_app`, `grant_permission` | Standard pm operations. |

### Observability

| Tool | What it does |
|---|---|
| `list_notifications` | Parses `dumpsys notification --noredact` into `{pkg, title, text}` entries. |
| `current_activity` | Foreground package + activity. |
| `device_info` | Model, manufacturer, Android version, SDK, CPU ABI. |
| `list_devices` | `adb devices -l`. |

### SSH transport (preferred post-bootstrap)

| Tool | What it does |
|---|---|
| `ssh_info` | Shows target + key the server uses. |
| `ssh_termux` | Run a command inside Termux over SSH on port 8022. |
| `ssh_debian` | Run a command inside the Debian proot (glibc userland). |
| `claude_run` | One-shot `claude -p <prompt>` inside the Debian proot as the non-root `dev` user — returns stdout. |

### Bootstrap + recovery

| Tool | What it does |
|---|---|
| `install_termux` | Downloads the Termux APK from GitHub and installs it. |
| `open_termux`, `termux_type`, `termux_run_command` | Drive Termux before SSH is up. |
| `setup_claude_code_in_termux` | Walks the pkg-install sequence. |
| `start_shizuku` | Restarts Shizuku's shell-UID service via USB adb (needed after every reboot — Android 14 rotates Wireless Debugging TLS keys). |
| `adb_path` | Shows which adb binary the server is using. |

### Low-level (escape hatches)

| Tool | What it does |
|---|---|
| `shell` | Raw `adb shell` pass-through. |
| `push`, `pull` | File transfer. |
| `screencap`, `keyevent`, `input_text` | Pre-uiautomator UI primitives. |

## Runnable examples

Each `examples/*.md` is a self-contained brief you can paste into Claude Code.

1. **[Read notifications and summarize](examples/01-read-notifications.md)** —
   one tool call, Claude summarizes what's happening on your phone.
2. **[Drive Settings by text selector](examples/02-ui-drive-settings.md)** —
   navigate Samsung's Settings app without a single hard-coded coordinate.
3. **[Build and serve a webapp from the phone](examples/03-build-and-serve.md)**
   — phone-Claude writes a full-stack demo, runs it in Termux, opens it in
   phone-Chrome.

## Architecture

```
Mac (MCP host)
   |
   |-- adb (USB) ---------------+------ bootstrap only
   |                            |
   |-- ssh:8022 (Tailscale) ----+
                                |
                                v
               +-------------- phone --------------+
               |  Termux (UID u0_a386)             |
               |    sshd                           |
               |    bin/claude wrapper             |
               |    bin/droid-sh -> rish ---+      |
               |                            |      |
               |  proot-distro (Debian)     |      |
               |    claude (native)         |      |
               |    droid-sh -> ssh         |      |
               |      u0_a386@localhost     |      |
               |                            |      |
               |  Shizuku (shell UID via    v      |
               |    libshizuku.so) <----- binder   |
               +-----------------------------------+
```

## Quickstart

### Prerequisites on the Mac

- `adb` (Android platform tools). The server autodetects it at
  `~/Library/Android/sdk/platform-tools/adb`, `/opt/homebrew/bin/adb`, or
  `/usr/local/bin/adb`. Override with the `ADB_PATH` env var.
- `node` 20+
- An SSH key at `~/.ssh/id_ed25519` (or override via `ANDROID_MCP_SSH_KEY`).

### Prerequisites on the phone

- Developer Options enabled
- USB debugging authorized for your Mac
- Enough free storage for Debian (~500 MB after install)

### One-command bootstrap

```bash
git clone https://github.com/celaya-solutions/android-claude-code-mcp-server.git
cd android-claude-code-mcp-server
npm install
node bin/cli.js init
```

That runs the full 9-phase flow (~80 s on a new device, < 10 s re-run):

1. **preflight** — adb, authorized device, ssh pubkey, LAN IP discovery
2. **apks** — Termux, Termux:API, Termux:Boot, Shizuku (downloaded from GitHub,
   installed via adb, Play Protect verifier disabled)
3. **ssh** — Mac pubkey → `~/.ssh/authorized_keys` in Termux, start sshd
4. **pkgs** — `pkg install openssh gh termux-api android-tools proot-distro`
5. **debian** — Debian trixie arm64 rootfs from images.linuxcontainers.org,
   extracted into `proot-distro`'s expected layout, DNS seeded
6. **claude** — Node 24 (NodeSource), `@anthropic-ai/claude-code`, official gh
   apt repo, non-root `dev` user with cloned auth
7. **rish** — extracts `rish` + `rish_shizuku.dex` from the cached Shizuku APK,
   installs `droid-sh` wrappers in both Termux and Debian (Debian version tunnels
   to Termux over localhost SSH)
8. **boot** — `~/.termux/boot/00-start-sshd`, Termux:Boot registered, Doze
   whitelist for all 4 packages
9. **shizuku** — starts `libshizuku.so`, verifies `droid-sh -c id` returns
   `uid=2000(shell)`

Every phase is idempotent — re-run after a reboot or partial failure.

**Skip phases** you don't want: `node bin/cli.js init --skip boot,shizuku`.

**Interactive one-time steps** the script intentionally leaves for you:

- `gh auth login --web` inside Termux and Debian
- Install the Tailscale Android app and sign in (for tailnet access)
- `claude mcp add android-mcp-server --scope user -- node "$PWD/src/index.js"`

### Optional env vars

```bash
ADB_PATH=$HOME/Library/Android/sdk/platform-tools/adb
ANDROID_MCP_SSH_KEY=$HOME/.ssh/id_ed25519.pub
ANDROID_MCP_SSH_TARGET=u0_a386@100.74.202.32:8022   # or a MagicDNS name
ANDROID_MCP_CACHE=$HOME/.cache/android-mcp-server
GIT_USER_NAME="Your Name"
GIT_USER_EMAIL="you@example.com"
```

### Reboot recovery

| Service | Survives reboot | Recovery |
|---|---|---|
| sshd | Yes (Termux:Boot) | `termux-wake-lock && sshd` runs on BOOT_COMPLETED |
| Tailscale | Manual | Open the Tailscale app or enable "Always-on VPN" |
| Shizuku | No | Run `start_shizuku` (or `bin/start-shizuku.sh`) while USB-connected |

The Shizuku restart limitation is an Android 14 / OEM issue, not a gap in this
project: Wireless Debugging rotates its TLS cert at every boot, invalidating any
previously-saved WD pairing.

## Why not just use the leaked Claude Code fork?

There's at least one project on GitHub that bundles a "Claude Code leak" together
with Shizuku and an OpenRouter proxy, and advertises safety-bypass flags. This
repo is the clean-room alternative: it uses the **genuine** `claude` binary from
Anthropic's public npm package, and it uses **unmodified** Shizuku and Termux.
The model keeps its default behavior. You get the device-control capability
without the license/IP/supply-chain baggage.

## Hardware realities

- **Real root is not available** on the SM-S921U (US carrier Galaxy S24). The
  bootloader is locked with no OEM unlock, so Magisk is not an option. Shizuku's
  shell UID is the ceiling.
- Samsung's **Adaptive Battery** will still try to limit Termux in the
  background. The bootstrap adds `termux*` and `moe.shizuku.privileged.api` to
  the Doze whitelist, but you may also need to add them to "Unmonitored apps"
  in Settings → Battery for bulletproof uptime.
- Expect to tap **Start** in the Shizuku app once per boot if the phone isn't
  near a Mac with USB adb — this is unavoidable on locked Samsung hardware.

## License

MIT. See [LICENSE](LICENSE).
