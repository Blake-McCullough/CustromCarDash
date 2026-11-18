#!/usr/bin/env python3
"""Generate the MFi 3.0 (MFI343S00177 XDFN-8) -> Raspberry Pi adapter board.

Coordinates in mm, board-local, origin top-left, +y down (KiCad convention).
J1 (2x3) plugs onto Pi header pins 1-6 (female socket soldered on the BOTTOM).
J2 (1x4) is an alternative wire header: 3V3, GND, SDA, SCL.

Chip land pattern from the Apple Auth 3.0 CP datasheet (Table 67-2):
  pitch 0.50, pad 0.30 x 0.90, row spacing C = 2.90 (pad centre to centre).
Pads here are lengthened 0.25 mm OUTWARD (inner edge unchanged) for hand soldering.
Exposed pad: datasheet allows NC or GND; we use a reduced GND pad (optional solder).
Pin map (top view): 1,4,7 GND | 2,3 NC (must stay unconnected) | 5 SDA | 6 SCL | 8 VCC
"""
import os
import pcbnew
from pcbnew import FromMM, VECTOR2I

OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "MFi-Pi-Adapter.kicad_pcb")
FPLIB = "/usr/share/kicad/footprints"

W, H = 16.0, 11.6  # board size

def P(x, y):
    return VECTOR2I(FromMM(x), FromMM(y))

board = pcbnew.BOARD()

# ---------------------------------------------------------------- rules
ds = board.GetDesignSettings()
ds.m_MinClearance = FromMM(0.15)
ds.m_TrackMinWidth = FromMM(0.15)
ds.m_ViasMinSize = FromMM(0.5)
ds.m_MinThroughDrill = FromMM(0.3)
ds.m_CopperEdgeClearance = FromMM(0.3)
ds.m_HoleToHoleMin = FromMM(0.25)
ds.m_HoleClearance = FromMM(0.25)
ds.m_SilkClearance = FromMM(0.1)
nc = ds.m_NetSettings.m_DefaultNetClass
nc.SetClearance(FromMM(0.15))
nc.SetTrackWidth(FromMM(0.25))
nc.SetViaDiameter(FromMM(0.6))
nc.SetViaDrill(FromMM(0.3))

# ---------------------------------------------------------------- nets
nets = {}
for name in ["GND", "+3V3", "SDA", "SCL"]:
    n = pcbnew.NETINFO_ITEM(board, name)
    board.Add(n)
    nets[name] = n

# ---------------------------------------------------------------- outline
def edge_line(a, b):
    s = pcbnew.PCB_SHAPE(board)
    s.SetShape(pcbnew.SHAPE_T_SEGMENT)
    s.SetStart(P(*a)); s.SetEnd(P(*b))
    s.SetLayer(pcbnew.Edge_Cuts); s.SetWidth(FromMM(0.1))
    board.Add(s)

pts = [(0, 0), (W, 0), (W, H), (0, H), (0, 0)]
for a, b in zip(pts, pts[1:]):
    edge_line(a, b)

# ---------------------------------------------------------------- footprints
def load(lib, name, ref, x, y, rot=0, value=None):
    fp = pcbnew.FootprintLoad(f"{FPLIB}/{lib}.pretty", name)
    fp.SetReference(ref)
    fp.SetValue(value or name)
    fp.SetPosition(P(x, y))
    if rot:
        fp.SetOrientationDegrees(rot)
    fp.Reference().SetVisible(False)
    fp.Value().SetVisible(False)
    if lib.startswith("Connector"):
        # drop library silk/courtyard: socket body is on the bottom, outlines clip the edge
        for g in fp.GraphicalItems():
            if g.GetLayer() in (pcbnew.F_SilkS, pcbnew.F_CrtYd, pcbnew.B_CrtYd):
                g.SetLayer(pcbnew.Cmts_User)   # keep for reference, not manufactured
    board.Add(fp)
    return fp

J1 = load("Connector_PinHeader_2.54mm", "PinHeader_2x03_P2.54mm_Vertical",
          "J1", 11.8, 2.6, value="Pi header pins 1-6 (2x3 female socket, BOTTOM side)")
J2 = load("Connector_PinHeader_2.54mm", "PinHeader_1x04_P2.54mm_Vertical",
          "J2", 1.6, 2.6, value="Wire header 3V3/GND/SDA/SCL")
C1 = load("Capacitor_SMD", "C_0805_2012Metric", "C1", 9.0, 2.6, value="100nF")
R1 = load("Resistor_SMD", "R_0805_2012Metric", "R1", 4.0, 2.8, rot=90, value="10k (optional)")
R2 = load("Resistor_SMD", "R_0805_2012Metric", "R2", 6.0, 2.8, rot=90, value="10k (optional)")

def setnet(fp, padnum, net):
    for pad in fp.Pads():
        if pad.GetNumber() == str(padnum):
            pad.SetNet(nets[net] if net else board.FindNet(""))

# J1: Pi pin numbering 1..6
setnet(J1, 1, "+3V3"); setnet(J1, 3, "SDA"); setnet(J1, 5, "SCL"); setnet(J1, 6, "GND")
# J1 pins 2,4 are Pi 5V -> deliberately unconnected
setnet(J2, 1, "+3V3"); setnet(J2, 2, "GND"); setnet(J2, 3, "SDA"); setnet(J2, 4, "SCL")
setnet(C1, 1, "+3V3"); setnet(C1, 2, "GND")

def pad_pos(fp, num):
    for pad in fp.Pads():
        if pad.GetNumber() == str(num):
            p = pad.GetPosition()
            return (pcbnew.ToMM(p.x), pcbnew.ToMM(p.y))

# resistors: top pad -> +3V3, bottom pad -> signal
for fp, sig in ((R1, "SDA"), (R2, "SCL")):
    pads = sorted(fp.Pads(), key=lambda p: p.GetPosition().y)
    pads[0].SetNet(nets["+3V3"]); pads[1].SetNet(nets[sig])

def rpad(fp, which):  # which: 'top' / 'bot'
    pads = sorted(fp.Pads(), key=lambda p: p.GetPosition().y)
    p = (pads[0] if which == "top" else pads[1]).GetPosition()
    return (pcbnew.ToMM(p.x), pcbnew.ToMM(p.y))

# ---------------------------------------------------------------- U1 custom footprint
UX, UY = 6.6, 5.6
U1 = pcbnew.FOOTPRINT(board)
U1.SetReference("U1"); U1.SetValue("MFI343S00177 (XDFN-8 2x3)")
U1.SetFPID(pcbnew.LIB_ID("MFi", "XDFN-8_2x3mm_P0.5mm_HandSolder"))
U1.SetPosition(P(UX, UY))
U1.SetAttributes(pcbnew.FP_SMD)   # so position exports include it
U1.Reference().SetVisible(False); U1.Value().SetVisible(False)
board.Add(U1)

PADL = 1.15          # lengthened pad (datasheet 0.90)
PADW = 0.30
XC = 1.45 + (PADL - 0.90) / 2   # centre shifted outward so inner edge stays at 1.00 mm
pinmap = {1: "GND", 2: None, 3: None, 4: "GND", 5: "SDA", 6: "SCL", 7: "GND", 8: "+3V3"}
ys = [-0.75, -0.25, 0.25, 0.75]
upads = {}
def add_smd(num, x, y, sx, sy, net):
    pad = pcbnew.PAD(U1)
    pad.SetNumber(str(num))
    pad.SetShape(pcbnew.PAD_SHAPE_ROUNDRECT)
    pad.SetRoundRectRadiusRatio(0.25)
    pad.SetAttribute(pcbnew.PAD_ATTRIB_SMD)
    pad.SetLayerSet(pad.SMDMask())
    pad.SetSize(P(sx, sy))
    pad.SetPos0(P(x, y))
    pad.SetPosition(P(UX + x, UY + y))
    if net:
        pad.SetNet(nets[net])
    U1.Add(pad)
    return pad

for i, y in enumerate(ys):           # left column, pins 1..4 top->bottom
    n = i + 1
    upads[n] = add_smd(n, -XC, y, PADL, PADW, pinmap[n])
for i, y in enumerate(ys):           # right column, pins 8..5 top->bottom
    n = 8 - i
    upads[n] = add_smd(n, +XC, y, PADL, PADW, pinmap[n])
# reduced exposed pad (datasheet EP 1.66 x 1.50); 1.2 x 1.1 keeps 0.4 mm to signal pads
ep = add_smd("EP", 0, 0, 1.2, 1.1, "GND")
ep.SetNumber("9")

def U(n):
    return (UX + (-XC if n <= 4 else XC), UY + ys[(n - 1) if n <= 4 else (8 - n)])

# fab outline of the 2x3 body
def fab_rect(fp, x0, y0, x1, y1, layer=pcbnew.F_Fab, w=0.1):
    for a, b in [((x0, y0), (x1, y0)), ((x1, y0), (x1, y1)), ((x1, y1), (x0, y1)), ((x0, y1), (x0, y0))]:
        s = pcbnew.FP_SHAPE(fp) if hasattr(pcbnew, "FP_SHAPE") else pcbnew.PCB_SHAPE(fp)
        s.SetShape(pcbnew.SHAPE_T_SEGMENT)
        s.SetStart(P(*a)); s.SetEnd(P(*b))
        if hasattr(s, "SetStart0"):
            s.SetStart0(P(a[0] - UX, a[1] - UY)); s.SetEnd0(P(b[0] - UX, b[1] - UY))
        s.SetLayer(layer); s.SetWidth(FromMM(w))
        fp.Add(s)
fab_rect(U1, UX - 1.5, UY - 1.0, UX + 1.5, UY + 1.0)

# ---------------------------------------------------------------- routing helpers
def track(points, net, w=0.25, layer=pcbnew.F_Cu):
    for a, b in zip(points, points[1:]):
        t = pcbnew.PCB_TRACK(board)
        t.SetStart(P(*a)); t.SetEnd(P(*b))
        t.SetWidth(FromMM(w)); t.SetLayer(layer); t.SetNet(nets[net])
        board.Add(t)

def via(x, y, net):
    v = pcbnew.PCB_VIA(board)
    v.SetPosition(P(x, y))
    v.SetDrill(FromMM(0.3)); v.SetWidth(FromMM(0.6))
    v.SetLayerPair(pcbnew.F_Cu, pcbnew.B_Cu)
    v.SetNet(nets[net])
    board.Add(v)

B = pcbnew.B_Cu
j1 = lambda n: pad_pos(J1, n)
j2 = lambda n: pad_pos(J2, n)
c1a, c1b = pad_pos(C1, 1), pad_pos(C1, 2)

# --- +3V3 rail along the top edge (0.3 mm)
RAIL_Y = 1.2
track([j2(1), (j2(1)[0], RAIL_Y), (j1(1)[0], RAIL_Y), j1(1)], "+3V3", 0.3)
track([(rpad(R1, "top")[0], RAIL_Y), rpad(R1, "top")], "+3V3", 0.3)
track([(rpad(R2, "top")[0], RAIL_Y), rpad(R2, "top")], "+3V3", 0.3)
track([(c1a[0], RAIL_Y), c1a], "+3V3", 0.3)
# VCC pin 8 straight up to C1 pad 1 (decoupling right at the pin)
p8 = U(8)
track([(c1a[0], p8[1]), c1a], "+3V3", 0.25)
track([p8, (c1a[0], p8[1])], "+3V3", 0.2)

# --- GND: pin 7 -> C1 pad 2, via to bottom pour; pins 1/4/7 tied to the exposed pad
p7 = U(7)
track([p7, (c1b[0], p7[1]), c1b], "GND", 0.25)
via(c1b[0], 4.0, "GND")
track([(p7[0], p7[1]), (UX + 0.5, p7[1])], "GND", 0.2)                 # pin7 -> EP
p1, p4 = U(1), U(4)
track([p1, (5.8, p1[1]), (6.1, p1[1] + 0.3)], "GND", 0.2)              # pin1 -> EP
track([p4, (5.8, p4[1]), (6.1, p4[1] - 0.3)], "GND", 0.2)              # pin4 -> EP

# --- SCL: pin 6 -> J1.5 on top, via at (10.2,7.0) -> bottom -> J2.4 and R2
p6 = U(6)
track([p6, (9.6, p6[1]), (10.2, p6[1] + 0.6), (10.2, 7.0), (j1(5)[0] - 0.52, j1(5)[1]), j1(5)], "SCL", 0.2)
via(10.2, 7.0, "SCL")
track([(10.2, 7.0), (10.2, 9.4), (2.6, 9.4), j2(4)], "SCL", 0.25, B)
via(6.4, 4.45, "SCL")
track([(6.4, 4.45), (6.4, 9.4)], "SCL", 0.25, B)
r2s = rpad(R2, "bot")
track([r2s, (6.4, r2s[1] + 0.4), (6.4, 4.45)], "SCL", 0.25)

# --- SDA: pin 5 down, then left on top to J2.3 and up to R1; via -> bottom -> J1.3
p5 = U(5)
SDA_Y = j2(3)[1]
track([p5, (p5[0], SDA_Y)], "SDA", 0.2)
track([(p5[0], SDA_Y), j2(3)], "SDA", 0.25)
track([(p5[0], SDA_Y), (8.9, SDA_Y)], "SDA", 0.25)
via(8.9, SDA_Y, "SDA")
track([(8.9, SDA_Y), (8.9, 6.4), j1(3)], "SDA", 0.25, B)
r1s = rpad(R1, "bot")
track([r1s, (3.4, r1s[1] + 0.6), (3.4, SDA_Y)], "SDA", 0.25)

# ---------------------------------------------------------------- GND pour (bottom)
def add_zone(layer, net, inset=0.0):
    z = pcbnew.ZONE(board)
    z.SetLayer(layer)
    z.SetNet(nets[net])
    z.SetLocalClearance(FromMM(0.25))
    z.SetMinThickness(FromMM(0.2))
    z.SetPadConnection(pcbnew.ZONE_CONNECTION_THERMAL)
    z.SetThermalReliefGap(FromMM(0.3))
    z.SetThermalReliefSpokeWidth(FromMM(0.3))
    ol = z.Outline()
    ol.NewOutline()
    for x, y in [(inset, inset), (W - inset, inset), (W - inset, H - inset), (inset, H - inset)]:
        ol.Append(FromMM(x), FromMM(y))
    board.Add(z)
    return z

add_zone(pcbnew.B_Cu, "GND")

# ---------------------------------------------------------------- silkscreen
def text(s, x, y, h=0.7, layer=pcbnew.F_SilkS, mirror=False, bold=False, rot=0):
    t = pcbnew.PCB_TEXT(board)
    t.SetText(s)
    t.SetPosition(P(x, y))
    t.SetTextSize(P(h, h))
    t.SetTextThickness(FromMM(h * 0.15))
    t.SetLayer(layer)
    t.SetHorizJustify(pcbnew.GR_TEXT_H_ALIGN_CENTER)
    if mirror:
        t.SetMirrored(True)
    if bold:
        t.SetBold(True)
    if rot:
        t.SetTextAngleDegrees(rot)
    board.Add(t)

def circle(x, y, r, layer=pcbnew.F_SilkS, w=0.15, fill=True):
    s = pcbnew.PCB_SHAPE(board)
    s.SetShape(pcbnew.SHAPE_T_CIRCLE)
    s.SetCenter(P(x, y)); s.SetEnd(P(x + r, y))
    s.SetLayer(layer); s.SetWidth(FromMM(w))
    if fill:
        s.SetFilled(True)
    board.Add(s)

circle(4.05, 4.85, 0.15)                    # U1 pin-1 dot (left of pad 1)
text("J1 SQ PAD=PI PIN1", 9.3, 9.65, 0.8)
text("5V ROW->PI EDGE", 9.3, 10.8, 0.8)
# bottom-side labels for J2 (readable from the bottom)
for i, lab in enumerate(["3V3", "GND", "SDA", "SCL"]):
    text(lab, 3.75, 2.6 + 2.54 * i, 0.8, pcbnew.B_SilkS, mirror=True)
text("SOCKET HERE", 11.2, 10.4, 0.8, pcbnew.B_SilkS, mirror=True)

board.Save(OUT)

# fill zones after save/reload so connectivity is built
b2 = pcbnew.LoadBoard(OUT)
pcbnew.ZONE_FILLER(b2).Fill(b2.Zones())
b2.Save(OUT)
print("saved", OUT)
