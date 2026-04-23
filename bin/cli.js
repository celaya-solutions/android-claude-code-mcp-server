#!/usr/bin/env node
// Entry point for the `android-claude-code-mcp` binary.
// Dispatches to one of a handful of subcommands.

import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const [cmd, ...rest] = process.argv.slice(2);

const SUB = {
  init: join(here, "init.js"),
  server: join(here, "..", "src", "index.js"),
  "start-shizuku": join(here, "start-shizuku.sh"),
};

if (!cmd || cmd === "--help" || cmd === "-h") {
  console.log(`android-claude-code-mcp — driver for the real Claude Code on Android

Subcommands:
  init              Bootstrap a phone end-to-end (APKs, ssh, Debian, claude, gh, Shizuku)
  server            Run the MCP server over stdio (for registering with Claude Code)
  start-shizuku     Restart Shizuku's shell-UID service (needed after each phone reboot)

Usage:
  android-claude-code-mcp init [--serial ID] [--skip ssh,boot,...]
  android-claude-code-mcp server
  android-claude-code-mcp start-shizuku

Env:
  ADB_PATH                   Override adb binary location
  ANDROID_MCP_SSH_KEY        Path to host pubkey (default ~/.ssh/id_ed25519.pub)
  ANDROID_MCP_SSH_TARGET     user@host:port for MCP tools (default u0_a386@100.74.202.32:8022)
  ANDROID_MCP_CACHE          Download cache dir (default ~/.cache/android-mcp-server)
  GIT_USER_NAME, GIT_USER_EMAIL  Set during init for git config
`);
  process.exit(cmd ? 0 : 2);
}

const target = SUB[cmd];
if (!target) {
  console.error(`unknown subcommand: ${cmd}\nRun with --help for a list.`);
  process.exit(2);
}

const isShell = target.endsWith(".sh");
const runner = isShell ? target : process.execPath;
const runnerArgs = isShell ? rest : [target, ...rest];
const child = spawn(runner, runnerArgs, { stdio: "inherit" });
child.on("exit", (code) => process.exit(code ?? 1));
