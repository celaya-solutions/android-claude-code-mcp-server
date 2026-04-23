# vhs tape: renders a demo GIF of `android-claude-code-mcp init` for the README.
# Run:  vhs assets/demo.tape
#
# Requires a phone to be adb-authorized so init can run for real.
# On a fresh phone the full flow takes ~80 s; on an already-configured phone
# (which is what you want for the demo), every phase fast-paths in ~10 s total.

Output assets/demo.gif

Set Shell "bash"
Set FontSize 16
Set Width 1100
Set Height 640
Set Theme "Catppuccin Mocha"
Set PlaybackSpeed 1.0
Set TypingSpeed 40ms

Type "node bin/cli.js init"
Sleep 400ms
Enter
Sleep 14s
Sleep 2s
