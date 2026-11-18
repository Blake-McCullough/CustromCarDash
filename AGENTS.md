# AGENTS.md: project overview for AI assistants

This file explains the CustromCarDash project so an AI assistant (or a new developer) can work on it
without re-deriving everything. Read the **Safety rules** section before changing anything that
touches CAN.

---

## 1. What this project is

A custom digital dashboard for the owner's **2013 Subaru Impreza** (4th gen "GP", FB20 2.0 L engine,
Australia, km/h). It reads the car's **CAN bus** from the OBD-II port (pins 6/14, 500 kbit/s) and shows
live data on a touch screen. The visual style is a dark "neon wireframe" dash with a glowing 3D car.

There are three independent parts:

| Folder | Hardware | Purpose |
|---|---|---|
| `pi/` | Raspberry Pi 5 + Waveshare **RS485 CAN HAT** (MCP2515 + SN65HVD230-type transceiver, SPI) + HDMI/USB touch screen | **The main dash.** Python backend + browser (three.js) frontend, kiosk mode. |
| `esp32canlogger/` | ESP32 (classic, "ESP-32S" board) + **Adafruit CAN Pal** (TJA1051T/3, has SLNT silent pin) | Standalone **reverse-engineering logger**: Wi-Fi hotspot, phone web UI, records CAN to flash, CSV download. |
| `esp32_canpal_slcan/` | Same ESP32 + CAN Pal | Optional: makes the ESP32 a **USB SLCAN adapter** so the Pi gets `can0` without the HAT. |

Nothing is compiled or bundled. There's no build step and no npm at runtime. Everything runs offline in the car.

---

## 2. Safety rules (hard constraints)

These come from a real incident. An earlier ESP32 firmware let the transceiver's TX pin go LOW while
switching bitrates, and at boot (GPIO5 pulses at boot). That forced the bus dominant, jammed the car's
CAN bus, and triggered Hill Start Assist and emissions warning lights.

1. **Never transmit on the car's bus.** Everything is listen-only:
   - Pi: `can0` is brought up with `listen-only on` (see `can0.service` in `pi/setup_pi.sh`).
   - ESP32: TWAI driver uses `TWAI_MODE_LISTEN_ONLY`. The SLCAN firmware refuses `t/T/r/R` commands.
   - CAN Pal: **SLNT pin tied to 3V3** (hardware transmitter disable). Also recommended: 10k pull-up TX→3V3.
2. **ESP32 TX pin must be held HIGH (recessive) whenever the TWAI driver isn't running.** Both sketches
   call `holdTxRecessive()` first thing in `setup()`, after every `twai_driver_uninstall()`, and on
   failed installs. Don't remove this.
3. ESP32 CAN pins are **GPIO21 = TX, GPIO22 = RX**. Don't move TX back to GPIO5 (it pulses at boot).
4. **Don't use the SN65HVD230 breakout on the car.** It has no silent pin.
5. Termination resistors **off** on every board. The car's bus is already terminated (~60–90 Ω measured).
6. Never connect OBD pin 16 (+12 V) to any board.

**The one exception: OBD-II polling** (`dash_server.py --obd`, installed with `sudo OBD=1 ./setup_pi.sh`).
It's opt-in and never the default. It brings can0 up in normal mode (no `listen-only`, no
`restart-ms`) and transmits only service 01 PID requests on 0x7DF. Guards in code:
`obd_request()` asserts the PID is in `OBD_PIDS` or the support-bitmap probes, the service byte is
hard-coded 0x01, requests are spaced 25 ms apart, and 5 consecutive send failures stop transmitting
until a restart. Keep all of that if you change the poller. Any other kind of transmit needs the
user's explicit confirmation.

---

## 3. Repository layout

```
CustromCarDash/
├── AGENTS.md                 ← this file
├── README.md                 ← human overview + safety rules
├── .gitattributes            ← *.sh and *.py forced to LF (they run on the Pi)
├── .gitignore                ← ignores pi/settings.json
├── esp32canlogger/
│   ├── esp32canlogger.ino    ← standalone Wi-Fi CAN logger (Arduino, esp32 core 3.x)
│   └── README.md
├── esp32_canpal_slcan/
│   └── esp32_canpal_slcan.ino← ESP32 → SLCAN USB bridge
└── pi/
    ├── dash_server.py        ← backend: CAN → decode → WebSocket; settings API; demo simulator
    ├── signals.json          ← CAN signal definitions (all currently "verified": false)
    ├── setup_pi.sh           ← one-shot Pi installer (CAN overlay, services, kiosk, boot tweaks)
    ├── kiosk.sh              ← launches cage + Chromium full-screen
    ├── setup_can_esp32_bridge.sh ← brings up can0 via slcand (ESP32 bridge path only)
    ├── setup_can.sh          ← older duplicate of the above (safe to delete)
    ├── settings.json         ← created at runtime; user settings (git-ignored)
    ├── README.md
    └── static/               ← frontend, served by dash_server.py at /static
        ├── index.html        ← layout; import map points "three" at vendor/
        ├── style.css
        ├── app.js            ← UI logic, state, gauges, graphs, bus table, settings page
        ├── car3d.js          ← three.js scene: wireframe car, camera modes, bloom, model loading
        ├── models/           ← optional real car model (.glb) + model.json; see README there
        └── vendor/           ← three.js r170 (three.module.js) + addons (bloom, GLTFLoader)
```

---

## 4. Pi dash: data flow

```
car CAN (500k) → RS485 CAN HAT (MCP2515) → Linux SocketCAN can0 (listen-only)
   → dash_server.py (python-can AsyncBufferedReader)
       → BusState.on_frame(): per-ID stats + decode signals from signals.json
       → push_task: JSON over WebSocket /ws at 25 Hz
   → Chromium (kiosk) → app.js renders DOM gauges + car3d.js renders the 3D scene
```

### 4.1 `dash_server.py`
- **Dependencies:** `aiohttp`, `python-can` (only imported in live mode; demo needs aiohttp only).
- **CLI:** `--demo` (simulated drive), `--channel can0`, `--host 127.0.0.1`, `--port 8080`,
  `--signals path`, `--cursor` (show the mouse pointer; the page hides it by default for touch),
  `--obd` (opt-in OBD-II polling, see 4.2b).
- **`load_signals()`** parses `signals.json`, ignoring keys starting with `_`. Builds `by_id` (CAN ID →
  list of signals). `mask` strings like `"0x3FFF"` are parsed with `int(x, 0)`.
- **`decode(sig, data)`** → value:
  1. take bytes `[start_byte, start_byte+length)`
  2. `int.from_bytes(..., endian)` (default **big**; `"endian": "little"` for little), `signed` optional
  3. `>> shift` (if present), then `& mask` (if present)
  4. `* scale + offset` (defaults 1 and 0), rounded to 3 dp
- **`encode_into()`** is the inverse. It's only used by the demo to build fake frames, and it ORs masked
  bit-fields so several flags can share one byte.
- **`BusState`** keeps `ids` (per ID: last data, 1-second frame count → `hz`, per-byte last-change
  timestamps), `values` (latest decoded signals), `fps` (total frames/s), `last_frame`, `source`
  (`"live"`/`"demo"`), and `error` (e.g. can0 missing).
- **Link detection:** `link = now - last_frame < 2.0 s`. When it's false, the frontend shows "VEHICLE POWERED OFF".
- **`live_source`** reconnects every 1 s if can0 isn't up yet. It ignores error and remote frames.
- **`demo_source`** runs a looping 45 s scenario (idle → pull through gears 1–4 → corner → brake →
  stop) plus random "noise" IDs, encoded with the real signal definitions, so the whole pipeline is exercised.
- **HTTP routes**
  - `GET /`: `index.html` (with `--cursor`, injects `class="showcursor"` and an inline style)
  - `GET /ws`: WebSocket (protocol below)
  - `GET /api/settings`: returns `settings.json` (or `{}`)
  - `POST /api/settings`: replaces `settings.json` (atomic write via `.tmp` + `os.replace`)
  - `POST /api/log/start|stop|mark|delete`, `GET /api/logs`, `GET /logs/<name>.zip`: CAN bus recording
    (`BusLogger`): every frame in `on_frame()` goes to `pi/logs/can_YYYYmmdd_HHMMSS.log.gz` (candump format,
    gzip so a power cut leaves a readable partial file). Markers go to `.markers.csv`. The zip bundles both plus a README.
    It stops below 300 MB free. Snapshots carry `"log": {on, name, frames, marks, secs, reason}`.
  - `POST /api/client`, `GET /api/clients`: every dash page reports its GPU, fps, 3D state and JS errors
    every 5 s. New errors are printed to the journal; Settings > System lists each screen (Pi screen vs remote).
  - `GET/POST /api/brightness`: `Brightness` uses `/sys/class/backlight` if writable, else `ddcutil` (DDC/CI,
    probed at startup), else reports `software` and the page dims itself with the `#dim` overlay.
  - `/static/*`: frontend. A middleware adds `Cache-Control: no-cache` so edits show on refresh.

### 4.2 WebSocket protocol (`/ws`)
- Server → client, **first message**: `{"meta": {signalName: {"unit", "verified", "id"}}}`
- Server → client, **every 40 ms**:
  ```json
  {"t": unix_time, "fps": int, "nids": int, "source": "live|demo", "error": "",
   "link": bool, "v": {signalName: number, ...},
   "ids": [["410", "00 00 00 00 5A 0A 00 00", hz, [ageMs x8]], ...]}
  ```
  `ids` is included only on every 5th push (5 Hz), and only for clients that asked for it.
  `ageMs` = ms since each byte last changed (99999 = never).
- Snapshots also carry `"obd": {"status", "supported": [names], "sent", "resp", "rate"}` (status is `"off"`
  unless started with `--obd`). When OBD support changes, the server re-sends `{"meta": ...}`. OBD-backed
  signals have `"src": "obd", "verified": true, "id": "0x7E8"`. Broadcast signals have `"src": "can"`.
- Client → server: `{"bus": true|false}` turns the `ids` table on or off for that client (the BUS tab sends it).

### 4.2b OBD-II polling (`--obd`)
`OBD_PIDS` maps PID → (signal name, decode, encode-for-demo, unit, fast?). The poller probes support
bitmaps (PIDs 0x00/0x20/0x40), then loops: every fast PID (rpm 0x0C, speed 0x0D, throttle 0x11) plus one
slow PID per cycle, round robin. Responses (0x7E8–0x7EF, single frame, byte1 = 0x41) are parsed in
`BusState.on_obd()`. Names in `obd_names` skip the broadcast decode in `on_frame()`, so OBD wins.
If no response arrives for 5 s, it re-probes. In demo mode, `fake_ecu()` answers from `state.sim`.
Extra signal names (not in signals.json): `engine_load, map_kpa, intake_temp, timing_adv, maf, stft, ltft,
fuel_level, voltage, baro, oil_temp`. The frontend shows them on the **ENGINE** tab (`ETILES` in app.js).

### 4.3 `signals.json`
Each entry is `name: {id, start_byte, length, endian?, signed?, shift?, mask?, scale?, offset?, unit, verified, _note?}`.

**Decoded from logs recorded on this car (2026-11-18: parked with markers, then a ~2 min drive up to 75 km/h).**
The car uses the 2012+ Subaru platform layout, **not** the 0x410/0x511-style IDs we first guessed (those
IDs don't exist on this bus). IDs at the OBD port:
`002 0D0 0D1 0D2 0D3 0D4 140 141 144 152 156 15A 280 281 282 360 361 370 372 374 376 378 3D1 660`.

| Signal | Decode | Status |
|---|---|---|
| throttle (accelerator pedal) | `0x140` b0 × 0.392 % | verified |
| rpm | `0x140` b2–3 LE & 0x3FFF | verified |
| **gear** | `0x141` b6 & 0x07: 1–6, **7 = neutral/between gears** (the ECU's own calculation) | verified |
| clutch (drivetrain disengaged) | `0x141` b6 bit5 (set when clutch pressed or in neutral) | verified |
| overrun (pedal released in gear) | `0x141` b6 bit6 | verified |
| steering | `0x0D0` b0–1 LE signed × −0.1 ° (left +) | verified |
| yaw_rate / lat_g | `0x0D0` b2–3 LE signed × 0.2725 °/s / b6 signed × 0.0204 g (right turn = negative) | verified (physics-consistent) |
| speed | `0x0D1` b0–1 LE × 0.05722 km/h (fitted to the wheel speeds) | verified (absolute ±~3%, no GPS check) |
| brake (pressure, uncalibrated, ~10–20 normal stop, ~50 firm) | `0x0D1` b2 | verified |
| wheel_fl/fr/rl/rr | `0x0D4` 4 × LE16 × 0.05747 km/h | verified |
| brake_sw | `0x152` b6 bit4 (mirror: `0x0D3` b2 bit5) | verified |
| handbrake | `0x152` b6 bit3 | verified |
| low_beam / high_beam | `0x152` b7 bit3 / bit4 | verified |
| coolant | `0x360` b3 − 40 | verified |
| oil_temp | `0x360` b2 − 40 | likely |

Measured rpm per km/h in each gear: 122, 66, 45, 34, 27, 24 (`CFG.gearDefaults`). The car has 6 forward gears.
**Reverse isn't detectable:** reversing shows 0x21 (gear 1 + clutch), the same as a slipping launch.
Not on this bus: reverse switch, cruise, MIL, outside temperature. With the clutch in, the gear nibble
is the ECU's prediction, so the dash shows it dimmed. The frontend accesses signals **by name**.
Unverified signals get an amber "?".

### 4.4 Frontend: `static/app.js` (ES module, uses top-level `await`)
- **Settings store:** loads `/api/settings` at startup into `SETTINGS`. `store.get(k, default)` and
  `store.set(k, v)` (debounced POST). Settings live on the backend, not in localStorage, because the
  kiosk Chromium starts with a fresh profile in `/tmp` every boot.
  Keys: `theme`, `fx`, `autofx`, `particles`, `redline`, `shiftAt`, `cam`, `zt_best`, `mass`,
  `gearMode`, `gearCount`, `gearLearn`, `gearCal`, `bright`, `brightNight`, `brightAuto`, plus the car-display keys.
- **`CFG`:** `redline` (6500), `shiftAt` (6000), `rpmMax` (= max(7000, redline+500)), `steerRatio` (15:
  steering wheel deg → road wheel deg for the 3D front wheels), `slipPct` (8: wheel-speed deviation
  flagged as slip).
- **URL params:** `?keepfx` disables the automatic quality drop (for testing). `?cursor` shows the mouse.
- **Mouse pointer:** hidden by default (touch screen). Tapping **Ctrl** on its own toggles it, and so does
  Settings > Graphics > Mouse pointer. Saved as setting `cursor`.
- **Views** (bottom nav): `drive`, `graphs`, `engine` (OBD-II tiles), `bus`, `settings` (⚙ button). Only the active view renders.
- **On each WS message (`onMsg`)** it updates `V` (decoded values) and the link/source pill, and computes:
  - `derive(now)` computes values that aren't on the bus and writes them into `V`:
    - `accel`/`longG`: slope of a least-squares line through the last 0.8 s of speed, smoothed
    - `wheel_kw` / `wheel_kw_peak`: virtual dyno, `P = v·(m·a + ½·1.2·CdA·v² + Crr·m·g)` with `CFG.mass`
      (settings, default 1400 kg), `cda` 0.70, `crr` 0.012. Zero when throttle < 3%, clutch in, reverse or < 1.5 m/s.
    - `gear_calc` (fallback): rpm ÷ km/h matched to `gearCal` (defaults measured on this car), within 7%.
      Auto-learn nudges the nearest gear when the ratio is steady for 1.2 s. The gear box shows the car's
      own `gear` by default (`gearMode` = `can`); `calc` is a Settings option.
  - **trip:** distance (integrated speed), moving time, top speed, start time
  - **0–100 timer:** state machine `idle → armed (speed < 0.5) → run (speed > 0.8) → done at ≥100 km/h`.
    The best time is saved to settings.
  - **`hist`:** the last ~31 s of `[t, rpm, speed, throttle, brake, steering]` for the graphs.
- **Render loop (`requestAnimationFrame`):**
  - `renderDash(dt)`: exponentially smoothed display values (`smooth()`); speed, gear (`R` if `reverse`,
    `N` if 0), 35-segment RPM bar (white → amber → red, flashes at ≥ `shiftAt`), throttle, brake,
    steering, torque bars, minis, indicator chips, trip, 0–100; calls `car.update()` and `car.render()`;
    positions HTML wheel-speed labels with `car.wheelScreen()`; draws the G-meter canvas.
  - `drawGraphs()`: 4 lanes (RPM, speed, throttle+brake, steering).
  - `renderBus(ids)`: table with bytes coloured by change age, plus which signals decode from each ID.
  - `renderOff()`: no CAN never blocks the UI. With no link there's a small `#nocan` notice on the 3D
    panel. After a drive, "VEHICLE POWERED OFF" (trip summary) covers the screen until tapped. Only
    "DASH OFFLINE" (no WS message for 3 s) is a permanent full cover.
  - Auto quality: if the render fps stays under 30 for 5 s on the drive view (and `autofx` is on), it
    switches the glow effects to low.
  - **Resilience:** the loop runs `renderOff()` first and wraps each part in `guard()`, so an exception
    can't freeze the page. `pause3d()` first drops to low effects/detail, then hides the 3D view (with
    TRY AGAIN) if `car.render()` takes > 120 ms for 15 frames or the page stays < 8 fps for 8 s. This came from a
    real bug: on the Pi 4 the page sat on "WAITING FOR CAN" while phones showed live data.
    `SOFTWARE_GPU` flags SwiftShader/llvmpipe.
- **Themes:** `THEMES = {red, wrb, ice, matrix, gold, neon, pink, mono}`, each `{name, acc, tint}`.
  `applyTheme()` sets the CSS variables `--acc`, `--accglow` and `--tint` and calls `car.setTheme()`.
  Warning colours (`--red`: brake bar, slip, check engine, redline segments) deliberately stay red.

### 4.5 Frontend: `static/car3d.js` (`export class Car3D`)
- **Coordinate convention: the car faces +X, +Y is up, +Z is the car's RIGHT side.** Wheel keys are
  `fl/fr/rl/rr` from the driver's seat (left wheels at −Z). Positive road-wheel steer angle = turning
  **left** (rotation about +Y). Units are metres.
- **Scene graph:** `root` ← `body` (pitch/roll applied here) ← `builtin` (procedural car) +
  `lightGroup` (brake/head/reverse light boxes). The wheel pivots are children of `root`, **not**
  `body`, so body roll doesn't move the wheels. Each wheel: `pivot` (steer, rotation.y) → `spin` (rotation.z).
- **Built-in car:** a generic hatchback made from two `ExtrudeGeometry` side profiles (body + narrower
  cabin), rendered as `EdgesGeometry` lines + a faint transparent fill, plus detail line segments,
  mirrors, and cylinder wheels with spokes.
- **Rendering:** `WebGLRenderer` → `EffectComposer` (MSAA 4×, HalfFloat) → `RenderPass` →
  `UnrealBloomPass` (strength 0.85, radius 0.45, threshold 0.12) → `OutputPass`. Low quality skips the
  composer. Fog, a scrolling `GridHelper` floor and drifting particles give a sense of motion.
- **Public API:**
  - `update(s, dt, t)` where `s = {speed, wheels:{fl,fr,rl,rr}, steerDeg, latG, longG, brake, brakeSw,
    lowBeam, highBeam, reverse}`: spins the wheels from their own speeds, steers the fronts, applies
    squat/dive (`longG`) and roll (`latG`), sets light colours (values above 1 make them bloom),
    scrolls the floor, and moves the camera.
  - `setMode('auto'|'orbit'|'chase'|'side'|'front'|'top')`. **auto** = slow orbit when speed ≤ 8,
    else a 3/4 chase view. Dragging on the canvas switches to orbit (`onModeChange` callback).
    The camera distance scales up for narrow viewports and never gets closer than a minimum distance,
    so transitions don't pass through the car.
  - `setQuality(bool)`, `setTheme(hex)`, `resize()`, `render()`, `wheelScreen()` (projected label positions).
  - `async loadModel()`: if `static/models/model.json` exists and is enabled, loads the .glb/.gltf with
    GLTFLoader, rotates it by `rotateY` degrees, scales it to `length` metres, centres it on the
    ground, converts every mesh to edges + the shared themed fill, and, if all four `wheels` node
    names are found, re-parents those nodes onto new steer/spin pivots. Otherwise it hides the built-in
    wheels (unless `keepBuiltinWheels`). It hides the built-in body and lights. `modelInfo` is shown
    on the settings page.

### 4.6 Install and boot on the Pi (`setup_pi.sh`, `kiosk.sh`)
- Installs `python3-can python3-aiohttp can-utils cage curl chromium`.
- Adds to `/boot/firmware/config.txt` (between `# >>> impreza-dash` markers):
  `dtparam=spi=on`, `dtoverlay=mcp2515-can0,oscillator=${OSC:-12000000},interrupt=25,spimaxfrequency=2000000`.
  The crystal is 12 MHz on current HATs; set `OSC=8000000` if the HAT's crystal says 8.000.
- `can0.service`: `ip link set can0 up type can bitrate 500000 listen-only on restart-ms 100`.
- `impreza-dash.service`: runs `dash_server.py --host 0.0.0.0` (reachable from phones/PCs on the LAN, for log downloads) as the user (with `--demo` if installed with `DEMO=1`).
- Console autologin on tty1. `~/.bash_profile` execs `kiosk.sh` → waits for the backend → runs
  `cage -s -- chromium --kiosk http://127.0.0.1:8080` with a fresh `--user-data-dir=/tmp/dash-chromium`.
- Boot speed: quiet cmdline, `boot_delay=0`, disables wait-online, apt timers and other unneeded services.

---

## 5. ESP32 logger (`esp32canlogger/esp32canlogger.ino`)
- Arduino IDE, "esp32 by Espressif" core 3.x, no extra libraries. Partition: biggest SPIFFS option
  (LittleFS mounts on the "spiffs" partition).
- **Wi-Fi AP** `CAN-LOGGER` / `subaru1234`, UI at `http://192.168.4.1`. Wi-Fi starts first, at reduced TX
  power (brownout mitigation). The CAN task starts 1.5 s later on core 1.
- **CAN task:** auto-detects the bitrate by trying 500k/250k/125k/1M for 1.5 s each. It locks when it
  sees ≥20 frames with few bus errors. While searching, it samples the raw RX pin for edges and
  publishes a `diagMsg` explaining what it sees (idle HIGH = no traffic reaching the board; stuck
  LOW = CANH/CANL swapped or the board unpowered; edges with no frames = wiring or ground issue).
- **Stats:** up to 256 IDs, each with last data, hz, min/max per byte, a changed-bytes mask and
  per-byte last-change time.
- **Recording:** binary file `/log_NNN.bin` of packed 17-byte records `{uint32 ms; uint32 id; uint8 dlc;
  uint8 d[8]}`. In `id`, bit 31 = extended frame and `0xFFFFFFFF` = marker (index stored in `d`).
  Marker labels go in `/log_NNN.mk` as `idx\tlabel`. Modes: "changes only" (a frame is logged when its
  data changes, plus each ID every 1 s) or every frame. Recording stops automatically below 24 KB free.
- **HTTP:** `/` (UI), `/api/live` (JSON status + IDs), `POST /api/rec?on=&mode=`, `POST /api/mark?label=`,
  `/api/files`, `POST /api/del?f=`, `POST /api/bitrate?r=`, `POST /api/reset`,
  `/dl?f=&fmt=csv|log` (converts binary to CSV or candump .log on the fly), `/summary.csv`.
- Status: Wi-Fi and the UI work, but in the car the logger reported **RX pin idle HIGH, 0 frames at
  every speed**, even though there were voltages and ~90 Ω on the OBD CAN pins. Not resolved yet.
  Suspects: the CAN Pal RX→ESP32 wiring/pin, or the OBD port only answering diagnostic requests.

## 6. ESP32 SLCAN bridge (`esp32_canpal_slcan/esp32_canpal_slcan.ino`)
Speaks the SLCAN text protocol over USB serial (921600). By default it auto-opens at 500k listen-only,
because opening the port often resets the board. It handles `S2–S8`, `O/L`, `C`, `V`, `v`, `N`, `F`
and `Z`, and refuses `t/T/r/R`. On the Pi: `slcand -o -c -s6 -S 921600 /dev/ttyUSB0 can0` (see
`setup_can_esp32_bridge.sh`). The dash then works unchanged.

---

## 7. Development workflow
- **On Windows/PC, no hardware:** `pip install aiohttp`, then in `pi/`: `py dash_server.py --demo --cursor`,
  and open `http://localhost:8080`. A refresh picks up frontend edits. Restart the server after editing
  `signals.json` or `dash_server.py`.
- **Watch out:** the user edits in an IDE. If an AI tool writes a file while it's open in the editor,
  the editor may save its stale buffer over it. That happened several times. After writing files,
  ask the user to reload the files in their editor without saving.
- **Testing done so far:** demo mode rendered headlessly with Chromium/SwiftShader at 1024×600 and
  1280×720/800, with no console errors. The ESP32 sketches compile for the `esp32:esp32:esp32` target.
  Nothing has been tested on a real Pi 5 yet.
- **Performance target:** Pi 5 at 60 fps with bloom at around 1024×600. Keep the line count low.
  Imported models should stay under about 100k triangles.

## 8. Open items / ideas not yet built
- Check absolute speed against GPS (tyre size). Calibrate brake pressure. Decode the remaining IDs (0x144, 0x15A, 0x280–282, 0x361, 0x370–378, 0x660) if useful: likely fuel, odometer, doors/indicators.
- Reversing camera (USB capture of composite video, switched on by the `reverse` signal) and
  dashcam recording were discussed but deliberately left out for now.
- Bluetooth music output through a USB DAC to the head unit's AUX was discussed but not built.
- OBD-II polling is built (`--obd`) but not yet tested on the real car. If the OBD port turns out to be
  gateway-filtered for broadcast traffic, OBD polling still works, because the gateway answers diagnostic requests.
