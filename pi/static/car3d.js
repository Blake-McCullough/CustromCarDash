// Wireframe 3D car for the dash. Default car: the bundled Impreza sedan wireframe
// (static/models/impreza_<detail>.bin.gz). Fallbacks: a custom .glb (models/model.json)
// or the generic hatchback built from primitives.
import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';

const DEFAULT_ACCENT = 0xff2d4a;
const WHEEL_R = 0.32;
const AXLE_F = 1.32, AXLE_R = -1.28, TRACK = 0.77;
const BODY_W = 1.74, CABIN_W = 1.40;

const MODES = {
  chase: { pos: new THREE.Vector3(-6.4, 2.3, 0.0),  look: new THREE.Vector3(1.2, 0.6, 0) },
  side:  { pos: new THREE.Vector3(0.2, 1.25, 7.0),  look: new THREE.Vector3(0, 0.62, 0) },
  top:   { pos: new THREE.Vector3(0.0, 9.5, 0.01),  look: new THREE.Vector3(0, 0, 0) },
  front: { pos: new THREE.Vector3(6.2, 1.6, 2.6),   look: new THREE.Vector3(0, 0.6, 0) },
};

// Scene presets for the UI skins (Settings > SKIN). Each sets the floor/backdrop, fog, chase camera,
// bloom and how bright the tail lights sit. Colours that aren't the theme accent are fixed per skin.
export const SKINS = {
  wire: {
    env: 'grid', fog: [9, 30], bg: null,
    chase: { pos: [-5.6, 2.2, 2.6], look: [0.8, 0.6, 0], lean: 2 },
    bloom: [0.85, 0.45, 0.12], bloomWire: [0.45, 0.35, 0.2], tailRest: 0.55, particles: 1,
  },
  synth: {   // neon road at sunset, low chase camera, glossy car
    env: 'road', fog: [14, 75], bg: '#14042a',
    chase: { pos: [-6.4, 1.3, 0], look: [3.0, 0.8, 0], lean: 1.2 },
    bloom: [0.8, 0.3, 0.72], bloomWire: [0.55, 0.3, 0.72], tailRest: 1.6, particles: 0.6,
    magenta: '#ff2fd6', sunTop: '#ffd24a', sunBot: '#ff2f9a', sky: ['#05010d', '#2a0848', '#7a1a78'],
  },
  crt: {     // vector-display tunnel, everything in the theme colour
    env: 'tunnel', fog: [6, 46], bg: '#010302',
    chase: { pos: [-6.2, 2.6, 1.4], look: [1.5, 0.7, 0], lean: 1.5 },
    bloom: [0.6, 0.3, 0.2], bloomWire: [0.28, 0.2, 0.35], tailRest: 0.55, particles: 0,
  },
};

function bodyShape() {
  const s = new THREE.Shape();
  s.moveTo(-2.20, 0.38);
  s.lineTo(-2.23, 0.62);
  s.lineTo(-2.14, 0.90);
  s.lineTo(-1.95, 0.97);
  s.lineTo(1.05, 0.95);          // beltline / base of windscreen
  s.lineTo(1.95, 0.80);          // bonnet
  s.lineTo(2.18, 0.66);
  s.lineTo(2.24, 0.44);          // front bumper
  s.lineTo(2.12, 0.27);
  s.lineTo(AXLE_F + 0.42, 0.27);
  s.absarc(AXLE_F, 0.32, 0.42, 0, Math.PI, false);   // front wheel arch
  s.lineTo(AXLE_R + 0.42, 0.27);
  s.absarc(AXLE_R, 0.32, 0.42, 0, Math.PI, false);   // rear wheel arch
  s.lineTo(-2.10, 0.27);
  s.lineTo(-2.20, 0.38);
  return s;
}

function cabinShape() {
  const s = new THREE.Shape();
  s.moveTo(-1.98, 0.95);
  s.lineTo(-1.86, 1.30);         // hatch glass
  s.lineTo(-1.55, 1.46);
  s.lineTo(0.18, 1.48);          // roof
  s.lineTo(1.08, 0.97);          // windscreen
  s.lineTo(-1.98, 0.95);
  return s;
}

function extrude(shape, width) {
  const g = new THREE.ExtrudeGeometry(shape, { depth: width, bevelEnabled: false, curveSegments: 12 });
  g.translate(0, 0, -width / 2);
  return g;
}

export class Car3D {
  constructor(canvas) {
    this.canvas = canvas;
    this.mode = 'auto';
    this.orbitAz = 0.9;
    this.orbitEl = 0.32;
    this.dist = 0;
    this.hq = true;
    this.lineMats = [];
    this.fillMats = [];
    this.accent = new THREE.Color(DEFAULT_ACCENT);
    this.modelInfo = 'built-in';
    this.wheelR = WHEEL_R;
    this.wire = null;                       // bundled Impreza wireframe, once loaded
    this.wireOpts = { style: 'solid', glow: true, lights: true, wheels: true, glass: true };
    this.skinName = 'wire';
    this.skin = SKINS.wire;
    this.envs = {};                         // floor/backdrop groups, built the first time a skin needs them

    const r = this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
    r.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.5));
    r.setClearColor(0x000000, 0);

    const scene = this.scene = new THREE.Scene();
    scene.fog = new THREE.Fog(0x07080a, 9, 30);
    this.camera = new THREE.PerspectiveCamera(38, 1, 0.1, 220);
    this.camera.position.set(-5, 2.5, 4.5);
    this.lookAt = new THREE.Vector3(0, 0.6, 0);

    this.root = new THREE.Group();
    scene.add(this.root);
    this.body = new THREE.Group();
    this.root.add(this.body);
    this.builtin = new THREE.Group();       // procedural car, hidden if a model is loaded
    this.body.add(this.builtin);

    this._buildBody();
    this._buildWheels();
    this._buildLights();
    this._buildGround();
    this._buildParticles();

    this.composer = new EffectComposer(r, new THREE.WebGLRenderTarget(4, 4, { samples: 4, type: THREE.HalfFloatType }));
    this.composer.addPass(new RenderPass(scene, this.camera));
    this.bloom = new UnrealBloomPass(new THREE.Vector2(256, 256), 0.85, 0.45, 0.12);
    this.composer.addPass(this.bloom);
    this.composer.addPass(new OutputPass());

    this._bindDrag();
    this.resize();
  }

  _line(geo, opacity = 1) {
    const m = new THREE.LineBasicMaterial({ color: this.accent.clone(), transparent: true, opacity });
    this.lineMats.push(m);
    return new THREE.LineSegments(geo, m);
  }

  _fillMat(opacity = 0.06) {
    const m = new THREE.MeshBasicMaterial({ color: this.accent.clone(), transparent: true, opacity, depthWrite: false, side: THREE.DoubleSide });
    m.userData.base = opacity;
    this.fillMats.push(m);
    return m;
  }

  _fill(geo, opacity = 0.06) { return new THREE.Mesh(geo, this._fillMat(opacity)); }

  _buildBody() {
    const bodyGeo = extrude(bodyShape(), BODY_W);
    const cabGeo = extrude(cabinShape(), CABIN_W);
    this.builtin.add(this._fill(bodyGeo, 0.07), this._line(new THREE.EdgesGeometry(bodyGeo, 12)));
    this.builtin.add(this._fill(cabGeo, 0.035), this._line(new THREE.EdgesGeometry(cabGeo, 12)));

    // detail lines: door shuts, B-pillar, sills, bonnet line, grille
    const P = [];
    const seg = (a, b) => P.push(...a, ...b);
    for (const z of [BODY_W / 2 + 0.001, -BODY_W / 2 - 0.001]) {
      seg([0.62, 0.36, z], [0.62, 0.95, z]);       // front door shut
      seg([-0.42, 0.36, z], [-0.42, 0.95, z]);     // rear door shut
      seg([-1.30, 0.62, z], [-0.42, 0.62, z]);     // door crease
      seg([-0.42, 0.62, z], [0.62, 0.64, z]);
      seg([0.80, 0.30, z], [-0.80, 0.30, z]);      // sill
      seg([1.75, 0.82, z], [2.15, 0.70, z]);       // headlight top
    }
    for (const z of [CABIN_W / 2 + 0.001, -CABIN_W / 2 - 0.001]) {
      seg([-0.40, 0.96, z], [-0.32, 1.47, z]);     // B-pillar
      seg([-1.60, 0.98, z], [-1.45, 1.40, z]);     // C-pillar
    }
    for (let i = -3; i <= 3; i++) seg([2.23, 0.36, i * 0.1], [2.23, 0.56, i * 0.1]);   // grille
    seg([1.05, 0.95, 0.5], [1.95, 0.80, 0.4]);      // bonnet creases
    seg([1.05, 0.95, -0.5], [1.95, 0.80, -0.4]);
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(P, 3));
    this.builtin.add(this._line(g, 0.75));

    // mirrors
    for (const s of [1, -1]) {
      const mg = new THREE.BoxGeometry(0.16, 0.1, 0.16);
      const m = this._line(new THREE.EdgesGeometry(mg));
      m.position.set(0.9, 1.0, s * (BODY_W / 2 + 0.09));
      this.builtin.add(m);
    }
  }

  _buildWheels() {
    this.wheels = {};
    const tireGeo = new THREE.CylinderGeometry(WHEEL_R, WHEEL_R, 0.22, 26, 1, true);
    tireGeo.rotateX(Math.PI / 2);
    const tireEdges = new THREE.EdgesGeometry(tireGeo, 1);
    const rimGeo = new THREE.CircleGeometry(0.2, 20);
    const rimEdges = new THREE.EdgesGeometry(rimGeo);
    const spokes = [];
    for (let i = 0; i < 5; i++) {
      const a = (i / 5) * Math.PI * 2;
      spokes.push(0, 0, 0, Math.cos(a) * 0.2, Math.sin(a) * 0.2, 0);
    }
    const spokeGeo = new THREE.BufferGeometry();
    spokeGeo.setAttribute('position', new THREE.Float32BufferAttribute(spokes, 3));

    // car faces +x, so +z is the car's RIGHT side
    const place = { fl: [AXLE_F, -1], fr: [AXLE_F, 1], rl: [AXLE_R, -1], rr: [AXLE_R, 1] };
    for (const [k, [x, side]] of Object.entries(place)) {
      const pivot = new THREE.Group();
      pivot.position.set(x, WHEEL_R, side * TRACK);
      const spin = new THREE.Group();
      pivot.add(spin);
      spin.add(this._line(tireEdges, 0.85));
      spin.add(this._fill(tireGeo, 0.05));
      const face = new THREE.Group();
      face.position.z = side * 0.111;
      face.add(this._line(rimEdges, 0.9), this._line(spokeGeo, 0.9));
      spin.add(face);
      this.root.add(pivot);
      this.wheels[k] = { pivot, spin, anchor: new THREE.Vector3(), builtin: true };
    }
  }

  _buildLights() {
    this.lightGroup = new THREE.Group();
    this.body.add(this.lightGroup);
    const mk = (w, h, d, x, y, z) => {
      const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), new THREE.MeshBasicMaterial({ color: 0x330408 }));
      m.position.set(x, y, z);
      this.lightGroup.add(m);
      return m;
    };
    this.brakeL = [mk(0.04, 0.12, 0.34, -2.215, 0.80, 0.56), mk(0.04, 0.12, 0.34, -2.215, 0.80, -0.56)];
    this.headL = [mk(0.04, 0.09, 0.32, 2.19, 0.70, 0.58), mk(0.04, 0.09, 0.32, 2.19, 0.70, -0.58)];
    this.revL = [mk(0.04, 0.06, 0.12, -2.22, 0.62, 0.35), mk(0.04, 0.06, 0.12, -2.22, 0.62, -0.35)];
  }

  _buildGround() {
    this._makeGrid();
    this.envs.grid = this.grid;
    // contact shadow
    this.shadowMat = this._fillMat(0.05);
    const sh = new THREE.Mesh(new THREE.PlaneGeometry(4.8, 2.1), this.shadowMat);
    sh.rotation.x = -Math.PI / 2;
    sh.position.y = 0.003;
    this.root.add(sh);
  }

  _buildParticles() {
    const N = 260;
    const pos = new Float32Array(N * 3);
    for (let i = 0; i < N; i++) {
      pos[i * 3] = (Math.random() - 0.5) * 30;
      pos[i * 3 + 1] = Math.random() * 4;
      pos[i * 3 + 2] = (Math.random() - 0.5) * 16;
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    this.particles = new THREE.Points(g, new THREE.PointsMaterial({
      color: this.accent.clone(), size: 0.045, transparent: true, opacity: 0.8, depthWrite: false,
    }));
    this.scene.add(this.particles);
  }

  _bindDrag() {
    let down = null;
    this.canvas.addEventListener('pointerdown', e => { down = { x: e.clientX, y: e.clientY, az: this.orbitAz, el: this.orbitEl, moved: false }; });
    window.addEventListener('pointerup', () => { down = null; });
    this.canvas.addEventListener('pointermove', e => {
      if (!down) return;
      const dx = e.clientX - down.x, dy = e.clientY - down.y;
      if (!down.moved && Math.hypot(dx, dy) < 6) return;
      down.moved = true;
      if (this.mode !== 'orbit') { this.setMode('orbit'); this.onModeChange && this.onModeChange('orbit'); }
      this.orbitAz = down.az - dx * 0.01;
      this.orbitEl = Math.min(1.35, Math.max(0.05, down.el + dy * 0.006));
    });
  }

  _makeGrid() {
    if (this.grid) { this.scene.remove(this.grid); this.grid.geometry.dispose(); this.grid.material.dispose(); }
    const c1 = this.accent.clone().multiplyScalar(0.35), c2 = this.accent.clone().multiplyScalar(0.16);
    const grid = this.grid = new THREE.GridHelper(60, 60, c1, c2);
    grid.material.transparent = true;
    grid.material.opacity = 0.7;
    this.scene.add(grid);
  }

  // hex like '#ff2d4a'; bg is the page background (fog fades into it)
  setTheme(hex, bg = '#050608') {
    this.accent.set(hex);
    for (const m of this.lineMats) m.color.copy(this.accent);
    for (const m of this.fillMats) m.color.copy(this.accent);
    this.particles.material.color.copy(this.accent);
    if (this.wire) this.wire.occMat.uniforms.uColor.value.copy(this.accent);
    this.themeBg = bg;
    this.scene.fog.color.set(this.skin.bg || bg);
    const gridOn = this.grid ? this.grid.visible : true;
    this._makeGrid();
    this.envs.grid = this.grid;
    this.grid.visible = gridOn;
    for (const m of this.envAccentMats || []) m.color.copy(this.accent).multiplyScalar(m.userData.k || 1);
  }

  // ------------------------------------------------------------ skins: floor, backdrop, camera, bloom
  setSkin(name) {
    const sk = SKINS[name] || SKINS.wire;
    this.skinName = SKINS[name] ? name : 'wire';
    this.skin = sk;
    if (!this.envs[sk.env]) this.envs[sk.env] = sk.env === 'road' ? this._buildRoad(sk) : this._buildTunnel(sk);
    for (const [k, g] of Object.entries(this.envs)) g.visible = k === sk.env;
    this.scene.fog.near = sk.fog[0]; this.scene.fog.far = sk.fog[1];
    this.scene.fog.color.set(sk.bg || this.themeBg || '#050608');
    this.particles.material.opacity = 0.8 * sk.particles;
    this.particles.visible = this.particlesOn !== false && sk.particles > 0;
    this._applyBloom();
  }

  setParticles(on) { this.particlesOn = on; this.particles.visible = on && this.skin.particles > 0; }

  _applyBloom() {
    const [st, r, th] = this.wire ? this.skin.bloomWire : this.skin.bloom;
    this.bloom.strength = st; this.bloom.radius = r; this.bloom.threshold = th;
  }

  _accentMat(Mat, k = 1, extra = {}) {          // a material that follows the theme accent (k = brightness)
    const m = new Mat({ color: this.accent.clone().multiplyScalar(k), ...extra });
    m.userData.k = k;
    (this.envAccentMats = this.envAccentMats || []).push(m);
    return m;
  }

  // flat quads (y = 0) from [x0, x1, z0, z1] boxes, as one geometry
  static _quads(boxes, y = 0.004) {
    const pos = [], idx = [];
    boxes.forEach(([x0, x1, z0, z1], i) => {
      pos.push(x0, y, z0, x1, y, z0, x1, y, z1, x0, y, z1);
      const o = i * 4; idx.push(o, o + 2, o + 1, o, o + 3, o + 2);
    });
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.setIndex(idx);
    return g;
  }

  // Synthwave: three-lane road with glowing edges and rushing dashes, a magenta grid either side,
  // wireframe mountains and a striped sun on the horizon (+X, ahead of the car), under a gradient sky.
  _buildRoad(sk) {
    const env = new THREE.Group();
    const L0 = -40, L1 = 140, HALF = 3.5, LANE = 1.17;
    const magenta = new THREE.Color(sk.magenta);
    // tarmac
    const road = new THREE.Mesh(new THREE.PlaneGeometry(L1 - L0, HALF * 2),
      new THREE.MeshBasicMaterial({ color: 0x05020b }));
    road.rotation.x = -Math.PI / 2; road.position.set((L0 + L1) / 2, 0.001, 0);
    env.add(road);
    // edge lines (theme colour, over-bright so they bloom)
    env.add(new THREE.Mesh(Car3D._quads([[L0, L1, HALF - 0.12, HALF], [L0, L1, -HALF, -HALF + 0.12]]),
      this._accentMat(THREE.MeshBasicMaterial, 1.5)));
    // lane dashes: 3 m on, 3 m off, scrolled by update()
    const dashes = [];
    for (let x = L0; x < L1; x += 6) for (const z of [LANE, -LANE]) dashes.push([x, x + 3, z - 0.06, z + 0.06]);
    this.roadDash = new THREE.Mesh(Car3D._quads(dashes, 0.005), new THREE.MeshBasicMaterial({ color: new THREE.Color(0.95, 0.95, 1.05) }));
    env.add(this.roadDash);
    // magenta grid beside the road, scrolled by update()
    const gp = [];
    for (let z = HALF + 1.2; z <= 60; z += 2.5) for (const sz of [z, -z]) gp.push(L0, 0, sz, L1, 0, sz);
    for (let x = L0; x <= L1; x += 2.5) gp.push(x, 0, HALF + 1.2, x, 0, 60, x, 0, -HALF - 1.2, x, 0, -60);
    const gg = new THREE.BufferGeometry(); gg.setAttribute('position', new THREE.Float32BufferAttribute(gp, 3));
    this.roadGrid = new THREE.LineSegments(gg, new THREE.LineBasicMaterial({ color: magenta.clone().multiplyScalar(0.9), transparent: true, opacity: 0.55 }));
    env.add(this.roadGrid);
    // mountains: a jagged ridge across the horizon, dark fill + glowing outline
    const ridge = [], N = 46, MX = 92;
    let seed = 7; const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
    for (let i = 0; i <= N; i++) {
      const z = -150 + i * 300 / N, centre = Math.abs(z) < 26;     // keep a gap so the sun shows over the road
      ridge.push([z, centre ? 1 + rnd() * 2 : 5 + rnd() * 14]);
    }
    const mp = [], mi = [], lp = [];
    ridge.forEach(([z, h], i) => {
      mp.push(MX, -1, z, MX, h, z);
      if (i) { const o = (i - 1) * 2; mi.push(o, o + 2, o + 1, o + 1, o + 2, o + 3);
        const [pz, ph] = ridge[i - 1]; lp.push(MX - 0.1, ph, pz, MX - 0.1, h, z); }
      if (i % 2) lp.push(MX - 0.1, h, z, MX - 0.1, 0, z + (rnd() - 0.5) * 8);    // a few ridge struts
    });
    const mg = new THREE.BufferGeometry(); mg.setAttribute('position', new THREE.Float32BufferAttribute(mp, 3)); mg.setIndex(mi);
    env.add(new THREE.Mesh(mg, new THREE.MeshBasicMaterial({ color: 0x0a0216, fog: false, side: THREE.DoubleSide })));
    const lg = new THREE.BufferGeometry(); lg.setAttribute('position', new THREE.Float32BufferAttribute(lp, 3));
    env.add(new THREE.LineSegments(lg, new THREE.LineBasicMaterial({ color: magenta, fog: false, transparent: true, opacity: 0.8 })));
    // sun: gradient disc with the classic gaps cut into its lower half
    const sun = new THREE.Mesh(new THREE.PlaneGeometry(56, 56), new THREE.ShaderMaterial({
      uniforms: { uTop: { value: new THREE.Color(sk.sunTop) }, uBot: { value: new THREE.Color(sk.sunBot) } },
      vertexShader: 'varying vec2 vU; void main(){ vU = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }',
      fragmentShader: `uniform vec3 uTop; uniform vec3 uBot; varying vec2 vU;
        void main(){ vec2 c = vU - 0.5; float d = length(c);
          float disc = smoothstep(0.5, 0.48, d);
          float y = vU.y;                                     // 0 bottom .. 1 top
          float gap = y < 0.55 ? step(0.5 + 0.45 * (0.55 - y) / 0.55, fract(y * 14.0)) : 0.0;
          vec3 col = mix(uBot, uTop, smoothstep(0.1, 0.9, y)) * 0.72;   // under the bloom threshold, or it hazes the whole view
          float a = disc * (1.0 - gap) + smoothstep(0.58, 0.49, d) * 0.15;    // + soft halo
          if (a < 0.004) discard;                             // don't touch the sky outside the disc
          gl_FragColor = vec4(col, a); }`,
      transparent: true, depthWrite: false, fog: false,
    }));
    sun.rotation.y = -Math.PI / 2; sun.position.set(MX + 20, 9, 0); sun.renderOrder = -5;
    env.add(sun);
    // sky dome: dark at the top, magenta glow at the horizon
    const sky = new THREE.Mesh(new THREE.SphereGeometry(180, 32, 16), new THREE.ShaderMaterial({
      uniforms: { uA: { value: new THREE.Color(sk.sky[0]) }, uB: { value: new THREE.Color(sk.sky[1]) }, uC: { value: new THREE.Color(sk.sky[2]) } },
      vertexShader: 'varying vec3 vP; void main(){ vP = normalize(position); gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }',
      fragmentShader: `uniform vec3 uA; uniform vec3 uB; uniform vec3 uC; varying vec3 vP;
        void main(){ float h = vP.y; vec3 col = h > 0.0 ? mix(uB, uA, smoothstep(0.0, 0.45, h)) : uB * 0.6;
          col += uC * exp(-abs(h) * 22.0) * 0.9;              // bright line at the horizon
          gl_FragColor = vec4(col, 1.0); }`,
      side: THREE.BackSide, depthWrite: false, fog: false,
    }));
    sky.renderOrder = -10;
    env.add(sky);
    this.scene.add(env);
    return env;
  }

  // Retro CRT: a vector-graphics tunnel of rings rushing past, with road lines, all in the theme colour.
  _buildTunnel() {
    const env = new THREE.Group();
    const prof = [[-4, 0], [-4, 3.2], [-2.4, 5], [2.4, 5], [4, 3.2], [4, 0]];   // [z, y] cross-section
    const rp = [];
    for (let x = -24; x <= 90; x += 4) {
      for (let i = 1; i < prof.length; i++) rp.push(x, prof[i - 1][1], prof[i - 1][0], x, prof[i][1], prof[i][0]);
    }
    const rg = new THREE.BufferGeometry(); rg.setAttribute('position', new THREE.Float32BufferAttribute(rp, 3));
    this.tunnelRings = new THREE.LineSegments(rg, this._accentMat(THREE.LineBasicMaterial, 1.4, { transparent: true, opacity: 0.9 }));
    env.add(this.tunnelRings);
    const lp = [];
    for (const [z, y] of prof) lp.push(-24, y, z, 90, y, z);                        // long edges
    for (const z of [-1.4, 1.4]) lp.push(-24, 0.002, z, 90, 0.002, z);               // lane edges
    const lg = new THREE.BufferGeometry(); lg.setAttribute('position', new THREE.Float32BufferAttribute(lp, 3));
    env.add(new THREE.LineSegments(lg, this._accentMat(THREE.LineBasicMaterial, 0.8, { transparent: true, opacity: 0.7 })));
    const dashes = [];
    for (let x = -24; x < 90; x += 4) dashes.push([x, x + 1.6, -0.05, 0.05]);
    this.tunnelDash = new THREE.Mesh(Car3D._quads(dashes, 0.004), this._accentMat(THREE.MeshBasicMaterial, 2));
    env.add(this.tunnelDash);
    this.scene.add(env);
    return env;
  }

  // ------------------------------------------------------------ bundled Impreza wireframe
  // Built offline from a 3D model: feature edges (lines) + a decimated solid copy used as an
  // occluder, so lines on the far side are hidden ('solid' style) or shown ('xray').
  async loadImpreza(detail = 'high') {
    const url = `/static/models/impreza_${detail === 'low' ? 'low' : 'high'}.bin.gz`;
    let buf;
    try {
      const r = await fetch(url);
      if (!r.ok) throw new Error(r.status);
      let u8 = new Uint8Array(await r.arrayBuffer());
      if (u8[0] === 0x1f && u8[1] === 0x8b) {     // server sent it still gzipped
        const ds = new Blob([u8]).stream().pipeThrough(new DecompressionStream('gzip'));
        u8 = new Uint8Array(await new Response(ds).arrayBuffer());
      }
      buf = u8.buffer;
    } catch (e) {
      console.warn('Impreza model failed, using built-in car', e);
      this.modelInfo = 'impreza model missing: ' + url;
      return false;
    }
    this._disposeWire();

    const hlen = new DataView(buf).getUint32(0, true);
    const H = JSON.parse(new TextDecoder().decode(new Uint8Array(buf, 4, hlen)));
    const base = 4 + hlen;
    const geo = spec => {
      const q = new Uint16Array(buf, base + spec.pos, spec.nv * 3);
      const p = new Float32Array(q.length), lo = spec.lo, hi = spec.hi;
      for (let i = 0; i < q.length; i++) { const k = i % 3; p[i] = lo[k] + q[i] / 65535 * (hi[k] - lo[k]); }
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.BufferAttribute(p, 3));
      g.setIndex(new THREE.BufferAttribute(new Uint32Array(buf, base + spec.idx, spec.ni).slice(), 1));
      return g;
    };

    const W = this.wire = {
      group: new THREE.Group(), parts: {}, pivots: [], detail: H.detail, lines: 0,
      lineMat: this._wireLineMat(0.95), glassMat: this._wireLineMat(0.6),
      headMat: new THREE.LineBasicMaterial({ color: this.accent.clone(), transparent: true }),
      tailMat: new THREE.LineBasicMaterial({ color: new THREE.Color(0.55, 0.04, 0.07), transparent: true }),
      occMat: new THREE.ShaderMaterial({
        uniforms: { uColor: { value: this.accent.clone() }, uGlow: { value: 1 }, uBase: { value: 0 },
          uGloss: { value: 0 }, uBody: { value: new THREE.Color(0x0b0716) }, uSky: { value: new THREE.Color(0xff2fd6) } },
        vertexShader: `varying vec3 vN; varying vec3 vV;
          void main(){ vec4 mv = modelViewMatrix * vec4(position, 1.0);
            vN = normalize(normalMatrix * normal); vV = normalize(-mv.xyz); gl_Position = projectionMatrix * mv; }`,
        // uGloss = 1: opaque "car paint": dark body, fake sky reflection, a horizon highlight band and an
        // accent-coloured rim. Otherwise a see-through fresnel glow used by the wireframe looks.
        fragmentShader: `uniform vec3 uColor; uniform float uGlow; uniform float uBase; uniform float uGloss;
          uniform vec3 uBody; uniform vec3 uSky; varying vec3 vN; varying vec3 vV;
          void main(){ vec3 n = normalize(vN), v = normalize(vV);
            float f = pow(1.0 - abs(dot(n, v)), 3.0);
            if (uGloss > 0.5) {
              vec3 r = reflect(-v, n);
              float up = smoothstep(-0.2, 0.7, r.y);
              float band = smoothstep(0.09, 0.0, abs(r.y - 0.12));
              vec3 col = uBody * (0.6 + 0.8 * up) + uSky * (0.22 * up + 0.5 * band) + uColor * f * (0.7 + 0.8 * uGlow)
                       + vec3(1.0) * band * 0.18;
              gl_FragColor = vec4(col, 1.0);
            } else {
              gl_FragColor = vec4(uColor * (0.5 + f), uBase + f * 0.55 * uGlow);
            }}`,
        transparent: true, side: THREE.DoubleSide,
        polygonOffset: true, polygonOffsetFactor: 2, polygonOffsetUnits: 4,
      }),
    };
    this.body.add(W.group);

    const build = (part, parent, lineMat) => {
      const g = new THREE.Group();
      if (part.lines) {
        const ls = new THREE.LineSegments(geo(part.lines), lineMat);
        ls.renderOrder = 1; g.add(ls); W.lines += part.lines.ni / 2;
      }
      if (part.mesh) {
        const mg = geo(part.mesh); mg.computeVertexNormals();
        const m = new THREE.Mesh(mg, W.occMat);
        m.renderOrder = -1; g.add(m);                    // occluder draws before the lines
      }
      parent.add(g);
      W.parts[part.name] = g;
      return g;
    };

    this.wheelR = H.wheelRadius || WHEEL_R;
    const pivots = {};
    for (const k of ['fl', 'fr', 'rl', 'rr']) {
      const o = H.wheels[k];
      const pivot = new THREE.Group(); pivot.position.set(o[0], o[1], o[2]);
      const spin = new THREE.Group(); pivot.add(spin);
      this.root.add(pivot); W.pivots.push(pivot);
      pivots[k] = { pivot, spin };
    }
    for (const part of H.parts) {
      const [kind, k] = part.name.split('_');
      if (kind === 'wheel') build(part, pivots[k].spin, W.lineMat);
      else if (kind === 'caliper') build(part, pivots[k].pivot, W.lineMat);   // steers, doesn't spin
      else build(part, W.group, { glass: W.glassMat, head: W.headMat, tail: W.tailMat }[kind] || W.lineMat);
    }

    // swap the built-in car out
    for (const w of Object.values(this.wheels)) if (w.builtin) w.pivot.visible = false;
    for (const k of ['fl', 'fr', 'rl', 'rr']) this.wheels[k] = { ...pivots[k], anchor: new THREE.Vector3(), builtin: false };
    this.builtin.visible = false;
    this.lightGroup.visible = false;
    // far more lines than the built-in car: tone the bloom down so it glows instead of smearing
    this._applyBloom();
    this.setWireOptions(this.wireOpts);
    this.modelInfo = `Impreza sedan · ${H.detail} detail · ${Math.round(W.lines / 1000)}k lines`;
    return true;
  }

  _wireLineMat(opacity) {
    const m = new THREE.LineBasicMaterial({ color: this.accent.clone(), transparent: true, opacity });
    this.lineMats.push(m);
    return m;
  }

  _disposeWire() {
    const W = this.wire;
    if (!W) return;
    const kill = o => o.traverse(n => { if (n.geometry) n.geometry.dispose(); });
    kill(W.group); this.body.remove(W.group);
    for (const p of W.pivots) { kill(p); this.root.remove(p); }
    this.lineMats = this.lineMats.filter(m => m !== W.lineMat && m !== W.glassMat);
    for (const m of [W.lineMat, W.glassMat, W.headMat, W.tailMat, W.occMat]) m.dispose();
    this.wire = null;
  }

  // opts: { style: 'solid'|'xray'|'gloss', glow, lights, wheels, glass }
  setWireOptions(opts) {
    Object.assign(this.wireOpts, opts);
    const o = this.wireOpts, gloss = o.style === 'gloss';
    for (const m of this.fillMats) {                   // built-in car: a gloss body is a near-opaque fill
      if (m === this.shadowMat) continue;
      m.opacity = gloss ? Math.max(0.5, m.userData.base * 8) : m.userData.base;
    }
    const W = this.wire;
    if (!W) return;
    const solid = o.style !== 'xray';
    W.occMat.depthWrite = solid;                       // solid: body hides the lines behind it
    W.occMat.transparent = !gloss;
    W.occMat.uniforms.uGloss.value = gloss ? 1 : 0;
    W.occMat.uniforms.uBase.value = solid ? 0 : 0.035;  // x-ray: faint see-through fill
    W.occMat.uniforms.uGlow.value = o.glow ? (solid ? 1 : 0.6) : 0;
    W.occMat.needsUpdate = true;
    W.lineMat.opacity = gloss ? 0.45 : solid ? 0.95 : 0.6;   // gloss: panel lines are just accents
    W.glassMat.opacity = gloss ? 0.75 : solid ? 0.6 : 0.4;
    const show = (name, on) => { if (W.parts[name]) W.parts[name].visible = on; };
    show('glass', o.glass);
    for (const n of ['head', 'tail']) {             // keep the solid lamp shells so the body stays closed
      const g = W.parts[n]; if (g) for (const c of g.children) if (c.isLineSegments) c.visible = o.lights;
    }
    for (const p of W.pivots) p.visible = o.wheels;
  }

  // Optional real car model: static/models/model.json + a .glb file (see static/models/README.md)
  async loadModel() {
    let cfg;
    try {
      const r = await fetch('/static/models/model.json', { cache: 'no-cache' });
      if (!r.ok) return false;
      cfg = await r.json();
      if (!cfg.file || cfg.enabled === false) return false;
    } catch { return false; }

    let gltf;
    try { gltf = await new GLTFLoader().loadAsync('/static/models/' + cfg.file); }
    catch (e) { console.warn('model load failed, using built-in car', e); this.modelInfo = 'model failed: ' + cfg.file; return false; }

    const obj = gltf.scene;
    const holder = new THREE.Group();
    holder.add(obj);
    obj.rotation.y = THREE.MathUtils.degToRad(cfg.rotateY || 0);
    holder.updateMatrixWorld(true);

    // scale to real length, centre it, sit it on the ground
    let box = new THREE.Box3().setFromObject(holder);
    const size = box.getSize(new THREE.Vector3());
    const scale = (cfg.length || 4.42) / Math.max(size.x, size.z);
    holder.scale.setScalar(scale);
    holder.updateMatrixWorld(true);
    box = new THREE.Box3().setFromObject(holder);
    const c = box.getCenter(new THREE.Vector3());
    holder.position.set(-c.x + (cfg.offsetX || 0), -box.min.y + (cfg.offsetY || 0), -c.z);
    this.body.add(holder);
    holder.updateMatrixWorld(true);

    // turn every mesh into glowing edges + faint fill
    let tris = 0;
    const fill = this._fillMat(cfg.fillOpacity ?? 0.05);
    obj.traverse(n => {
      if (!n.isMesh) return;
      const g = n.geometry;
      tris += (g.index ? g.index.count : g.attributes.position.count) / 3;
      n.add(this._line(new THREE.EdgesGeometry(g, cfg.edgeAngle || 30), cfg.lineOpacity ?? 0.9));
      n.material = fill;
    });
    if (tris > 150000) console.warn(`model has ${Math.round(tris)} triangles: may be slow on a Pi`);

    // wheels: re-parent named wheel nodes onto pivots so they spin and steer
    const names = cfg.wheels || {};
    const found = {};
    for (const k of ['fl', 'fr', 'rl', 'rr']) if (names[k]) found[k] = obj.getObjectByName(names[k]);
    const haveWheels = ['fl', 'fr', 'rl', 'rr'].every(k => found[k]);
    this.root.updateMatrixWorld(true);
    if (haveWheels) {
      for (const k of ['fl', 'fr', 'rl', 'rr']) {
        const node = found[k];
        const wc = new THREE.Box3().setFromObject(node).getCenter(new THREE.Vector3());
        this.root.worldToLocal(wc);
        const pivot = new THREE.Group(); pivot.position.copy(wc);
        const spin = new THREE.Group(); pivot.add(spin);
        this.root.add(pivot);
        this.root.updateMatrixWorld(true);
        spin.attach(node);
        this.root.remove(this.wheels[k].pivot);
        this.wheels[k] = { pivot, spin, anchor: new THREE.Vector3(), builtin: false };
      }
    } else {
      // model wheels stay static; hide the built-in wheels so they don't double up
      for (const w of Object.values(this.wheels)) w.pivot.visible = !!cfg.keepBuiltinWheels;
    }

    this.builtin.visible = false;
    this.lightGroup.visible = !!cfg.keepBuiltinLights;
    this.modelInfo = `${cfg.file} · ${Math.round(tris / 1000)}k tris${haveWheels ? ' · animated wheels' : ''}`;
    return true;
  }

  setMode(m) { this.mode = m; this.lastInteract = performance.now(); }

  setQuality(hq) {
    this.hq = hq;
    this.renderer.setPixelRatio(hq ? Math.min(window.devicePixelRatio || 1, 1.5) : 1);
    this.resize();
  }

  resize() {
    const w = this.canvas.clientWidth || 1, h = this.canvas.clientHeight || 1;
    this.renderer.setSize(w, h, false);
    this.composer.setPixelRatio(this.renderer.getPixelRatio());
    this.composer.setSize(w, h);
    this.bloom.resolution.set(w / 2, h / 2);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }

  // s: { speed, wheels{fl,fr,rl,rr}, steerDeg (road wheel), latG, longG, brake, lowBeam, highBeam, reverse }
  update(s, dt, t) {
    const v = (s.speed || 0) / 3.6;
    this.dist += v * dt;

    // wheels
    for (const k of ['fl', 'fr', 'rl', 'rr']) {
      const w = this.wheels[k];
      const ws = (s.wheels && s.wheels[k] != null ? s.wheels[k] : s.speed || 0) / 3.6;
      w.spin.rotation.z -= (ws / this.wheelR) * dt * (s.reverse ? -1 : 1);
      if (k[0] === 'f') w.pivot.rotation.y = THREE.MathUtils.degToRad(s.steerDeg || 0);
    }

    // body dynamics: squat/dive and roll
    const k = 1 - Math.exp(-dt * 6);
    const pitch = THREE.MathUtils.clamp((s.longG || 0) * 0.07, -0.05, 0.05);
    const roll = THREE.MathUtils.clamp((s.latG || 0) * 0.06, -0.05, 0.05);
    this.body.rotation.z += (pitch - this.body.rotation.z) * k;
    this.body.rotation.x += (roll - this.body.rotation.x) * k;
    this.body.position.y += (Math.abs(s.longG || 0) * -0.01 - this.body.position.y) * k;

    // lights
    const brakeOn = (s.brake || 0) > 3 || s.brakeSw;
    const tr0 = this.skin.tailRest * 0.64;
    for (const m of this.brakeL) m.material.color.setRGB(brakeOn ? 3.2 : tr0, brakeOn ? 0.2 : tr0 * 0.06, brakeOn ? 0.3 : tr0 * 0.11);
    const hl = s.highBeam ? 3.0 : s.lowBeam ? 1.8 : 0.25;
    for (const m of this.headL) m.material.color.setRGB(hl, hl, hl * 0.95);
    for (const m of this.revL) m.material.color.setRGB(s.reverse ? 2.5 : 0.1, s.reverse ? 2.5 : 0.1, s.reverse ? 2.5 : 0.1);
    if (this.wire) {   // the model's own lamp lines: tail lights glow on brake, headlights with the beams
      const tr = this.skin.tailRest;              // some skins keep the tail lights lit, like at night
      this.wire.tailMat.color.setRGB(brakeOn ? 3.6 : tr, brakeOn ? 0.2 : tr * 0.07, brakeOn ? 0.3 : tr * 0.13);
      if (s.highBeam || s.lowBeam) this.wire.headMat.color.setRGB(hl, hl, hl * 0.95);
      else this.wire.headMat.color.copy(this.accent);
    }

    // ground + particles scroll past
    this.grid.position.x = -(this.dist % 1);
    if (this.roadDash) { this.roadDash.position.x = -(this.dist % 6); this.roadGrid.position.x = -(this.dist % 2.5); }
    if (this.tunnelRings) { this.tunnelRings.position.x = -(this.dist % 4); this.tunnelDash.position.x = -(this.dist % 4); }
    const p = this.particles.geometry.attributes.position;
    for (let i = 0; i < p.count; i++) {
      let x = p.getX(i) - v * dt - 0.05 * dt;
      if (x < -15) x += 30;
      p.setX(i, x);
      p.setY(i, p.getY(i) + Math.sin(t * 0.7 + i) * 0.0015);
    }
    p.needsUpdate = true;

    // camera
    let mode = this.mode;
    if (mode === 'auto') mode = (s.speed || 0) > 8 ? 'chase3q' : 'orbitAuto';
    if (mode === 'orbit' && performance.now() - (this.lastInteract || 0) > 4000) this.orbitAz += dt * 0.12;
    let pos, look;
    if (mode === 'orbitAuto' || mode === 'orbit') {
      if (mode === 'orbitAuto') this.orbitAz += dt * 0.18;
      const r = 7.0;
      pos = new THREE.Vector3(Math.cos(this.orbitAz) * Math.cos(this.orbitEl) * r,
        Math.sin(this.orbitEl) * r + 0.4, Math.sin(this.orbitAz) * Math.cos(this.orbitEl) * r);
      look = new THREE.Vector3(0, 0.6, 0);
    } else if (mode === 'chase3q') {
      const c = this.skin.chase;
      pos = new THREE.Vector3(c.pos[0], c.pos[1], c.pos[2] - (s.latG || 0) * c.lean);
      look = new THREE.Vector3(...c.look);
    } else {
      pos = MODES[mode].pos; look = MODES[mode].look;
    }
    // pull the camera back if the viewport is narrow, so the whole car fits
    const hHalf = Math.atan(Math.tan(THREE.MathUtils.degToRad(this.camera.fov / 2)) * this.camera.aspect);
    const fit = Math.max(1, (3.3 / Math.tan(hHalf)) / 7.0);
    pos = look.clone().add(pos.clone().sub(look).multiplyScalar(fit));
    const ck = 1 - Math.exp(-dt * (this.mode === 'orbit' ? 12 : 2.5));
    this.camera.position.lerp(pos, ck);
    this.lookAt.lerp(look, ck);
    // never let a camera transition pass through the car
    const off = this.camera.position.clone().sub(this.lookAt);
    const minD = this.mode === 'top' ? 3 : 5.2 * fit;
    if (off.length() < minD) this.camera.position.copy(this.lookAt).add(off.setLength(minD));
    this.camera.lookAt(this.lookAt);
  }

  // screen positions (px, relative to canvas) above each wheel, for HTML labels
  wheelScreen() {
    const out = {};
    const w = this.canvas.clientWidth, h = this.canvas.clientHeight;
    for (const [k, wh] of Object.entries(this.wheels)) {
      wh.pivot.getWorldPosition(wh.anchor);
      wh.anchor.y += 0.05;
      wh.anchor.z += (k[1] === 'l' ? -1 : 1) * 0.35;
      const v = wh.anchor.clone().project(this.camera);
      out[k] = { x: (v.x + 1) / 2 * w, y: (1 - v.y) / 2 * h, vis: v.z < 1 };
    }
    return out;
  }

  render() {
    const b = this.boost || 0;
    if (b > 0) {                                   // brightness boost from Settings
      const st = this.bloom.strength;
      this.bloom.strength = st * (1 + b * 0.9);
      this._renderInner();
      this.bloom.strength = st;
      return;
    }
    this._renderInner();
  }

  _renderInner() {
    if (this.hq) this.composer.render();
    else this.renderer.render(this.scene, this.camera);
  }
}
