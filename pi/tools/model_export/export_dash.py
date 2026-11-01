"""Export the Impreza wireframe for the Pi dash (static/models/impreza_<detail>.bin.gz).

Dash frame: car faces +x, +z = car's right, y up, metres, tyres on y=0.
File: u32 header_len | JSON header | pad4 | buffers.  Each part has optional
'lines' (uint16 xyz quantised to the part's lo/hi, uint32 index pairs) and
'mesh' (same, uint32 index triples) used as the hidden-line occluder.
usage: export_dash.py mesh.npz out.bin.gz high|low
"""
import sys, re, json, gzip, struct, numpy as np

d = np.load(sys.argv[1]); out = sys.argv[2]; detail = sys.argv[3]
v = d['v'].astype(np.float64); F = d['F']; fo = d['fo']; n = d['n']
e, f0, f1 = d['e'], d['f0'], d['f1']
names = [str(x) for x in d['names']]
NO = len(names)
rx = lambda pat: np.array([bool(re.fullmatch(pat, nm)) for nm in names])

# ---- object classes -------------------------------------------------------
INTERIOR = rx(r'int\d*|dash|stwheel|door')
HIDDEN_WHEEL = rx(r'silver(07|11|15|18)|chrome(13|15|17|19)|gum(25|29|31|34)')   # discs, rotor bolts, hub backs
TYRE = rx(r'gum(28|30|32|33)')
CALIPER = rx(r'silver(09|10|14|19)|gum26')
WHEELISH = rx(r'gum(2[5-9]|3[0-4])|silver(0[7-9]|1\d|2[01])?|chrome1[3-9]') | HIDDEN_WHEEL
HEAD = rx(r'gum0[1-3]|orange|o_glass')
TAIL = rx(r'red|d_red|l_red|glass01|o_glass01')
GLASS = rx(r'glass|d_glass\d*')

cen = v[F].mean(1)
silver = names.index('silver')
radiator = (fo == silver) & (cen[:, 0] < 5.5)

# ---- wheel centres from tyres (model: +z forward, -x = car's right) -------
wc = {}
for i in np.where(TYRE)[0]:
    p = v[np.unique(F[fo == i])]; c = (p.min(0) + p.max(0)) / 2
    k = ('f' if c[2] > 0 else 'r') + ('r' if c[0] < 0 else 'l')
    wc[k] = c
WK = ['fl', 'fr', 'rl', 'rr']
W = np.array([wc[k] for k in WK])

# ---- per-face part ---------------------------------------------------------
PARTS = ['body', 'glass', 'head', 'tail'] + [f'wheel_{k}' for k in WK] + [f'caliper_{k}' for k in WK]
P = np.full(len(F), 0, np.int16)          # body
P[GLASS[fo]] = 1; P[HEAD[fo]] = 2; P[TAIL[fo]] = 3
wf = WHEELISH[fo] & ~radiator
near = np.argmin(((cen[wf][:, None, :] - W[None]) ** 2).sum(-1), axis=1)
P[np.where(wf)[0]] = 4 + near
cal = CALIPER[fo]
P[cal] = 8 + np.argmin(((cen[cal][:, None, :] - W[None]) ** 2).sum(-1), axis=1)

face_drop_mesh = INTERIOR[fo] | HIDDEN_WHEEL[fo]           # radiator stays as occluder
face_drop_line = face_drop_mesh | radiator

# ---- edge selection ---------------------------------------------------------
if detail == 'high':
    ang = np.where(TYRE, 80, np.where(rx(r'chrome|l_red|red'), 40, 30)).astype(float)
    cluster = 0.08
else:
    ang = np.where(TYRE, 100, np.where(WHEELISH, 55, np.where(rx(r'chrome|l_red|red'), 55, 40))).astype(float)
    cluster = 0.16
dot = np.where(f1 >= 0, np.einsum('ij,ij->i', n[f0], n[np.maximum(f1, 0)]), -2.0)
eo = fo[f0]
diff = (f1 >= 0) & (fo[np.maximum(f1, 0)] != eo)
sel = ((dot < np.cos(np.radians(ang[eo]))) | diff) & ~face_drop_line[f0]
if detail == 'low':   # tyres: drop the object-boundary tread blocks too, keep only true creases/rims
    sel &= ~(TYRE[eo] & diff & (dot > np.cos(np.radians(60))))
epart = P[f0]

# ---- transform to dash frame -----------------------------------------------
keepv = np.unique(F[~face_drop_mesh])
lo_m, hi_m = v[keepv].min(0), v[keepv].max(0)
c_m = (lo_m + hi_m) / 2
LENGTH = 4.58                                    # GP Impreza sedan, metres
s = LENGTH / (hi_m[2] - lo_m[2])
def to_dash(p):
    q = np.stack([p[:, 2] - c_m[2], p[:, 1] - lo_m[1], -(p[:, 0] - c_m[0])], 1) * s
    return q

vd = to_dash(v)
Wd = to_dash(W)

def quant(pts):
    lo, hi = pts.min(0), pts.max(0); span = np.maximum(hi - lo, 1e-6)
    return np.round((pts - lo) / span * 65535).astype(np.uint16), lo, hi

blobs = []; header = {'version': 1, 'detail': detail, 'length': LENGTH, 'parts': [],
                      'wheels': {k: Wd[i].round(4).tolist() for i, k in enumerate(WK)},
                      'wheelRadius': round(float((v[np.unique(F[fo == np.where(TYRE)[0][0]])][:, 1].max() - v[np.unique(F[fo == np.where(TYRE)[0][0]])][:, 1].min()) / 2 * s), 4)}
offset = 0
def add(arr):
    global offset
    b = arr.tobytes(); pad = (-len(b)) % 4
    blobs.append(b + b'\0' * pad); o = offset; offset += len(b) + pad; return o

stats = {}
for pi, pname in enumerate(PARTS):
    part = {'name': pname}
    origin = np.zeros(3)
    if pname.startswith(('wheel_', 'caliper_')):
        origin = Wd[WK.index(pname.split('_')[1])]
        part['origin'] = origin.round(4).tolist()
    # lines
    E = e[sel & (epart == pi)]
    if len(E):
        uv, li = np.unique(E.ravel(), return_inverse=True)
        q, lo, hi = quant(vd[uv] - origin)
        part['lines'] = {'lo': lo.tolist(), 'hi': hi.tolist(), 'nv': len(uv), 'ni': li.size,
                         'pos': add(q), 'idx': add(li.astype(np.uint32))}
    # occluder mesh (vertex-cluster decimated, per part)
    Fm = F[(P == pi) & ~face_drop_mesh]
    if len(Fm):
        key = np.floor(v / cluster).astype(np.int64)
        used = np.unique(Fm)
        _, cl = np.unique(key[used], axis=0, return_inverse=True); cl = cl.ravel()
        remap = np.zeros(len(v), np.int64); remap[used] = cl
        cv = np.zeros((cl.max() + 1, 3)); np.add.at(cv, cl, vd[used]); cv /= np.bincount(cl)[:, None]
        Fc = remap[Fm]
        ok = (Fc[:, 0] != Fc[:, 1]) & (Fc[:, 1] != Fc[:, 2]) & (Fc[:, 0] != Fc[:, 2]); Fc = Fc[ok]
        _, ui = np.unique(np.sort(Fc, 1), axis=0, return_index=True); Fc = Fc[np.sort(ui)]
        u2, oi = np.unique(Fc.ravel(), return_inverse=True)
        q, lo, hi = quant(cv[u2] - origin)
        part['mesh'] = {'lo': lo.tolist(), 'hi': hi.tolist(), 'nv': len(u2), 'ni': oi.size,
                        'pos': add(q), 'idx': add(oi.astype(np.uint32))}
    header['parts'].append(part)
    stats[pname] = (part.get('lines', {}).get('ni', 0) // 2, part.get('mesh', {}).get('ni', 0) // 3)

hj = json.dumps(header).encode(); hj += b' ' * ((-len(hj)) % 4)
raw = struct.pack('<I', len(hj)) + hj + b''.join(blobs)
with gzip.open(out, 'wb', compresslevel=9) as fh:
    fh.write(raw)
import os
print(detail, 'raw', len(raw), 'gz', os.path.getsize(out), 'wheelR', header['wheelRadius'])
print(' total lines', sum(a for a, b in stats.values()), 'tris', sum(b for a, b in stats.values()))
for k, (a, b) in stats.items():
    print(f'  {k:12s} lines {a:6d}  tris {b:6d}')
print('wheels', header['wheels'])
