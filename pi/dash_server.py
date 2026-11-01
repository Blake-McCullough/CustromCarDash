#!/usr/bin/env python3
"""
Impreza dash backend.

Reads CAN frames from can0 (Waveshare RS485 CAN HAT, listen-only), decodes the
signals in signals.json, and streams them to the dash page over a WebSocket.

  python3 dash_server.py            # live from can0
  python3 dash_server.py --demo     # simulated drive, no car needed
  python3 dash_server.py --cursor   # show the mouse pointer (add to either)
Open http://localhost:8080
"""
import argparse
import asyncio
import json
import math
import os
import random
import time
from pathlib import Path

from aiohttp import web, WSMsgType

HERE = Path(__file__).resolve().parent
LINK_TIMEOUT = 2.0      # s without frames = vehicle off
PUSH_INTERVAL = 0.04    # 25 Hz to the browser


# ---------------------------------------------------------------- signals
def load_signals(path):
    raw = json.loads(Path(path).read_text())
    sigs = {k: v for k, v in raw.items() if not k.startswith("_")}
    by_id = {}
    for name, s in sigs.items():
        s["_id"] = int(str(s["id"]), 0)
        if "mask" in s:
            s["_mask"] = int(str(s["mask"]), 0)
        by_id.setdefault(s["_id"], []).append((name, s))
    return sigs, by_id


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


# ---------------------------------------------------------------- state
class BusState:
    def __init__(self, sigs, by_id):
        self.sigs, self.by_id = sigs, by_id
        self.ids = {}
        self.values = {}
        self.window = 0
        self.fps = 0
        self.last_frame = 0.0
        self.source = "live"
        self.error = ""

    def on_frame(self, arb_id, data, now):
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
        for name, s in self.by_id.get(arb_id, ()):
            v = decode(s, data)
            if v is not None:
                self.values[name] = v

    def roll_rates(self):
        self.fps, self.window = self.window, 0
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
        }
        if with_bus:
            out["ids"] = [[f"{i:03X}" if i <= 0x7FF else f"{i:08X}",
                           e["data"].hex(" ").upper(), e["hz"],
                           [int((now - t) * 1000) if t else 99999 for t in e["changed"]]]
                          for i, e in sorted(self.ids.items())]
        return out

    def meta(self):
        return {k: {"unit": s.get("unit", ""), "verified": s.get("verified", False), "id": s["id"]}
                for k, s in self.sigs.items()}


# ---------------------------------------------------------------- sources
async def live_source(state, channel):
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
        try:
            async for msg in reader:
                if msg.is_error_frame or msg.is_remote_frame:
                    continue
                state.on_frame(msg.arbitration_id, msg.data, time.monotonic())
        except Exception as ex:
            state.error = f"{channel}: {ex}"
        finally:
            notifier.stop()
            bus.shutdown()
        await asyncio.sleep(1)


async def demo_source(state):
    """A looping simulated drive: idle, pull through the gears, corner, brake."""
    state.source = "demo"
    noise = {i: bytearray(random.getrandbits(8) for _ in range(8))
             for i in (0x0D0, 0x0D1, 0x0D4, 0x141, 0x144, 0x152, 0x360, 0x361, 0x501, 0x601, 0x630, 0x6D1)}
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
        frames = {}
        for name, s in state.sigs.items():
            buf = frames.setdefault(s["_id"], bytearray(8))
            if name in vals:
                encode_into(s, vals[name], buf)
        for i, buf in frames.items():
            state.on_frame(i, buf, now)
        for i, buf in noise.items():
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
    while True:
        await asyncio.sleep(PUSH_INTERVAL)
        n += 1
        clients = app["clients"]
        if not clients:
            continue
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
    await ws.send_str(json.dumps({"meta": app["state"].meta()}))
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
    ap.add_argument("--signals", default=str(HERE / "signals.json"))
    ap.add_argument("--cursor", action="store_true", help="show the mouse cursor (hidden by default for touch screens)")
    args = ap.parse_args()

    sigs, by_id = load_signals(args.signals)
    app = web.Application(middlewares=[no_cache])
    app["state"] = BusState(sigs, by_id)
    app["clients"] = {}
    app["cursor"] = args.cursor
    app.router.add_get("/", index)
    app.router.add_get("/ws", ws_handler)
    app.router.add_get("/api/settings", get_settings)
    app.router.add_post("/api/settings", post_settings)
    app.router.add_static("/static", HERE / "static")

    async def start_bg(app):
        st = app["state"]
        src = demo_source(st) if args.demo else live_source(st, args.channel)
        app["tasks"] = [asyncio.create_task(c) for c in (src, rate_task(st), push_task(app))]

    async def stop_bg(app):
        for t in app["tasks"]:
            t.cancel()

    app.on_startup.append(start_bg)
    app.on_cleanup.append(stop_bg)
    print(f"Dash on http://{args.host}:{args.port}  ({'demo' if args.demo else args.channel})", flush=True)
    web.run_app(app, host=args.host, port=args.port, print=None)


if __name__ == "__main__":
    main()
