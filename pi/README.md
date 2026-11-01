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
python3 dash_server.py --cursor   # show the mouse pointer (or add ?cursor to the URL)
```

## Settings (⚙ bottom right)
- **Theme:** Red, WR Blue, Ice, Matrix, Gold, Neon, Synth or Mono.
- **Graphics:** glow effects high/low, auto-lower when the frame rate drops, particles on/off.
- **Shift lights:** where the lights start flashing, and the redline.
- **Reset:** trip, best 0–100, peak G, or all settings.
- **System:** data source, CAN frame rate, signals, car model, screen size, render fps.

Settings are saved on the Pi in `settings.json`, so they survive reboots.

## Themes
The 3D car, glow, grid, G-meter and highlights all follow the theme. Warning colours
(brake, slip, check engine, redline) stay red.

## Using a real car model
See `static/models/README.md`. Drop in a .glb file and a small `model.json`, and the dash renders it
in the same glowing wireframe style, with spinning and steering wheels if the wheels are separate objects.

## Preview on your Windows PC (no Pi needed)
1. Install Python from python.org (tick **Add python.exe to PATH**).
2. In a terminal: `pip install aiohttp`
3. In the `pi` folder: `python dash_server.py --demo --cursor` (`--cursor` shows the mouse pointer,
   which is hidden by default for the touch screen)
4. Open **http://localhost:8080** in Chrome. Press **F11** for full screen.
5. To see it at your screen's exact size: press **F12** → device toolbar icon → enter your screen's
   resolution (e.g. 1024 × 600).
Edit any file, then press **Ctrl+F5** in the browser to see the change. No need to restart the server,
except after editing `signals.json` or `dash_server.py`.

## Notes
- Steering ratio and the wheel-slip threshold are at the top of `static/app.js`.
- Glow effects drop to LOW automatically if the frame rate falls below 30 (switch this off in ⚙ Settings).
- Camera: tap AUTO/ORBIT/CHASE/SIDE/FRONT/TOP, or drag the car to orbit it.
- Boot: the dash should be up roughly 8–12 s after power. Chromium runs with a fresh profile in RAM
  each boot, so cutting power can't corrupt it.
- All signal decodes start **unverified**. They come from a 2013 Subaru main-bus decode, not from
  your exact car.
