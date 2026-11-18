#!/usr/bin/env bash
# Impreza dash: one-shot installer for Raspberry Pi 5 + Waveshare RS485 CAN HAT.
# Run on a fresh Raspberry Pi OS Lite (64-bit):
#   sudo ./setup_pi.sh                 # normal install
#   sudo OSC=8000000 ./setup_pi.sh     # if your HAT's crystal says 8.000 (default 12 MHz)
#   sudo DEMO=1 ./setup_pi.sh          # run the dash on simulated data (bench testing)
# Safe to re-run.
set -euo pipefail

[[ $EUID -eq 0 ]] || { echo "Run with sudo: sudo ./setup_pi.sh"; exit 1; }
USER_NAME="${SUDO_USER:-pi}"
USER_HOME="$(getent passwd "$USER_NAME" | cut -d: -f6)"
PI_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
OSC="${OSC:-12000000}"
DEMO="${DEMO:-0}"
BOOT=/boot/firmware
[[ -d $BOOT ]] || BOOT=/boot

echo "==> Installing for user '$USER_NAME', dash in $PI_DIR (CAN crystal ${OSC} Hz, demo=$DEMO)"

# ------------------------------------------------------------------ packages
apt-get update
apt-get install -y python3-can python3-aiohttp can-utils cage curl
if ! command -v chromium >/dev/null && ! command -v chromium-browser >/dev/null; then
  apt-get install -y chromium || apt-get install -y chromium-browser
fi

# ------------------------------------------------------------------ CAN HAT overlay
CFG="$BOOT/config.txt"
sed -i '/# >>> impreza-dash/,/# <<< impreza-dash/d' "$CFG"
cat >> "$CFG" <<EOF
# >>> impreza-dash
dtparam=spi=on
dtoverlay=mcp2515-can0,oscillator=${OSC},interrupt=25,spimaxfrequency=2000000
disable_splash=1
boot_delay=0
# <<< impreza-dash
EOF

# quiet, fast boot console
CMD="$BOOT/cmdline.txt"
for opt in quiet loglevel=3 logo.nologo vt.global_cursor_default=0 consoleblank=0; do
  grep -qw -- "$opt" "$CMD" || sed -i "1 s/\$/ $opt/" "$CMD"
done

# ------------------------------------------------------------------ can0: up, LISTEN-ONLY, 500 kbit/s
cat > /etc/systemd/system/can0.service <<'EOF'
[Unit]
Description=can0 up (500 kbit/s, listen-only)
BindsTo=sys-subsystem-net-devices-can0.device
After=sys-subsystem-net-devices-can0.device

[Service]
Type=oneshot
RemainAfterExit=yes
ExecStartPre=-/sbin/ip link set can0 down
ExecStart=/sbin/ip link set can0 up type can bitrate 500000 listen-only on restart-ms 100
ExecStop=/sbin/ip link set can0 down

[Install]
WantedBy=sys-subsystem-net-devices-can0.device
EOF

# ------------------------------------------------------------------ dash backend
EXTRA=""
[[ "$DEMO" == "1" ]] && EXTRA="--demo"
cat > /etc/systemd/system/impreza-dash.service <<EOF
[Unit]
Description=Impreza dash backend
After=local-fs.target

[Service]
User=$USER_NAME
WorkingDirectory=$PI_DIR
ExecStart=/usr/bin/python3 $PI_DIR/dash_server.py $EXTRA
Restart=always
RestartSec=1
Nice=-5

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable can0.service impreza-dash.service

# ------------------------------------------------------------------ kiosk on tty1
chmod +x "$PI_DIR/kiosk.sh"
if command -v raspi-config >/dev/null; then
  raspi-config nonint do_boot_behaviour B2      # console autologin
fi
PROFILE="$USER_HOME/.bash_profile"
touch "$PROFILE"
sed -i '/# >>> impreza-dash/,/# <<< impreza-dash/d' "$PROFILE"
cat >> "$PROFILE" <<EOF
# >>> impreza-dash
if [ -z "\$WAYLAND_DISPLAY" ] && [ "\$(tty)" = "/dev/tty1" ]; then
  exec "$PI_DIR/kiosk.sh"
fi
# <<< impreza-dash
EOF
chown "$USER_NAME": "$PROFILE"
usermod -aG video,render,input "$USER_NAME"

# ------------------------------------------------------------------ boot speed: skip things a dash doesn't need
for s in NetworkManager-wait-online.service systemd-networkd-wait-online.service \
         apt-daily.timer apt-daily-upgrade.timer man-db.timer e2scrub_reap.service \
         ModemManager.service cups.service avahi-daemon.service triggerhappy.service; do
  systemctl disable "$s" >/dev/null 2>&1 || true
done

echo
echo "==> Done. Reboot to start the dash:  sudo reboot"
echo "    After reboot, check CAN with:     ip -details link show can0   and   candump can0"
echo "    Backend logs:                     journalctl -u impreza-dash -f"
