# Impreza Dash (Raspberry Pi 4/5 + RS485 CAN HAT)

3D wireframe car, speed/RPM/gear, shift lights, pedals, steering, G-meter, wheel speeds with slip
warning, trip stats, 0–100 timer, live graphs, and a raw CAN bus viewer. Runs full-screen on boot.

## Hardware
- Raspberry Pi 5 (2 GB is enough) + Active Cooler, **or a Raspberry Pi 4** (see the Pi 4 notes below)
- Waveshare **RS485 CAN HAT** (MCP2515, 3.3 V)
- Your HDMI + USB touch screen
- 12 V → 5 V converter on an ignition-switched (ACC), fused circuit: **5 A** for a Pi 5, **3 A** for a Pi 4

### HAT settings
- CAN **termination DIP switch: OFF** (the car's bus is already terminated)
- Check the crystal next to the MCP2515: **12.000** (default) or **8.000** → use `OSC=8000000` when installing

### Wiring (HAT green terminal → OBD-II pigtail)
| HAT | OBD pin | Colour |
|---|---|---|
| H | 6 | Green |
| L | 14 | Green/White |
| GND (any Pi GND pin, e.g. physical pin 6) | 5 | Light blue |
| A, B | not used (RS485) | |

Twist the H/L pair. **Never connect OBD pin 16 (red, +12 V)** to the HAT. Tape off every unused wire.

## Install (fresh Raspberry Pi OS Lite 64-bit)
Flash **Raspberry Pi OS Lite (64-bit)** with Raspberry Pi Imager. In its settings, set the hostname (e.g.
`dash`), a user, Wi-Fi, and enable SSH. Boot the Pi, then `ssh <user>@dash.local`:
```bash
sudo apt install -y git
git clone https://github.com/Blake-McCullough/CustromCarDash.git ~/CustromCarDash
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

## Updating
```bash
cd ~/CustromCarDash && git pull
sudo systemctl restart impreza-dash      # then reboot, or reload the page from ⚙
```
Only re-run `setup_pi.sh` if the installer itself changed.

## Raspberry Pi 4 notes
- Screen: use **micro-HDMI port 0** (the one next to the USB-C power socket).
- It has a weaker GPU than a Pi 5. In ⚙ Settings, set **Car → Detail: LOW**, and if needed
  **Glow effects: LOW** and **Particles: OFF**.
- If the screen shows the wrong resolution, add `video=HDMI-A-1:1024x600@60` (your screen's
  resolution) to the end of the single line in `/boot/firmware/cmdline.txt`, then reboot.

## Recording the CAN bus (to share for decoding)
1. Open the **BUS** tab and tap **● RECORD**. A red **● REC** shows in the header while it runs.
2. Do one thing at a time, and tap the matching **marker** button just before each one: IDLE, REV,
   BRAKE, CLUTCH, STEER L/R, gears N/1–6/R, lights, indicators and so on.
3. Tap **■ STOP**.
4. Get the file off the Pi, either way:
   - **From your phone or PC** on the same Wi-Fi: open `http://<pi-name>.local:8080` (e.g. `http://pidash.local:8080`),
     then ⚙ → **CAN LOGS** → **ZIP**. The zip holds the log, the markers and a README.
   - **Or copy the folder:** `scp -r <user>@<pi-name>.local:~/CustromCarDash/pi/logs .`
5. Send the zip to whoever is decoding it (e.g. upload it to Claude).

Logs are saved in `pi/logs/` (not committed to git) in candump format, gzip-compressed (roughly
3–6 MB per 10 minutes). Recording stops automatically if the Pi gets below 300 MB free.

## Display brightness
⚙ → **DISPLAY**: brightness, a separate night brightness, and *Dim when headlights on*.
- Official/DSI touch screens: the dash controls the real backlight.
- HDMI monitors that support DDC/CI: the dash controls the backlight through `ddcutil` (detected at startup).
- Most small HDMI screens support neither. The dash then dims the picture in software, and the screen's own
  buttons set the maximum. The settings page shows which method is in use.
- *Dim when headlights on* uses the `low_beam`/`high_beam` signals, so it only works once those are verified.

## Gear and wheel power
The car broadcasts its own **gear** (1–6, N) on CAN, and the dash uses it by default. It's shown dimmed while the
clutch is in (the car is guessing then). Reverse can't be detected. A calculated gear is available as a fallback:
- **Gear:** engine rpm ÷ speed, matched to each gear's ratio. It starts with approximate ratios and
  **learns your car's exact ones automatically** as you drive steadily in each gear. ⚙ Settings → Gear & Power
  shows the learned values; *Gear ratios* under Reset starts over. Pick 5 or 6 gears there, or switch back to the CAN signal.
- **Wheel power (kW):** a "virtual dyno" from how fast you're accelerating, the car's weight, drag and rolling
  resistance. Set **Car + driver (kg)** in Settings for accuracy. It reads 0 off-throttle and with the clutch in.
  It's an estimate (expect ±10–15%); best on a flat road in one gear at full throttle. Peak is shown on the ENGINE tab.
- If your car is a **CVT**, the calculated gear only works in manual (paddle) mode.

## OBD-II live data (optional, `OBD=1`)
By default the dash only **listens** to the car's own broadcast messages. With OBD mode it also
**asks** the engine computer for standard OBD-II values, the same requests every scan tool and ELM327
dongle sends: RPM, speed, throttle, load, manifold pressure, air flow, timing, intake/coolant/oil temp,
fuel trims, battery voltage, fuel level, outside temp and baro. They show on the **ENGINE** tab. RPM,
speed, throttle and coolant also feed the main dash. OBD values count as verified, so they replace the
unverified broadcast decodes for those signals.

```bash
sudo OBD=1 ./setup_pi.sh && sudo reboot          # add OSC=8000000 if your crystal says 8.000
```

What changes, and the safety limits:
- `can0` comes up in **normal mode** instead of listen-only, so the HAT can transmit and ACK.
- The code only ever builds **service 01 "read current data"** requests (ID `0x7DF`), from a fixed list.
  It never clears codes, writes or resets anything.
- About 40 requests a second, the normal pace for a scan tool.
- If 5 sends in a row fail, it **stops transmitting** until the next restart.
- `can0` has no auto-restart, so a wrong crystal or bitrate makes the HAT go silent instead of
  repeatedly disturbing the bus.

**First test:** engine **off**, key to **ON** (bus awake, car parked). Watch the dash warning lights.
The ENGINE tab header should say `polling · N values`. If any warning light comes on, unplug and
re-check the crystal setting. Only then start the engine.

To go back to listen-only: `sudo ./setup_pi.sh && sudo reboot`.
Try it without the car: `python3 dash_server.py --demo --obd` (a simulated engine computer answers).

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
- **Car:**
  - **Model:** IMPREZA (the bundled 2012 sedan wireframe, default), CUSTOM (your own .glb, only shown
    when `static/models/model.json` exists) or BASIC (the simple built-in shape). Changing it reloads the page.
  - **Style:** SOLID hides the lines on the far side of the car. X-RAY shows every line through the body.
  - **Detail:** HIGH (about 120k lines) or LOW (about 66k lines, lighter on the Pi).
  - **Edge glow:** the soft outline glow around the body.
  - **Show:** turn the light, wheel and glass lines on or off.
- **Graphics:** glow effects high/low, auto-lower when the frame rate drops, particles on/off.
- **Shift lights:** where the lights start flashing, and the redline.
- **Reset:** trip, best 0–100, peak G, or all settings.
- **System:** data source, CAN frame rate, signals, car model, screen size, render fps.

Settings are saved on the Pi in `settings.json`, so they survive reboots.

## Themes
The 3D car, glow, grid, G-meter and highlights all follow the theme. Warning colours
(brake, slip, check engine, redline) stay red.

## The 3D car
The dash ships with a wireframe of a 2012 Impreza sedan (`static/models/impreza_high.bin.gz` and
`impreza_low.bin.gz`). Its wheels spin at the measured wheel speeds and the fronts steer, the tail-light
lines glow when you brake, and the headlight lines glow with low/high beam.
To use a different model, see `static/models/README.md` (CUSTOM in Settings), or `tools/model_export`
to rebuild the bundled files from an OBJ.

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
- **Mouse pointer:** hidden for the touch screen. With a keyboard attached, tap **Ctrl** on its own to show or hide it
  (or ⚙ Settings → Graphics → Mouse pointer).
- **No CAN connected:** the dash still works (a small *NO CAN DATA* notice shows on the 3D panel), so you can use
  Settings, logs and the other tabs with the car off.
- Steering ratio and the wheel-slip threshold are at the top of `static/app.js`.
- Glow effects drop to LOW automatically if the frame rate falls below 30 (switch this off in ⚙ Settings).
  If it is still below 25 after that, the car drops to LOW detail for that drive (not saved).
- Camera: tap AUTO/ORBIT/CHASE/SIDE/FRONT/TOP, or drag the car to orbit it.
- Boot: the dash should be up roughly 8–12 s after power. Chromium runs with a fresh profile in RAM
  each boot, so cutting power can't corrupt it.
- All signal decodes start **unverified**. They come from a 2013 Subaru main-bus decode, not from
  your exact car.
