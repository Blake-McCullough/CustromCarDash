import { Car3D } from './car3d.js';

// ---------------------------------------------------------------- config
const CFG = {
  rpmMax: 7000,      // top of the rpm bar
  redline: 6500,     // FB20 redline
  shiftAt: 6000,     // shift lights flash from here
  steerRatio: 15,    // steering wheel deg -> road wheel deg
  slipPct: 8,        // wheel speed % difference flagged as slip
};

const $ = id => document.getElementById(id);
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

// Settings are saved on the Pi (settings.json via the backend), because the kiosk browser
// starts with a fresh profile every boot.
let SETTINGS = {};
try { SETTINGS = await (await fetch('/api/settings', { cache: 'no-store' })).json(); } catch { /* backend not up: defaults */ }
let saveTimer;
const store = {
  get(k, d) { return k in SETTINGS ? SETTINGS[k] : d; },
  set(k, v) {
    SETTINGS[k] = v;
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => fetch('/api/settings', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(SETTINGS),
    }).catch(() => {}), 300);
  },
};
CFG.redline = store.get('redline', CFG.redline);
CFG.shiftAt = store.get('shiftAt', CFG.shiftAt);

// ---------------------------------------------------------------- state
let meta = {};
let V = {};                         // latest decoded values
let link = false, everLinked = false, source = '', lastMsg = 0, busOn = false;
const D = {};                       // display-smoothed values
let longG = 0, lastSpeed = null, lastSpeedT = 0;
let gPeak = 0;
const gTrail = [];
const hist = [];                    // graph samples [t, rpm, speed, thr, brk, steer]

const trip = { dist: 0, moveTime: 0, start: null, top: 0, lastT: null, lostAt: '' };
const zt = { state: 'idle', t0: 0, run: null, best: store.get('zt_best', null) };

// ---------------------------------------------------------------- UI setup
let AUTO_FX = store.get('autofx', true) && !new URLSearchParams(location.search).has('keepfx');
if (new URLSearchParams(location.search).has('cursor')) document.documentElement.classList.add('showcursor');   // ?cursor shows the mouse   // ?keepfx disables auto quality drop
const SEGS = 35;
const segEls = [];
for (let i = 0; i < SEGS; i++) { const s = document.createElement('i'); $('segs').appendChild(s); segEls.push(s); }
function buildSegs() {
  CFG.rpmMax = Math.max(7000, CFG.redline + 500);
  for (let i = 0; i < SEGS; i++) {
    const r = (i / SEGS) * CFG.rpmMax;
    segEls[i].dataset.cls = r >= CFG.redline - 250 ? 'on r' : r >= CFG.shiftAt - 1500 ? 'on w' : 'on';
  }
}
buildSegs();

document.addEventListener('contextmenu', e => e.preventDefault());

const views = { drive: $('v-drive'), graphs: $('v-graphs'), bus: $('v-bus'), settings: $('v-settings') };
let view = 'drive';
document.querySelectorAll('nav [data-view]').forEach(b => b.onclick = () => {
  view = b.dataset.view;
  document.querySelectorAll('nav [data-view]').forEach(x => x.classList.toggle('on', x === b));
  for (const [k, el] of Object.entries(views)) el.classList.toggle('on', k === view);
  setBus(view === 'bus');
  if (view === 'drive') requestAnimationFrame(() => car.resize());
  if (view === 'settings') renderSettings();
});

const car = new Car3D($('c3d'));
const camNames = { auto: 'AUTO', orbit: 'ORBIT', chase: 'CHASE', side: 'SIDE', front: 'FRONT', top: 'TOP' };
function selectCam(m) {
  document.querySelectorAll('.cams button').forEach(x => x.classList.toggle('on', x.dataset.cam === m));
  $('camname').textContent = camNames[m];
  store.set('cam', m);
}
document.querySelectorAll('.cams button').forEach(b => b.onclick = () => { car.setMode(b.dataset.cam); selectCam(b.dataset.cam); });
car.onModeChange = selectCam;
const savedCam = store.get('cam', 'auto');
car.setMode(savedCam); selectCam(savedCam);

// ---------------------------------------------------------------- themes
const THEMES = {
  red:    { name: 'RED',     acc: '#ff2d4a', tint: '#12070a' },
  wrb:    { name: 'WR BLUE', acc: '#2f7bff', tint: '#060b1c' },
  ice:    { name: 'ICE',     acc: '#2ee6ff', tint: '#05121a' },
  matrix: { name: 'MATRIX',  acc: '#39ff7a', tint: '#06140a' },
  gold:   { name: 'GOLD',    acc: '#e8b33a', tint: '#151005' },
  neon:   { name: 'NEON',    acc: '#b14dff', tint: '#10061a' },
  pink:   { name: 'SYNTH',   acc: '#ff3fb4', tint: '#170612' },
  mono:   { name: 'MONO',    acc: '#e8ecf2', tint: '#0d0e10' },
};
let theme = store.get('theme', 'red');
if (!THEMES[theme]) theme = 'red';
const hexA = (hex, a) => { const n = parseInt(hex.slice(1), 16); return `rgba(${n >> 16},${(n >> 8) & 255},${n & 255},${a})`; };
function applyTheme(key) {
  theme = key; store.set('theme', key);
  const t = THEMES[key], st = document.documentElement.style;
  st.setProperty('--acc', t.acc); st.setProperty('--accglow', hexA(t.acc, 0.55)); st.setProperty('--tint', t.tint);
  car.setTheme(t.acc);
  LANES[0].color = t.acc;
  document.querySelectorAll('#tgrid button').forEach(b => b.classList.toggle('on', b.dataset.t === key));
}
for (const [k, t] of Object.entries(THEMES)) {
  const b = document.createElement('button');
  b.dataset.t = k;
  b.innerHTML = `<i style="background:${t.acc};box-shadow:0 0 14px ${t.acc}"></i>${t.name}`;
  b.onclick = () => applyTheme(k);
  $('tgrid').appendChild(b);
}

let hq = store.get('fx', true);
function applyFx(save) { car.setQuality(hq); if (save) store.set('fx', hq); renderSettings(); }

// ---------------------------------------------------------------- car model
// carModel: 'impreza' (bundled wireframe) | 'custom' (models/model.json + .glb) | 'basic' (built-in shape)
const CAR = {
  model: store.get('carModel', 'impreza'),
  detail: store.get('carDetail', 'high'),
  style: store.get('carStyle', 'solid'),
  glow: store.get('carGlow', true),
  lights: store.get('carLights', true),
  wheels: store.get('carWheels', true),
  glass: store.get('carGlass', true),
};
let hasCustom = false;
fetch('/static/models/model.json', { method: 'HEAD', cache: 'no-store' })
  .then(r => { hasCustom = r.ok; renderSettings(); }).catch(() => {});
const wireOpts = () => ({ style: CAR.style, glow: CAR.glow, lights: CAR.lights, wheels: CAR.wheels, glass: CAR.glass });
car.setWireOptions(wireOpts());
let carBusy = false;
async function loadCar() {
  carBusy = true;
  let ok = false;
  if (CAR.model === 'impreza') ok = await car.loadImpreza(CAR.detail);
  else if (CAR.model === 'custom') ok = await car.loadModel();
  if (ok) applyTheme(theme);
  carBusy = false;
  renderSettings();
}
function setCar(k, v) {
  if (CAR[k] === v) return;
  CAR[k] = v;
  store.set('car' + k[0].toUpperCase() + k.slice(1), v);
  if (k === 'model') {
    // switching between model types is cleanest as a fresh page: save now, then reload
    clearTimeout(saveTimer);
    fetch('/api/settings', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(SETTINGS) })
      .finally(() => location.reload());
    return;
  }
  if (k === 'detail') { if (CAR.model === 'impreza') loadCar(); }
  else car.setWireOptions(wireOpts());
  renderSettings();
}

// ---------------------------------------------------------------- settings page
function seg(id, val, onPick) {
  const el = $(id);
  el.querySelectorAll('button').forEach(b => {
    b.classList.toggle('on', b.dataset.v === (val ? '1' : '0'));
    b.onclick = () => onPick(b.dataset.v === '1');
  });
}
function pick(id, val, onPick) {          // like seg(), for named values
  $(id).querySelectorAll('button').forEach(b => {
    b.classList.toggle('on', b.dataset.v === val);
    b.onclick = () => onPick(b.dataset.v);
  });
}
function renderSettings() {
  seg('o-fx', hq, v => { hq = v; applyFx(true); });
  seg('o-autofx', AUTO_FX, v => { AUTO_FX = v; store.set('autofx', v); renderSettings(); });
  const parts = store.get('particles', true);
  car.particles.visible = parts;
  seg('o-particles', parts, v => { store.set('particles', v); renderSettings(); });
  // car
  pick('o-model', CAR.model, v => setCar('model', v));
  $('o-model').querySelector('[data-v="custom"]').style.display = hasCustom || CAR.model === 'custom' ? '' : 'none';
  pick('o-style', CAR.style, v => setCar('style', v));
  pick('o-detail', CAR.detail, v => setCar('detail', v));
  seg('o-glow', CAR.glow, v => setCar('glow', v));
  for (const k of ['lights', 'wheels', 'glass']) {     // on/off toggles on one row
    const b = $('o-' + k); b.classList.toggle('on', CAR[k]); b.onclick = () => setCar(k, !CAR[k]);
  }
  document.querySelectorAll('.caronly').forEach(el => el.classList.toggle('na', CAR.model !== 'impreza'));
  $('o-detail').classList.toggle('busy', carBusy);
  document.querySelectorAll('.step').forEach(st => { st.querySelector('b').textContent = CFG[st.dataset.k].toLocaleString(); });
  renderSysinfo();
}
document.querySelectorAll('.step').forEach(st => {
  const [minus, , plus] = st.children;
  const bump = d => {
    const k = st.dataset.k, step = +st.dataset.step;
    CFG[k] = clamp(CFG[k] + d * step, +st.dataset.min, +st.dataset.max);
    if (CFG.shiftAt > CFG.redline) { if (k === 'shiftAt') CFG.redline = CFG.shiftAt; else CFG.shiftAt = CFG.redline; }
    store.set('redline', CFG.redline); store.set('shiftAt', CFG.shiftAt);
    buildSegs(); LANES[0].max = CFG.rpmMax; renderSettings();
  };
  minus.onclick = () => bump(-1);
  plus.onclick = () => bump(1);
});
const flashDone = b => { b.classList.add('done'); setTimeout(() => b.classList.remove('done'), 900); };
$('r-trip').onclick = e => { Object.assign(trip, { dist: 0, moveTime: 0, start: null, top: 0, lastT: null }); flashDone(e.currentTarget); };
$('r-zt').onclick = e => { zt.best = null; zt.run = null; store.set('zt_best', null); flashDone(e.currentTarget); };
$('r-g').onclick = e => { gPeak = 0; flashDone(e.currentTarget); };
$('r-all').onclick = () => {
  SETTINGS = {};
  fetch('/api/settings', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })
    .finally(() => location.reload());
};
function renderSysinfo() {
  if (view !== 'settings') return;
  const n = Object.values(meta).filter(m => !m.verified).length;
  const rows = [
    ['Data source', !link ? 'no CAN link' : source === 'demo' ? 'demo (simulated)' : 'live CAN (can0)'],
    ['CAN frames/s', $('fps').textContent],
    ['Signals', `${Object.keys(meta).length} defined · ${n} unverified`],
    ['Car model', car.modelInfo],
    ['Screen', `${window.innerWidth} × ${window.innerHeight}`],
    ['Render', `${$('gfps').textContent} fps · effects ${hq ? 'high' : 'low'}`],
  ];
  $('sysinfo').innerHTML = rows.map(([k, v]) => `<span>${k}</span><b>${v}</b>`).join('');
}
setInterval(renderSysinfo, 1000);
applyFx(false);


window.addEventListener('resize', () => { car.resize(); });
setInterval(() => { $('clock').textContent = new Date().toTimeString().slice(0, 5); }, 1000);

// ---------------------------------------------------------------- websocket
let ws;
function connect() {
  ws = new WebSocket(`ws://${location.host}/ws`);
  ws.onopen = () => setBus(view === 'bus');
  ws.onmessage = e => onMsg(JSON.parse(e.data));
  ws.onclose = () => setTimeout(connect, 1000);
}
function setBus(on) { busOn = on; try { ws && ws.readyState === 1 && ws.send(JSON.stringify({ bus: on })); } catch { /* reconnecting */ } }
connect();

function onMsg(m) {
  if (m.meta) { meta = m.meta; applyMeta(); return; }
  const now = performance.now();
  lastMsg = now;
  V = m.v || {};
  source = m.source;
  $('fps').textContent = m.fps.toLocaleString();
  $('nids').textContent = m.nids;

  const wasLinked = link;
  link = !!m.link;
  if (link) everLinked = true;
  if (wasLinked && !link) trip.lostAt = new Date().toTimeString().slice(0, 5);

  const src = $('src');
  src.className = 'pill ' + (!link ? 'off' : source === 'demo' ? 'demo' : 'live');
  src.textContent = !link ? (m.error ? 'CAN ERROR' : 'NO CAN') : source === 'demo' ? 'DEMO' : 'LIVE CAN';

  // longitudinal g from speed change
  const spd = V.speed;
  if (spd != null) {
    if (lastSpeed != null) {
      const dt = (now - lastSpeedT) / 1000;
      if (dt > 0.02) {
        const a = ((spd - lastSpeed) / 3.6) / dt / 9.81;
        longG += (clamp(a, -1.5, 1.5) - longG) * 0.25;
        lastSpeed = spd; lastSpeedT = now;
      }
    } else { lastSpeed = spd; lastSpeedT = now; }
  }

  // trip
  if (link && spd != null) {
    if (trip.start === null) trip.start = now;
    if (trip.lastT !== null) {
      const dt = (now - trip.lastT) / 1000;
      if (dt < 1) { trip.dist += spd / 3.6 * dt / 1000; if (spd > 1) trip.moveTime += dt; }
    }
    trip.lastT = now;
    trip.top = Math.max(trip.top, spd);
  } else trip.lastT = null;

  // 0-100 timer
  if (spd != null) {
    if (zt.state === 'idle' && spd < 0.5) zt.state = 'armed';
    else if (zt.state === 'armed' && spd > 0.8) { zt.state = 'run'; zt.t0 = now; }
    else if (zt.state === 'run') {
      zt.run = (now - zt.t0) / 1000;
      if (spd >= 100) {
        zt.state = 'idle';
        if (zt.best === null || zt.run < zt.best) { zt.best = zt.run; store.set('zt_best', zt.best); }
      } else if (spd < 0.5 || zt.run > 30) { zt.state = 'armed'; zt.run = null; }
    }
  }

  hist.push([now, rpmOf(V), spd ?? 0, V.throttle ?? 0, V.brake ?? 0, V.steering ?? 0]);
  while (hist.length && now - hist[0][0] > 31000) hist.shift();

  if (m.ids && view === 'bus') renderBus(m.ids);
}

function rpmOf(v) { return v.rpm ?? v.rpm_alt ?? 0; }

function applyMeta() {
  let n = 0;
  document.querySelectorAll('[data-sig]').forEach(el => {
    const mm = meta[el.dataset.sig];
    el.classList.toggle('unv', !!mm && !mm.verified);
  });
  for (const mm of Object.values(meta)) if (!mm.verified) n++;
  $('unv').textContent = n ? `${n} UNVERIFIED SIGNALS (?)` : '';
}

// ---------------------------------------------------------------- render
const setText = (id, s) => { const el = $(id); if (el.textContent !== s) el.textContent = s; };
const setW = (id, f) => { $(id).style.width = (clamp(f, 0, 1) * 100).toFixed(1) + '%'; };
function smooth(k, target, dt, rate = 10) {
  if (target == null) return D[k] = undefined;
  if (D[k] == null || !isFinite(D[k])) D[k] = target;
  D[k] += (target - D[k]) * (1 - Math.exp(-dt * rate));
  return D[k];
}
function fmtTime(s) { s = Math.floor(s); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`; }

function renderDash(dt) {
  const rpm = smooth('rpm', rpmOf(V), dt, 14);
  const spd = smooth('spd', V.speed ?? 0, dt, 8);
  const thr = smooth('thr', V.throttle ?? 0, dt, 14);
  const brk = smooth('brk', V.brake ?? 0, dt, 14);
  const str = smooth('str', V.steering ?? 0, dt, 10);
  const trq = smooth('trq', V.torque ?? 0, dt, 10);
  const lat = smooth('lat', V.lat_g ?? 0, dt, 8);
  const lng = smooth('lng', longG, dt, 6);

  setText('speed', Math.round(spd).toString());
  setText('rpm', Math.round(rpm).toLocaleString());
  const g = $('gear');
  const gtxt = V.reverse ? 'R' : V.gear == null ? '–' : V.gear === 0 ? 'N' : String(V.gear);
  setText('gear', gtxt);
  g.classList.toggle('rev', gtxt === 'R');

  const lit = Math.round(rpm / CFG.rpmMax * SEGS);
  for (let i = 0; i < SEGS; i++) { const c = i < lit ? segEls[i].dataset.cls : ''; if (segEls[i].className !== c) segEls[i].className = c; }
  $('segs').classList.toggle('flash', rpm >= CFG.shiftAt);

  setText('thr', Math.round(thr) + '%'); setW('b-thr', thr / 100);
  setText('brk', Math.round(brk) + '%'); setW('b-brk', brk / 100);
  setText('trq', Math.round(trq).toString()); setW('b-trq', trq / 250);
  setText('str', Math.abs(Math.round(str)) + '°' + (str > 2 ? 'L' : str < -2 ? 'R' : ''));
  const sf = clamp(Math.abs(str) / 540, 0, 1) * 50, sb = $('b-str');
  sb.style.width = sf + '%'; sb.style.left = str >= 0 ? (50 - sf) + '%' : '50%';

  setText('cool', V.coolant == null ? '--' : Math.round(V.coolant).toString());
  $('cool').classList.toggle('hot', (V.coolant ?? 0) > 105);
  setText('amb', V.ambient == null ? '--' : Math.round(V.ambient).toString());
  setText('yaw', (V.yaw_rate ?? 0).toFixed(1));

  const chip = (id, on) => $(id).classList.toggle('on', !!on);
  chip('c-low', V.low_beam); chip('c-high', V.high_beam); chip('c-hand', V.handbrake);
  chip('c-clutch', V.clutch); chip('c-cruise', V.cruise); chip('c-vdc', V.vdc_off); chip('c-mil', V.mil);

  // trip + 0-100
  setText('t-dist', trip.dist.toFixed(1));
  setText('t-time', fmtTime(trip.start ? (performance.now() - trip.start) / 1000 : 0));
  setText('t-top', Math.round(trip.top).toString());
  setText('t-avg', trip.moveTime > 5 ? Math.round(trip.dist / (trip.moveTime / 3600)).toString() : '0');
  const zs = $('z-state');
  zs.textContent = zt.state === 'armed' ? 'ARMED' : zt.state === 'run' ? 'TIMING' : 'READY';
  zs.className = 'dim ' + (zt.state === 'armed' ? 'armed' : zt.state === 'run' ? 'run' : '');
  setText('z-run', zt.run != null ? zt.run.toFixed(2) + 's' : '--');
  setText('z-best', zt.best != null ? zt.best.toFixed(2) + 's' : '--');

  // 3D
  const wheels = { fl: V.wheel_fl, fr: V.wheel_fr, rl: V.wheel_rl, rr: V.wheel_rr };
  car.update({
    speed: spd, wheels, steerDeg: clamp(str / CFG.steerRatio, -38, 38), latG: lat, longG: lng,
    brake: brk, brakeSw: V.brake_sw, lowBeam: V.low_beam, highBeam: V.high_beam, reverse: V.reverse,
  }, dt, performance.now() / 1000);
  car.render();

  // wheel labels
  const pos = car.wheelScreen();
  const ref = Math.max(V.speed ?? 0, 1);
  for (const k of ['fl', 'fr', 'rl', 'rr']) {
    const el = $('wl-' + k), p = pos[k], w = wheels[k];
    el.style.left = p.x + 'px'; el.style.top = p.y + 'px';
    el.style.opacity = p.vis ? 1 : 0;
    el.lastChild.textContent = w == null ? '--' : Math.round(w).toString();
    el.classList.toggle('slip', w != null && (V.speed ?? 0) > 5 && Math.abs(w - ref) / ref * 100 > CFG.slipPct);
  }

  drawG(lat, lng);
}

// ---------------------------------------------------------------- G meter
const gc = $('gmeter'), gx = gc.getContext('2d');
function drawG(lat, lng) {
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const w = gc.clientWidth * dpr, h = gc.clientHeight * dpr;
  if (gc.width !== w || gc.height !== h) { gc.width = w; gc.height = h; }
  const cx = w / 2, cy = h / 2, R = Math.min(w, h) / 2 - 6 * dpr, max = 1.2;
  gx.clearRect(0, 0, w, h);
  gx.strokeStyle = '#1f232a'; gx.lineWidth = dpr;
  for (const r of [0.4, 0.8, 1.2]) { gx.beginPath(); gx.arc(cx, cy, R * r / max, 0, Math.PI * 2); gx.stroke(); }
  gx.beginPath(); gx.moveTo(cx - R, cy); gx.lineTo(cx + R, cy); gx.moveTo(cx, cy - R); gx.lineTo(cx, cy + R); gx.stroke();
  gx.fillStyle = '#4a4f58'; gx.font = `${10 * dpr}px ui-monospace, monospace`;
  gx.fillText('0.4', cx + 3 * dpr, cy - R * 0.4 / max - 2 * dpr); gx.fillText('0.8', cx + 3 * dpr, cy - R * 0.8 / max - 2 * dpr);
  // dot: right = turning right (lat positive to the left -> dot left), up = accelerating
  const px = cx - clamp(lat, -max, max) / max * R, py = cy - clamp(lng, -max, max) / max * R;
  const now = performance.now();
  gTrail.push([px, py, now]);
  while (gTrail.length && now - gTrail[0][2] > 1500) gTrail.shift();
  const acc = THEMES[theme].acc;
  gx.lineWidth = 2 * dpr; gx.strokeStyle = hexA(acc, 0.35); gx.beginPath();
  gTrail.forEach(([x, y], i) => i ? gx.lineTo(x, y) : gx.moveTo(x, y)); gx.stroke();
  gx.shadowColor = hexA(acc, 0.9); gx.shadowBlur = 14 * dpr;
  gx.fillStyle = acc; gx.beginPath(); gx.arc(px, py, 6 * dpr, 0, Math.PI * 2); gx.fill(); gx.shadowBlur = 0;
  const tot = Math.hypot(lat, lng);
  gPeak = Math.max(gPeak, tot);
  setText('glat', Math.abs(lat).toFixed(2)); setText('glong', lng.toFixed(2)); setText('gpeak', gPeak.toFixed(2));
}

// ---------------------------------------------------------------- graphs
const grc = $('graphs'), grx = grc.getContext('2d');
const LANES = [
  { name: 'RPM', idx: 1, min: 0, max: CFG.rpmMax, color: '#ff2d4a' },
  { name: 'SPEED km/h', idx: 2, min: 0, max: 160, color: '#eef0f4' },
  { name: 'THROTTLE / BRAKE %', idx: 3, idx2: 4, min: 0, max: 100, color: '#3ddc84', color2: '#ff2d4a' },
  { name: 'STEER °', idx: 5, min: -540, max: 540, color: '#ffb020' },
];
function drawGraphs() {
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const w = grc.clientWidth * dpr, h = grc.clientHeight * dpr;
  if (grc.width !== w || grc.height !== h) { grc.width = w; grc.height = h; }
  grx.clearRect(0, 0, w, h);
  const now = performance.now(), span = 30000, lh = h / LANES.length;
  grx.font = `${11 * dpr}px ui-monospace, monospace`;
  LANES.forEach((L, li) => {
    const y0 = li * lh + 6 * dpr, y1 = (li + 1) * lh - 6 * dpr;
    grx.strokeStyle = '#1a1d22'; grx.lineWidth = dpr; grx.strokeRect(0.5, y0, w - 1, y1 - y0);
    grx.fillStyle = '#6a707b'; grx.fillText(L.name, 8 * dpr, y0 + 14 * dpr);
    const Y = v => y1 - (clamp(v, L.min, L.max) - L.min) / (L.max - L.min) * (y1 - y0);
    if (L.min < 0) { grx.strokeStyle = '#22262c'; grx.beginPath(); grx.moveTo(0, Y(0)); grx.lineTo(w, Y(0)); grx.stroke(); }
    const plot = (idx, color) => {
      grx.strokeStyle = color; grx.lineWidth = 2 * dpr; grx.beginPath();
      hist.forEach((s, i) => { const x = w - (now - s[0]) / span * w; i ? grx.lineTo(x, Y(s[idx])) : grx.moveTo(x, Y(s[idx])); });
      grx.stroke();
    };
    plot(L.idx, L.color);
    if (L.idx2) plot(L.idx2, L.color2);
    const last = hist.length ? hist[hist.length - 1][L.idx] : 0;
    grx.fillStyle = L.color; grx.textAlign = 'right'; grx.font = `bold ${16 * dpr}px ui-monospace, monospace`;
    grx.fillText(Math.round(last).toLocaleString(), w - 10 * dpr, y0 + 20 * dpr);
    grx.textAlign = 'left'; grx.font = `${11 * dpr}px ui-monospace, monospace`;
  });
}

// ---------------------------------------------------------------- bus table
function renderBus(ids) {
  const byId = {};
  for (const [k, mm] of Object.entries(meta)) {
    const id = parseInt(mm.id).toString(16).toUpperCase().padStart(3, '0');
    (byId[id] = byId[id] || []).push(k);
  }
  let html = '';
  for (const [id, data, hz, ages] of ids) {
    const bytes = data.split(' ').map((b, i) => {
      const a = ages[i]; const c = a < 250 ? 'hot' : a < 1500 ? 'warm' : '';
      return `<span class="byte ${c}">${b}</span>`;
    }).join('');
    html += `<tr><td class="id">${id}</td><td class="hz">${hz}</td><td>${bytes}</td><td class="sig">${(byId[id] || []).join(', ')}</td></tr>`;
  }
  $('busrows').innerHTML = html;
}

// ---------------------------------------------------------------- power-off overlay
function renderOff() {
  const stale = performance.now() - lastMsg > 3000;        // backend not answering
  const show = !link || stale;
  $('off').classList.toggle('show', show);
  if (!show) return;
  if (stale) { setText('off-title', 'DASH OFFLINE'); setText('off-sub', 'RECONNECTING TO BACKEND'); setText('off-lost', ''); }
  else if (!everLinked) { setText('off-title', 'WAITING FOR CAN'); setText('off-sub', 'IGNITION ON?'); setText('off-lost', ''); }
  else { setText('off-title', 'VEHICLE POWERED OFF'); setText('off-sub', 'SYSTEM STANDBY'); setText('off-lost', trip.lostAt ? 'LINK LOST AT ' + trip.lostAt : ''); }
  setText('o-dist', trip.dist.toFixed(1) + ' KM');
  setText('o-time', Math.round(trip.start ? (performance.now() - trip.start) / 60000 : 0) + ' MIN');
  setText('o-top', Math.round(trip.top) + ' KM/H');
}

// ---------------------------------------------------------------- main loop
let lastT = performance.now(), frames = 0, fpsT = lastT, slowSecs = 0, slowCar = 0;
function loop(t) {
  const dt = Math.min((t - lastT) / 1000, 0.1);
  lastT = t;
  if (view === 'drive') renderDash(dt);
  else if (view === 'graphs') drawGraphs();
  renderOff();

  frames++;
  if (t - fpsT >= 1000) {
    const fps = Math.round(frames * 1000 / (t - fpsT));
    setText('gfps', String(fps));
    // auto-drop effects if the Pi can't keep up
    if (AUTO_FX && hq && view === 'drive' && fps < 30) { if (++slowSecs >= 5) { hq = false; applyFx(false); } } else slowSecs = 0;
    // still slow with effects off: drop the car to low detail for this session (not saved)
    if (AUTO_FX && !hq && !carBusy && CAR.model === 'impreza' && CAR.detail === 'high' && view === 'drive' && fps < 25) {
      if (++slowCar >= 5) { CAR.detail = 'low'; loadCar(); slowCar = 0; }
    } else slowCar = 0;
    frames = 0; fpsT = t;
  }
  requestAnimationFrame(loop);
}
applyTheme(theme);
loadCar();
lastMsg = performance.now();
requestAnimationFrame(loop);
