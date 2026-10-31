/*
  ESP32 CAN LOGGER  -  standalone, phone over Wi-Fi
  ---------------------------------------------------
  Plug into the car's CAN bus (via the Adafruit CAN Pal or SN65HVD230 board),
  join the "CAN-LOGGER" Wi-Fi from your phone, open http://192.168.4.1

  - Auto-detects the bus speed (500k / 250k / 125k / 1M)
  - Live view of every CAN ID: rate, data, bytes flash red when they change
  - Record to the ESP32's flash, drop labelled markers ("clutch in", "rev 3000")
  - Download each recording as CSV (Excel/Sheets) or candump .log (SavvyCAN, can-utils)
  - Download a summary CSV: every ID, its rate, which bytes change, min/max per byte

  LISTEN-ONLY: the ESP32 never transmits or ACKs. With the CAN Pal, also tie SLNT to 3V3.

  Wiring (ESP32 -> CAN Pal):  3V3->Vcc, GND->GND, GPIO5->TX, GPIO4->RX, 3V3->SLNT
  CAN Pal -> OBD-II:          CANH->pin 6, CANL->pin 14, GND->pin 5. Termination switch OFF.
  Power the ESP32 from a USB car charger (or a 12V->5V buck on OBD pin 16 + pin 4).

  Arduino IDE: board package "esp32 by Espressif Systems" 3.x. No extra libraries.
  Tools > Partition Scheme: pick the option with the biggest SPIFFS for more log space
  (e.g. "No OTA (2MB APP/2MB SPIFFS)" on 4MB boards).
*/

#include <Arduino.h>
#include <WiFi.h>
#include <WebServer.h>
#include <LittleFS.h>
#include "driver/twai.h"

// ===================== Settings =====================
#define CAN_TX_PIN   GPIO_NUM_5
#define CAN_RX_PIN   GPIO_NUM_4
const char *AP_SSID = "CAN-LOGGER";
const char *AP_PASS = "subaru1234";      // at least 8 characters
#define MAX_IDS      256
#define KEEPALIVE_MS 1000                // "changes only" mode still logs each ID once a second
#define MIN_FREE     (24 * 1024)         // stop recording when flash gets this low

// ===================== Types =====================
struct __attribute__((packed)) Rec {     // 17 bytes per logged frame
  uint32_t ms;                           // ms since recording started
  uint32_t id;                           // bit31 = extended; 0xFFFFFFFF = marker
  uint8_t  dlc;
  uint8_t  d[8];
};
#define MARK_ID  0xFFFFFFFFu
#define EXT_FLAG 0x80000000u

struct IdStat {
  uint32_t id;
  bool     ext;
  uint8_t  dlc;
  uint8_t  d[8], mn[8], mx[8];
  uint8_t  changedMask;
  uint32_t count, win;
  uint16_t hz;
  uint32_t lastChange[8];
  uint32_t lastLog;
};

// ===================== Shared state =====================
static IdStat stats[MAX_IDS];
static IdStat snap[MAX_IDS];
static volatile int nStats = 0;
static portMUX_TYPE mux = portMUX_INITIALIZER_UNLOCKED;

static volatile uint32_t fps = 0, totalFrames = 0;
static volatile uint32_t bitrate = 0;          // 0 = still searching
static volatile uint32_t forcedBitrate = 0;    // 0 = auto
static volatile bool     resetReq = false;

static volatile bool     recWant = false, recOn = false, recAll = false, fsFull = false;
static volatile uint32_t recStart = 0, recBytes = 0;
static char              recName[24] = "";
static volatile int      pendingMark = 0;
static int               markCount = 0;

WebServer server(80);

// ===================== CAN =====================
static bool startTwai(uint32_t rate) {
  twai_timing_config_t t;
  switch (rate) {
    case 1000000: { twai_timing_config_t x = TWAI_TIMING_CONFIG_1MBITS();   t = x; } break;
    case 250000:  { twai_timing_config_t x = TWAI_TIMING_CONFIG_250KBITS(); t = x; } break;
    case 125000:  { twai_timing_config_t x = TWAI_TIMING_CONFIG_125KBITS(); t = x; } break;
    default:      { twai_timing_config_t x = TWAI_TIMING_CONFIG_500KBITS(); t = x; } break;
  }
  twai_general_config_t g =
      TWAI_GENERAL_CONFIG_DEFAULT(CAN_TX_PIN, CAN_RX_PIN, TWAI_MODE_LISTEN_ONLY);
  g.rx_queue_len = 256;
  twai_filter_config_t f = TWAI_FILTER_CONFIG_ACCEPT_ALL();
  if (twai_driver_install(&g, &t, &f) != ESP_OK) return false;
  if (twai_start() != ESP_OK) { twai_driver_uninstall(); return false; }
  return true;
}

static void stopTwai() {
  twai_stop();
  twai_driver_uninstall();
}

// ---- Diagnostics shown on the phone page while searching ----
static char diagMsg[160] = "starting";

// Watch the raw RX pin (CAN driver not running) and count level changes.
// A live CAN bus gives hundreds+ edges per 100 ms; an idle/disconnected line gives 0.
static void sampleRxPin(uint32_t ms, uint32_t &edges, int &idleLevel) {
  pinMode((int)CAN_RX_PIN, INPUT);
  int last = digitalRead((int)CAN_RX_PIN), highs = 0, samples = 0;
  edges = 0;
  uint32_t t0 = millis();
  while (millis() - t0 < ms) {
    int v = digitalRead((int)CAN_RX_PIN);
    if (v != last) { edges++; last = v; }
    highs += v; samples++;
  }
  idleLevel = (highs * 2 > samples) ? 1 : 0;
}

// Try each speed for 1.5 s; the right one gives clean frames, wrong ones give errors.
static uint32_t detectBitrate() {
  static const uint32_t RATES[] = {500000, 250000, 125000, 1000000};
  for (;;) {
    uint32_t edges; int lvl;
    sampleRxPin(200, edges, lvl);

    if (forcedBitrate) {
      if (startTwai(forcedBitrate)) return forcedBitrate;
      vTaskDelay(pdMS_TO_TICKS(500));
      continue;
    }
    String results;
    for (uint32_t r : RATES) {
      if (forcedBitrate) break;
      if (!startTwai(r)) continue;
      uint32_t good = 0, t0 = millis();
      twai_message_t m;
      while (millis() - t0 < 1500) {
        if (twai_receive(&m, pdMS_TO_TICKS(50)) == ESP_OK) good++;
      }
      twai_status_info_t s;
      twai_get_status_info(&s);
      Serial.printf("  try %4luk: frames=%lu bus_errors=%lu\n", (unsigned long)(r / 1000),
                    (unsigned long)good, (unsigned long)s.bus_error_count);
      results += String(r / 1000) + "k:" + good + "f/" + s.bus_error_count + "e ";
      if (good >= 20 && s.bus_error_count < good / 4 + 5) return r;
      stopTwai();
    }

    const char *verdict;
    if (edges == 0 && lvl == 1)
      verdict = "RX pin idle HIGH: no CAN traffic reaching the board (wiring/pins, or OBD port is silent)";
    else if (edges == 0 && lvl == 0)
      verdict = "RX pin stuck LOW: CANH/CANL swapped, CAN board unpowered, or RX on wrong pin";
    else
      verdict = "signal on RX pin but no valid frames: check CANH/CANL swap and GND to OBD pin 5";
    snprintf(diagMsg, sizeof(diagMsg), "rx edges/200ms=%lu idle=%s | %s| %s",
             (unsigned long)edges, lvl ? "HIGH" : "LOW", results.c_str(), verdict);
    Serial.printf("DIAG: %s\n", diagMsg);
  }
}

// Returns true if this frame should be written to the log.
static bool updateStats(const twai_message_t &m, uint32_t now) {
  const uint8_t dlc = m.data_length_code > 8 ? 8 : m.data_length_code;
  bool logIt;
  portENTER_CRITICAL(&mux);
  int i = 0;
  while (i < nStats && !(stats[i].id == m.identifier && stats[i].ext == (bool)m.extd)) i++;
  if (i == nStats) {
    if (nStats >= MAX_IDS) { portEXIT_CRITICAL(&mux); return recAll; }
    IdStat &n = stats[nStats++];
    memset(&n, 0, sizeof(n));
    n.id = m.identifier; n.ext = m.extd; n.dlc = dlc;
    memcpy(n.d, m.data, dlc);
    memset(n.mn, 0xFF, 8);
    for (int b = 0; b < dlc; b++) { n.mn[b] = n.mx[b] = m.data[b]; }
    n.count = n.win = 1;
    n.lastLog = now;
    portEXIT_CRITICAL(&mux);
    return true;
  }
  IdStat &s = stats[i];
  bool changed = (dlc != s.dlc);
  for (int b = 0; b < dlc; b++) {
    if (m.data[b] != s.d[b]) { changed = true; s.changedMask |= (1 << b); s.lastChange[b] = now; }
    if (m.data[b] < s.mn[b]) s.mn[b] = m.data[b];
    if (m.data[b] > s.mx[b]) s.mx[b] = m.data[b];
  }
  memcpy(s.d, m.data, dlc);
  s.dlc = dlc;
  s.count++; s.win++;
  logIt = recAll || changed || (now - s.lastLog >= KEEPALIVE_MS);
  if (logIt) s.lastLog = now;
  portEXIT_CRITICAL(&mux);
  return logIt;
}

// ===================== Recording =====================
static File     recFile;
static uint8_t  wbuf[4096];
static size_t   wlen = 0;
static uint32_t lastFlush = 0;

static size_t fsFree() { return LittleFS.totalBytes() - LittleFS.usedBytes(); }

static void stopRec() {
  if (wlen && recFile) { recFile.write(wbuf, wlen); recBytes += wlen; }
  wlen = 0;
  if (recFile) recFile.close();
  recOn = false;
  recWant = false;
}

static void flushBuf() {
  if (wlen && recFile) { recFile.write(wbuf, wlen); recBytes += wlen; }
  wlen = 0;
  lastFlush = millis();
  if (fsFree() < MIN_FREE) { fsFull = true; stopRec(); }
}

static void appendRec(const Rec &r) {
  if (wlen + sizeof(Rec) > sizeof(wbuf)) flushBuf();
  if (!recOn) return;
  memcpy(wbuf + wlen, &r, sizeof(Rec));
  wlen += sizeof(Rec);
}

static int nextLogNumber() {
  int maxN = 0;
  File root = LittleFS.open("/");
  for (File f = root.openNextFile(); f; f = root.openNextFile()) {
    int n;
    if (sscanf(f.name(), "log_%d.bin", &n) == 1 && n > maxN) maxN = n;
  }
  return maxN + 1;
}

static void startRec() {
  if (fsFree() < MIN_FREE * 2) { fsFull = true; recWant = false; return; }
  snprintf(recName, sizeof(recName), "/log_%03d.bin", nextLogNumber());
  recFile = LittleFS.open(recName, "w");
  if (!recFile) { recWant = false; return; }
  fsFull = false;
  wlen = 0; recBytes = 0; markCount = 0; pendingMark = 0;
  portENTER_CRITICAL(&mux);
  for (int i = 0; i < nStats; i++) stats[i].lastLog = 0;   // log every ID at the start
  portEXIT_CRITICAL(&mux);
  recStart = millis();
  lastFlush = recStart;
  recOn = true;
}

// ===================== CAN task =====================
static void canTask(void *) {
  bitrate = detectBitrate();
  Serial.printf("CAN locked at %lu bit/s\n", (unsigned long)bitrate);
  uint32_t lastRoll = millis(), winTotal = 0;
  for (;;) {
    if (forcedBitrate && forcedBitrate != bitrate) {
      stopTwai(); bitrate = 0; bitrate = detectBitrate();
    }
    if (resetReq) {
      portENTER_CRITICAL(&mux); nStats = 0; portEXIT_CRITICAL(&mux);
      resetReq = false;
    }
    if (recWant && !recOn) startRec();
    else if (!recWant && recOn) stopRec();

    twai_message_t m;
    if (twai_receive(&m, pdMS_TO_TICKS(20)) == ESP_OK) {
      do {
        if (m.rtr) continue;
        uint32_t now = millis();
        bool logIt = updateStats(m, now);
        winTotal++; totalFrames++;
        if (recOn && logIt) {
          Rec r;
          r.ms  = now - recStart;
          r.id  = m.identifier | (m.extd ? EXT_FLAG : 0);
          r.dlc = m.data_length_code > 8 ? 8 : m.data_length_code;
          memcpy(r.d, m.data, 8);
          appendRec(r);
        }
      } while (twai_receive(&m, 0) == ESP_OK);
    }

    if (pendingMark && recOn) {
      Rec r = {};
      r.ms = millis() - recStart; r.id = MARK_ID; r.dlc = 0;
      int idx = pendingMark; memcpy(r.d, &idx, sizeof(idx));
      pendingMark = 0;
      appendRec(r);
    }
    if (recOn && millis() - lastFlush > 1000) flushBuf();

    uint32_t now = millis();
    if (now - lastRoll >= 1000) {
      lastRoll = now;
      fps = winTotal; winTotal = 0;
      portENTER_CRITICAL(&mux);
      for (int i = 0; i < nStats; i++) { stats[i].hz = stats[i].win; stats[i].win = 0; }
      portEXIT_CRITICAL(&mux);
    }
  }
}

// ===================== Web =====================
static const char INDEX_HTML[] PROGMEM = R"HTML(<!DOCTYPE html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>CAN Logger</title>
<style>
:root{--bg:#07080a;--p:#101216;--l:#262a31;--d:#727885;--f:#eef0f4;--r:#ff2d4a;--a:#ffb020;--g:#3ddc84}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--f);font:14px ui-monospace,Menlo,Consolas,monospace}
header{position:sticky;top:0;background:var(--bg);padding:10px 12px;border-bottom:1px solid var(--l);z-index:2}
h1{margin:0 0 6px;font-size:16px;letter-spacing:.14em}h1 b{color:var(--r)}
.st{display:flex;flex-wrap:wrap;gap:6px 14px;color:var(--d);font-size:12px}.st em{color:var(--f);font-style:normal}
.card{background:var(--p);border:1px solid var(--l);border-radius:8px;margin:10px 12px;padding:10px}
.row{display:flex;gap:8px;flex-wrap:wrap;align-items:center}
button,select,input{font:inherit;color:var(--f);background:#181b20;border:1px solid var(--l);border-radius:6px;padding:9px 12px}
input{flex:1;min-width:120px}
button.rec{background:var(--r);border-color:var(--r);font-weight:700;min-width:110px}
button.rec.on{animation:p 1s infinite}@keyframes p{50%{opacity:.55}}
.lbl{color:var(--d);font-size:11px;letter-spacing:.12em;margin-bottom:6px}
table{width:100%;border-collapse:collapse}td{padding:4px 3px;border-bottom:1px solid #16191d;white-space:nowrap}
td.id{font-weight:800}td.hz{color:var(--d);text-align:right;padding-right:8px}
.b{display:inline-block;width:2.4ch;text-align:center;margin-right:1px;border-radius:2px}
.b.h{background:var(--r);color:#fff}.b.w{color:var(--r)}.b.s{color:#4a4f58}
.files a{color:var(--a);margin-right:10px}.files div{padding:6px 0;border-bottom:1px solid #16191d;display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.files span{flex:1}.x{padding:4px 9px;color:var(--d)}
.warn{color:var(--a)}.ok{color:var(--g)}.bad{color:var(--r)}
label{color:var(--d);font-size:12px;display:flex;gap:6px;align-items:center}
input[type=checkbox]{flex:0 0 auto;min-width:0;width:22px;height:22px;padding:0;accent-color:#ff2d4a}
</style></head><body>
<header><h1>CAN <b>//</b> LOGGER</h1>
<div class="st"><span>BUS <em id="br">searching…</em></span><span><em id="fps">0</em> f/s</span><span><em id="nid">0</em> IDs</span>
<span>MISSED <em id="miss">0</em></span><span>FREE <em id="free">-</em></span></div>
<div id="diag" class="warn" style="font-size:12px;margin-top:6px;display:none"></div></header>

<div class="card">
 <div class="row">
  <button class="rec" id="rec" onclick="toggleRec()">● RECORD</button>
  <select id="mode"><option value="changes">Changes only (longer logs)</option><option value="all">Every frame</option></select>
 </div>
 <div class="st" style="margin-top:8px"><span id="recinfo">Not recording</span></div>
 <div class="row" style="margin-top:10px">
  <input id="mlabel" placeholder="Marker, e.g. clutch in" maxlength="40">
  <button onclick="mark()">⚑ MARK</button>
 </div>
</div>

<div class="card">
 <div class="row" style="justify-content:space-between">
  <label><input type="checkbox" id="onlych"> Only IDs that change</label>
  <select id="brsel" onchange="setBr()"><option value="0">Auto speed</option><option>500000</option><option>250000</option><option>125000</option><option>1000000</option></select>
  <button class="x" onclick="fetch('/api/reset',{method:'POST'})">Clear</button>
 </div>
 <div class="lbl" style="margin-top:10px">LIVE · red = just changed · grey = never changes</div>
 <table><tbody id="rows"></tbody></table>
</div>

<div class="card files">
 <div class="row" style="justify-content:space-between"><div class="lbl">RECORDINGS</div><a href="/summary.csv">Summary CSV</a></div>
 <div id="files" style="display:block"></div>
</div>

<script>
const $=id=>document.getElementById(id);let rec=false,lastRec=null;
function kb(n){return n>1048576?(n/1048576).toFixed(1)+' MB':(n/1024).toFixed(0)+' KB'}
async function live(){
 try{const s=await (await fetch('/api/live')).json();
  $('br').textContent=s.br?(s.br/1000)+' kbit/s':'searching… (ignition on?)';
  $('br').className=s.br?'ok':'warn';
  $('diag').style.display=s.diag?'block':'none';$('diag').textContent=s.diag?'DIAG: '+s.diag:'';
  $('fps').textContent=s.fps;$('nid').textContent=s.ids.length;$('miss').textContent=s.missed;$('free').textContent=kb(s.free);
  rec=s.rec;$('rec').textContent=rec?'■ STOP':'● RECORD';$('rec').classList.toggle('on',rec);
  $('recinfo').innerHTML=rec?`Recording <b>${s.file.slice(1)}</b> · ${(s.recms/1000).toFixed(0)} s · ${kb(s.bytes)} · ${s.marks} markers`:
   (s.full?'<span class="bad">Flash full: recording stopped. Download &amp; delete old logs.</span>':'Not recording');
  if(lastRec!==null&&lastRec!==rec)files();lastRec=rec;
  const only=$('onlych').checked;let h='';
  for(const [id,ext,dlc,data,hz,ages,mask] of s.ids){
   if(only&&!mask)continue;
   let bs='';for(let i=0;i<dlc;i++){const a=ages[i];const c=!(mask>>i&1)?'s':a<300?'h':a<2000?'w':'';bs+=`<span class="b ${c}">${data.substr(i*2,2)}</span>`}
   h+=`<tr><td class="id">${id}</td><td class="hz">${hz}</td><td>${bs}</td></tr>`}
  $('rows').innerHTML=h;
 }catch(e){$('br').textContent='disconnected';$('br').className='bad'}
 setTimeout(live,500)}
async function toggleRec(){await fetch(`/api/rec?on=${rec?0:1}&mode=${$('mode').value}`,{method:'POST'})}
async function mark(){const l=$('mlabel').value||'mark';const r=await fetch('/api/mark?label='+encodeURIComponent(l),{method:'POST'});
 if(r.ok){$('mlabel').value='';}else alert('Start recording first')}
async function setBr(){await fetch('/api/bitrate?r='+$('brsel').value,{method:'POST'})}
async function files(){const f=await (await fetch('/api/files')).json();
 $('files').innerHTML=f.length?f.map(x=>`<div><span>${x.n.slice(1)} · ${kb(x.s)}${x.a?' · <i class="warn">recording</i>':''}</span>
  ${x.a?'':`<a href="/dl?f=${x.n}&fmt=csv">CSV</a><a href="/dl?f=${x.n}&fmt=log">.log</a><button class="x" onclick="del('${x.n}')">✕</button>`}</div>`).join(''):'<div><span style="color:var(--d)">No recordings yet</span></div>'}
async function del(n){if(confirm('Delete '+n.slice(1)+'?')){await fetch('/api/del?f='+n,{method:'POST'});files()}}
live();files();
</script></body></html>)HTML";

static bool validName(const String &f) {
  return f.startsWith("/log_") && f.endsWith(".bin") && f.indexOf("..") < 0 && f.length() < 20;
}

static String markName(const String &bin) { return bin.substring(0, bin.length() - 4) + ".mk"; }

static void handleLive() {
  int n;
  portENTER_CRITICAL(&mux);
  n = nStats;
  memcpy(snap, stats, n * sizeof(IdStat));
  portEXIT_CRITICAL(&mux);

  // sort by ID
  for (int i = 1; i < n; i++) {
    IdStat t = snap[i]; int j = i - 1;
    while (j >= 0 && snap[j].id > t.id) { snap[j + 1] = snap[j]; j--; }
    snap[j + 1] = t;
  }

  twai_status_info_t st = {};
  if (bitrate) twai_get_status_info(&st);
  const uint32_t now = millis();

  String o;
  o.reserve(300 + n * 90);
  o += "{\"br\":"; o += bitrate;
  o += ",\"fps\":"; o += fps;
  o += ",\"total\":"; o += totalFrames;
  o += ",\"missed\":"; o += st.rx_missed_count + st.rx_overrun_count;
  o += ",\"free\":"; o += (uint32_t)fsFree();
  o += ",\"rec\":"; o += recOn ? "true" : "false";
  o += ",\"full\":"; o += fsFull ? "true" : "false";
  o += ",\"file\":\""; o += recName; o += "\"";
  o += ",\"bytes\":"; o += recBytes;
  o += ",\"recms\":"; o += recOn ? (now - recStart) : 0;
  o += ",\"marks\":"; o += markCount;
  o += ",\"diag\":\""; o += bitrate ? "" : diagMsg; o += "\"";
  o += ",\"ids\":[";
  char buf[96];
  for (int i = 0; i < n; i++) {
    const IdStat &s = snap[i];
    char hex[17]; for (int b = 0; b < s.dlc; b++) sprintf(hex + b * 2, "%02X", s.d[b]); hex[s.dlc * 2] = 0;
    if (i) o += ',';
    snprintf(buf, sizeof(buf), s.ext ? "[\"%08lX\",1,%u,\"%s\",%u,[" : "[\"%03lX\",0,%u,\"%s\",%u,[",
             (unsigned long)s.id, s.dlc, hex, s.hz);
    o += buf;
    for (int b = 0; b < 8; b++) {
      uint32_t a = s.lastChange[b] ? now - s.lastChange[b] : 99999;
      if (a > 99999) a = 99999;
      if (b) o += ',';
      o += a;
    }
    o += "],"; o += s.changedMask; o += ']';
  }
  o += "]}";
  server.send(200, "application/json", o);
}

static void handleRec() {
  bool on = server.arg("on") == "1";
  if (on) { recAll = server.arg("mode") == "all"; fsFull = false; }
  recWant = on;
  server.send(200, "text/plain", "ok");
}

static void handleMark() {
  if (!recOn) { server.send(409, "text/plain", "not recording"); return; }
  String label = server.arg("label");
  label.replace(",", " "); label.replace("\n", " "); label.replace("\r", " "); label.replace("\t", " ");
  if (label.length() > 40) label = label.substring(0, 40);
  int idx = ++markCount;
  File mk = LittleFS.open(markName(String(recName)), "a");
  if (mk) { mk.printf("%d\t%s\n", idx, label.c_str()); mk.close(); }
  pendingMark = idx;
  server.send(200, "text/plain", "ok");
}

static void handleFiles() {
  String o = "[";
  File root = LittleFS.open("/");
  bool first = true;
  for (File f = root.openNextFile(); f; f = root.openNextFile()) {
    String n = String("/") + f.name();
    if (!n.endsWith(".bin")) continue;
    if (!first) o += ',';
    first = false;
    bool active = recOn && n == recName;
    o += "{\"n\":\""; o += n; o += "\",\"s\":"; o += (uint32_t)f.size();
    o += ",\"a\":"; o += active ? "true" : "false"; o += '}';
  }
  o += "]";
  server.send(200, "application/json", o);
}

static void handleDownload() {
  String f = server.arg("f");
  bool csv = server.arg("fmt") != "log";
  if (!validName(f) || !LittleFS.exists(f)) { server.send(404, "text/plain", "not found"); return; }
  if (recOn && f == recName) { server.send(409, "text/plain", "stop recording first"); return; }

  // load marker labels
  static String labels[101];
  for (auto &l : labels) l = "";
  File mk = LittleFS.open(markName(f), "r");
  if (mk) {
    while (mk.available()) {
      String line = mk.readStringUntil('\n');
      int tab = line.indexOf('\t');
      int idx = line.substring(0, tab).toInt();
      if (tab > 0 && idx > 0 && idx <= 100) labels[idx] = line.substring(tab + 1);
    }
    mk.close();
  }

  File in = LittleFS.open(f, "r");
  String base = f.substring(1, f.length() - 4);
  server.sendHeader("Content-Disposition", "attachment; filename=\"" + base + (csv ? ".csv\"" : ".log\""));
  server.setContentLength(CONTENT_LENGTH_UNKNOWN);
  server.send(200, csv ? "text/csv" : "text/plain", "");
  if (csv) server.sendContent("time_s,id,ext,dlc,b0,b1,b2,b3,b4,b5,b6,b7,marker\n");

  Rec r;
  String out;
  out.reserve(2400);
  char line[96];
  while (in.read((uint8_t *)&r, sizeof(r)) == sizeof(r)) {
    unsigned long sec = r.ms / 1000, ms = r.ms % 1000;
    if (r.id == MARK_ID) {
      int idx; memcpy(&idx, r.d, sizeof(idx));
      if (csv) {
        snprintf(line, sizeof(line), "%lu.%03lu,MARK,,,,,,,,,,,%d ", sec, ms, idx);
        out += line;
        if (idx > 0 && idx <= 100) out += labels[idx];
        out += '\n';
      }
    } else {
      bool ext = r.id & EXT_FLAG;
      uint32_t id = r.id & 0x1FFFFFFF;
      uint8_t dlc = r.dlc > 8 ? 8 : r.dlc;
      if (csv) {
        int n = snprintf(line, sizeof(line), ext ? "%lu.%03lu,%08lX,1,%u" : "%lu.%03lu,%03lX,0,%u",
                         sec, ms, (unsigned long)id, dlc);
        for (int b = 0; b < 8; b++)
          n += (b < dlc) ? snprintf(line + n, sizeof(line) - n, ",%02X", r.d[b])
                         : snprintf(line + n, sizeof(line) - n, ",");
        snprintf(line + n, sizeof(line) - n, ",\n");
      } else {
        int n = snprintf(line, sizeof(line), ext ? "(%lu.%03lu000) can0 %08lX#" : "(%lu.%03lu000) can0 %03lX#",
                         sec, ms, (unsigned long)id);
        for (int b = 0; b < dlc; b++) n += snprintf(line + n, sizeof(line) - n, "%02X", r.d[b]);
        snprintf(line + n, sizeof(line) - n, "\n");
      }
      out += line;
    }
    if (out.length() > 2000) { server.sendContent(out); out = ""; }
  }
  if (out.length()) server.sendContent(out);
  server.sendContent("");
  in.close();
}

static void handleSummary() {
  int n;
  portENTER_CRITICAL(&mux);
  n = nStats;
  memcpy(snap, stats, n * sizeof(IdStat));
  portEXIT_CRITICAL(&mux);
  for (int i = 1; i < n; i++) {
    IdStat t = snap[i]; int j = i - 1;
    while (j >= 0 && snap[j].id > t.id) { snap[j + 1] = snap[j]; j--; }
    snap[j + 1] = t;
  }
  server.sendHeader("Content-Disposition", "attachment; filename=\"can_summary.csv\"");
  server.setContentLength(CONTENT_LENGTH_UNKNOWN);
  server.send(200, "text/csv", "");
  server.sendContent("id,ext,hz,frames,dlc,last_data,changing_bytes,byte_ranges(min-max)\n");
  char line[200];
  for (int i = 0; i < n; i++) {
    const IdStat &s = snap[i];
    int k = snprintf(line, sizeof(line), s.ext ? "%08lX,1,%u,%lu,%u," : "%03lX,0,%u,%lu,%u,",
                     (unsigned long)s.id, s.hz, (unsigned long)s.count, s.dlc);
    for (int b = 0; b < s.dlc; b++) k += snprintf(line + k, sizeof(line) - k, "%02X%s", s.d[b], b < s.dlc - 1 ? " " : "");
    k += snprintf(line + k, sizeof(line) - k, ",");
    bool any = false;
    for (int b = 0; b < 8; b++) if (s.changedMask >> b & 1) { k += snprintf(line + k, sizeof(line) - k, "%sb%d", any ? " " : "", b); any = true; }
    if (!any) k += snprintf(line + k, sizeof(line) - k, "none");
    k += snprintf(line + k, sizeof(line) - k, ",");
    for (int b = 0; b < s.dlc; b++)
      k += snprintf(line + k, sizeof(line) - k, "%sb%d %02X-%02X", b ? "; " : "", b, s.mn[b], s.mx[b]);
    snprintf(line + k, sizeof(line) - k, "\n");
    server.sendContent(line);
  }
  server.sendContent("");
}

static void handleDelete() {
  String f = server.arg("f");
  if (!validName(f)) { server.send(400, "text/plain", "bad name"); return; }
  if (recOn && f == recName) { server.send(409, "text/plain", "recording"); return; }
  LittleFS.remove(f);
  LittleFS.remove(markName(f));
  server.send(200, "text/plain", "ok");
}

static void handleBitrate() {
  uint32_t r = server.arg("r").toInt();
  if (r == 0 || r == 125000 || r == 250000 || r == 500000 || r == 1000000) forcedBitrate = r;
  server.send(200, "text/plain", "ok");
}

// ===================== Setup / loop =====================
static const char *resetReasonStr() {
  switch (esp_reset_reason()) {
    case ESP_RST_POWERON:  return "power on";
    case ESP_RST_BROWNOUT: return "BROWNOUT (power supply dipped: weak USB/cable or too much load on 3V3)";
    case ESP_RST_PANIC:    return "CRASH (panic)";
    case ESP_RST_INT_WDT:
    case ESP_RST_TASK_WDT:
    case ESP_RST_WDT:      return "WATCHDOG";
    case ESP_RST_SW:       return "software restart";
    default:               return "other";
  }
}

void setup() {
  Serial.begin(115200);
  delay(300);
  Serial.printf("\n\n=== CAN LOGGER boot. Reset reason: %s ===\n", resetReasonStr());

  if (!LittleFS.begin(true)) Serial.println("LittleFS mount failed");

  // Wi-Fi first, at reduced TX power: smaller current spikes = fewer brownouts.
  WiFi.mode(WIFI_AP);
  bool apOk = WiFi.softAP(AP_SSID, AP_PASS);
  WiFi.setTxPower(WIFI_POWER_11dBm);
  Serial.printf("Wi-Fi AP \"%s\" %s  ->  http://%s\n", AP_SSID, apOk ? "started" : "FAILED",
                WiFi.softAPIP().toString().c_str());

  server.on("/", []() { server.send_P(200, "text/html", INDEX_HTML); });
  server.on("/api/live", handleLive);
  server.on("/api/rec", HTTP_POST, handleRec);
  server.on("/api/mark", HTTP_POST, handleMark);
  server.on("/api/files", handleFiles);
  server.on("/api/del", HTTP_POST, handleDelete);
  server.on("/api/bitrate", HTTP_POST, handleBitrate);
  server.on("/api/reset", HTTP_POST, []() { resetReq = true; server.send(200, "text/plain", "ok"); });
  server.on("/dl", handleDownload);
  server.on("/summary.csv", handleSummary);
  server.begin();

  // Let Wi-Fi settle before starting CAN. Run CAN on the other core from Wi-Fi
  // (the CAN interrupt is attached to the core that installs the driver).
  delay(1500);
#if CONFIG_FREERTOS_UNICORE
  xTaskCreate(canTask, "can", 8192, nullptr, 5, nullptr);
#else
  xTaskCreatePinnedToCore(canTask, "can", 8192, nullptr, 5, nullptr, 1);
#endif
  Serial.println("CAN task started (listen-only, auto bitrate)");
}

void loop() {
  server.handleClient();
  static uint32_t lastLog = 0;
  if (millis() - lastLog > 5000) {
    lastLog = millis();
    Serial.printf("bus=%lu  fps=%lu  ids=%d  wifi_clients=%d  free_heap=%lu\n",
                  (unsigned long)bitrate, (unsigned long)fps, nStats,
                  WiFi.softAPgetStationNum(), (unsigned long)ESP.getFreeHeap());
  }
  delay(2);
}
