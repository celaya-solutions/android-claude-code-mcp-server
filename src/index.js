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

// --- ui automator helpers -------------------------------------------------
// Pulls the accessibility tree via `uiautomator dump` and parses it into a
// flat list of node objects. Each node gets `_cx`/`_cy` centered-point helpers
// so selector-driven tools can tap without the caller knowing coordinates.
async function uiDump({ serial } = {}) {
  // Unique per call so concurrent uiDump() invocations don't clobber each other.
  const remote = `/sdcard/_mcp_ui_${process.pid}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}.xml`;
  const dump = await adbShell(
    `uiautomator dump ${remote} >/dev/null 2>&1 && cat ${remote} && rm -f ${remote}`,
    { serial, timeoutMs: 20_000 },
  );
  if (dump.code !== 0) {
    await adbShell(`rm -f ${remote}`, { serial }).catch(() => {});
    return { ok: false, error: dump.stderr || dump.stdout, nodes: [] };
  }
  return { ok: true, xml: dump.stdout, nodes: parseUiXml(dump.stdout) };
}

function parseUiXml(xml) {
  const nodes = [];
  // Match `<node ...>` or `<node .../>`. Attribute values may contain `/`
  // (e.g. resource-id="com.example:id/foo"), so we can't exclude `/` — just `>`.
  for (const nm of xml.matchAll(/<node\s+([^>]+?)\s*\/?>/g)) {
    const raw = nm[1];
    const attrs = {};
    for (const am of raw.matchAll(/([a-zA-Z][\w-]*)="([^"]*)"/g)) {
      attrs[am[1]] = am[2];
    }
    if (attrs.bounds) {
      const b = attrs.bounds.match(/\[(\d+),(\d+)\]\[(\d+),(\d+)\]/);
      if (b) {
        attrs._x1 = +b[1];
        attrs._y1 = +b[2];
        attrs._x2 = +b[3];
        attrs._y2 = +b[4];
        attrs._cx = (attrs._x1 + attrs._x2) >> 1;
        attrs._cy = (attrs._y1 + attrs._y2) >> 1;
      }
    }
    nodes.push(attrs);
  }
  return nodes;
}

// selector: { text?, textContains?, contentDesc?, resourceId?, className?, clickable? }
// Returns the best matching node or null. Ties break toward clickable + smallest-area.
function findNode(nodes, selector) {
  const s = selector || {};
  const match = (n) => {
    if (s.text != null && n.text !== s.text) return false;
    if (s.textContains != null && !(n.text || "").includes(s.textContains)) return false;
    if (s.contentDesc != null && n["content-desc"] !== s.contentDesc) return false;
    if (s.resourceId != null && n["resource-id"] !== s.resourceId) return false;
    if (s.className != null && !(n.class || "").includes(s.className)) return false;
    if (s.clickable != null && n.clickable !== String(s.clickable)) return false;
    return true;
  };
  const hits = nodes.filter(match);
  hits.sort((a, b) => {
    const aClick = a.clickable === "true" ? 0 : 1;
    const bClick = b.clickable === "true" ? 0 : 1;
    if (aClick !== bClick) return aClick - bClick;
    const aArea = (a._x2 - a._x1) * (a._y2 - a._y1);
    const bArea = (b._x2 - b._x1) * (b._y2 - b._y1);
    return aArea - bArea;
  });
  return hits[0] || null;
}

function summarizeNode(n) {
  const keys = ["text", "content-desc", "resource-id", "class", "clickable", "bounds"];
  const pairs = keys.filter((k) => n[k]).map((k) => `${k}=${JSON.stringify(n[k])}`);
  return `{ ${pairs.join(", ")} }`;
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
  // ---------- UI automation tools (uiautomator tree + input gestures) ----------
  {
    name: "ui_dump",
    description:
      "Snapshot the on-screen accessibility tree via `uiautomator dump`. Returns a list " +
      "of nodes with text/content-desc/resource-id/bounds so Claude can decide where to tap.",
    inputSchema: {
      type: "object",
      properties: {
        serial: { type: "string" },
        filter: {
          type: "string",
          description:
            "Optional: only return nodes whose text, content-desc, or resource-id contains this substring.",
        },
        clickableOnly: { type: "boolean", description: "Drop non-clickable nodes from the result." },
      },
      additionalProperties: false,
    },
  },
  {
    name: "ui_tap",
    description:
      "Tap a UI element matched by a selector (text, textContains, contentDesc, resourceId, " +
      "className). Preferred over raw coordinate taps. Falls back to `x`/`y` if no selector.",
    inputSchema: {
      type: "object",
      properties: {
        text: { type: "string" },
        textContains: { type: "string" },
        contentDesc: { type: "string" },
        resourceId: { type: "string" },
        className: { type: "string" },
        clickable: { type: "boolean" },
        x: { type: "number", description: "Raw x (only used when no selector is given)." },
        y: { type: "number" },
        serial: { type: "string" },
      },
      additionalProperties: false,
    },
  },
  {
    name: "ui_type",
    description:
      "Type text into the currently-focused input. Call `ui_tap` on an input field first.",
    inputSchema: {
      type: "object",
      properties: {
        text: { type: "string" },
        pressEnter: { type: "boolean", description: "Send ENTER after typing." },
        serial: { type: "string" },
      },
      required: ["text"],
      additionalProperties: false,
    },
  },
  {
    name: "ui_swipe",
    description: "Swipe from (x1,y1) to (x2,y2) in the given duration (ms).",
    inputSchema: {
      type: "object",
      properties: {
        x1: { type: "number" }, y1: { type: "number" },
        x2: { type: "number" }, y2: { type: "number" },
        durationMs: { type: "number" },
        serial: { type: "string" },
      },
      required: ["x1", "y1", "x2", "y2"],
      additionalProperties: false,
    },
  },
  {
    name: "ui_screenshot",
    description:
      "Grab a screenshot. Saves to localPath if given (PNG), otherwise returns the image inline " +
      "as a base64 data URL that Claude can view directly.",
    inputSchema: {
      type: "object",
      properties: {
        localPath: { type: "string", description: "Optional host PNG path to save to." },
        serial: { type: "string" },
      },
      additionalProperties: false,
    },
  },
  {
    name: "ui_back",
    description: "Press the Android BACK key.",
    inputSchema: {
      type: "object",
      properties: { serial: { type: "string" } },
      additionalProperties: false,
    },
  },
  {
    name: "ui_home",
    description: "Press the Android HOME key.",
    inputSchema: {
      type: "object",
      properties: { serial: { type: "string" } },
      additionalProperties: false,
    },
  },
  {
    name: "ui_wait_for",
    description:
      "Poll the accessibility tree until a selector matches (up to `timeoutMs` / default 8000). " +
      "Useful after launching an app or navigating.",
    inputSchema: {
      type: "object",
      properties: {
        text: { type: "string" },
        textContains: { type: "string" },
        contentDesc: { type: "string" },
        resourceId: { type: "string" },
        className: { type: "string" },
        timeoutMs: { type: "number" },
        serial: { type: "string" },
      },
      additionalProperties: false,
    },
  },

  // ---------- App / package / permission tools ----------
  {
    name: "launch_app",
    description:
      "Start an app. Use `pkg` + optional `activity`, or `pkg` + `url` for VIEW-intent deep links " +
      "(useful for opening URLs in Chrome: pkg=com.android.chrome, url=http://…).",
    inputSchema: {
      type: "object",
      properties: {
        pkg: { type: "string" },
        activity: { type: "string" },
        url: { type: "string" },
        action: { type: "string", description: "Override the intent action (default MAIN or VIEW if url)." },
        serial: { type: "string" },
      },
      required: ["pkg"],
      additionalProperties: false,
    },
  },
  {
    name: "list_apps",
    description: "List installed packages. `thirdPartyOnly` filters out system packages.",
    inputSchema: {
      type: "object",
      properties: {
        thirdPartyOnly: { type: "boolean", description: "Adds -3 (third-party only)." },
        filter: { type: "string", description: "Case-insensitive substring filter." },
        serial: { type: "string" },
      },
      additionalProperties: false,
    },
  },
  {
    name: "uninstall_app",
    description: "Uninstall a package by id.",
    inputSchema: {
      type: "object",
      properties: { pkg: { type: "string" }, serial: { type: "string" } },
      required: ["pkg"],
      additionalProperties: false,
    },
  },
  {
    name: "grant_permission",
    description: "Grant a runtime permission to a package (pm grant).",
    inputSchema: {
      type: "object",
      properties: {
        pkg: { type: "string" },
        permission: { type: "string", description: "e.g. android.permission.CAMERA" },
        serial: { type: "string" },
      },
      required: ["pkg", "permission"],
      additionalProperties: false,
    },
  },
  {
    name: "install_apk_url",
    description: "Download an APK from a URL to the host cache, then `adb install -r`.",
    inputSchema: {
      type: "object",
      properties: {
        url: { type: "string" },
        filename: { type: "string", description: "Cache filename override." },
        serial: { type: "string" },
      },
      required: ["url"],
      additionalProperties: false,
    },
  },

  // ---------- Observability ----------
  {
    name: "list_notifications",
    description: "Parse `dumpsys notification --noredact` into a list of title/text/package summaries.",
    inputSchema: {
      type: "object",
      properties: { serial: { type: "string" } },
      additionalProperties: false,
    },
  },
  {
    name: "current_activity",
    description: "Return the package + activity currently in the foreground.",
    inputSchema: {
      type: "object",
      properties: { serial: { type: "string" } },
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
    case "ui_dump": {
      const r = await uiDump({ serial: a.serial });
      if (!r.ok) return textResult(`ui_dump failed: ${r.error}`, { isError: true });
      let nodes = r.nodes.filter((n) => n.bounds);
      if (a.clickableOnly) nodes = nodes.filter((n) => n.clickable === "true");
      if (a.filter) {
        const f = a.filter;
        nodes = nodes.filter(
          (n) =>
            (n.text || "").includes(f) ||
            (n["content-desc"] || "").includes(f) ||
            (n["resource-id"] || "").includes(f),
        );
      }
      const lines = nodes.map(
        (n) =>
          `  (${n._cx},${n._cy}) ${summarizeNode(n)}`.replace(/_x1|_y1|_x2|_y2|_cx|_cy/g, ""),
      );
      const summary = `${nodes.length} node(s)${a.filter ? ` matching "${a.filter}"` : ""}${
        a.clickableOnly ? " (clickable only)" : ""
      }`;
      return textResult(`${summary}\n${lines.slice(0, 80).join("\n")}${lines.length > 80 ? `\n...(+${lines.length - 80} more)` : ""}`);
    }

    case "ui_tap": {
      let x = a.x, y = a.y;
      const selectorKeys = ["text", "textContains", "contentDesc", "resourceId", "className", "clickable"];
      const hasSelector = selectorKeys.some((k) => a[k] != null);
      if (hasSelector) {
        const dump = await uiDump({ serial: a.serial });
        if (!dump.ok) return textResult(`ui_tap: dump failed: ${dump.error}`, { isError: true });
        const sel = {};
        for (const k of selectorKeys) if (a[k] != null) sel[k] = a[k];
        const node = findNode(dump.nodes, sel);
        if (!node || node._cx == null) {
          return textResult(`ui_tap: no node matched selector ${JSON.stringify(sel)}`, { isError: true });
        }
        x = node._cx;
        y = node._cy;
      }
      if (x == null || y == null) {
        return textResult("ui_tap: need a selector or explicit x/y", { isError: true });
      }
      const r = await adbShell(`input tap ${x} ${y}`, { serial: a.serial });
      return textResult(`tapped (${x},${y})${r.stderr ? `\n${r.stderr}` : ""}`, {
        isError: r.code !== 0,
      });
    }

    case "ui_type": {
      const escaped = a.text.replace(/ /g, "%s").replace(/'/g, "'\\''");
      const r = await adbShell(`input text '${escaped}'`, { serial: a.serial });
      if (r.code !== 0) return textResult(formatResult(r, { label: "input text" }), { isError: true });
      if (a.pressEnter) {
        const e = await adbShell("input keyevent 66", { serial: a.serial });
        if (e.code !== 0) return textResult(formatResult(e, { label: "keyevent ENTER" }), { isError: true });
      }
      return textResult(`typed ${JSON.stringify(a.text)}${a.pressEnter ? " <ENTER>" : ""}`);
    }

    case "ui_swipe": {
      const dur = a.durationMs || 300;
      const r = await adbShell(`input swipe ${a.x1} ${a.y1} ${a.x2} ${a.y2} ${dur}`, { serial: a.serial });
      return textResult(
        `swiped (${a.x1},${a.y1}) -> (${a.x2},${a.y2}) in ${dur}ms${r.stderr ? `\n${r.stderr}` : ""}`,
        { isError: r.code !== 0 },
      );
    }

    case "ui_screenshot": {
      const remote = "/sdcard/_mcp_shot.png";
      const r1 = await adbShell(`screencap -p ${remote}`, { serial: a.serial });
      if (r1.code !== 0) {
        return textResult(formatResult(r1, { label: "screencap" }), { isError: true });
      }
      if (a.localPath) {
        const r2 = await adb(["pull", remote, a.localPath], { serial: a.serial });
        await adbShell(`rm -f ${remote}`, { serial: a.serial });
        return textResult(formatResult(r2, { label: `pull -> ${a.localPath}` }), {
          isError: r2.code !== 0,
        });
      }
      // No localPath: read bytes and return as an image content block.
      const tmp = join(DOWNLOAD_DIR, `shot_${Date.now()}.png`);
      const pullRes = await adb(["pull", remote, tmp], { serial: a.serial });
      await adbShell(`rm -f ${remote}`, { serial: a.serial });
      if (pullRes.code !== 0) {
        return textResult(formatResult(pullRes, { label: "pull screenshot" }), { isError: true });
      }
      const { readFile, unlink } = await import("node:fs/promises");
      const buf = await readFile(tmp);
      await unlink(tmp).catch(() => {});
      return {
        content: [
          { type: "image", data: buf.toString("base64"), mimeType: "image/png" },
          { type: "text", text: `screenshot captured (${buf.length} bytes)` },
        ],
      };
    }

    case "ui_back": {
      const r = await adbShell("input keyevent 4", { serial: a.serial });
      return textResult("BACK", { isError: r.code !== 0 });
    }
    case "ui_home": {
      const r = await adbShell("input keyevent 3", { serial: a.serial });
      return textResult("HOME", { isError: r.code !== 0 });
    }

    case "ui_wait_for": {
      const timeout = a.timeoutMs || 8_000;
      const deadline = Date.now() + timeout;
      const selectorKeys = ["text", "textContains", "contentDesc", "resourceId", "className"];
      const sel = {};
      for (const k of selectorKeys) if (a[k] != null) sel[k] = a[k];
      if (Object.keys(sel).length === 0) {
        return textResult("ui_wait_for: provide at least one selector", { isError: true });
      }
      let last = null;
      while (Date.now() < deadline) {
        const dump = await uiDump({ serial: a.serial });
        if (dump.ok) {
          const hit = findNode(dump.nodes, sel);
          if (hit) {
            return textResult(`matched after ${Date.now() - (deadline - timeout)}ms: ${summarizeNode(hit)}`);
          }
        } else {
          last = dump.error;
        }
        await new Promise((r) => setTimeout(r, 500));
      }
      return textResult(`ui_wait_for: timed out after ${timeout}ms waiting for ${JSON.stringify(sel)}${last ? `\n(last dump error: ${last})` : ""}`, { isError: true });
    }

    case "launch_app": {
      // For plain-launch (no URL, no explicit activity), resolve the LAUNCHER activity
      // via `cmd package resolve-activity` — passing a bare pkg to `am start -a MAIN`
      // trips the Android Resolver on Samsung. For VIEW-intent URL deep links, go direct.
      if (a.url) {
        const args = [
          "shell", "am", "start",
          "-a", a.action || "android.intent.action.VIEW",
          "-d", a.url,
        ];
        if (a.activity) args.push("-n", `${a.pkg}/${a.activity}`);
        else args.push(a.pkg);
        const r = await adb(args, { serial: a.serial });
        return textResult(formatResult(r, { label: `launch ${a.pkg} ${a.url}` }), { isError: r.code !== 0 });
      }
      let activity = a.activity;
      if (!activity) {
        const resolve = await adbShell(
          `cmd package resolve-activity --brief -c android.intent.category.LAUNCHER ${a.pkg}`,
          { serial: a.serial },
        );
        // Last line of output is `<pkg>/<activity>` when resolved.
        const line = (resolve.stdout || "").trim().split("\n").pop() || "";
        if (line.includes("/")) activity = line.split("/")[1];
      }
      if (activity) {
        const r = await adb(["shell", "am", "start", "-n", `${a.pkg}/${activity}`], { serial: a.serial });
        return textResult(formatResult(r, { label: `launch ${a.pkg}/${activity}` }), {
          isError: r.code !== 0,
        });
      }
      // Fall back to monkey — it synthesizes a LAUNCHER intent.
      const mk = await adbShell(`monkey -p ${a.pkg} -c android.intent.category.LAUNCHER 1`, { serial: a.serial });
      return textResult(
        `launched ${a.pkg} (monkey fallback)${mk.stdout ? `\n${mk.stdout}` : ""}`,
        { isError: mk.code !== 0 },
      );
    }

    case "list_apps": {
      const args = ["shell", "pm", "list", "packages"];
      if (a.thirdPartyOnly) args.push("-3");
      const r = await adb(args, { serial: a.serial });
      let lines = (r.stdout || "").split("\n").map((s) => s.replace(/^package:/, "").trim()).filter(Boolean);
      if (a.filter) {
        const f = a.filter.toLowerCase();
        lines = lines.filter((p) => p.toLowerCase().includes(f));
      }
      return textResult(`${lines.length} package(s):\n${lines.slice(0, 200).join("\n")}`);
    }

    case "uninstall_app": {
      const r = await adb(["uninstall", a.pkg], { serial: a.serial });
      return textResult(formatResult(r, { label: `uninstall ${a.pkg}` }), { isError: r.code !== 0 });
    }

    case "grant_permission": {
      const r = await adbShell(`pm grant ${a.pkg} ${a.permission}`, { serial: a.serial });
      return textResult(formatResult(r, { label: `grant ${a.permission} -> ${a.pkg}` }), {
        isError: r.code !== 0,
      });
    }

    case "install_apk_url": {
      const filename = a.filename || a.url.split("/").pop().split("?")[0] || "download.apk";
      const dest = join(DOWNLOAD_DIR, filename);
      if (!existsSync(dest)) {
        try {
          await downloadFile(a.url, dest);
        } catch (e) {
          return textResult(`download failed: ${e.message}`, { isError: true });
        }
      }
      const r = await adb(["install", "-r", dest], { serial: a.serial, timeoutMs: 300_000 });
      return textResult(`apk: ${dest}\n${formatResult(r, { label: "install" })}`, {
        isError: r.code !== 0,
      });
    }

    case "list_notifications": {
      const r = await adbShell("dumpsys notification --noredact", { serial: a.serial });
      if (r.code !== 0) {
        return textResult(formatResult(r, { label: "dumpsys notification" }), { isError: true });
      }
      const out = r.stdout || "";
      // Parse: each notification block starts with "NotificationRecord(…pkg=com.foo…)".
      // Within the block: android.title=…, android.text=… entries.
      const entries = [];
      const blocks = out.split(/\n(?=\s*NotificationRecord\(|\s*N\[)/);
      for (const blk of blocks) {
        const pkgM = blk.match(/pkg=([^\s]+)/);
        const titleM = blk.match(/android\.title=(?:String \()?([^\n)]+)\)?/);
        const textM = blk.match(/android\.text=(?:String \()?([^\n)]+)\)?/);
        if (pkgM && (titleM || textM)) {
          entries.push({
            pkg: pkgM[1],
            title: titleM ? titleM[1].trim() : "",
            text: textM ? textM[1].trim() : "",
          });
        }
      }
      // Dedupe
      const seen = new Set();
      const dedup = entries.filter((e) => {
        const k = `${e.pkg}::${e.title}::${e.text}`;
        if (seen.has(k)) return false;
        seen.add(k);
        return true;
      });
      const rendered = dedup.map((e) => `[${e.pkg}] ${e.title}${e.text ? ` — ${e.text}` : ""}`);
      return textResult(`${dedup.length} notification(s):\n${rendered.join("\n")}`);
    }

    case "current_activity": {
      const r = await adbShell(
        "dumpsys window | grep -E 'mCurrentFocus|mFocusedApp' | head -4",
        { serial: a.serial },
      );
      return textResult(formatResult(r, { label: "current_activity" }), { isError: r.code !== 0 });
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
