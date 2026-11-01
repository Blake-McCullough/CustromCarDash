#!/usr/bin/env bash
# Launches the dash full-screen (cage Wayland kiosk + Chromium). Started from tty1 autologin.
URL="http://127.0.0.1:8080"

# wait (max ~15 s) for the backend so the first paint is the dash, not an error page
for _ in $(seq 1 60); do curl -s -o /dev/null "$URL" && break; sleep 0.25; done

BROWSER="$(command -v chromium || command -v chromium-browser)"

# Fresh profile in RAM every boot: nothing to corrupt when the car's power is cut,
# and no "restore pages?" prompts.
PROFILE_DIR="/tmp/dash-chromium"
rm -rf "$PROFILE_DIR"

exec cage -s -- "$BROWSER" \
  --kiosk "$URL" \
  --user-data-dir="$PROFILE_DIR" \
  --ozone-platform=wayland \
  --ignore-gpu-blocklist --enable-gpu-rasterization --enable-zero-copy \
  --noerrdialogs --disable-infobars --no-first-run --disable-session-crashed-bubble \
  --disable-features=Translate,TouchpadOverscrollHistoryNavigation \
  --overscroll-history-navigation=0 --disable-pinch \
  --check-for-update-interval=31536000 --password-store=basic
