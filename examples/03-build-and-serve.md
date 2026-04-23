# Example 3 — Build a web app on the phone, view it in phone-Chrome

End-to-end demo where phone-Claude (the real `claude` CLI running inside the
Debian proot on Android) builds a tiny full-stack app, serves it from Termux,
then opens it in the phone's Chrome browser. Host-Claude (on your Mac) only
orchestrates.

## What it does

1. Host-Claude SSHes into Termux → Debian proot → runs `claude -p "<brief>"` as
   the non-root `dev` user (Claude Code refuses `--dangerously-skip-permissions`
   as UID 0; we seeded a `dev` account with cloned auth during bootstrap).
2. Phone-Claude writes `server.js` and `index.html` in `~/webapp/`.
3. Files are copied out to Termux (so the server survives any proot session
   exit) and started with `nohup node server.js &`.
4. Host-Claude calls `launch_app { pkg: "com.android.chrome", url: "http://127.0.0.1:3000/" }`.
5. Phone-Chrome loads the page, JS fetches `/api/message`, renders `it works`.

## Run it

```
Use claude_run to invoke claude-on-phone with this brief:
---
Build a tiny demo in ~/webapp/:
1) server.js — Node HTTP server (built-in `http` + `fs` only, no deps). Serves
   index.html at / and JSON {"message":"it works"} at /api/message. Listen on
   0.0.0.0:3000.
2) index.html — page that fetches /api/message and renders the string into an
   <h1> with a centered card.
Then start the server with `nohup node server.js >server.log 2>&1 &` and
curl /api/message to confirm.
---
After that completes, copy server.js and index.html from the Debian proot's
~/webapp to Termux's ~/webapp, kill any prior node, then start it in Termux
with nohup + disown so it survives. Finally use launch_app to open
http://127.0.0.1:3000/ in Chrome and take a ui_screenshot.
```

## Notes on the Debian-vs-Termux split

- **Run Claude Code inside the Debian proot** because `claude` is a
  glibc-linked binary; Termux uses bionic.
- **Run long-lived servers inside Termux** because proot-distro cleans up
  child processes when its session exits. The `claude_run` wrapper's session
  is short-lived by design.
- A typical pattern is "phone-Claude writes code in the proot, host-Claude
  moves it to Termux and runs it there". The two filesystems share
  `~/termux-home -> /root/termux-home` via bind mount, so this is mostly free.

## Extension ideas

- Replace the toy server with a SQLite-backed notes app; persist at
  `~/webapp/notes.db`.
- Expose the server on the tailnet instead of LAN; `ssh -R 3000:localhost:3000`
  to give a laptop peer access.
- Wire it to `termux-notification` for push alerts when the API is hit.
