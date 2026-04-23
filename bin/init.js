#!/usr/bin/env node
// One-command phone bootstrap. Idempotent: safe to re-run.
//
// Usage: npx android-claude-code-mcp init [--serial X] [--skip SECTION]
//
// Phases:
//   1. preflight    — check adb, device, ssh key, required tools
//   2. apks         — install Termux, Termux:API, Termux:Boot, Shizuku
//   3. ssh          — drop Mac pubkey into authorized_keys, start sshd
//   4. pkgs         — termux-api, openssh, gh, proot-distro, android-tools
//   5. debian       — install + configure Debian proot
//   6. claude       — node, claude-code, dev user, auth clone, gh install
//   7. rish         — install rish + droid-sh wrappers (Termux + Debian)
//   8. boot         — Termux:Boot script for sshd + Doze whitelist
//   9. shizuku      — start the shell-UID service
//
// Each phase is idempotent. --skip=ssh,boot etc. to opt out of any phase.

import { spawn } from "node:child_process";
import { existsSync, mkdirSync, createWriteStream, readFileSync, writeFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { pipeline } from "node:stream/promises";

const args = parseArgs(process.argv.slice(2));
if (args.positional[0] !== "init" && args.positional[0] !== undefined) {
  console.error(`unknown command: ${args.positional[0]}\nUsage: android-claude-code-mcp init [--serial ID] [--skip a,b,c]`);
  process.exit(2);
}

const ADB = resolveAdb();
const SERIAL = args.flags.serial;
const SKIP = new Set((args.flags.skip || "").split(",").filter(Boolean));
const CACHE = resolve(process.env.ANDROID_MCP_CACHE || join(homedir(), ".cache/android-mcp-server"));
mkdirSync(CACHE, { recursive: true });

const COLORS = {
  dim: (s) => `\x1b[2m${s}\x1b[0m`,
  bold: (s) => `\x1b[1m${s}\x1b[0m`,
  green: (s) => `\x1b[32m${s}\x1b[0m`,
  yellow: (s) => `\x1b[33m${s}\x1b[0m`,
  red: (s) => `\x1b[31m${s}\x1b[0m`,
  cyan: (s) => `\x1b[36m${s}\x1b[0m`,
};

const PHASES = [
  { key: "preflight", label: "Preflight checks",            fn: phasePreflight },
  { key: "apks",      label: "Install APKs",                fn: phaseApks },
  { key: "ssh",       label: "SSH pubkey + sshd",           fn: phaseSsh },
  { key: "pkgs",      label: "Termux packages",             fn: phasePkgs },
  { key: "debian",    label: "Debian proot rootfs",         fn: phaseDebian },
  { key: "claude",    label: "Node, claude, gh, dev user",  fn: phaseClaude },
  { key: "rish",      label: "rish + droid-sh wrappers",    fn: phaseRish },
  { key: "boot",      label: "Termux:Boot + Doze whitelist", fn: phaseBoot },
  { key: "shizuku",   label: "Start Shizuku",               fn: phaseShizuku },
];

const ctx = {
  macPubKey: null,
  lanIp: null,
  sshUser: "u0_a386",
  deviceSerial: null,
};

async function main() {
  console.log(COLORS.bold(`\nandroid-claude-code-mcp init\n`));
  for (const phase of PHASES) {
    if (SKIP.has(phase.key)) {
      console.log(COLORS.dim(`  [skip]  ${phase.label}`));
      continue;
    }
    const t0 = Date.now();
    process.stdout.write(COLORS.cyan(`  [ .. ]  ${phase.label} ...`));
    try {
      await phase.fn(ctx);
      const ms = Date.now() - t0;
      process.stdout.write(`\r  ${COLORS.green("[ ok ]")}  ${phase.label} ${COLORS.dim(`(${ms} ms)`)}\n`);
    } catch (e) {
      process.stdout.write(`\r  ${COLORS.red("[FAIL]")}  ${phase.label}\n`);
      console.error(COLORS.red(`\n${e.message}\n`));
      console.error(COLORS.dim(e.stack || ""));
      process.exit(1);
    }
  }

  console.log();
  console.log(COLORS.bold("Next steps (interactive, one-time):"));
  console.log(`  1. ${COLORS.cyan("Authenticate gh")} on the phone:`);
  console.log(`     ssh -p 8022 ${ctx.sshUser}@${ctx.lanIp} 'gh auth login --web --hostname github.com --git-protocol https'`);
  console.log(`     proot-distro login debian -- bash -lc 'gh auth login --web ...' (same, inside Debian)`);
  console.log(`  2. ${COLORS.cyan("Install Tailscale from Play Store")} on the phone and sign in.`);
  console.log(`  3. Register this MCP server with Claude Code:`);
  console.log(`     ${COLORS.dim("claude mcp add android-mcp-server --scope user -- node \"$(pwd)/src/index.js\"")}`);
  console.log();
  console.log(COLORS.green(`Phone ready. ssh -p 8022 ${ctx.sshUser}@${ctx.lanIp}`));
  console.log();
}

// --- phases ----------------------------------------------------------------

async function phasePreflight(ctx) {
  if (!existsSync(ADB)) throw new Error(`adb not found (searched ~/Library/Android/sdk/platform-tools, /opt/homebrew/bin, /usr/local/bin). Set ADB_PATH.`);
  const { stdout: devOut } = await run(ADB, ["devices"], { timeoutMs: 10_000 });
  const lines = devOut.trim().split("\n").slice(1).filter(Boolean);
  if (lines.length === 0) throw new Error(`No ADB devices. Plug phone in, enable USB debugging, authorize the RSA key.`);
  const authorized = lines.filter((l) => /\bdevice\b/.test(l));
  if (authorized.length === 0) throw new Error(`Device visible but not authorized. Tap "Allow" on the RSA prompt.`);
  if (!SERIAL && authorized.length > 1) {
    throw new Error(`Multiple devices: ${authorized.map((l) => l.split(/\s+/)[0]).join(", ")}. Pass --serial ID.`);
  }
  ctx.deviceSerial = SERIAL || authorized[0].split(/\s+/)[0];

  const keyPath = process.env.ANDROID_MCP_SSH_KEY || join(homedir(), ".ssh/id_ed25519.pub");
  if (!existsSync(keyPath)) {
    throw new Error(`No public key at ${keyPath}. Generate one: ssh-keygen -t ed25519`);
  }
  ctx.macPubKey = readFileSync(keyPath, "utf8").trim();

  // Discover the phone's Wi-Fi IP now so later phases can reach it over SSH
  // even if the SSH phase was skipped (already set up).
  const ipRes = await adbShell(`ip addr show wlan0 2>/dev/null || true`, ctx);
  const m = (ipRes.stdout || "").match(/inet (\d+\.\d+\.\d+\.\d+)/);
  if (m) ctx.lanIp = m[1];
}

async function phaseApks(ctx) {
  // Each entry: { name, pkg, url }. Skip if pkg already installed.
  const apks = [
    { name: "Termux",       pkg: "com.termux",                     url: "https://github.com/termux/termux-app/releases/download/v0.118.3/termux-app_v0.118.3%2Bgithub-debug_universal.apk" },
    { name: "Termux:API",   pkg: "com.termux.api",                 url: "https://github.com/termux/termux-api/releases/download/v0.53.0/termux-api-app_v0.53.0%2Bgithub.debug.apk" },
    { name: "Termux:Boot",  pkg: "com.termux.boot",                url: "https://github.com/termux/termux-boot/releases/download/v0.8.1/termux-boot-app_v0.8.1%2Bgithub.debug.apk" },
    { name: "Shizuku",      pkg: "moe.shizuku.privileged.api",     url: "https://github.com/RikkaApps/Shizuku/releases/download/v13.6.0/shizuku-v13.6.0.r1086.2650830c-release.apk" },
  ];

  // Disable Play Protect adb-install verification (harmless if already off).
  await adbShell(`settings put global verifier_verify_adb_installs 0`, ctx);
  await adbShell(`settings put global package_verifier_enable 0`, ctx);

  for (const a of apks) {
    const dest = join(CACHE, `${a.pkg}.apk`);
    // Always keep a cached copy on the host — other phases (e.g. rish
    // extraction from the Shizuku APK) read from the cache.
    if (!existsSync(dest) || statSync(dest).size < 50_000) {
      await download(a.url, dest);
    }
    const r = await adbShell(`pm list packages | grep '^package:${a.pkg}$'`, ctx);
    if (r.stdout.trim()) continue; // already installed
    await adb(["install", "-r", dest], ctx, { timeoutMs: 300_000 });
  }
}

async function phaseSsh(ctx) {
  // Fast path: already set up? (sshd on 8022 + our pubkey authorized)
  if (ctx.lanIp) {
    const probe = await run(
      "ssh",
      ["-p", "8022", "-o", "BatchMode=yes", "-o", "StrictHostKeyChecking=accept-new",
       "-o", "ConnectTimeout=3", `${ctx.sshUser}@${ctx.lanIp}`, "echo ssh_ok"],
      { timeoutMs: 8_000 },
    );
    if (probe.stdout.includes("ssh_ok")) {
      return; // already working — nothing to do
    }
  }

  // Push pubkey to /data/local/tmp, copy into Termux ~/.ssh/authorized_keys.
  const tmpPub = join(CACHE, "_mac_pubkey.pub");
  writeFileSync(tmpPub, ctx.macPubKey + "\n");
  await adb(["push", tmpPub, "/data/local/tmp/mac_pubkey.pub"], ctx);

  // Launch Termux once so its home dir exists (first-run bootstrap takes ~30s on fresh install).
  await adbShell("am start -n com.termux/.HomeActivity", ctx);
  await sleep(2_000);
  // Wait for Termux's bootstrap to finish — sentinel: $PREFIX/bin/sh exists
  const deadline = Date.now() + 90_000;
  while (Date.now() < deadline) {
    const r = await adbShell(`run-as com.termux test -x files/usr/bin/sh && echo ok`, ctx);
    if (r.stdout.includes("ok")) break;
    await sleep(3_000);
  }

  // Type commands into the Termux session to install the key + start sshd.
  // Using `input text` only here because sshd is not yet available.
  await termuxType(
    `mkdir -p ~/.ssh && chmod 700 ~/.ssh && cat /data/local/tmp/mac_pubkey.pub > ~/.ssh/authorized_keys_new && cat ~/.ssh/authorized_keys ~/.ssh/authorized_keys_new 2>/dev/null | sort -u > ~/.ssh/authorized_keys.merged && mv ~/.ssh/authorized_keys.merged ~/.ssh/authorized_keys && chmod 600 ~/.ssh/authorized_keys && rm -f ~/.ssh/authorized_keys_new && sshd && echo DONE_SSH_SETUP`,
    ctx,
  );
  // Wait for sshd to listen on 8022 (via direct adb).
  await waitForPort(8022, ctx);

  // Discover LAN IP
  const r = await adbShell(`ip addr show wlan0`, ctx);
  const m = r.stdout.match(/inet (\d+\.\d+\.\d+\.\d+)/);
  if (!m) throw new Error("Could not determine wlan0 IP; is the phone on Wi-Fi?");
  ctx.lanIp = m[1];

  // Verify ssh actually works end-to-end.
  const probe = await run(
    "ssh",
    ["-p", "8022", "-o", "BatchMode=yes", "-o", "StrictHostKeyChecking=accept-new",
     "-o", "ConnectTimeout=5", `${ctx.sshUser}@${ctx.lanIp}`, "echo ssh_ok"],
    { timeoutMs: 15_000 },
  );
  if (!probe.stdout.includes("ssh_ok")) {
    throw new Error(`SSH probe failed:\n${probe.stdout}\n${probe.stderr}`);
  }
}

async function phasePkgs(ctx) {
  await ssh(
    `yes | pkg install -y openssh gh termux-api android-tools proot-distro 2>&1 | tail -3`,
    ctx,
  );
}

async function phaseDebian(ctx) {
  const rootDir = "$PREFIX/var/lib/proot-distro/installed-rootfs/debian";
  const check = await ssh(`[ -d ${rootDir} ] && [ -x ${rootDir}/usr/bin/apt ] && echo present`, ctx);
  if (check.stdout.includes("present")) return;

  // Find latest Debian arm64 rootfs URL from LXC's mirror.
  const lxc = await httpGet("https://images.linuxcontainers.org/images/debian/trixie/arm64/default/");
  const builds = [...lxc.matchAll(/(\d{8}_\d{2}:\d{2})/g)].map((m) => m[1]);
  if (builds.length === 0) throw new Error("Could not discover a Debian arm64 rootfs build on images.linuxcontainers.org");
  const build = builds.sort().pop();
  const rootfsUrl = `https://images.linuxcontainers.org/images/debian/trixie/arm64/default/${build}/rootfs.tar.xz`;
  const localFs = join(CACHE, "debian-rootfs.tar.xz");
  if (!existsSync(localFs)) await download(rootfsUrl, localFs);

  // Push + extract using the same pattern we tested manually.
  await adb(["push", localFs, "/data/local/tmp/debian-rootfs.tar.xz"], ctx, { timeoutMs: 600_000 });
  await ssh(
    `cp /data/local/tmp/debian-rootfs.tar.xz ~/rootfs.tar.xz && mkdir -p ${rootDir} && cd ${rootDir} && proot --link2symlink tar -xJf $HOME/rootfs.tar.xz`,
    ctx,
    { timeoutMs: 600_000 },
  );

  // Seed DNS + hosts so apt works.
  await ssh(
    `printf 'nameserver 8.8.8.8\\nnameserver 1.1.1.1\\n' > ${rootDir}/etc/resolv.conf && printf '127.0.0.1 localhost\\n' > ${rootDir}/etc/hosts`,
    ctx,
  );
  // Sanity probe.
  await ssh(`proot-distro login debian -- bash -lc 'cat /etc/os-release | head -2'`, ctx, { timeoutMs: 60_000 });
}

async function phaseClaude(ctx) {
  // Install node + claude + gh + create dev user + clone auth.
  // Everything written to one script + pushed to avoid ssh quoting hell.
  const script = `
set -e
export DEBIAN_FRONTEND=noninteractive
apt-get update -y >/dev/null
apt-get install -y --no-install-recommends ca-certificates curl gnupg git wget >/dev/null

# Node 24 via NodeSource (idempotent).
if ! command -v node >/dev/null || [ "$(node -v | cut -c2 | head -c 2)" != "24" ]; then
  curl -fsSL https://deb.nodesource.com/setup_24.x -o /tmp/ns.sh
  bash /tmp/ns.sh
  apt-get install -y nodejs >/dev/null
fi

# Claude Code (global).
if ! command -v claude >/dev/null; then
  npm install -g @anthropic-ai/claude-code >/dev/null
fi

# gh CLI.
if ! command -v gh >/dev/null; then
  install -dm 755 /etc/apt/keyrings
  curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg | tee /etc/apt/keyrings/githubcli-archive-keyring.gpg > /dev/null
  chmod go+r /etc/apt/keyrings/githubcli-archive-keyring.gpg
  printf "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main\\n" > /etc/apt/sources.list.d/github-cli.list
  apt-get update -y >/dev/null
  apt-get install -y gh >/dev/null
fi

# Non-root dev user (needed for --dangerously-skip-permissions).
if ! id dev >/dev/null 2>&1; then
  useradd -m -s /bin/bash dev
fi
mkdir -p /home/dev/.claude /home/dev/.config
[ -d /root/.claude ] && cp -r /root/.claude/. /home/dev/.claude/ 2>/dev/null || true
[ -d /root/.config/gh ] && cp -r /root/.config/gh /home/dev/.config/gh 2>/dev/null || true
[ -f /root/.gitconfig ] && cp /root/.gitconfig /home/dev/.gitconfig 2>/dev/null || true
chown -R dev:dev /home/dev

node --version
claude --version
gh --version | head -1
echo DONE
`;
  await pushAndRunInDebian(script, ctx, { timeoutMs: 1800_000 });

  // Termux-side claude wrapper.
  const wrapper = `#!/data/data/com.termux/files/usr/bin/bash
exec proot-distro login debian --bind "$HOME:/root/termux-home" -- bash -lc "cd /root/termux-home && claude \\"\\$@\\"" bash "$@"
`;
  await ssh(`cat > $PREFIX/bin/claude <<'CLAUDE_WRAPPER_EOF'\n${wrapper}CLAUDE_WRAPPER_EOF\nchmod +x $PREFIX/bin/claude`, ctx);

  // Git identity (harmless if already set).
  const name = process.env.GIT_USER_NAME || "";
  const email = process.env.GIT_USER_EMAIL || "";
  if (name && email) {
    await ssh(`git config --global user.name "${name}" && git config --global user.email "${email}" && git config --global init.defaultBranch main`, ctx);
    await ssh(`proot-distro login debian -- bash -lc 'git config --global user.name "${name}" && git config --global user.email "${email}" && git config --global init.defaultBranch main'`, ctx);
  }
}

async function phaseRish(ctx) {
  // Extract rish + dex from Shizuku APK cached locally.
  const apk = join(CACHE, "moe.shizuku.privileged.api.apk");
  if (!existsSync(apk)) throw new Error("Shizuku APK not in cache — phase 'apks' must run first.");
  const rishDir = join(CACHE, "shizuku_extracted");
  mkdirSync(rishDir, { recursive: true });
  await run("unzip", ["-o", "-q", apk, "assets/rish", "assets/rish_shizuku.dex", "-d", rishDir], {});

  // Push both files to device, install into Termux.
  await adb(["push", join(rishDir, "assets/rish"), "/data/local/tmp/rish"], ctx);
  await adb(["push", join(rishDir, "assets/rish_shizuku.dex"), "/data/local/tmp/rish_shizuku.dex"], ctx);

  const install = `
cp /data/local/tmp/rish_shizuku.dex $PREFIX/share/rish_shizuku.dex
chmod 400 $PREFIX/share/rish_shizuku.dex
cat > $PREFIX/bin/rish <<'RISH_EOF'
#!/data/data/com.termux/files/usr/bin/sh
export RISH_APPLICATION_ID=com.termux
DEX=$PREFIX/share/rish_shizuku.dex
exec /system/bin/app_process -Djava.class.path=$DEX /system/bin --nice-name=rish rikka.shizuku.shell.ShizukuShellLoader "$@"
RISH_EOF
chmod +x $PREFIX/bin/rish

cat > $PREFIX/bin/droid-sh <<'DROID_EOF'
#!/data/data/com.termux/files/usr/bin/sh
if [ "$1" = "-c" ]; then shift; fi
exec rish -c "$*"
DROID_EOF
chmod +x $PREFIX/bin/droid-sh
`;
  await ssh(install, ctx);

  // Debian-side droid-sh: ssh out to Termux localhost and call droid-sh there.
  const genKey = `
mkdir -p /root/.ssh && chmod 700 /root/.ssh
[ -f /root/.ssh/id_droid ] || ssh-keygen -t ed25519 -N "" -C "debian->termux" -f /root/.ssh/id_droid >/dev/null
cat /root/.ssh/id_droid.pub
`;
  const keyRes = await pushAndRunInDebian(genKey, ctx);
  const pub = (keyRes.stdout || "").split("\n").filter((l) => l.startsWith("ssh-")).pop();
  if (!pub) throw new Error("Failed to generate debian->termux ssh key");
  // Install into Termux authorized_keys (idempotent).
  await ssh(
    `grep -qxF ${JSON.stringify(pub)} ~/.ssh/authorized_keys 2>/dev/null || echo ${JSON.stringify(pub)} >> ~/.ssh/authorized_keys`,
    ctx,
  );
  // Prime Termux host key inside Debian.
  await pushAndRunInDebian(`ssh-keyscan -p 8022 -H localhost 2>/dev/null >> /root/.ssh/known_hosts; sort -u -o /root/.ssh/known_hosts /root/.ssh/known_hosts`, ctx);

  // Write Debian-side droid-sh.
  const debianWrapper = `#!/bin/bash
if [ "$1" = "-c" ]; then shift; fi
exec ssh -i /root/.ssh/id_droid -o StrictHostKeyChecking=no -o LogLevel=ERROR \\
  -p 8022 ${ctx.sshUser}@localhost "droid-sh $(printf ' %q' "$@")"
`;
  await ssh(
    `ROOT=$PREFIX/var/lib/proot-distro/installed-rootfs/debian; cat > $ROOT/usr/local/bin/droid-sh <<'DROID_DEB_EOF'\n${debianWrapper}DROID_DEB_EOF\nchmod +x $ROOT/usr/local/bin/droid-sh`,
    ctx,
  );
}

async function phaseBoot(ctx) {
  // Termux:Boot script to start sshd on BOOT_COMPLETED.
  await ssh(
    `mkdir -p ~/.termux/boot && cat > ~/.termux/boot/00-start-sshd <<'BOOT_EOF'
#!/data/data/com.termux/files/usr/bin/sh
termux-wake-lock
sshd
BOOT_EOF
chmod +x ~/.termux/boot/00-start-sshd`,
    ctx,
  );

  // Launch Termux:Boot once so Android whitelists it for boot-time bg-start.
  await adbShell(`am start -n com.termux.boot/.BootActivity`, ctx);

  // Doze / battery whitelist.
  for (const pkg of ["com.termux", "com.termux.boot", "com.termux.api", "moe.shizuku.privileged.api"]) {
    await adbShell(`dumpsys deviceidle whitelist +${pkg}`, ctx);
  }
}

async function phaseShizuku(ctx) {
  // Discover Shizuku APK path on device and invoke its starter binary.
  const r = await adbShell(`pm path moe.shizuku.privileged.api`, ctx);
  const apkPath = (r.stdout || "").split("\n").map((s) => s.trim()).find((s) => s.startsWith("package:"))?.slice("package:".length);
  if (!apkPath) throw new Error("Shizuku package not found — phase 'apks' must have succeeded.");
  const starter = apkPath.replace(/\/base\.apk$/, "/lib/arm64/libshizuku.so");
  await adbShell(starter, ctx, { timeoutMs: 60_000 });

  // Verify via droid-sh. Check both streams — ssh may muddle them with warnings.
  const v = await ssh(`droid-sh -c 'id'`, ctx);
  if (!/uid=2000\(shell\)/.test(v.stdout + v.stderr)) {
    throw new Error(`Shizuku started, but droid-sh didn't return shell UID:\nstdout: ${v.stdout}\nstderr: ${v.stderr}`);
  }
}

// --- helpers ---------------------------------------------------------------

function parseArgs(argv) {
  const positional = [];
  const flags = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const eq = a.indexOf("=");
      if (eq !== -1) flags[a.slice(2, eq)] = a.slice(eq + 1);
      else if (!argv[i + 1] || argv[i + 1].startsWith("--")) flags[a.slice(2)] = "true";
      else flags[a.slice(2)] = argv[++i];
    } else positional.push(a);
  }
  return { positional, flags };
}

function resolveAdb() {
  if (process.env.ADB_PATH && existsSync(process.env.ADB_PATH)) return process.env.ADB_PATH;
  for (const p of [
    join(homedir(), "Library/Android/sdk/platform-tools/adb"),
    "/opt/homebrew/bin/adb",
    "/usr/local/bin/adb",
    "/usr/bin/adb",
  ]) if (existsSync(p)) return p;
  return "adb";
}

function run(cmd, cmdArgs, { input, timeoutMs = 120_000 } = {}) {
  return new Promise((resolvePromise) => {
    const child = spawn(cmd, cmdArgs, { stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "", stderr = "";
    const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
    child.stdout.on("data", (d) => (stdout += d.toString()));
    child.stderr.on("data", (d) => (stderr += d.toString()));
    child.on("error", (err) => { clearTimeout(timer); resolvePromise({ code: -1, stdout, stderr: stderr + err.message }); });
    child.on("close", (code) => { clearTimeout(timer); resolvePromise({ code, stdout, stderr }); });
    if (input != null) child.stdin.end(input);
  });
}

async function adb(argsArr, ctx, opts = {}) {
  const full = ctx?.deviceSerial ? ["-s", ctx.deviceSerial, ...argsArr] : argsArr;
  const res = await run(ADB, full, opts);
  if (res.code !== 0) throw new Error(`adb ${argsArr.join(" ")} failed (code ${res.code}):\n${res.stderr || res.stdout}`);
  return res;
}
async function adbShell(cmd, ctx, opts = {}) { return adb(["shell", cmd], ctx, opts); }

async function ssh(cmd, ctx, opts = {}) {
  const target = `${ctx.sshUser}@${ctx.lanIp || "127.0.0.1"}`;
  const args = ["-p", "8022", "-o", "BatchMode=yes", "-o", "StrictHostKeyChecking=accept-new",
                "-o", "ConnectTimeout=10", target, cmd];
  const res = await run("ssh", args, opts);
  if (res.code !== 0) throw new Error(`ssh failed (code ${res.code}):\n$ ${cmd}\n${res.stderr || res.stdout}`);
  return res;
}

// Run a script inside the Debian proot by pushing it to /data/local/tmp first
// (avoids ssh quoting hell around multi-line heredocs).
async function pushAndRunInDebian(script, ctx, opts = {}) {
  const localScript = join(CACHE, `_debian_${Date.now()}.sh`);
  writeFileSync(localScript, "#!/bin/bash\nset -e\n" + script);
  await adb(["push", localScript, `/data/local/tmp/_debian.sh`], ctx);
  const res = await ssh(
    `cp /data/local/tmp/_debian.sh $PREFIX/var/lib/proot-distro/installed-rootfs/debian/tmp/init.sh && chmod +x $PREFIX/var/lib/proot-distro/installed-rootfs/debian/tmp/init.sh && proot-distro login debian -- bash /tmp/init.sh`,
    ctx,
    opts,
  );
  return res;
}

async function termuxType(cmd, ctx) {
  const escaped = cmd.replace(/ /g, "%s").replace(/'/g, "'\\''");
  await adbShell(`input text '${escaped}'`, ctx);
  await adbShell(`input keyevent 66`, ctx);
  // Wait for the sentinel prompt-echo to hint completion. Generous window;
  // the caller is also doing waitForPort which is the real signal.
  await sleep(1_500);
}

async function waitForPort(port, ctx, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const r = await adbShell(`(ss -tln 2>/dev/null || netstat -tln 2>/dev/null) | grep :${port} || true`, ctx);
    if (r.stdout.trim()) return;
    await sleep(1_000);
  }
  throw new Error(`port ${port} never opened on device`);
}

async function download(url, dest) {
  const res = await fetch(url, { redirect: "follow" });
  if (!res.ok || !res.body) throw new Error(`download ${url} failed: ${res.status} ${res.statusText}`);
  await pipeline(res.body, createWriteStream(dest));
}

async function httpGet(url) {
  const res = await fetch(url, { redirect: "follow" });
  if (!res.ok) throw new Error(`GET ${url} -> ${res.status}`);
  return res.text();
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

main().catch((e) => {
  console.error(e.stack || e.message);
  process.exit(1);
});
