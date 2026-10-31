#!/usr/bin/env python3
"""
Z34 dash backend.
Reads frames from can0 (or a built-in demo), decodes signals from signals.json,
and streams everything to the browser dash over a WebSocket.

  python3 dash_server.py            # live, reads can0
  python3 dash_server.py --demo     # fake data, no hardware needed
Then open http://localhost:8080
"""
import argparse
import asyncio
import json
import math
import random
import time
from pathlib import Path

from aiohttp import web, WSMsgType

HERE = Path(__file__).resolve().parent
LINK_TIMEOUT = 2.0  # seconds without frames = "vehicle powered off"


def load_signals(path):
    raw = json.loads(Path(path).read_text())
    sigs = {k: v for k, v in raw.items() if not k.startswith("_")}
    by_id = {}
    for name, s in sigs.items():
        s["_id"] = int(str(s["id"]), 0)
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
    if "mask" in s:
        raw &= int(str(s["mask"]), 0)
    return round(raw * s.get("scale", 1) + s.get("offset", 0), 2)


def encode_into(s, value, buf):
    """Inverse of decode, used only by demo mode."""
    raw = int(round((value - s.get("offset", 0)) / s.get("scale", 1)))
    if "shift" in s:
        raw <<= s["shift"]
    sb, n = s.get("start_byte", 0), s.get("length", 1)
    raw &= (1 << (8 * n)) - 1
    b = raw.to_bytes(n, "little" if s.get("endian") == "little" else "big")
    buf[sb:sb + n] = b


class BusState:
    def __init__(self, sigs, by_id):
        self.sigs, self.by_id = sigs, by_id
        self.ids = {}
        self.values = {}
        self.window = 0
        self.fps = 0
        self.last_frame = 0.0
        self.source = "live"

    def on_frame(self, arb_id, data, now):
        e = self.ids.get(arb_id)
        if e is None:
            e = self.ids[arb_id] = {"data": b"", "win": 0, "hz": 0.0, "changed": [0.0] * 8}
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
        self.fps = self.window
        self.window = 0
        for e in self.ids.values():
            e["hz"], e["win"] = e["win"], 0

    def snapshot(self):
        now = time.monotonic()
        return {
            "fps": self.fps,
            "source": self.source,
            "link": (now - self.last_frame) < LINK_TIMEOUT,
            "signals": self.values,
            "meta": {k: {"unit": s.get("unit", ""), "verified": s.get("verified", False),
                         "id": s["id"]} for k, s in self.sigs.items()},
            "ids": [[f"{i:03X}" if i <= 0x7FF else f"{i:08X}", e["data"].hex(" ").upper(),
                     e["hz"], [int((now - t) * 1000) if t else 99999 for t in e["changed"]]]
                    for i, e in sorted(self.ids.items())],
        }


async def live_source(state, channel):
    import can
    bus = can.Bus(channel=channel, interface="socketcan")
    reader = can.AsyncBufferedReader()
    notifier = can.Notifier(bus, [reader], loop=asyncio.get_running_loop())
    try:
        async for msg in reader:
            if msg.is_error_frame or msg.is_remote_frame:
                continue
            state.on_frame(msg.arbitration_id, msg.data, time.monotonic())
    finally:
        notifier.stop()
        bus.shutdown()


async def demo_source(state):
    state.source = "demo"
    noise = {i: bytearray(random.getrandbits(8) for _ in range(8))
             for i in (0x070, 0x0D0, 0x0D1, 0x0D4, 0x144, 0x152, 0x360, 0x361, 0x501, 0x513, 0x601, 0x630, 0x6D1)}
    t0 = time.monotonic()
    while True:
        t = time.monotonic() - t0
        cyc = t % 20
        clutch = brake = 0
        if cyc < 2:          # idle
            rpm, thr, gear, brake = 750 + 30 * math.sin(t * 7), 0, 0, 40
        elif cyc > 17:       # braking
            rpm, thr, gear, brake = 1800 - (cyc - 17) * 300, 0, 5, 70
        else:                # pull through the gears
            g = min(int((cyc - 2) / 3) + 1, 5)
            p = ((cyc - 2) % 3) / 3
            rpm, thr, gear = 2600 + p * 3800, 85 + 10 * math.sin(t * 3), g
            if p > 0.92:
                clutch, thr = 1, 0
        speed = 0 if gear == 0 else gear * 30 * (rpm / 6500) + 8
        vals = {"rpm": rpm, "rpm_alt": rpm, "throttle": thr, "speed": speed,
                "coolant": 88 + math.sin(t / 30) * 3, "gear": gear,
                "steering": 25 * math.sin(t / 2.5), "brake": brake, "clutch": clutch,
                "handbrake": 1 if cyc < 1 else 0, "ambient": 24}
        frames = {}
        for name, s in state.sigs.items():
            buf = frames.setdefault(s["_id"], bytearray(8))
            if name in vals:
                encode_into(s, vals[name], buf)
        now = time.monotonic()
        for i, buf in frames.items():
            state.on_frame(i, buf, now)
        for i, buf in noise.items():
            if random.random() < 0.3:
                buf[random.randrange(8)] = random.getrandbits(8)
            if random.random() < 0.5:
                state.on_frame(i, buf, now)
        await asyncio.sleep(0.01)


async def rate_task(state):
    while True:
        await asyncio.sleep(1)
        state.roll_rates()


async def push_task(app):
    state = app["state"]
    while True:
        await asyncio.sleep(0.05)
        if not app["clients"]:
            continue
        msg = json.dumps(state.snapshot())
        for ws in list(app["clients"]):
            try:
                await ws.send_str(msg)
            except Exception:
                app["clients"].discard(ws)


async def ws_handler(request):
    ws = web.WebSocketResponse(heartbeat=10)
    await ws.prepare(request)
    request.app["clients"].add(ws)
    try:
        async for m in ws:
            if m.type == WSMsgType.ERROR:
                break
    finally:
        request.app["clients"].discard(ws)
    return ws


async def index(request):
    return web.FileResponse(HERE / "static" / "index.html")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--demo", action="store_true", help="simulated data, no CAN hardware")
    ap.add_argument("--channel", default="can0")
    ap.add_argument("--port", type=int, default=8080)
    ap.add_argument("--signals", default=str(HERE / "signals.json"))
    args = ap.parse_args()

    sigs, by_id = load_signals(args.signals)
    app = web.Application()
    app["state"] = BusState(sigs, by_id)
    app["clients"] = set()
    app.router.add_get("/", index)
    app.router.add_get("/ws", ws_handler)
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
    print(f"Dash on http://localhost:{args.port}  ({'demo' if args.demo else args.channel})")
    web.run_app(app, port=args.port, print=None)


if __name__ == "__main__":
    main()
