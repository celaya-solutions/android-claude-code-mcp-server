#!/usr/bin/env node
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { createWriteStream } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { pipeline } from "node:stream/promises";

// --- adb resolution -------------------------------------------------------
function resolveAdb() {
  if (process.env.ADB_PATH && existsSync(process.env.ADB_PATH)) {
    return process.env.ADB_PATH;
  }
  const candidates = [
    join(homedir(), "Library/Android/sdk/platform-tools/adb"),
    "/opt/homebrew/bin/adb",
    "/usr/local/bin/adb",
    "/usr/bin/adb",
  ];
  for (const p of candidates) if (existsSync(p)) return p;
  return "adb";
}
const ADB = resolveAdb();
const DOWNLOAD_DIR = resolve(process.env.ANDROID_MCP_CACHE || join(homedir(), ".cache/android-mcp-server"));
mkdirSync(DOWNLOAD_DIR, { recursive: true });

// --- ssh resolution -------------------------------------------------------
// Target format: [user@]host[:port]. Examples:
//   u0_a386@100.74.202.32:8022
//   galaxy-s24                     (when a matching Host block lives in ~/.ssh/config)
const SSH_TARGET_DEFAULT = "u0_a386@100.74.202.32:8022";
function parseSshTarget(raw) {
  const target = raw || process.env.ANDROID_MCP_SSH_TARGET || SSH_TARGET_DEFAULT;
  let user, host, port;
  const atIdx = target.indexOf("@");
  if (atIdx >= 0) {
    user = target.slice(0, atIdx);
    host = target.slice(atIdx + 1);
  } else {
    host = target;
  }
  const colonIdx = host.lastIndexOf(":");
  if (colonIdx > 0 && /^\d+$/.test(host.slice(colonIdx + 1))) {
    port = host.slice(colonIdx + 1);
    host = host.slice(0, colonIdx);
  }
  return { user, host, port };
}
function sshArgs(target) {
  const { user, host, port } = parseSshTarget(target);
  const args = [
    "-o", "BatchMode=yes",
    "-o", "ConnectTimeout=10",
    "-o", "StrictHostKeyChecking=accept-new",
  ];
  if (process.env.ANDROID_MCP_SSH_KEY) args.push("-i", process.env.ANDROID_MCP_SSH_KEY);
  if (port) args.push("-p", port);
  args.push(user ? `${user}@${host}` : host);
  return args;
}
async function ssh(remoteCmd, { target, timeoutMs = 300_000 } = {}) {
  return runProcess("ssh", [...sshArgs(target), remoteCmd], { timeoutMs });
}
// Wrap a command to run inside the Debian proot (bash login shell).
function wrapDebian(cmd) {
  // The command is delivered as the argument to `bash -lc`, single-quoted on
  // the remote. Any existing single quotes in `cmd` are split + reassembled.
  const quoted = "'" + cmd.replace(/'/g, "'\\''") + "'";
  return `proot-distro login debian -- bash -lc ${quoted}`;
}

// --- process helpers ------------------------------------------------------
function runProcess(cmd, args, { input, timeoutMs = 120_000 } = {}) {
  return new Promise((resolvePromise) => {
    const child = spawn(cmd, args, { stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, timeoutMs);

    child.stdout.on("data", (d) => (stdout += d.toString()));
    child.stderr.on("data", (d) => (stderr += d.toString()));
    child.on("error", (err) => {
      clearTimeout(timer);
      resolvePromise({ code: -1, stdout, stderr: stderr + `\n[spawn error] ${err.message}`, timedOut });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolvePromise({ code, stdout, stderr, timedOut });
    });
    if (input != null) child.stdin.end(input);
  });
}

function buildAdbArgs(serial, args) {
  return serial ? ["-s", serial, ...args] : args;
}

async function adb(args, { serial, timeoutMs } = {}) {
  return runProcess(ADB, buildAdbArgs(serial, args), { timeoutMs });
}

async function adbShell(command, { serial, timeoutMs } = {}) {
  return adb(["shell", command], { serial, timeoutMs });
}

function formatResult(res, { label } = {}) {
  const header = label ? `$ ${label}\n` : "";
  const body =
    (res.stdout ? res.stdout : "") +
    (res.stderr ? (res.stdout ? "\n" : "") + `[stderr]\n${res.stderr}` : "");
  const suffix = res.timedOut
    ? "\n[timed out]"
    : res.code !== 0
      ? `\n[exit ${res.code}]`
      : "";
  return header + (body || "(no output)") + suffix;
}

function textResult(text, { isError = false } = {}) {
  return {
    content: [{ type: "text", text }],
    isError,
  };
}

// --- downloads ------------------------------------------------------------
async function downloadFile(url, destPath) {
  const res = await fetch(url, { redirect: "follow" });
  if (!res.ok || !res.body) {
    throw new Error(`download failed: ${res.status} ${res.statusText} (${url})`);
  }
  await pipeline(res.body, createWriteStream(destPath));
  return destPath;
}

// Termux (F-Droid) direct APK — universal build
// See: https://f-droid.org/packages/com.termux/
const TERMUX_APK_URL =
  process.env.TERMUX_APK_URL ||
  "https://f-droid.org/repo/com.termux_1020.apk";

// --- tool definitions -----------------------------------------------------
const TOOLS = [
  {
    name: "adb_path",
    description: "Return the adb binary the server is using and its version.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "list_devices",
    description: "List ADB-visible devices (adb devices -l).",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "device_info",
    description: "Get basic device properties (model, android version, abi, sdk).",
    inputSchema: {
      type: "object",
      properties: { serial: { type: "string", description: "Optional device serial." } },
      additionalProperties: false,
    },
  },
  {
    name: "shell",
    description: "Run a command via `adb shell`. Use for any on-device shell work.",
    inputSchema: {
      type: "object",
      properties: {
        command: { type: "string", description: "Shell command to run on the device." },
        serial: { type: "string" },
        timeoutMs: { type: "number", description: "Timeout in ms (default 120000)." },
      },
      required: ["command"],
      additionalProperties: false,
    },
  },
  {
    name: "install_apk",
    description: "Install an APK from a local file path on this Mac (adb install -r).",
    inputSchema: {
      type: "object",
      properties: {
        apkPath: { type: "string", description: "Absolute path to .apk file on host." },
        serial: { type: "string" },
        downgrade: { type: "boolean", description: "Add -d to allow version downgrade." },
      },
      required: ["apkPath"],
      additionalProperties: false,
    },
  },
  {
    name: "push",
    description: "adb push a local file to the device.",
    inputSchema: {
      type: "object",
      properties: {
        localPath: { type: "string" },
        remotePath: { type: "string" },
        serial: { type: "string" },
      },
      required: ["localPath", "remotePath"],
      additionalProperties: false,
    },
  },
  {
    name: "pull",
    description: "adb pull a file from the device to the host.",
    inputSchema: {
      type: "object",
      properties: {
        remotePath: { type: "string" },
        localPath: { type: "string" },
        serial: { type: "string" },
      },
      required: ["remotePath", "localPath"],
      additionalProperties: false,
    },
  },
  {
    name: "install_termux",
    description:
      "Download the Termux APK from F-Droid (if not cached) and install it on the connected device.",
    inputSchema: {
      type: "object",
      properties: {
        serial: { type: "string" },
        apkUrl: { type: "string", description: "Override APK URL." },
      },
      additionalProperties: false,
    },
  },
  {
    name: "open_termux",
    description: "Launch the Termux app on the device (com.termux/.HomeActivity).",
    inputSchema: {
      type: "object",
      properties: { serial: { type: "string" } },
      additionalProperties: false,
    },
  },
  {
    name: "termux_type",
    description:
      "Type a command into the foreground Termux session via `adb shell input` and press Enter. " +
      "Termux must be in the foreground. Good for bootstrapping before RUN_COMMAND is available.",
    inputSchema: {
      type: "object",
      properties: {
        command: { type: "string", description: "Shell command to type (no trailing newline needed)." },
        serial: { type: "string" },
        pressEnter: { type: "boolean", description: "Send ENTER after typing. Default true." },
      },
      required: ["command"],
      additionalProperties: false,
    },
  },
  {
    name: "termux_run_command",
    description:
      "Run a command inside Termux using its RUN_COMMAND intent (requires " +
      "`allow-external-apps=true` in ~/.termux/termux.properties on the device). " +
      "Captures stdout/stderr to files under /data/data/com.termux/files/home/mcp-out/.",
    inputSchema: {
      type: "object",
      properties: {
        command: { type: "string", description: "Command to run (executed via bash -lc)." },
        serial: { type: "string" },
        background: { type: "boolean", description: "Run in background (default false)." },
        timeoutMs: { type: "number" },
      },
      required: ["command"],
      additionalProperties: false,
    },
  },
  {
    name: "setup_claude_code_in_termux",
    description:
      "Bootstrap sequence: installs Node.js + git in Termux and installs @anthropic-ai/claude-code globally. " +
      "By default uses termux_type (Termux must be foreground). Set mode='run_command' if " +
      "RUN_COMMAND is enabled in termux.properties.",
    inputSchema: {
      type: "object",
      properties: {
        serial: { type: "string" },
        mode: {
          type: "string",
          enum: ["type", "run_command"],
          description: "How to deliver commands to Termux. Default 'type'.",
        },
      },
      additionalProperties: false,
    },
  },
  {
    name: "screencap",
    description: "Grab a screenshot and pull it to a local path on the host.",
    inputSchema: {
      type: "object",
      properties: {
        localPath: { type: "string", description: "Host destination PNG path." },
        serial: { type: "string" },
      },
      required: ["localPath"],
      additionalProperties: false,
    },
  },
  {
    name: "keyevent",
    description: "Send a key event (e.g. 'KEYCODE_ENTER', 'KEYCODE_BACK').",
    inputSchema: {
      type: "object",
      properties: {
        key: { type: "string" },
        serial: { type: "string" },
      },
      required: ["key"],
      additionalProperties: false,
    },
  },
  {
    name: "input_text",
    description: "Type literal text on the device (spaces become %s, no newline sent).",
    inputSchema: {
      type: "object",
      properties: {
        text: { type: "string" },
        serial: { type: "string" },
      },
      required: ["text"],
      additionalProperties: false,
    },
  },

  // ---------- SSH-based tools (preferred over termux_type once sshd is up) ----------
  {
    name: "ssh_info",
    description:
      "Show which SSH target and key the server will use. Helpful for verifying the ANDROID_MCP_SSH_TARGET env var.",
    inputSchema: {
      type: "object",
      properties: { target: { type: "string", description: "Override for this call only." } },
      additionalProperties: false,
    },
  },
  {
    name: "ssh_termux",
    description:
      "Run a shell command inside Termux over SSH. Preferred over `termux_type` for reliability. " +
      "Requires sshd running in Termux (port 8022) and the host's pubkey in ~/.ssh/authorized_keys.",
    inputSchema: {
      type: "object",
      properties: {
        command: { type: "string", description: "Shell command to run in Termux." },
        target: { type: "string", description: "Override SSH target (user@host:port)." },
        timeoutMs: { type: "number" },
      },
      required: ["command"],
      additionalProperties: false,
    },
  },
  {
    name: "ssh_debian",
    description:
      "Run a shell command inside the Debian proot-distro (glibc userland) over SSH. " +
      "Use this for anything that needs glibc — including the native `claude` binary.",
    inputSchema: {
      type: "object",
      properties: {
        command: { type: "string", description: "Shell command to run inside Debian." },
        target: { type: "string" },
        timeoutMs: { type: "number" },
      },
      required: ["command"],
      additionalProperties: false,
    },
  },
  {
    name: "start_shizuku",
    description:
      "(Re)start Shizuku's server on the device via USB adb. Needed after each phone reboot " +
      "because Android 14 rotates Wireless Debugging TLS keys, invalidating Shizuku's saved " +
      "WD pairing. Leaves the server running as shell UID, which `droid-sh` / `rish` consume.",
    inputSchema: {
      type: "object",
      properties: { serial: { type: "string", description: "Optional device serial for adb -s." } },
      additionalProperties: false,
    },
  },
  {
    name: "claude_run",
    description:
      "One-shot Claude Code invocation inside the Debian proot. Runs `claude -p <prompt>` " +
      "and returns stdout. For multi-turn work, ssh in directly and run `claude` interactively.",
    inputSchema: {
      type: "object",
      properties: {
        prompt: { type: "string", description: "Prompt text passed as `claude -p`." },
        workdir: {
          type: "string",
          description: "Directory inside the Debian proot to run in. Default: /root/termux-home.",
        },
        extraArgs: {
          type: "array",
          items: { type: "string" },
          description: "Additional CLI args appended before the prompt (e.g. --model sonnet).",
        },
        target: { type: "string" },
        timeoutMs: { type: "number", description: "Default 600000." },
      },
      required: ["prompt"],
      additionalProperties: false,
    },
  },
];

// --- tool handlers --------------------------------------------------------
async function handleTool(name, args) {
  const a = args || {};
  switch (name) {
    case "adb_path": {
      const v = await runProcess(ADB, ["version"]);
      return textResult(`adb: ${ADB}\n${v.stdout || v.stderr}`);
    }
    case "list_devices": {
      const r = await adb(["devices", "-l"]);
      return textResult(formatResult(r, { label: "adb devices -l" }), { isError: r.code !== 0 });
    }
    case "device_info": {
      const props = [
        "ro.product.model",
        "ro.product.manufacturer",
        "ro.build.version.release",
        "ro.build.version.sdk",
        "ro.product.cpu.abi",
      ];
      const lines = [];
      for (const p of props) {
        const r = await adbShell(`getprop ${p}`, { serial: a.serial });
        lines.push(`${p}=${(r.stdout || "").trim()}`);
      }
      return textResult(lines.join("\n"));
    }
    case "shell": {
      const r = await adbShell(a.command, { serial: a.serial, timeoutMs: a.timeoutMs });
      return textResult(formatResult(r, { label: `adb shell ${a.command}` }), { isError: r.code !== 0 });
    }
    case "install_apk": {
      const args = ["install", "-r"];
      if (a.downgrade) args.push("-d");
      args.push(a.apkPath);
      const r = await adb(args, { serial: a.serial, timeoutMs: 300_000 });
      return textResult(formatResult(r, { label: `adb install ${a.apkPath}` }), { isError: r.code !== 0 });
    }
    case "push": {
      const r = await adb(["push", a.localPath, a.remotePath], { serial: a.serial, timeoutMs: 600_000 });
      return textResult(formatResult(r, { label: `adb push ${a.localPath} ${a.remotePath}` }), { isError: r.code !== 0 });
    }
    case "pull": {
      const r = await adb(["pull", a.remotePath, a.localPath], { serial: a.serial, timeoutMs: 600_000 });
      return textResult(formatResult(r, { label: `adb pull ${a.remotePath} ${a.localPath}` }), { isError: r.code !== 0 });
    }
    case "install_termux": {
      const url = a.apkUrl || TERMUX_APK_URL;
      const filename = url.split("/").pop() || "termux.apk";
      const dest = join(DOWNLOAD_DIR, filename);
      const log = [];
      if (!existsSync(dest)) {
        log.push(`downloading ${url} -> ${dest}`);
        try {
          await downloadFile(url, dest);
        } catch (e) {
          return textResult(`download failed: ${e.message}`, { isError: true });
        }
      } else {
        log.push(`using cached apk: ${dest}`);
      }
      const r = await adb(["install", "-r", dest], { serial: a.serial, timeoutMs: 300_000 });
      log.push(formatResult(r, { label: `adb install -r ${dest}` }));
      return textResult(log.join("\n"), { isError: r.code !== 0 });
    }
    case "open_termux": {
      const r = await adbShell("am start -n com.termux/.HomeActivity", { serial: a.serial });
      return textResult(formatResult(r, { label: "am start com.termux" }), { isError: r.code !== 0 });
    }
    case "termux_type": {
      return termuxType(a.command, { serial: a.serial, pressEnter: a.pressEnter !== false });
    }
    case "termux_run_command": {
      return termuxRunCommand(a.command, { serial: a.serial, background: !!a.background, timeoutMs: a.timeoutMs });
    }
    case "setup_claude_code_in_termux": {
      return setupClaudeCode({ serial: a.serial, mode: a.mode || "type" });
    }
    case "screencap": {
      const remote = "/sdcard/_mcp_screencap.png";
      const r1 = await adbShell(`screencap -p ${remote}`, { serial: a.serial });
      if (r1.code !== 0) return textResult(formatResult(r1, { label: "screencap" }), { isError: true });
      const r2 = await adb(["pull", remote, a.localPath], { serial: a.serial });
      await adbShell(`rm -f ${remote}`, { serial: a.serial });
      return textResult(formatResult(r2, { label: `pull -> ${a.localPath}` }), { isError: r2.code !== 0 });
    }
    case "keyevent": {
      const r = await adbShell(`input keyevent ${a.key}`, { serial: a.serial });
      return textResult(formatResult(r, { label: `keyevent ${a.key}` }), { isError: r.code !== 0 });
    }
    case "input_text": {
      const escaped = a.text.replace(/ /g, "%s").replace(/'/g, "'\\''");
      const r = await adbShell(`input text '${escaped}'`, { serial: a.serial });
      return textResult(formatResult(r, { label: `input text` }), { isError: r.code !== 0 });
    }
    case "start_shizuku": {
      // Locate the Shizuku APK and invoke the starter binary packaged alongside it.
      const pmRes = await adb(["shell", "pm", "path", "moe.shizuku.privileged.api"], { serial: a.serial });
      const apkPath = (pmRes.stdout || "")
        .split("\n").map(s => s.trim()).find(s => s.startsWith("package:"))?.slice("package:".length);
      if (!apkPath) {
        return textResult("Shizuku not installed on device (pm path returned nothing).", { isError: true });
      }
      const starter = apkPath.replace(/\/base\.apk$/, "/lib/arm64/libshizuku.so");
      const run = await adb(["shell", starter], { serial: a.serial, timeoutMs: 60_000 });
      const verify = await adb(["shell", "ps -A 2>/dev/null | grep shizuku_server | head -1"], { serial: a.serial });
      const out = `starter: ${starter}\n\n${run.stdout}${run.stderr ? "\n[stderr]\n" + run.stderr : ""}\n---\nverify: ${verify.stdout.trim() || "(no shizuku_server process found)"}`;
      return textResult(out, { isError: run.code !== 0 });
    }
    case "ssh_info": {
      const { user, host, port } = parseSshTarget(a.target);
      const key = process.env.ANDROID_MCP_SSH_KEY || "(agent/default)";
      return textResult(`target: ${user || "(default)"}@${host}:${port || "22"}\nkey: ${key}`);
    }
    case "ssh_termux": {
      const r = await ssh(a.command, { target: a.target, timeoutMs: a.timeoutMs });
      return textResult(formatResult(r, { label: `ssh $ ${a.command}` }), { isError: r.code !== 0 });
    }
    case "ssh_debian": {
      const r = await ssh(wrapDebian(a.command), { target: a.target, timeoutMs: a.timeoutMs });
      return textResult(formatResult(r, { label: `ssh debian $ ${a.command}` }), { isError: r.code !== 0 });
    }
    case "claude_run": {
      const workdir = a.workdir || "/root/termux-home";
      const extra = Array.isArray(a.extraArgs) ? a.extraArgs : [];
      // Build the Debian-side command. claude's -p flag takes the prompt as its
      // argument. We escape every token as a single-quoted shell word.
      const shq = (s) => "'" + String(s).replace(/'/g, "'\\''") + "'";
      const cmd =
        `cd ${shq(workdir)} && claude ` +
        [...extra, "-p", a.prompt].map(shq).join(" ");
      const r = await ssh(wrapDebian(cmd), {
        target: a.target,
        timeoutMs: a.timeoutMs || 600_000,
      });
      return textResult(formatResult(r, { label: `claude -p` }), { isError: r.code !== 0 });
    }
    default:
      return textResult(`unknown tool: ${name}`, { isError: true });
  }
}

// --- higher-level helpers -------------------------------------------------
async function termuxType(command, { serial, pressEnter = true } = {}) {
  // `adb shell input text` requires no spaces — they are converted to %s, which
  // input decodes back to space. Single quotes must be escaped for the shell.
  const escaped = command.replace(/ /g, "%s").replace(/'/g, "'\\''");
  const r = await adbShell(`input text '${escaped}'`, { serial });
  if (r.code !== 0) return textResult(formatResult(r, { label: "input text" }), { isError: true });
  if (pressEnter) {
    const e = await adbShell("input keyevent 66", { serial });
    if (e.code !== 0) return textResult(formatResult(e, { label: "keyevent ENTER" }), { isError: true });
  }
  return textResult(`typed: ${command}${pressEnter ? " <ENTER>" : ""}`);
}

async function termuxRunCommand(command, { serial, background = false, timeoutMs } = {}) {
  // Requires allow-external-apps=true in ~/.termux/termux.properties
  const outDir = "/data/data/com.termux/files/home/mcp-out";
  const stamp = Date.now().toString(36);
  const stdoutFile = `${outDir}/${stamp}.out`;
  const stderrFile = `${outDir}/${stamp}.err`;

  await adbShell(`run-as com.termux mkdir -p ${outDir} 2>/dev/null || true`, { serial });

  const intent =
    "am startservice " +
    "--user 0 " +
    "-n com.termux/com.termux.app.RunCommandService " +
    "-a com.termux.RUN_COMMAND " +
    `--es com.termux.RUN_COMMAND_PATH '/data/data/com.termux/files/usr/bin/bash' ` +
    `--esa com.termux.RUN_COMMAND_ARGUMENTS '-lc,${command.replace(/'/g, "'\\''")}' ` +
    `--es com.termux.RUN_COMMAND_WORKDIR '/data/data/com.termux/files/home' ` +
    `--ez com.termux.RUN_COMMAND_BACKGROUND ${background ? "true" : "false"} ` +
    `--es com.termux.RUN_COMMAND_SESSION_ACTION '0' ` +
    `--es com.termux.RUN_COMMAND_STDOUT_FILE '${stdoutFile}' ` +
    `--es com.termux.RUN_COMMAND_STDERR_FILE '${stderrFile}'`;

  const r = await adbShell(intent, { serial, timeoutMs });
  const label = `RUN_COMMAND ${background ? "(bg)" : "(fg)"}`;
  if (r.code !== 0) {
    return textResult(
      formatResult(r, { label }) +
        "\n\nHint: enable RUN_COMMAND by adding `allow-external-apps = true` to ~/.termux/termux.properties inside Termux, then run `termux-reload-settings`.",
      { isError: true },
    );
  }
  return textResult(`${label} dispatched.\nstdout: ${stdoutFile}\nstderr: ${stderrFile}\n${r.stdout || ""}`.trim());
}

async function setupClaudeCode({ serial, mode }) {
  const steps = [
    "yes | pkg update -y",
    "yes | pkg install -y nodejs-lts git",
    "npm install -g @anthropic-ai/claude-code",
    "claude --version || true",
  ];
  const log = [`mode: ${mode}`];
  if (mode === "run_command") {
    for (const cmd of steps) {
      log.push(`> ${cmd}`);
      const r = await termuxRunCommand(cmd, { serial, background: false, timeoutMs: 600_000 });
      log.push(r.content[0].text);
      if (r.isError) return textResult(log.join("\n\n"), { isError: true });
    }
    log.push(
      "Done. Check Termux session for progress. Output files live in ~/mcp-out/ on the device.",
    );
    return textResult(log.join("\n\n"));
  }

  // mode === "type": ensure Termux is open, then type each command.
  const open = await adbShell("am start -n com.termux/.HomeActivity", { serial });
  log.push(formatResult(open, { label: "open Termux" }));
  if (open.code !== 0) return textResult(log.join("\n\n"), { isError: true });

  // Small settle delay via a no-op; `adb shell` returns only after command exits.
  await adbShell("sleep 1", { serial });

  for (const cmd of steps) {
    const r = await termuxType(cmd, { serial, pressEnter: true });
    log.push(r.content[0].text);
    if (r.isError) return textResult(log.join("\n"), { isError: true });
    // Give each command time to run. `pkg update` and `npm install` can take minutes.
    await adbShell("sleep 2", { serial });
  }

  log.push(
    "Commands typed into Termux. Watch the phone — `pkg update` and " +
      "`npm install -g @anthropic-ai/claude-code` may take several minutes. " +
      "When it finishes, run `claude login` in Termux to authenticate.",
  );
  return textResult(log.join("\n"));
}

// --- server wiring --------------------------------------------------------
const server = new Server(
  { name: "android-mcp-server", version: "0.1.0" },
  { capabilities: { tools: {} } },
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));
server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const { name, arguments: args } = req.params;
  try {
    return await handleTool(name, args);
  } catch (err) {
    return textResult(`tool error: ${err?.stack || err?.message || String(err)}`, { isError: true });
  }
});

const transport = new StdioServerTransport();
await server.connect(transport);
