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

## MCP tools

| Tool | Purpose |
|---|---|
| `adb_path`, `list_devices`, `device_info`, `shell`, `install_apk`, `push`, `pull` | Classic adb operations — used for bootstrap and for anything that must predate sshd |
| `install_termux`, `open_termux`, `termux_type`, `termux_run_command` | Bootstrap / fallback controls for fresh installs |
| `screencap`, `keyevent`, `input_text` | UI primitives (usable before Shizuku is up) |
| `ssh_info`, `ssh_termux`, `ssh_debian` | Run commands in Termux or in the Debian proot over SSH — the preferred post-bootstrap channel |
| `start_shizuku` | Restart Shizuku's shell-UID service via USB adb (needed after each reboot — Android 14 rotates its Wireless Debugging TLS keys) |
| `claude_run` | One-shot `claude -p <prompt>` inside the Debian proot — returns stdout |

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

### Install the MCP server

```bash
git clone https://github.com/celaya-solutions/android-claude-code-mcp-server.git
cd android-claude-code-mcp-server
npm install
```

Register it with Claude Code at user scope:

```bash
claude mcp add android-mcp-server --scope user -- node "$(pwd)/src/index.js"
```

Optional env vars (read by the server at startup):

```bash
ANDROID_MCP_SSH_TARGET=u0_a386@100.74.202.32:8022   # or a Tailscale MagicDNS name
ANDROID_MCP_SSH_KEY=$HOME/.ssh/id_ed25519
ADB_PATH=$HOME/Library/Android/sdk/platform-tools/adb
```

### Bootstrap the phone

With the phone on USB and adb authorized, from Claude Code:

1. `install_termux` — downloads the Termux APK from GitHub and installs it
2. `open_termux`
3. `termux_run_command` with `scripts/bootstrap.sh` pushed via `push`, or just call
   `setup_claude_code_in_termux` and follow the prompts
4. Run `gh auth login --web` inside Termux + Debian (one-time, interactive)
5. Install Shizuku (`gh release download` + `install_apk`) and start it with
   `start_shizuku`
6. From inside Termux, you can now run `droid-sh "id"` and see `uid=2000(shell)`

See `scripts/bootstrap.sh` for the full end-to-end sequence this project lands on.

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
