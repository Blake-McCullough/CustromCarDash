"""Weld mesh and build edge table: (v0,v1,f0,f1,obj) for every unique edge, plus face normals.
usage: edges.py work.npz out.npz"""
import sys, numpy as np

d = np.load(sys.argv[1]); out = sys.argv[2]
v, f, fo, names = d['v'], d['f'], d['fo'], d['names']
q = np.round(v / 2e-3).astype(np.int64)
_, inv = np.unique(q, axis=0, return_inverse=True); inv = inv.ravel()
vw = np.zeros((inv.max() + 1, 3)); np.add.at(vw, inv, v); vw /= np.bincount(inv)[:, None]
F = inv[f]
good = (F[:, 0] != F[:, 1]) & (F[:, 1] != F[:, 2]) & (F[:, 0] != F[:, 2])
F, fo = F[good], fo[good]
a, b, c = vw[F[:, 0]], vw[F[:, 1]], vw[F[:, 2]]
n = np.cross(b - a, c - a); ln = np.linalg.norm(n, axis=1); ok = ln > 1e-12; n[ok] /= ln[ok, None]
E = np.concatenate([F[:, [0, 1]], F[:, [1, 2]], F[:, [2, 0]]]); EF = np.tile(np.arange(len(F)), 3)
E.sort(axis=1); key = E[:, 0] * (len(vw) + 1) + E[:, 1]
o = np.argsort(key, kind='stable'); key, E, EF = key[o], E[o], EF[o]
uk, start, cnt = np.unique(key, return_index=True, return_counts=True)
f0 = EF[start]; f1 = np.where(cnt >= 2, EF[np.minimum(start + 1, len(EF) - 1)], -1)
f1[cnt > 2] = -1  # non-manifold: treat as boundary (always drawn)
np.savez(out, v=vw.astype(np.float32), F=F.astype(np.int32), n=n.astype(np.float32), fo=fo,
         e=E[start].astype(np.int32), f0=f0.astype(np.int32), f1=f1.astype(np.int32), names=names)
print('faces', len(F), 'edges', len(uk))
