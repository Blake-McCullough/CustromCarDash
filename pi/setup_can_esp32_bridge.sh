#!/usr/bin/env bash
# Bring up the ESP32 (SLCAN) as can0 on the Raspberry Pi.
# Usage:  ./setup_can.sh            (auto-detects the ESP32's serial port)
#         ./setup_can.sh /dev/ttyACM0
set -euo pipefail

DEV="${1:-}"
if [[ -z "$DEV" ]]; then
  for d in /dev/ttyACM0 /dev/ttyUSB0; do [[ -e "$d" ]] && DEV="$d" && break; done
fi
[[ -z "$DEV" ]] && { echo "ESP32 not found. Plug it in, or pass the port: ./setup_can.sh /dev/ttyUSB0"; exit 1; }

if ! command -v slcand >/dev/null; then
  sudo apt-get update
  sudo apt-get install -y can-utils python3-can python3-aiohttp
fi

sudo modprobe can
sudo modprobe can-raw
sudo modprobe slcan

# Clean up any previous session
sudo ip link set can0 down 2>/dev/null || true
sudo pkill -f "slcand.*can0" 2>/dev/null || true
sleep 0.3

# -o open, -c close first, -s6 = 500 kbit/s, -S = serial speed
sudo slcand -o -c -s6 -S 921600 "$DEV" can0
sleep 0.5
sudo ip link set can0 up txqueuelen 1000

echo "can0 is up on $DEV. Test with:  candump can0   or   cansniffer -c can0"
