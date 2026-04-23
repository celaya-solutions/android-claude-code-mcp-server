# Example 1 — Read the phone's notifications and summarize them

A two-minute demo that shows Claude using MCP tools to read live Android state
and reason over it. Great for a "wait, it can do that?" moment in a README.

## What it does

1. Calls `list_notifications` to dump parsed notification entries (package,
   title, text) from `dumpsys notification --noredact`.
2. Summarizes them in plain English, grouping by app.
3. Flags anything that looks time-sensitive (2FA codes, calendar, missed calls).

## Prerequisites

- `android-mcp-server` registered in Claude Code (see the main README).
- Phone on USB, `adb devices` shows the device.

## Run it

From a Claude Code session on the Mac, paste:

```
Use the list_notifications MCP tool to grab my phone's current notifications,
then give me a 3-bullet summary: (1) what apps are most active, (2) anything
that looks urgent or time-sensitive (codes, calendar events, missed calls), and
(3) anything weird/surprising. Don't repeat the raw dump back at me.
```

## Expected shape of output

```
You have 11 notifications across 6 apps.

- Most active: Gmail (4), Slack (3), Google Calendar (2).
- Time-sensitive: a 6-digit code from "GitHub" that may be a 2FA expire, and a
  calendar reminder for "Standup" at 09:00.
- Surprising: a persistent "USB for file transfer" from com.android.systemui —
  that's a system toast, not a real alert.
```

## Extension ideas

- Add `grant_permission android.permission.READ_NOTIFICATIONS` to a logging app,
  then poll every few minutes and write to a file.
- Feed `current_activity` to correlate notification surges with app usage.
- Pipe the parsed entries into a Next.js dashboard (serve from Termux via the
  pattern in `examples/03-build-and-serve.md`).
