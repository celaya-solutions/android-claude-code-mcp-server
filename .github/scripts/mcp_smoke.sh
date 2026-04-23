#!/usr/bin/env bash
# No-device smoke test: verify the MCP server handshakes and exposes 30+ tools.
set -euo pipefail

OUT=$(mktemp)
trap 'rm -f "$OUT"' EXIT

{
  printf '%s\n' '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"ci","version":"0"}}}'
  printf '%s\n' '{"jsonrpc":"2.0","method":"notifications/initialized"}'
  printf '%s\n' '{"jsonrpc":"2.0","id":2,"method":"tools/list"}'
} | node src/index.js > "$OUT" &
SERVER_PID=$!
# kill if it hasn't exited on its own within 15s (stdin is closed so it should)
( sleep 15; kill -0 $SERVER_PID 2>/dev/null && kill -9 $SERVER_PID 2>/dev/null ) &
WATCHDOG=$!
wait $SERVER_PID || true
{ kill -9 $WATCHDOG 2>/dev/null && wait $WATCHDOG 2>/dev/null; } || true

node -e '
const fs = require("node:fs");
const buf = fs.readFileSync(process.argv[1], "utf8");
let ok = false;
let toolCount = 0;
for (const l of buf.split("\n").filter(Boolean)) {
  let j; try { j = JSON.parse(l); } catch { continue; }
  if (j.id === 1 && j.result && j.result.serverInfo) ok = true;
  if (j.id === 2 && j.result && Array.isArray(j.result.tools)) toolCount = j.result.tools.length;
}
if (!ok) { console.error("handshake failed"); process.exit(1); }
if (toolCount < 30) { console.error(`expected 30+ tools, got ${toolCount}`); process.exit(1); }
console.log(`ok: handshake + ${toolCount} tools`);
' "$OUT"
