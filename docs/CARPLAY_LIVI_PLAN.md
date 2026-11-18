# CarPlay, Waze and audio: integration plan (not built yet)

How Apple CarPlay and Waze get added to the dash without touching the car's CAN bus. The neon dash stays
as it is. **LIVI** (open-source CarPlay/Android Auto head unit: https://github.com/f-io/LIVI) runs next to it
on the same Pi 5.

Nothing here transmits on CAN. The only new traffic is HTTP between programs on the Pi (see AGENTS.md §2).

## Overall shape
```
car CAN → HAT → can0 (listen-only) → dash_server.py ─┬─ WebSocket → Chromium: neon dash (unchanged)
                                                     └─ HTTP POST → LIVI :4000/telemetry
iPhone ⇄ (Wi-Fi + Bluetooth) ⇄ LIVI ⇄ MFi auth chip (I²C, see hardware/mfi-pi-adapter/)
LIVI audio → USB DAC → [ground loop isolator] → factory head unit AUX → factory amp/speakers
USB mic → LIVI (Siri, calls)
```

## 1. CarPlay authentication (pick one)
- **MFi chip on the Pi:** board in `hardware/mfi-pi-adapter/`. The MFI343S00177 chip goes on Pi I2C1 (pins 1/3/5/6).
  LIVI `config.json`: `{ "carPlayMfiI2cBus": 1, "carPlayMfiPowerGpio": -1 }`, plus `dtparam=i2c_arm=on`.
- **Or a Carlinkit CPC200-CCPA reflashed as a "LIVI Link"** (see LIVI-LINK.md in the LIVI repo). No soldering.

Android Auto needs neither.

## 2. Screens
`cage` (current kiosk) shows exactly one app, so it can't run Chromium and LIVI together. Switch to `labwc` or `sway`:
- **Two screens:** the neon dash on one HDMI output, LIVI on the other. Pin each app to its output.
- **One screen:** add a CARPLAY button to the bottom nav that brings LIVI's window to the front.

LIVI's own tabs are fixed (Projection, Dashboard, Media, Camera, Settings). There's no "web page" tab. Making
the dash a real LIVI tab means forking LIVI. The plan for that fork:
1. Add a tab with a see-through page.
2. Launch Chromium inside LIVI's compositor as a "video plane" window, the same way CarPlay video is shown.
3. Show and hide it with the tab.
4. Send touches to it instead of to the phone.

Ask upstream for a web tab first.

## 3. Telemetry bridge (`dash_server.py` → LIVI)
LIVI accepts JSON over HTTP: `curl -d '{"gear":"R"}' http://127.0.0.1:4000/telemetry`.
`livi-core telemetry demo` fills every field, which is useful for testing on the bench.
The field list is in LIVI's `native/crates/livi-core-proto/src/telemetry.rs`.

Plan: one more aiohttp task in `dash_server.py` that posts at 10 Hz, forwards only `verified` signals,
and ignores errors (LIVI not running must never affect the dash).

| Our signal | LIVI field | Notes |
|---|---|---|
| `speed` | `speedKph` | |
| `rpm` | `rpm` | |
| `low_beam` | `nightMode` | CarPlay goes dark with the headlights |
| `gear` (1–6, 7 = N) | `gear` | Check which values `telemetry.rs` accepts |
| `coolant` (over about 105 °C) | `notification.title/text/open` | Send once, when it turns on. Shows as a banner on CarPlay |
| `fuel_level`, `voltage` (OBD, `--obd`) | check `telemetry.rs` | Only when OBD polling is on |

**Corrections from the 2026-11-18 decode:**
- **Reverse isn't on this bus**, so `gear=R` can't drive LIVI's reverse-camera view from CAN. If a reverse
  camera is added, use a GPIO input from the reverse-light wire instead (through an optocoupler). The camera
  itself is a separate open item.
- **MIL isn't on this bus.** A "check engine" banner would need OBD (service 01 PID 0x01) under `--obd`.

## 4. Audio
- **The Pi 5 has no 3.5 mm jack.** Use a USB DAC (Apple's USB-C to 3.5 mm adapter works on Linux with no drivers).
- The DAC goes into the **factory head unit's AUX input**. The factory unit stays the amp and volume control,
  and the steering-wheel volume buttons keep working.
- **Fit a ground loop isolator** on the AUX cable. Without one, expect engine-rpm whine.
- Set LIVI/Pi volume to about 80–90% and leave it. Use the factory volume knob.
- **Unpair the phone from the factory head unit's Bluetooth**, so calls go through CarPlay and the USB mic.
- **Limits:**
  - Steering-wheel track and phone buttons still talk to the factory unit. They could be mapped to LIVI key
    bindings later if they're found on CAN.
  - Factory FM radio can't be mixed with navigation prompts. Use radio apps through CarPlay instead.

This replaces the "Bluetooth music via USB DAC to AUX" open item in AGENTS.md §8.

## 5. Waze
- **Navigation:** the Waze app on the iPhone appears in CarPlay through LIVI. Nothing to build.
- **Optional Waze alerts on the neon dash:** OpenWeb Ninja's Waze API (unofficial, has a free tier). It gives
  alerts and jams inside a lat/lng box. It needs:
  - **GPS position:** a USB GPS module + gpsd. It isn't on CAN, and the phone doesn't share its position.
    The same position can be sent to LIVI as `gps.lat`/`gps.lng`.
  - **Internet:** phone tethering. With wireless CarPlay, the phone's Wi-Fi is busy, so use USB tethering
    (`ipheth`) or Bluetooth tethering. Test whether Bluetooth tethering coexists with LIVI's own Bluetooth.
  - Poll every 30–60 s, show only alerts ahead of you, and keep showing the last alerts while offline.

## 6. Things to check early
- **Video decoding:** the Pi 5 has no hardware H.264 decoder. CarPlay video plus three.js bloom at 60 fps
  may be too much. Pause the dash's 3D rendering while LIVI is in front.
- **GPIO 2/3 must be free on the Waveshare CAN HAT.** The HAT covers pins 1–6, so use a stacking header,
  or wire the adapter's J2.

## Suggested order
1. On the bench: LIVI + MFi (adapter board or LIVI Link), CarPlay working, audio through the DAC.
2. Replace cage with labwc/sway and auto-start both apps.
3. Add the telemetry task to `dash_server.py` and test it with `--demo`.
4. In the car: audio into the factory AUX, with the isolator.
5. Optional: GPS, tethering, Waze alerts.
