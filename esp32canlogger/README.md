# ESP32 CAN Logger (phone over Wi-Fi)

Standalone: no Pi or laptop needed in the car. Just the ESP32, the CAN board and USB power.

## Wiring
| ESP32 | CAN Pal |
|---|---|
| 3V3 | Vcc |
| GND | GND |
| GPIO21 | TX (+ 10k resistor TX → 3V3) |
| GPIO22 | RX |
| 3V3 | SLNT (**required**) |

| CAN Pal terminal | OBD pin | Pigtail colour |
|---|---|---|
| CANH | 6 | Green |
| GND (middle) | 5 | Light blue |
| CANL | 14 | Green/White |

Termination switch **OFF**. Leave OBD pin 16 (red, +12V) disconnected and taped off.
Power the ESP32 from a USB car charger.

**Do not use the SN65HVD230 board on the car.** It has no silent pin, so a wiring or firmware fault can jam the bus.

## Flash it
1. Arduino IDE → Boards Manager → **esp32 by Espressif Systems** (3.x). No other libraries needed.
2. Board: your ESP32 (e.g. "ESP32 Dev Module").
3. Tools → Partition Scheme → **No OTA (2MB APP/2MB SPIFFS)** for more log space.
4. Upload `esp32canlogger.ino`.

## Use it
1. Ignition on (engine running for the most data).
2. On your phone join Wi-Fi **CAN-LOGGER**, password **subaru1234**. If the phone says "no internet", choose to stay connected.
3. Open **http://192.168.4.1**
4. The header shows the detected bus speed (should say 500 kbit/s), frames/sec and number of IDs.
5. Press **● RECORD**, do things in the car, and type a **marker** before each action
   ("clutch in", "rev to 3000", "steer full left", "headlights on"). Markers show up in the CSV
   so you can find the matching bytes.
6. **■ STOP**, then download from the Recordings list:
   - **CSV**: open in Excel / Google Sheets. Columns: time, ID, data bytes, marker.
   - **.log**: candump format for SavvyCAN (desktop app) or can-utils.
   - **Summary CSV**: one row per ID with its rate, which bytes change and each byte's min–max.
     The fastest way to see what's on the bus.

## Log length
Flash is small (~1.5–2 MB). Rough recording time:
- **Changes only** (default): logs a frame only when its data changes, plus each ID once a second.
  Typically several minutes per session.
- **Every frame**: about 1 minute at ~1,500 frames/s.

The page shows free space. Recording stops automatically when flash is nearly full. Delete old logs with ✕.

## Notes
- Listen-only: the ESP32 never transmits. The SLNT pin enforces this in hardware too.
- "MISSED" counting up means frames were dropped. Use "Changes only" mode and avoid downloading while recording.
- "searching…" that never locks: check CANH/CANL aren't swapped and the ignition is on.
