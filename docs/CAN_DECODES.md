# CAN decodes: Blake's 2013 Subaru Impreza (GP, 6-speed manual)

Recorded 2026-11-18 at the OBD port (pins 6/14, 500 kbit/s):
- Parked, engine running: an 8 s test, a 67 s log with markers (clutch, handbrake, steer L/R, N/1–6/R, low/high beam), and a 233 s log with a throttle blip and engine on/off.
- **Driving:** an 11 s log and a 127 s drive (reversing, then 1st→6th up to 75 km/h, tight turns, braking).

The car uses the **2012+ Subaru platform layout**. The early guesses (0x410, 0x411, 0x511–0x514, 0x600, 0x070) do not exist on this bus.

IDs present: `002 0D0 0D1 0D2 0D3 0D4 140 141 144 152 156 15A 280 281 282 360 361 370 372 374 376 378 3D1 660` (24 IDs, ~920 frames/s).

The dash reads these from [`pi/vehicles/subaru_impreza_2013.json`](../pi/vehicles/subaru_impreza_2013.json), which is the source of truth. Keep this file in step with it.

| Signal | Decode | Status | Evidence |
|---|---|---|---|
| Accelerator pedal | `0x140` byte 0 × 0.392 % | Verified | Rises just before RPM |
| RPM | `0x140` bytes 2–3 LE & 0x3FFF | Verified | ~815 idle, 4,980 max in the drive |
| **Gear** | `0x141` byte 6 & 0x07: 1–6, **7 = neutral / between gears** | Verified | Each value holds its own steady rpm/km/h ratio |
| Clutch / drivetrain disengaged | `0x141` byte 6 bit 5 (0x20) | Verified | Set when coasting with the clutch in, on launches, and in neutral (parked = 0x27) |
| Overrun (pedal released in gear) | `0x141` byte 6 bit 6 (0x40) | Verified | Set every time the pedal hits 0% in gear |
| Steering angle | `0x0D0` bytes 0–1 LE signed × 0.1 ° (raw negative = left) | Verified | ±~578 ° at full lock |
| Yaw rate | `0x0D0` bytes 2–3 LE signed × 0.2725 °/s (right = negative) | Verified | −41 °/s in a tight right turn at 15 km/h |
| Lateral g | `0x0D0` byte 6 signed × 0.0204 g | Verified | −0.31 g in the same turn |
| Vehicle speed | `0x0D1` bytes 0–1 LE × 0.05722 km/h | Verified | Matches the wheel speeds within 0.4% |
| Brake pressure | `0x0D1` byte 2 (uncalibrated: ~10–20 normal stop, ~50 firm) | Verified | |
| Wheel speeds FL/FR/RL/RR | `0x0D4` 4 × LE16 × 0.05747 km/h | Verified | Outer wheels faster in turns |
| Brake light switch | `0x152` byte 6 bit 4 (also `0x0D3` byte 2 bit 5) | Verified | |
| Handbrake | `0x152` byte 6 bit 3 | Verified | |
| Low beam / high beam | `0x152` byte 7 bit 3 / bit 4 | Verified | Exactly at markers |
| Coolant | `0x360` byte 3 − 40 °C | Verified | 85 → 91 °C warm-up |
| Oil temp | `0x360` byte 2 − 40 °C | Likely | ~80 °C, lags coolant |

LE = little-endian (low byte first). Bytes are numbered from 0.

Measured engine rpm per km/h in each gear: **122, 66, 45, 34, 27, 24** (1st–6th).

## Not available on this bus
- **Reverse:** while reversing the car sends 0x21 (1st + clutch), the same as a slipping launch.
- Cruise, check-engine light, outside temperature: not found.

## Not yet decoded
Probably fuel level, odometer, doors and indicators: `0x144 0x15A 0x280–0x282 0x361 0x370–0x378 0x660`.
To decode more, record on the dash's BUS tab with markers, then compare byte changes against the marker times.

## Caveats
- Absolute speed depends on tyre size and hasn't been checked against GPS.
- Brake pressure is a raw value, not calibrated to bar.
