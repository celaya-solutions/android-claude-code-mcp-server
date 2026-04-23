#!/bin/bash
# Start (or restart) Shizuku's server on the phone.
# Requires the phone to be reachable via adb over USB OR a paired self-adb.
# Why this exists: Shizuku's Wireless Debugging auto-start breaks on Samsung S24
# after every reboot because Android 14's WD rotates its TLS cert, invalidating
# Shizuku's saved pairing. Using a stable adb connection (USB) sidesteps that.
set -eu

ADB="${ADB_PATH:-$HOME/Library/Android/sdk/platform-tools/adb}"
SERIAL="${ANDROID_SERIAL:-}"

if [ ! -x "$ADB" ]; then
  echo "adb not found at $ADB — set ADB_PATH" >&2
  exit 1
fi

# Build the serial arg if specified
run_adb() { if [ -n "$SERIAL" ]; then "$ADB" -s "$SERIAL" "$@"; else "$ADB" "$@"; fi; }

# Discover Shizuku's APK path so we don't hardcode an install-specific hash.
APK=$(run_adb shell pm path moe.shizuku.privileged.api 2>/dev/null | head -1 | sed 's/^package://' | tr -d '\r')
if [ -z "$APK" ]; then
  echo "Shizuku not installed on the device" >&2
  exit 2
fi

# The starter binary lives next to the base.apk inside the app's native lib dir.
LIB_DIR="${APK%/base.apk}/lib/arm64"
STARTER="$LIB_DIR/libshizuku.so"

echo "apk:     $APK"
echo "starter: $STARTER"
echo

run_adb shell "$STARTER"
echo
echo "verify:"
run_adb shell 'ps -A 2>/dev/null | grep shizuku_server | head -1'
