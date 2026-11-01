# Rebuilding the bundled car model

These scripts made `pi/static/models/impreza_high.bin.gz` and `impreza_low.bin.gz` from the
"subaru impreza 2012 sedan" OBJ (3ds Max export). Run them on a PC, not the Pi. Needs Python 3 + numpy.

```bash
pip install numpy
python parse.py  "path/to/impreza.obj"  work.npz     # read the OBJ (about 2 s)
python edges.py  work.npz  mesh.npz                  # weld vertices, build the edge table
python export_dash.py mesh.npz ../../static/models/impreza_high.bin.gz high
python export_dash.py mesh.npz ../../static/models/impreza_low.bin.gz  low
```

## What it does
- Keeps **feature edges** only: edges where the surface bends more than a set angle (30° on the body,
  80° on the tyres in HIGH), plus outlines between separate parts. Flat-panel triangles are dropped,
  so the wireframe shows the body lines, not the mesh.
- Drops the interior, brake discs, rotor bolts and hub backs, and the radiator core's lines.
- Builds a decimated solid copy of the car that the dash uses to hide far-side lines (SOLID style)
  and for the edge glow.
- Splits each wheel (tyre, rim, nuts, centre cap) into its own part so it spins, and the calipers
  so they steer but don't spin. The tail-light and headlight parts are split out so they can glow.
- Converts to the dash's frame: car faces +x, +z is the car's right, metres, tyres on y = 0,
  scaled to 4.58 m long.

The object names (`gum28`, `silver12`, `l_red` …) are specific to that model. For a different OBJ,
edit the patterns at the top of `export_dash.py`. Or use a .glb with `model.json` instead
(see `static/models/README.md`).

## File format
`u32 header length | JSON header | buffers`. Each part in the header has optional `lines` and `mesh`
entries: vertex positions are uint16, quantised to the part's `lo`/`hi` box; indices are uint32.
The whole file is gzipped.
