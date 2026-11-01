"""Parse the OBJ into numpy arrays: vertices, triangle faces, per-face object id."""
import sys, numpy as np

src, out = sys.argv[1], sys.argv[2]
verts = []
tris = []
tri_obj = []
objs = []
cur = -1
with open(src, 'r', errors='ignore') as fh:
    for line in fh:
        if line.startswith('v '):
            p = line.split()
            verts.append((float(p[1]), float(p[2]), float(p[3])))
        elif line.startswith('f '):
            idx = [int(t.split('/')[0]) for t in line.split()[1:]]
            idx = [i - 1 if i > 0 else len(verts) + i for i in idx]
            for k in range(1, len(idx) - 1):
                tris.append((idx[0], idx[k], idx[k + 1]))
                tri_obj.append(cur)
        elif line.startswith('o '):
            objs.append(line[2:].strip())
            cur = len(objs) - 1
np.savez(out, v=np.array(verts, np.float32), f=np.array(tris, np.int32),
         fo=np.array(tri_obj, np.int16), names=np.array(objs))
print(len(verts), len(tris), len(objs))
