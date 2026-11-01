// Wireframe 3D car for the dash. Generic hatchback built from primitives (no external model).
import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';

const RED = new THREE.Color(0xff2d4a);
const WHEEL_R = 0.32;
const AXLE_F = 1.32, AXLE_R = -1.28, TRACK = 0.77;
const BODY_W = 1.74, CABIN_W = 1.40;

const MODES = {
  chase: { pos: new THREE.Vector3(-6.4, 2.3, 0.0),  look: new THREE.Vector3(1.2, 0.6, 0) },
  side:  { pos: new THREE.Vector3(0.2, 1.25, 7.0),  look: new THREE.Vector3(0, 0.62, 0) },
  top:   { pos: new THREE.Vector3(0.0, 9.5, 0.01),  look: new THREE.Vector3(0, 0, 0) },
  front: { pos: new THREE.Vector3(6.2, 1.6, 2.6),   look: new THREE.Vector3(0, 0.6, 0) },
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

    const r = this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
    r.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.5));
    r.setClearColor(0x000000, 0);

    const scene = this.scene = new THREE.Scene();
    scene.fog = new THREE.Fog(0x07080a, 9, 30);
    this.camera = new THREE.PerspectiveCamera(38, 1, 0.1, 100);
    this.camera.position.set(-5, 2.5, 4.5);
    this.lookAt = new THREE.Vector3(0, 0.6, 0);

    this.root = new THREE.Group();
    scene.add(this.root);
    this.body = new THREE.Group();
    this.root.add(this.body);

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

  _line(geo, opacity = 1, color = RED) {
    const m = new THREE.LineBasicMaterial({ color, transparent: true, opacity });
    this.lineMats.push(m);
    return new THREE.LineSegments(geo, m);
  }

  _fill(geo, opacity = 0.06) {
    return new THREE.Mesh(geo, new THREE.MeshBasicMaterial({
      color: RED, transparent: true, opacity, depthWrite: false, side: THREE.DoubleSide,
    }));
  }

  _buildBody() {
    const bodyGeo = extrude(bodyShape(), BODY_W);
    const cabGeo = extrude(cabinShape(), CABIN_W);
    this.body.add(this._fill(bodyGeo, 0.07), this._line(new THREE.EdgesGeometry(bodyGeo, 12)));
    this.body.add(this._fill(cabGeo, 0.035), this._line(new THREE.EdgesGeometry(cabGeo, 12)));

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
    this.body.add(this._line(g, 0.75));

    // mirrors
    for (const s of [1, -1]) {
      const mg = new THREE.BoxGeometry(0.16, 0.1, 0.16);
      const m = this._line(new THREE.EdgesGeometry(mg));
      m.position.set(0.9, 1.0, s * (BODY_W / 2 + 0.09));
      this.body.add(m);
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
      this.wheels[k] = { pivot, spin, anchor: new THREE.Vector3() };
    }
  }

  _buildLights() {
    const mk = (w, h, d, x, y, z) => {
      const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), new THREE.MeshBasicMaterial({ color: 0x330408 }));
      m.position.set(x, y, z);
      this.body.add(m);
      return m;
    };
    this.brakeL = [mk(0.04, 0.12, 0.34, -2.215, 0.80, 0.56), mk(0.04, 0.12, 0.34, -2.215, 0.80, -0.56)];
    this.headL = [mk(0.04, 0.09, 0.32, 2.19, 0.70, 0.58), mk(0.04, 0.09, 0.32, 2.19, 0.70, -0.58)];
    this.revL = [mk(0.04, 0.06, 0.12, -2.22, 0.62, 0.35), mk(0.04, 0.06, 0.12, -2.22, 0.62, -0.35)];
  }

  _buildGround() {
    const grid = this.grid = new THREE.GridHelper(60, 60, 0x5a0d18, 0x2a070c);
    grid.material.transparent = true;
    grid.material.opacity = 0.7;
    this.scene.add(grid);
    // contact shadow
    const sh = new THREE.Mesh(new THREE.PlaneGeometry(4.8, 2.1), new THREE.MeshBasicMaterial({
      color: 0xff2d4a, transparent: true, opacity: 0.05, depthWrite: false,
    }));
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
      color: RED, size: 0.045, transparent: true, opacity: 0.8, depthWrite: false,
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
      w.spin.rotation.z -= (ws / WHEEL_R) * dt * (s.reverse ? -1 : 1);
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
    for (const m of this.brakeL) m.material.color.setRGB(brakeOn ? 3.2 : 0.35, brakeOn ? 0.2 : 0.02, brakeOn ? 0.3 : 0.04);
    const hl = s.highBeam ? 3.0 : s.lowBeam ? 1.8 : 0.25;
    for (const m of this.headL) m.material.color.setRGB(hl, hl, hl * 0.95);
    for (const m of this.revL) m.material.color.setRGB(s.reverse ? 2.5 : 0.1, s.reverse ? 2.5 : 0.1, s.reverse ? 2.5 : 0.1);

    // ground + particles scroll past
    this.grid.position.x = -(this.dist % 1);
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
      pos = new THREE.Vector3(-5.6, 2.2, 2.6 - (s.latG || 0) * 2);
      look = new THREE.Vector3(0.8, 0.6, 0);
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
    if (this.hq) this.composer.render();
    else this.renderer.render(this.scene, this.camera);
  }
}
