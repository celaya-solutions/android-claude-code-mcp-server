# Example 2 — Drive the phone's Settings UI by intent, not by pixel

Shows Claude using `ui_wait_for` + `ui_tap` with **text selectors** to navigate
a multi-screen UI. No hard-coded coordinates — the same flow keeps working if
Samsung reshuffles the menu next firmware update.

## What it does

1. Presses HOME.
2. Launches the Settings app (`launch_app` auto-resolves the LAUNCHER activity).
3. Waits for the top-level menu to render, then taps **Connections**.
4. Waits for the Connections screen, confirms **Wi-Fi** is visible, and takes a
   screenshot.
5. Returns to the home screen.

## Run it

```
Open the phone's Settings app, navigate into "Connections", take a screenshot
of that page, and then return to the home screen. Use ui_tap with a text
selector rather than coordinates.
```

## Expected tool-call sequence

```
ui_home
launch_app { pkg: "com.android.settings" }
ui_wait_for { textContains: "Connections", timeoutMs: 6000 }
ui_tap { text: "Connections" }
ui_wait_for { textContains: "Wi-Fi", timeoutMs: 5000 }
ui_screenshot { localPath: "/tmp/connections.png" }
ui_home
```

## Why selectors beat coordinates

- The Samsung Galaxy S24 ships at `1080x2340`, but tablets/foldables vary.
- Samsung rearranges the Settings menu across OneUI versions — "Connections"
  is row 4 on some, row 6 on others, sometimes "Network & internet" on newer
  builds.
- Text + content-desc selectors survive layout changes. Coordinates do not.

## Extension ideas

- Toggle Wi-Fi off/on by selector + ui_tap on the Wi-Fi switch.
- Combine with `droid-sh "settings put global mobile_data 0"` for a scripted
  airplane-mode-ish workflow that's immune to future UI changes.
- Wrap a sequence of selectors into a small JSON "flow" and have Claude replay
  it on demand ("run my 'travel mode' flow").
