# Custom Car Dash: 2013 Subaru Impreza

| Folder | What it is |
|---|---|
| `esp32canlogger/` | **Start here.** Standalone ESP32 logger: phone over Wi-Fi, live CAN view, record + download CSV. See its README. |
| `esp32_canpal_slcan/` | ESP32 firmware for the in-car dash: turns the ESP32 into a USB CAN adapter (`can0`) for the Raspberry Pi. |
| `pi/` | Raspberry Pi dash: CAN → WebSocket backend + full-screen dash page. |

Workflow: use the logger to find out what's on the bus. Put the IDs you confirm into `pi/signals.json`,
then flash `esp32_canpal_slcan` and run the Pi dash in the car.

---

## Raspberry Pi dash

```
Impreza OBD port ──► CAN Pal (TJA1051) ──► ESP32 (TWAI, listen-only) ──USB──► Raspberry Pi ──HDMI──► screen
```

### 1. Wiring

**ESP32 → CAN Pal**

| ESP32 | CAN Pal | Why |
|---|---|---|
| 3V3 | VCC | power |
| GND | GND | ground |
| GPIO5 | TX | ESP32 CAN TX |
| GPIO4 | RX | ESP32 CAN RX |
| 3V3 | SLNT | silent mode: transmitter disabled in hardware |

**CAN Pal → OBD-II pigtail** (colours from your cable's chart; confirm with a multimeter in continuity mode, because cheap pigtails don't always match their chart)

| CAN Pal | OBD pin | Pigtail colour |
|---|---|---|
| CANH | 6 | Green |
| CANL | 14 | Green/White |
| GND | 5 | Light blue (signal ground) |

- Termination switch on the CAN Pal: **OFF**.
- Do **not** connect pin 16 (Red, +12V always-on battery) to the ESP32 or CAN Pal. The ESP32 is powered over USB from the Pi.
- Insulate every unused pigtail wire, especially pin 16.
- Twist the CANH/CANL wires together if you extend them.

### 2. Flash the ESP32
1. Arduino IDE → Boards Manager → install **esp32 by Espressif Systems** (3.x).
2. Open `esp32_canpal_slcan/esp32_canpal_slcan.ino`, select your board, upload.
3. ESP32-S3 on its native "USB" port: Tools → USB CDC On Boot → Enabled.

### 3. Pi setup
```bash
cd pi
chmod +x setup_can.sh
./setup_can.sh           # brings up can0 from the ESP32
candump can0             # with the ignition on, you should see frames scroll
```

### 4. Run the dash
```bash
python3 dash_server.py --demo   # test with fake data first, no car needed
python3 dash_server.py          # live from can0
```
Open http://localhost:8080. For full screen on the car display:
```bash
chromium-browser --kiosk --noerrdialogs --disable-infobars http://localhost:8080
```

### 5. Decode your car
`signals.json` has **unverified** starting points taken from a 2013 Subaru main-bus decode (Autosport Labs forum):
RPM `0x410`, throttle `0x410`, gear `0x411`, steering + brake `0x511`, speed `0x512`, ambient/handbrake `0x514`,
coolant + clutch `0x600`, plus an alternate RPM on `0x140` (seen on 2015 WRX). They weren't logged on a GP Impreza,
so some IDs or scalings may differ on yours.
Open the **BUS** tab. Every ID is listed, and bytes flash red when they change. Do one thing at a time
(rev, roll forward, turn the wheel, press the clutch) and see which bytes react. Fix the entry in
`signals.json` and set `"verified": true`. The amber `?` badge then disappears from that gauge.

### If you see very few IDs
Some Subarus route the OBD port through the body control module, which filters most traffic (seen on 2018 STI).
If `candump` shows only a couple of IDs with the engine running, tap CAN-H/CAN-L behind the cluster or head unit
instead (twisted pair; confirm with a wiring diagram for your model).

### Power (permanent install)
Use an ignition-switched 12V → 5V 3A+ buck converter for the Pi (add-a-fuse on an ACC circuit).
When the car turns off, CAN goes quiet and the dash shows **VEHICLE POWERED OFF**. Add a supercap/UPS HAT if you
want a clean shutdown instead of losing power instantly.
