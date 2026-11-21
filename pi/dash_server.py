#!/usr/bin/env python3
"""
Impreza dash backend.

Reads CAN frames from can0 (Waveshare RS485 CAN HAT, listen-only), decodes the
signals from the active vehicle profile (vehicles/*.json), and streams them to the dash page over a WebSocket.

  python3 dash_server.py            # live from can0
  python3 dash_server.py --demo     # simulated drive, no car needed
  python3 dash_server.py --cursor   # show the mouse pointer (add to either)
  python3 dash_server.py --obd      # also poll standard OBD-II data (transmits requests; see README)
Open http://localhost:8080
"""
import argparse
import asyncio
import glob
import gzip
import io
import json
import math
import os
import random
import re
import shutil
import subprocess
import time
import zipfile
from datetime import datetime
from pathlib import Path

from aiohttp import web, WSMsgType

HERE = Path(__file__).resolve().parent
LINK_TIMEOUT = 2.0      # s without frames = vehicle off
PUSH_INTERVAL = 0.04    # 25 Hz to the browser


# ---------------------------------------------------------------- signals
VEHICLES_DIR = HERE / "vehicles"
ACTIVE_FILE = HERE / "vehicle.json"       # which profile is selected (git-ignored, written by the settings page)
DEFAULT_VEHICLE = "subaru_impreza_2013"


def load_signals(path):
    sigs, by_id, _ = load_profile(path)
    return sigs, by_id


def load_profile(path):
    """A vehicle profile: CAN signal decodes plus an optional "_vehicle" block with car defaults
    (name, bitrate, redline, shift_at, mass, cda, gear_count, gear_ratios, model)."""
    raw = json.loads(Path(path).read_text(encoding="utf-8"))
    info = dict(raw.get("_vehicle") or {})
    info.setdefault("name", Path(path).stem.replace("_", " "))
    sigs = {k: v for k, v in raw.items() if not k.startswith("_")}
    by_id = {}
    for name, s in sigs.items():
        s["_id"] = int(str(s["id"]), 0)
        if "mask" in s:
            s["_mask"] = int(str(s["mask"]), 0)
        by_id.setdefault(s["_id"], []).append((name, s))
    return sigs, by_id, info


def list_vehicles():
    out = []
    for f in sorted(VEHICLES_DIR.glob("*.json")):
        try:
            sigs, _, info = load_profile(f)
        except Exception as ex:              # a broken file shouldn't hide the others
            out.append({"id": f.stem, "name": f.stem, "error": str(ex)})
            continue
        out.append({"id": f.stem, "name": info["name"], "signals": len(sigs),
                    "verified": sum(1 for s in sigs.values() if s.get("verified")),
                    "bitrate": info.get("bitrate", 500000)})
    return out


def active_vehicle():
    try:
        vid = json.loads(ACTIVE_FILE.read_text()).get("active", "")
    except (OSError, ValueError):
        vid = ""
    return vid if (VEHICLES_DIR / f"{vid}.json").is_file() else DEFAULT_VEHICLE


def can_bitrate(channel):
    """Bitrate can0 is actually running at (None if unknown / not up)."""
    try:
        r = subprocess.run(["ip", "-details", "-json", "link", "show", channel],
                           capture_output=True, text=True, timeout=2)
        return json.loads(r.stdout)[0]["linkinfo"]["info_data"]["bittiming"]["bitrate"]
    except Exception:
        return None


def decode(s, data):
    sb, n = s.get("start_byte", 0), s.get("length", 1)
    if sb + n > len(data):
        return None
    raw = int.from_bytes(bytes(data[sb:sb + n]),
                         "little" if s.get("endian") == "little" else "big",
                         signed=s.get("signed", False))
    if "shift" in s:
        raw >>= s["shift"]
    if "_mask" in s:
        raw &= s["_mask"]
    return round(raw * s.get("scale", 1) + s.get("offset", 0), 3)


def encode_into(s, value, buf):
    """Inverse of decode. Only used by demo mode."""
    sb, n = s.get("start_byte", 0), s.get("length", 1)
    order = "little" if s.get("endian") == "little" else "big"
    raw = int(round((value - s.get("offset", 0)) / s.get("scale", 1)))
    width = (1 << (8 * n)) - 1
    if "_mask" in s:
        shift = s.get("shift", 0)
        field = (s["_mask"] << shift) & width
        cur = int.from_bytes(bytes(buf[sb:sb + n]), order)
        cur = (cur & ~field) | ((raw << shift) & field)
        buf[sb:sb + n] = cur.to_bytes(n, order)
    else:
        buf[sb:sb + n] = (raw & width).to_bytes(n, order)


# ---------------------------------------------------------------- OBD-II polling (opt-in: --obd)
# Standard OBD-II "service 01" (show current data) over CAN, the same requests every scan tool
# and ELM327 dongle sends: functional request on 0x7DF, ECU replies on 0x7E8-0x7EF.
# Only service 01 is ever built here. Nothing that clears codes, writes or resets.
OBD_REQ_ID = 0x7DF
OBD_RESP_IDS = range(0x7E8, 0x7F0)
OBD_GAP = 0.025            # s between requests (~40 requests/s, normal scan-tool pace)
OBD_MAX_SEND_FAILS = 5     # consecutive send errors -> stop transmitting for good (until restart)

# pid: (signal name, decode(A, B), encode(value) -> [A, B], unit, fast?)
OBD_PIDS = {
    0x0C: ("rpm",         lambda a, b: (a * 256 + b) / 4,     lambda v: divmod(int(v * 4) & 0xFFFF, 256), "rpm",  True),
    0x0D: ("speed",       lambda a, b: a,                     lambda v: (int(v) & 0xFF, 0),               "km/h", True),
    0x11: ("throttle",    lambda a, b: a * 100 / 255,         lambda v: (int(v * 255 / 100) & 0xFF, 0),   "%",    True),
    0x04: ("engine_load", lambda a, b: a * 100 / 255,         lambda v: (int(v * 255 / 100) & 0xFF, 0),   "%",    False),
    0x0B: ("map_kpa",     lambda a, b: a,                     lambda v: (int(v) & 0xFF, 0),               "kPa",  False),
    0x05: ("coolant",     lambda a, b: a - 40,                lambda v: (int(v + 40) & 0xFF, 0),          "°C",   False),
    0x0F: ("intake_temp", lambda a, b: a - 40,                lambda v: (int(v + 40) & 0xFF, 0),          "°C",   False),
    0x0E: ("timing_adv",  lambda a, b: a / 2 - 64,            lambda v: (int((v + 64) * 2) & 0xFF, 0),    "°",    False),
    0x10: ("maf",         lambda a, b: (a * 256 + b) / 100,   lambda v: divmod(int(v * 100) & 0xFFFF, 256), "g/s", False),
    0x06: ("stft",        lambda a, b: (a - 128) * 100 / 128, lambda v: (int(v * 128 / 100 + 128) & 0xFF, 0), "%", False),
    0x07: ("ltft",        lambda a, b: (a - 128) * 100 / 128, lambda v: (int(v * 128 / 100 + 128) & 0xFF, 0), "%", False),
    0x2F: ("fuel_level",  lambda a, b: a * 100 / 255,         lambda v: (int(v * 255 / 100) & 0xFF, 0),   "%",    False),
    0x42: ("voltage",     lambda a, b: (a * 256 + b) / 1000,  lambda v: divmod(int(v * 1000) & 0xFFFF, 256), "V",  False),
    0x46: ("ambient",     lambda a, b: a - 40,                lambda v: (int(v + 40) & 0xFF, 0),          "°C",   False),
    0x33: ("baro",        lambda a, b: a,                     lambda v: (int(v) & 0xFF, 0),               "kPa",  False),
    0x5C: ("oil_temp",    lambda a, b: a - 40,                lambda v: (int(v + 40) & 0xFF, 0),          "°C",   False),
}
OBD_TWO_BYTE = {0x0C, 0x10, 0x42}
OBD_PROBES = (0x00, 0x20, 0x40)      # "which PIDs do you support?" bitmaps


def obd_request(pid):
    """The only frame this program ever transmits: service 01, one PID."""
    assert pid in OBD_PIDS or pid in OBD_PROBES
    return bytes([0x02, 0x01, pid, 0x55, 0x55, 0x55, 0x55, 0x55])


def pids_from_bitmap(base, data4):
    out = set()
    for i in range(32):
        if data4[i // 8] & (0x80 >> (i % 8)):
            out.add(base + i + 1)
    return out


async def obd_poller(state, send):
    """Probe supported PIDs, then poll them. `send(bytes)` returns True if the frame went out."""
    o = state.obd
    fails = 0

    async def tx(pid):
        nonlocal fails
        ok = await send(obd_request(pid))
        if ok:
            fails = 0
            o["sent"] += 1
            return True
        fails += 1
        if fails >= OBD_MAX_SEND_FAILS:
            o["status"] = "stopped: send failed (check wiring, crystal/bitrate). Restart to retry."
            raise asyncio.CancelledError
        return False

    try:
        while True:
            # 1) discover supported PIDs
            o.update(status="probing", supported=[])
            state.obd_bitmaps.clear()
            for _ in range(3):
                await tx(0x00)
                await asyncio.sleep(0.25)
                if 0x00 in state.obd_bitmaps:
                    break
            if 0x00 not in state.obd_bitmaps:
                o["status"] = "no OBD response (ignition on?)"
                await asyncio.sleep(5)
                continue
            for base in (0x20, 0x40):
                if base in state.obd_supported_raw():
                    await tx(base)
                    await asyncio.sleep(0.25)
            sup = state.obd_supported_raw()
            pids = [p for p in OBD_PIDS if p in sup]
            state.set_obd_pids(pids)
            o.update(status="polling", supported=[OBD_PIDS[p][0] for p in pids])

            # 2) poll: fast PIDs every cycle, one slow PID per cycle (round robin)
            fast = [p for p in pids if OBD_PIDS[p][4]]
            slow = [p for p in pids if not OBD_PIDS[p][4]] or [None]
            i = 0
            while True:
                for p in fast + [slow[i % len(slow)]]:
                    if p is not None:
                        await tx(p)
                        await asyncio.sleep(OBD_GAP)
                i += 1
                if time.monotonic() - state.obd_last_resp > 5:   # ECU went quiet: start over
                    o["status"] = "ECU stopped answering, re-probing"
                    break
    finally:
        state.set_obd_pids([])


def fake_ecu(state):
    """Demo mode: answers OBD requests from the simulated drive."""
    async def send(frame):
        pid = frame[2]
        await asyncio.sleep(0.004)
        now = time.monotonic()
        if pid in OBD_PROBES:
            bits = bytearray(4)
            for p in OBD_PIDS:
                if pid < p <= pid + 32:
                    i = p - pid - 1
                    bits[i // 8] |= 0x80 >> (i % 8)
            if pid + 0x20 in OBD_PROBES:            # "next bitmap supported" bit
                bits[3] |= 0x01
            state.on_frame(0x7E8, bytes([0x06, 0x41, pid, *bits, 0x55]), now)
            return True
        name, _, enc, _, _ = OBD_PIDS[pid]
        v = state.sim.get(name)
        if v is None:
            return True
        a, b = enc(v)
        n = 4 if pid in OBD_TWO_BYTE else 3
        state.on_frame(0x7E8, bytes([n, 0x41, pid, a, b, 0x55, 0x55, 0x55]), now)
        return True
    return send


# ---------------------------------------------------------------- bus logging
LOG_DIR = HERE / "logs"
LOG_MIN_FREE = 300 * 1024 * 1024        # stop recording below 300 MB free


class BusLogger:
    """Records every CAN frame to logs/can_<date>_<time>.log.gz in candump format
    "(unix_time) can0 ID#DATA" (readable by can-utils, SavvyCAN, python-can, cantools).
    Markers go to a matching .markers.csv. gzip is used because a partial .gz from a power cut
    still decompresses up to the cut."""

    def __init__(self):
        self.f = None
        self.mk = None
        self.name = ""
        self.frames = 0
        self.marks = 0
        self.t0 = 0.0
        self.last_check = 0.0
        self.stopped_reason = ""

    @property
    def on(self):
        return self.f is not None

    def start(self):
        if self.on:
            return
        LOG_DIR.mkdir(exist_ok=True)
        if shutil.disk_usage(LOG_DIR).free < LOG_MIN_FREE:
            self.stopped_reason = "not enough free space"
            return
        self.name = "can_" + datetime.now().strftime("%Y%m%d_%H%M%S")
        self.f = gzip.open(LOG_DIR / f"{self.name}.log.gz", "wt", compresslevel=4, newline="\n")
        self.mk = open(LOG_DIR / f"{self.name}.markers.csv", "w", newline="\n")
        self.mk.write("unix_time,seconds_from_start,label\n")
        self.frames = self.marks = 0
        self.t0 = time.time()
        self.stopped_reason = ""

    def stop(self, reason=""):
        if not self.on:
            return
        self.f.close()
        self.mk.close()
        self.f = self.mk = None
        self.stopped_reason = reason

    def write(self, arb_id, data, ext=False):
        t = time.time()
        idf = f"{arb_id:08X}" if (ext or arb_id > 0x7FF) else f"{arb_id:03X}"
        self.f.write(f"({t:.6f}) can0 {idf}#{bytes(data).hex().upper()}\n")
        self.frames += 1
        if t - self.last_check > 10:                     # periodic flush + disk check
            self.last_check = t
            self.f.flush()
            if shutil.disk_usage(LOG_DIR).free < LOG_MIN_FREE:
                self.stop("disk nearly full")

    def mark(self, label):
        if not self.on:
            return False
        t = time.time()
        self.marks += 1
        label = re.sub(r"[\r\n,]", " ", str(label))[:60] or f"mark {self.marks}"
        self.mk.write(f"{t:.6f},{t - self.t0:.3f},{label}\n")
        self.mk.flush()
        return True

    def status(self):
        return {"on": self.on, "name": self.name, "frames": self.frames, "marks": self.marks,
                "secs": round(time.time() - self.t0) if self.on else 0, "reason": self.stopped_reason}


def list_logs():
    out = []
    for p in sorted(LOG_DIR.glob("can_*.log.gz"), reverse=True):
        base = p.name[:-len(".log.gz")]
        mk = LOG_DIR / f"{base}.markers.csv"
        try:
            marks = max(0, sum(1 for _ in open(mk)) - 1) if mk.exists() else 0
        except OSError:
            marks = 0
        out.append({"name": base, "bytes": p.stat().st_size, "marks": marks})
    return out


# ---------------------------------------------------------------- display brightness
class Brightness:
    """Real backlight if the Pi can control it (DSI panels: /sys/class/backlight; HDMI monitors
    that support DDC/CI: ddcutil). Otherwise the page dims itself in software."""

    def __init__(self):
        self.method = "software"
        self.path = None
        self.max = 100
        self._pending = None
        self._busy = False
        for b in glob.glob("/sys/class/backlight/*"):
            br = Path(b) / "brightness"
            if os.access(br, os.W_OK):
                self.method, self.path = "backlight", br
                self.max = int((Path(b) / "max_brightness").read_text().strip() or 255)
                return

    async def probe_ddc(self):
        if self.method != "software" or not shutil.which("ddcutil"):
            return
        try:
            r = await asyncio.to_thread(subprocess.run, ["ddcutil", "getvcp", "10", "--brief"],
                                        capture_output=True, text=True, timeout=15)
            if r.returncode == 0 and "VCP 10" in r.stdout:
                self.method = "ddc"
        except Exception:
            pass

    async def set(self, pct):
        pct = max(5, min(100, int(pct)))
        if self.method == "backlight":
            self.path.write_text(str(round(self.max * pct / 100)))
        elif self.method == "ddc":
            self._pending = pct                          # ddcutil is slow: only apply the latest value
            if not self._busy:
                self._busy = True
                try:
                    while self._pending is not None:
                        v, self._pending = self._pending, None
                        await asyncio.to_thread(subprocess.run, ["ddcutil", "setvcp", "10", str(v), "--noverify"],
                                                capture_output=True, timeout=10)
                finally:
                    self._busy = False
        return self.method


# ---------------------------------------------------------------- state
class BusState:
    def __init__(self, sigs, by_id, vehicle=None):
        self.sigs, self.by_id = sigs, by_id
        self.vehicle = vehicle or {}
        self.ids = {}
        self.values = {}
        self.window = 0
        self.fps = 0
        self.last_frame = 0.0
        self.source = "live"
        self.error = ""
        # OBD polling state
        self.obd = {"status": "off", "supported": [], "sent": 0, "resp": 0, "rate": 0}
        self.obd_bitmaps = {}
        self.obd_names = set()          # signals currently coming from OBD (override broadcast decodes)
        self.obd_last_resp = 0.0
        self.obd_win = 0
        self.meta_ver = 0
        self.sim = {}                   # demo: current simulated values (for the fake ECU)
        self.logger = BusLogger()

    def set_profile(self, sigs, by_id, vehicle):
        """Switch vehicle profile live: new decodes from the next frame on."""
        self.sigs, self.by_id, self.vehicle = sigs, by_id, vehicle
        for name in list(self.values):          # drop values the old profile decoded
            if name not in self.obd_names:
                del self.values[name]
        self.meta_ver += 1

    def obd_supported_raw(self):
        out = set()
        for base, bits in self.obd_bitmaps.items():
            out |= pids_from_bitmap(base, bits)
        return out

    def set_obd_pids(self, pids):
        self.obd_names = {OBD_PIDS[p][0] for p in pids}
        self.meta_ver += 1

    def on_obd(self, data, now):
        n = data[0]                                     # single-frame length
        if n < 2 or n > 7 or data[1] != 0x41:
            return
        pid = data[2]
        if pid in OBD_PROBES and n >= 6:
            self.obd_bitmaps[pid] = bytes(data[3:7])
        elif pid in OBD_PIDS:
            name, dec = OBD_PIDS[pid][0], OBD_PIDS[pid][1]
            a = data[3] if n >= 3 else 0
            b = data[4] if n >= 4 else 0
            self.values[name] = round(dec(a, b), 3)
        else:
            return
        self.obd_last_resp = now
        self.obd_win += 1
        self.obd["resp"] += 1

    def on_frame(self, arb_id, data, now, ext=False):
        if self.logger.f is not None:
            self.logger.write(arb_id, data, ext)
        e = self.ids.get(arb_id)
        if e is None:
            e = self.ids[arb_id] = {"data": b"", "win": 0, "hz": 0, "changed": [0.0] * 8}
        old = e["data"]
        for i, b in enumerate(data[:8]):
            if i >= len(old) or old[i] != b:
                e["changed"][i] = now
        e["data"] = bytes(data)
        e["win"] += 1
        self.window += 1
        self.last_frame = now
        if arb_id in OBD_RESP_IDS and len(data) >= 3:
            self.on_obd(data, now)
        for name, s in self.by_id.get(arb_id, ()):
            if name in self.obd_names:                  # OBD value wins over an unverified decode
                continue
            v = decode(s, data)
            if v is not None:
                self.values[name] = v

    def roll_rates(self):
        self.fps, self.window = self.window, 0
        self.obd["rate"], self.obd_win = self.obd_win, 0
        for e in self.ids.values():
            e["hz"], e["win"] = e["win"], 0

    def snapshot(self, with_bus):
        now = time.monotonic()
        out = {
            "t": time.time(),
            "fps": self.fps,
            "nids": len(self.ids),
            "source": self.source,
            "error": self.error,
            "link": (now - self.last_frame) < LINK_TIMEOUT,
            "v": self.values,
            "obd": self.obd,
            "log": self.logger.status(),
        }
        if with_bus:
            out["ids"] = [[f"{i:03X}" if i <= 0x7FF else f"{i:08X}",
                           e["data"].hex(" ").upper(), e["hz"],
                           [int((now - t) * 1000) if t else 99999 for t in e["changed"]]]
                          for i, e in sorted(self.ids.items())]
        return out

    def meta(self):
        m = {k: {"unit": s.get("unit", ""), "verified": s.get("verified", False), "id": s["id"], "src": "can"}
             for k, s in self.sigs.items()}
        for pid, (name, _, _, unit, _) in OBD_PIDS.items():
            if name in self.obd_names:                  # standard OBD-II values are verified by definition
                m[name] = {"unit": unit, "verified": True, "id": "0x7E8", "src": "obd", "pid": f"01 {pid:02X}"}
        return m


# ---------------------------------------------------------------- sources
async def live_source(state, channel, obd=False):
    import can
    while True:
        try:
            bus = can.Bus(channel=channel, interface="socketcan")
        except Exception as ex:          # can0 not up yet: keep retrying
            state.error = f"{channel}: {ex}"
            await asyncio.sleep(1)
            continue
        state.error = ""
        reader = can.AsyncBufferedReader()
        notifier = can.Notifier(bus, [reader], loop=asyncio.get_running_loop())
        poller = None
        if obd:
            async def send(frame, bus=bus):
                try:
                    await asyncio.to_thread(bus.send, can.Message(arbitration_id=OBD_REQ_ID, data=frame,
                                                                   is_extended_id=False), 0.05)
                    return True
                except can.CanError:
                    return False
            poller = asyncio.create_task(obd_poller(state, send))
        try:
            async for msg in reader:
                if msg.is_error_frame or msg.is_remote_frame:
                    continue
                state.on_frame(msg.arbitration_id, msg.data, time.monotonic(), msg.is_extended_id)
        except Exception as ex:
            state.error = f"{channel}: {ex}"
        finally:
            if poller:
                poller.cancel()
            notifier.stop()
            bus.shutdown()
        await asyncio.sleep(1)


async def demo_source(state, obd=False):
    """A looping simulated drive: idle, pull through the gears, corner, brake."""
    state.source = "demo"
    if obd:
        asyncio.create_task(obd_poller(state, fake_ecu(state)))
    noise = {i: bytearray(random.getrandbits(8) for _ in range(8))
             for i in (0x002, 0x0D2, 0x0D3, 0x144, 0x156, 0x15A, 0x280, 0x281, 0x282, 0x361, 0x370, 0x372)}
    ratios = [3.454, 1.947, 1.296, 0.972, 0.738]   # approx 5-speed
    final, tyre_m = 4.111, 1.97                     # final drive, tyre circumference (m)
    speed = 0.0
    t0 = time.monotonic()
    last = t0
    while True:
        now = time.monotonic()
        dt, last = now - last, now
        t = (now - t0) % 45
        clutch = brake = 0
        steer = 0.0
        if t < 4:                                   # idle
            gear, thr, target = 0, 0, 0
            rpm = 720 + 25 * math.sin(now * 6)
            brake = 30
        elif t < 22:                                # pull through 1-4
            seg = t - 4
            gear = min(int(seg / 4.5) + 1, 4)
            p = (seg % 4.5) / 4.5
            thr = 0 if p > 0.93 else 90
            clutch = 1 if p > 0.93 else 0
            speed += (9.0 / gear) * dt * (0 if clutch else 1)
            rpm = speed / 3.6 / tyre_m * 60 * ratios[gear - 1] * final
            rpm = max(1200, min(rpm, 6600))
        elif t < 32:                                # sweeping corner in 4th
            gear, thr = 4, 35
            steer = 70 * math.sin((t - 22) / 10 * math.pi)
            rpm = speed / 3.6 / tyre_m * 60 * ratios[3] * final
        elif t < 40:                                # brake to stop
            gear = 3 if speed > 30 else 2 if speed > 12 else 0
            thr, brake = 0, 65
            clutch = 1 if gear == 0 else 0
            speed = max(0.0, speed - 22 * dt)
            rpm = max(750, speed / 3.6 / tyre_m * 60 * ratios[max(gear, 1) - 1] * final) if gear else 800
        else:                                       # stopped
            gear, thr, brake, speed, rpm = 0, 0, 30, 0, 760
        v = speed / 3.6
        lat = v * v / 90 * (steer / 70) / 9.81 if steer else 0.0
        yaw = math.degrees(v / 90) * (steer / 70) if steer else 0.0
        spin = 1.06 if (gear == 1 and thr > 50) else 1.0
        vals = {
            "rpm": rpm, "rpm_alt": rpm, "throttle": thr, "torque": thr * 1.8, "gear": gear,
            "cruise": 0, "mil": 0, "speed": speed, "brake_sw": 1 if brake else 0, "vdc_off": 0,
            "wheel_fl": speed * (1 + 0.004 * steer / 70), "wheel_fr": speed * (1 - 0.004 * steer / 70),
            "wheel_rl": speed * spin, "wheel_rr": speed * spin * 1.004,
            "steering": steer * 2.2, "brake": brake, "yaw_rate": yaw, "lat_g": lat,
            "reverse": 0, "ambient": 24, "high_beam": 0, "low_beam": 1, "handbrake": 1 if t > 41 else 0,
            "coolant": 89 + 2 * math.sin(now / 40), "clutch": clutch,
        }
        vals.update({"engine_load": 15 + thr * 0.8, "map_kpa": 30 + thr * 0.7, "intake_temp": 31,
                     "timing_adv": 28 - thr * 0.15, "maf": 2.5 + rpm / 6500 * thr * 0.9, "stft": 1.6 * math.sin(now),
                     "ltft": -2.3, "fuel_level": 62, "voltage": 14.1 + 0.1 * math.sin(now / 3), "baro": 101,
                     "oil_temp": 96})
        vals["gear"] = gear if gear else 7          # the car sends 7 for neutral
        state.sim = vals
        frames = {}
        for name, s in state.sigs.items():
            buf = frames.setdefault(s["_id"], bytearray(8))
            if name in vals:
                encode_into(s, vals[name], buf)
        for i, buf in frames.items():
            state.on_frame(i, buf, now)
        for i, buf in noise.items():
            if i in state.by_id:                    # the active profile decodes this ID: don't scramble it
                continue
            if random.random() < 0.2:
                buf[random.randrange(8)] = random.getrandbits(8)
            state.on_frame(i, buf, now)
        await asyncio.sleep(0.01)


# ---------------------------------------------------------------- web
async def rate_task(state):
    while True:
        await asyncio.sleep(1)
        state.roll_rates()


async def push_task(app):
    state = app["state"]
    n = 0
    meta_sent = 0
    while True:
        await asyncio.sleep(PUSH_INTERVAL)
        n += 1
        clients = app["clients"]
        if not clients:
            continue
        if state.meta_ver != meta_sent:
            meta_sent = state.meta_ver
            m = json.dumps({"meta": state.meta(), "vehicle": state.vehicle.get("id")})
            for ws in list(clients):
                try:
                    await ws.send_str(m)
                except Exception:
                    clients.pop(ws, None)
        lite = json.dumps(state.snapshot(False))
        full = json.dumps(state.snapshot(True)) if n % 5 == 0 else None   # bus table at 5 Hz
        for ws, wants_bus in list(clients.items()):
            try:
                await ws.send_str(full if (full and wants_bus) else lite)
            except Exception:
                clients.pop(ws, None)


async def ws_handler(request):
    ws = web.WebSocketResponse(heartbeat=10)
    await ws.prepare(request)
    app = request.app
    app["clients"][ws] = False
    await ws.send_str(json.dumps({"meta": app["state"].meta(), "vehicle": app["state"].vehicle.get("id")}))
    try:
        async for m in ws:
            if m.type == WSMsgType.TEXT:
                try:
                    msg = json.loads(m.data)
                    if "bus" in msg:
                        app["clients"][ws] = bool(msg["bus"])
                except ValueError:
                    pass
            elif m.type == WSMsgType.ERROR:
                break
    finally:
        app["clients"].pop(ws, None)
    return ws


SETTINGS_FILE = HERE / "settings.json"


async def log_api(request):
    st, act = request.app["state"], request.match_info["action"]
    lg = st.logger
    if act == "start":
        lg.start()
    elif act == "stop":
        lg.stop()
    elif act == "mark":
        body = await request.json() if request.can_read_body else {}
        if not lg.mark(body.get("label", "")):
            return web.json_response({"ok": False, "error": "not recording"}, status=409)
    elif act == "delete":
        body = await request.json()
        base = str(body.get("name", ""))
        if not re.fullmatch(r"can_\d{8}_\d{6}", base) or (lg.on and lg.name == base):
            return web.json_response({"ok": False}, status=400)
        for suffix in (".log.gz", ".markers.csv"):
            (LOG_DIR / f"{base}{suffix}").unlink(missing_ok=True)
    return web.json_response({"ok": True, "status": lg.status(), "logs": list_logs()})


async def log_list(request):
    return web.json_response({"status": request.app["state"].logger.status(), "logs": list_logs(),
                              "free": shutil.disk_usage(HERE).free})


async def log_download(request):
    """One zip per recording: the .log.gz plus its markers, ready to share."""
    base = request.match_info["name"]
    st = request.app["state"]
    if not re.fullmatch(r"can_\d{8}_\d{6}", base) or not (LOG_DIR / f"{base}.log.gz").exists():
        raise web.HTTPNotFound()
    if st.logger.on and st.logger.name == base:
        st.logger.f.flush()
        st.logger.mk.flush()
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_STORED) as z:
        z.write(LOG_DIR / f"{base}.log.gz", f"{base}.log.gz")
        mk = LOG_DIR / f"{base}.markers.csv"
        if mk.exists():
            z.write(mk, f"{base}.markers.csv")
        z.writestr("README.txt", "CAN bus log from the Impreza dash.\n"
                   f"{base}.log.gz: candump format '(unix_time) can0 ID#DATA', 500 kbit/s, one frame per line.\n"
                   f"{base}.markers.csv: what was being done at each moment (tapped during the recording).\n")
    return web.Response(body=buf.getvalue(), content_type="application/zip",
                        headers={"Content-Disposition": f'attachment; filename="{base}.zip"'})


async def client_report(request):
    """Each dash page (Pi screen, phone...) reports its GPU, fps and errors, so problems on the
    Pi's own screen can be seen from a phone and in the journal."""
    try:
        body = await request.json()
    except ValueError:
        return web.Response(status=400)
    cid = str(body.get("id", ""))[:12]
    clients = request.app["screens"]
    prev = clients.get(cid, {}).get("errors", [])
    errs = [str(e)[:300] for e in body.get("errors", [])][-10:]
    for e in errs:
        if e not in prev:
            print(f"[screen {cid} {'pi' if body.get('local') else request.remote}] {e}", flush=True)
    clients[cid] = {"id": cid, "ip": request.remote, "local": bool(body.get("local")),
                    "gpu": str(body.get("gpu", "?"))[:80], "fps": body.get("fps", 0),
                    "car3d": str(body.get("car3d", "?"))[:10], "errors": errs, "seen": time.time()}
    return web.json_response({"ok": True})


async def client_list(request):
    now = time.time()
    clients = request.app["screens"]
    for k in [k for k, c in clients.items() if now - c["seen"] > 30]:
        del clients[k]
    return web.json_response(sorted(clients.values(), key=lambda c: not c["local"]))


async def brightness_api(request):
    br = request.app["bright"]
    if request.method == "POST":
        body = await request.json()
        await br.set(body.get("pct", 100))
    return web.json_response({"method": br.method})


async def vehicles_api(request):
    app = request.app
    st = app["state"]
    if request.method == "POST":
        if app["vehicle_locked"]:
            return web.json_response({"ok": False, "error": "started with --signals; restart without it to switch"},
                                     status=409)
        body = await request.json()
        vid = str(body.get("id", ""))
        path = VEHICLES_DIR / f"{vid}.json"
        if not re.fullmatch(r"[A-Za-z0-9_\-]+", vid) or not path.is_file():
            return web.json_response({"ok": False, "error": "unknown vehicle"}, status=404)
        try:
            sigs, by_id, info = load_profile(path)
        except Exception as ex:
            return web.json_response({"ok": False, "error": f"{vid}.json: {ex}"}, status=400)
        info["id"] = vid
        st.set_profile(sigs, by_id, info)
        tmp = ACTIVE_FILE.with_suffix(".tmp")
        tmp.write_text(json.dumps({"active": vid}))
        os.replace(tmp, ACTIVE_FILE)
        print(f"Vehicle profile: {info['name']} ({len(sigs)} signals)", flush=True)
    rate = None if st.source == "demo" else await asyncio.to_thread(can_bitrate, app["channel"])
    return web.json_response({"active": st.vehicle.get("id"), "profile": st.vehicle, "list": list_vehicles(),
                              "locked": app["vehicle_locked"], "can_bitrate": rate,
                              "signals": sorted(st.sigs)},
                             headers={"Cache-Control": "no-cache"})


async def get_settings(request):
    try:
        data = json.loads(SETTINGS_FILE.read_text())
    except (OSError, ValueError):
        data = {}
    return web.json_response(data, headers={"Cache-Control": "no-cache"})


async def post_settings(request):
    try:
        data = await request.json()
        if not isinstance(data, dict):
            raise ValueError
    except ValueError:
        return web.Response(status=400, text="bad json")
    tmp = SETTINGS_FILE.with_suffix(".tmp")
    tmp.write_text(json.dumps(data, indent=1))
    os.replace(tmp, SETTINGS_FILE)          # atomic: safe if power is cut mid-write
    return web.json_response({"ok": True})


@web.middleware
async def no_cache(request, handler):
    """Always re-check files, so edits show up on a normal refresh."""
    resp = await handler(request)
    if request.path.startswith("/static/"):
        resp.headers["Cache-Control"] = "no-cache"
    return resp


async def index(request):
    html = (HERE / "static" / "index.html").read_text(encoding="utf-8")
    if request.app["cursor"]:
        # inline so it works even if the browser has an old style.css cached
        html = html.replace('<html lang="en">', '<html lang="en" class="showcursor">', 1)
        html = html.replace("</head>", "<style>html.showcursor, html.showcursor * { cursor: default !important; }"
                            " html.showcursor button, html.showcursor #c3d { cursor: pointer !important; }</style>\n</head>", 1)
    return web.Response(text=html, content_type="text/html", headers={"Cache-Control": "no-cache"})


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--demo", action="store_true", help="simulated drive, no CAN hardware")
    ap.add_argument("--channel", default="can0")
    ap.add_argument("--host", default="127.0.0.1")
    ap.add_argument("--port", type=int, default=8080)
    ap.add_argument("--vehicle", help="vehicle profile in vehicles/ (e.g. mazda_rx8); default: the one picked "
                                      "in Settings, else " + DEFAULT_VEHICLE)
    ap.add_argument("--signals", help="use this signal file instead of a vehicle profile (disables switching)")
    ap.add_argument("--cursor", action="store_true", help="show the mouse cursor (hidden by default for touch screens)")
    ap.add_argument("--obd", action="store_true",
                    help="poll standard OBD-II PIDs (TRANSMITS requests; can0 must NOT be listen-only)")
    args = ap.parse_args()

    if args.signals:
        path, vid = Path(args.signals), "custom"
    else:
        vid = args.vehicle or active_vehicle()
        path = VEHICLES_DIR / f"{vid}.json"
        if not path.is_file():
            ap.error(f"no vehicle profile {path} (have: {', '.join(v['id'] for v in list_vehicles())})")
    sigs, by_id, info = load_profile(path)
    info["id"] = vid
    app = web.Application(middlewares=[no_cache])
    app["state"] = BusState(sigs, by_id, info)
    app["vehicle_locked"] = bool(args.signals)
    app["channel"] = args.channel
    app["bright"] = Brightness()
    app["screens"] = {}
    app["clients"] = {}
    app["cursor"] = args.cursor
    app.router.add_get("/", index)
    app.router.add_get("/ws", ws_handler)
    app.router.add_get("/api/settings", get_settings)
    app.router.add_get("/api/vehicles", vehicles_api)
    app.router.add_post("/api/vehicle", vehicles_api)
    app.router.add_post("/api/settings", post_settings)
    app.router.add_post("/api/log/{action:start|stop|mark|delete}", log_api)
    app.router.add_get("/api/logs", log_list)
    app.router.add_get("/logs/{name}.zip", log_download)
    app.router.add_get("/api/brightness", brightness_api)
    app.router.add_post("/api/client", client_report)
    app.router.add_get("/api/clients", client_list)
    app.router.add_post("/api/brightness", brightness_api)
    app.router.add_static("/static", HERE / "static")

    async def start_bg(app):
        asyncio.create_task(app["bright"].probe_ddc())
        st = app["state"]
        if args.obd:
            st.obd["status"] = "starting"
        src = demo_source(st, args.obd) if args.demo else live_source(st, args.channel, args.obd)
        app["tasks"] = [asyncio.create_task(c) for c in (src, rate_task(st), push_task(app))]

    async def stop_bg(app):
        app["state"].logger.stop("server stopped")
        for t in app["tasks"]:
            t.cancel()

    app.on_startup.append(start_bg)
    app.on_cleanup.append(stop_bg)
    mode = ("demo" if args.demo else args.channel) + (", OBD polling" if args.obd else "")
    print(f"Dash on http://{args.host}:{args.port}  ({mode}) · vehicle: {info['name']} ({len(sigs)} signals)",
          flush=True)
    web.run_app(app, host=args.host, port=args.port, print=None)


if __name__ == "__main__":
    main()
