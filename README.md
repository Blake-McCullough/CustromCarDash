# Custom Car Dash: 2013 Subaru Impreza

| Folder | What it is |
|---|---|
| `docs/CAN_DECODES.md` | What each CAN message on the car means (gear, speed, steering, lights…), with evidence from the logs. |
| `pi/` | **The dash.** Raspberry Pi 5 + Waveshare RS485 CAN HAT: 3D wireframe car, gauges, G-meter, graphs, CAN bus viewer. One-command installer, boots straight into the dash. See `pi/README.md`. |
| `esp32canlogger/` | Standalone ESP32 + CAN Pal logger: phone over Wi-Fi, live CAN view, record + download CSV. |
| `esp32_canpal_slcan/` | Optional: ESP32 + CAN Pal as a USB CAN adapter for the Pi (instead of the HAT). Use `pi/setup_can_esp32_bridge.sh`. |

## Safety rules for this project
- Everything connects **listen-only**. The Pi HAT is brought up with `listen-only on`. The ESP32
  boards run TWAI listen-only, and the CAN Pal has **SLNT tied to 3V3**.
- **Never** connect OBD pin 16 (+12 V, red) to any board. Tape off unused pigtail wires.
- Termination **off** on every board (the car's bus is already terminated).
- Don't use the SN65HVD230 breakout on the car: it has no silent pin.
- First connection to the car: engine off, key to ON, check the warning lights stay normal before starting.
