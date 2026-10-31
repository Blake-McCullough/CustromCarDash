/*
  ESP32 + Adafruit CAN Pal (5708, TJA1051T/3)  ->  SLCAN over USB, LISTEN-ONLY
  -----------------------------------------------------------------------------
  The ESP32's built-in CAN controller (TWAI) reads the car's bus through the
  CAN Pal and streams every frame to the Raspberry Pi over USB using the
  standard SLCAN text protocol. On the Pi, `slcand` turns it into a normal
  Linux CAN interface (can0), so candump / cansniffer / python-can all work.

  Safety: the bus is opened in TWAI_MODE_LISTEN_ONLY (never ACKs, never
  transmits) AND the CAN Pal's SLNT pin is tied to 3.3V (transmitter
  physically disabled). Transmit commands from the host are refused.

  Wiring (ESP32 -> CAN Pal):
    3V3    -> VCC
    GND    -> GND
    GPIO5  -> TX
    GPIO4  -> RX
    3V3    -> SLNT   (silent mode)
  CAN Pal -> OBD-II:
    CANH -> pin 6  (green on the pigtail)
    CANL -> pin 14 (green/white)
    GND  -> pin 5  (light blue, signal ground)
  CAN Pal termination switch: OFF (the car's bus is already terminated).

  Arduino IDE: install "esp32 by Espressif Systems" (core 3.x) in Boards Manager.
  ESP32-S3 boards: if you plug into the "USB" (native) port rather than "UART",
  set Tools > USB CDC On Boot > Enabled.
*/

#include <Arduino.h>
#include "driver/twai.h"

// ---------- Settings ----------
#define CAN_TX_PIN       GPIO_NUM_5    // ESP32 -> CAN Pal TX
#define CAN_RX_PIN       GPIO_NUM_4    // ESP32 <- CAN Pal RX
#define SERIAL_BAUD      921600        // UART-bridge boards; ignored on native USB
#define AUTO_OPEN        true          // start listening on boot (survives the reset
                                       // many boards do when the Pi opens the port)
#define DEFAULT_BITRATE  '6'           // SLCAN code: 6 = 500 kbit/s (Nissan 370Z)
#define LED_PIN          -1            // set to your board's LED pin to blink on traffic (e.g. 2)

// ---------- State ----------
static bool     busOpen     = false;
static char     bitrateCode = DEFAULT_BITRATE;
static bool     timestamps  = false;
static char     cmd[32];
static uint8_t  cmdLen      = 0;
static uint32_t lastLedMs   = 0;

static const char HEXCH[] = "0123456789ABCDEF";

// SLCAN S-codes -> TWAI timing
#define PICK(code, MACRO) case code: { twai_timing_config_t x = MACRO(); t = x; return true; }
static bool timingFor(char code, twai_timing_config_t &t) {
  switch (code) {
    PICK('2', TWAI_TIMING_CONFIG_50KBITS)
    PICK('3', TWAI_TIMING_CONFIG_100KBITS)
    PICK('4', TWAI_TIMING_CONFIG_125KBITS)
    PICK('5', TWAI_TIMING_CONFIG_250KBITS)
    PICK('6', TWAI_TIMING_CONFIG_500KBITS)
    PICK('7', TWAI_TIMING_CONFIG_800KBITS)
    PICK('8', TWAI_TIMING_CONFIG_1MBITS)
    default: return false;
  }
}

static bool openBus() {
  if (busOpen) return true;
  twai_timing_config_t t;
  if (!timingFor(bitrateCode, t)) return false;

  twai_general_config_t g =
      TWAI_GENERAL_CONFIG_DEFAULT(CAN_TX_PIN, CAN_RX_PIN, TWAI_MODE_LISTEN_ONLY);
  g.rx_queue_len = 128;
  twai_filter_config_t f = TWAI_FILTER_CONFIG_ACCEPT_ALL();

  if (twai_driver_install(&g, &t, &f) != ESP_OK) return false;
  if (twai_start() != ESP_OK) { twai_driver_uninstall(); return false; }
  busOpen = true;
  return true;
}

static void closeBus() {
  if (!busOpen) return;
  twai_stop();
  twai_driver_uninstall();
  busOpen = false;
}

static inline void reply(bool ok) { Serial.write(ok ? '\r' : '\a'); }

static void handleCommand() {
  if (cmdLen == 0) return;                  // bare CR/LF: ignore
  switch (cmd[0]) {
    case 'S': {                             // S0..S8 set bitrate
      twai_timing_config_t t;
      if (cmdLen < 2 || !timingFor(cmd[1], t)) { reply(false); break; }
      bool wasOpen = busOpen;
      closeBus();
      bitrateCode = cmd[1];
      if (wasOpen) openBus();
      reply(true);
      break;
    }
    case 'O':                               // open (we always open listen-only)
    case 'L': reply(openBus()); break;      // open listen-only
    case 'C': closeBus(); reply(true); break;
    case 'V': Serial.print("V1013\r"); break;
    case 'v': Serial.print("v0100\r"); break;
    case 'N': Serial.print("NE32C\r"); break;
    case 'F': Serial.print("F00\r");   break;
    case 'Z': timestamps = (cmdLen > 1 && cmd[1] == '1'); reply(true); break;
    case 't': case 'T': case 'r': case 'R': // transmit requests: refused, by design
    default:  reply(false); break;
  }
}

static void sendFrame(const twai_message_t &m) {
  char b[40];
  int n = 0;
  const bool ext = m.extd;
  const bool rtr = m.rtr;
  b[n++] = ext ? (rtr ? 'R' : 'T') : (rtr ? 'r' : 't');

  const uint32_t id = m.identifier;
  const int digits = ext ? 8 : 3;
  for (int i = digits - 1; i >= 0; --i) b[n++] = HEXCH[(id >> (i * 4)) & 0xF];

  const uint8_t dlc = m.data_length_code > 8 ? 8 : m.data_length_code;
  b[n++] = '0' + dlc;
  if (!rtr) {
    for (uint8_t i = 0; i < dlc; ++i) {
      b[n++] = HEXCH[m.data[i] >> 4];
      b[n++] = HEXCH[m.data[i] & 0xF];
    }
  }
  if (timestamps) {
    const uint16_t ms = millis() % 60000;
    for (int i = 3; i >= 0; --i) b[n++] = HEXCH[(ms >> (i * 4)) & 0xF];
  }
  b[n++] = '\r';
  Serial.write((const uint8_t *)b, n);
}

void setup() {
  Serial.begin(SERIAL_BAUD);
  if (LED_PIN >= 0) pinMode(LED_PIN, OUTPUT);
  if (AUTO_OPEN) openBus();
}

void loop() {
  // Commands from the Pi
  while (Serial.available()) {
    char c = (char)Serial.read();
    if (c == '\r' || c == '\n') { handleCommand(); cmdLen = 0; }
    else if (cmdLen < sizeof(cmd) - 1) cmd[cmdLen++] = c;
  }

  // Frames from the car
  if (busOpen) {
    twai_message_t m;
    int budget = 64;
    bool got = false;
    while (budget-- > 0 && twai_receive(&m, 0) == ESP_OK) { sendFrame(m); got = true; }

    if (LED_PIN >= 0) {
      uint32_t now = millis();
      if (got && now - lastLedMs > 50) { digitalWrite(LED_PIN, !digitalRead(LED_PIN)); lastLedMs = now; }
    }
  }
}
