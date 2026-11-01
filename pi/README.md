# Impreza Dash (Raspberry Pi 5 + RS485 CAN HAT)

3D wireframe car, speed/RPM/gear, shift lights, pedals, steering, G-meter, wheel speeds with slip
warning, trip stats, 0–100 timer, live graphs, and a raw CAN bus viewer. Runs full-screen on boot.

## Hardware
- Raspberry Pi 5 (2 GB is enough) + Active Cooler
- Waveshare **RS485 CAN HAT** (MCP2515, 3.3 V)
- Your HDMI + USB touch screen
- 12 V → 5 V **5 A** converter on an ignition-switched (ACC), fused circuit

### HAT settings
- CAN **termination DIP switch: OFF** (the car's bus is already terminated)
- Check the crystal next to the MCP2515: **12.000** (default) or **8.000** → use `OSC=8000000` when installing

### Wiring (HAT green terminal → OBD-II pigtail)
| HAT | OBD pin | Colour |
|---|---|---|
| H | 6 | Green |
| L | 14 | Green/White |
| GND (Pi GND pin) | 5 | Light blue |

Twist the H/L pair. **Never connect OBD pin 16 (red, +12 V)** to the HAT. Tape off every unused wire.

## Install (fresh Raspberry Pi OS Lite 64-bit)
```bash
git clone <your repo>  ~/CustromCarDash      # or copy the folder over
cd ~/CustromCarDash/pi
sudo ./setup_pi.sh                 # crystal 12 MHz
# sudo OSC=8000000 ./setup_pi.sh   # crystal 8 MHz
sudo reboot
```
It installs everything, brings up `can0` **listen-only** at 500 kbit/s on every boot, starts the
backend, and launches the dash full-screen. The listen-only mode means the HAT never transmits
or acknowledges anything on the car's bus.

**Bench test first, without the car:** `sudo DEMO=1 ./setup_pi.sh` runs on simulated data.
Re-run without `DEMO=1` when you go live.

## First time in the car
1. Engine **off**, plug in, turn the key to ACC/ON. Check the car's warning lights stay normal.
2. Start the engine. The header should say **LIVE CAN** with a few thousand FR/S.
3. Open the **BUS** tab. Rev the engine, press the brake, turn the wheel, and watch which bytes flash.
4. Fix any wrong decodes in `signals.json`, then set `"verified": true` (the amber `?` disappears).
   Restart the backend: `sudo systemctl restart impreza-dash`.

## Useful commands
```bash
ip -details link show can0        # should say LISTEN-ONLY, bitrate 500000
candump can0                      # raw traffic
journalctl -u impreza-dash -f     # backend log
python3 dash_server.py --demo     # run manually on simulated data (stop the service first)
```

## Notes
- **Settings** (redline, shift light, steering ratio) are at the top of `static/app.js`.
- **FX: HIGH/LOW** in the bottom bar toggles the glow effect. It drops to LOW automatically if the
  frame rate falls below 30.
- Camera: tap AUTO/ORBIT/CHASE/SIDE/FRONT/TOP, or drag the car to orbit it.
- Boot: the dash should be up roughly 8–12 s after power. Chromium runs with a fresh profile in RAM
  each boot, so cutting power can't corrupt it.
- All signal decodes start **unverified**. They come from a 2013 Subaru main-bus decode, not from
  your exact car.
