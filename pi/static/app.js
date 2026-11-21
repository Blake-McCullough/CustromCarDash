import { Car3D } from './car3d.js';

// ---------------------------------------------------------------- config
const CFG = {
  rpmMax: 7000,      // top of the rpm bar
  redline: 6500,     // defaults; the active vehicle profile (pi/vehicles/*.json) overrides these
  shiftAt: 6000,     // shift lights flash from here
  steerRatio: 15,    // steering wheel deg -> road wheel deg
  slipPct: 8,        // wheel speed % difference flagged as slip
  // --- calculated gear (fallback): engine rpm per km/h in each gear, measured from a drive on this car.
  //     The car also sends its own gear on 0x141, which is the default source.
  gearDefaults: [130, 75, 52, 40, 32, 27],   // generic; replaced by the profile's gear_ratios (rpm per km/h)
  gearTol: 0.07,     // ratio must be within 7% of a gear to show it
  // --- wheel power estimate (virtual dyno): P = v * (m*a + aero drag + rolling resistance)
  mass: 1400,        // kg, car + driver
  cda: 0.70,         // drag coefficient x frontal area (m²)
  crr: 0.012,        // rolling resistance coefficient
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
// ---------------------------------------------------------------- vehicle profile
// The backend loads one profile from pi/vehicles/ (CAN decodes + car defaults). Car-specific settings are
// kept per profile in SETTINGS.vehicles[id], so switching to another car doesn't carry over this one's
// redline, gear ratios or 0-100 time.
const CAR_KEYS = ['redline', 'shiftAt', 'mass', 'gearCount', 'gearCal', 'gearMode', 'carModel', 'zt_best'];
let VEH = { active: null, profile: {}, list: [], locked: false, can_bitrate: null, signals: [] };
try { VEH = await (await fetch('/api/vehicles', { cache: 'no-store' })).json(); } catch { /* backend not up */ }
const VP = VEH.profile || {};
if (VEH.active && SETTINGS.vehicle !== VEH.active) {
  const per = SETTINGS.vehicles || (SETTINGS.vehicles = {});
  const had = CAR_KEYS.filter(k => k in SETTINGS);
  if (had.length) per[SETTINGS.vehicle || 'subaru_impreza_2013'] =      // settings from before profiles = the Impreza
    Object.fromEntries(had.map(k => [k, SETTINGS[k]]));
  for (const k of CAR_KEYS) delete SETTINGS[k];
  Object.assign(SETTINGS, per[VEH.active] || {});
  store.set('vehicle', VEH.active);
}
if (VP.redline) CFG.redline = VP.redline;
if (VP.shift_at) CFG.shiftAt = VP.shift_at;
if (VP.mass) CFG.mass = VP.mass;
if (VP.cda) CFG.cda = VP.cda;
if (Array.isArray(VP.gear_ratios) && VP.gear_ratios.length) CFG.gearDefaults = VP.gear_ratios.slice();
CFG.redline = store.get('redline', CFG.redline);
CFG.shiftAt = store.get('shiftAt', CFG.shiftAt);
CFG.mass = store.get('mass', CFG.mass);
CFG.bright = store.get('bright', 130);       // >100 = boost: brighter greys/lines/glow on top of full backlight
CFG.brightNight = store.get('brightNight', 40);

// ---------------------------------------------------------------- state
let meta = {};
let OBD = null;                    // OBD-II polling status from the backend (null = off)
let V = {};                         // latest decoded values
let link = false, everLinked = false, source = '', lastMsg = 0, busOn = false;
const D = {};                       // display-smoothed values
let longG = 0;
// derived values (not on the bus): acceleration from a speed regression, wheel power, calculated gear
const spdBuf = [];                       // [t ms, speed m/s]
let accel = 0, wheelKw = 0, pwrPeak = 0;
let gearCount = store.get('gearCount', VP.gear_count || 6);
let gearMode = store.get('gearMode', VEH.signals && VEH.signals.includes('gear') ? 'can' : 'calc');            // 'can' (the car's own gear, 0x141) or 'calc' (rpm/speed)
let gearCal = store.get('gearCal', null) || CFG.gearDefaults.slice();
let learn = { ratio: 0, since: 0, dirty: false, saved: 0 };
let gPeak = 0;
const gTrail = [];
const hist = [];                    // graph samples [t, rpm, speed, thr, brk, steer]

const trip = { dist: 0, moveTime: 0, start: null, top: 0, lastT: null, lostAt: '' };
const zt = { state: 'idle', t0: 0, run: null, best: store.get('zt_best', null) };

// ---------------------------------------------------------------- UI setup
let AUTO_FX = store.get('autofx', true) && !new URLSearchParams(location.search).has('keepfx');
// Mouse pointer: hidden for the touch screen. Shown by ?cursor, --cursor, the Settings option,
// or by tapping Ctrl on its own (toggles; remembered).
let showCursor = new URLSearchParams(location.search).has('cursor') || document.documentElement.classList.contains('showcursor')
  || store.get('cursor', false);
function applyCursor(save) {
  document.documentElement.classList.toggle('showcursor', showCursor);
  if (save) store.set('cursor', showCursor);
}
applyCursor(false);
let ctrlAlone = false;
addEventListener('keydown', e => { ctrlAlone = e.key === 'Control' && !e.repeat; });
addEventListener('keyup', e => {
  if (e.key === 'Control' && ctrlAlone) { showCursor = !showCursor; applyCursor(true); if (view === 'settings') renderSettings(); }
  ctrlAlone = false;
});
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

const views = { drive: $('v-drive'), graphs: $('v-graphs'), engine: $('v-engine'), bus: $('v-bus'), settings: $('v-settings') };
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
  model: store.get('carModel', VP.model || 'basic'),
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
  seg('o-cursor', showCursor, v => { showCursor = v; applyCursor(true); renderSettings(); });
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
  // gear & power
  pick('o-gearmode', gearMode, v => { gearMode = v; store.set('gearMode', v); renderSettings(); });
  pick('o-gears', String(gearCount), v => { gearCount = +v; store.set('gearCount', gearCount); renderSettings(); });
  seg('o-learn', store.get('gearLearn', true), v => { store.set('gearLearn', v); renderSettings(); });
  const ord = ['1st', '2nd', '3rd', '4th', '5th', '6th'];
  seg('o-brightauto', store.get('brightAuto', false), v => { store.set('brightAuto', v); applyBrightness(true); renderSettings(); });
  $('brightinfo').textContent = brightInfo();
  renderLogList();
  renderVehicles();
  $('gearcal').textContent = gearCal.slice(0, gearCount).map((r, i) => `${ord[i]} ${Math.round(r)}`).join(' · ') + '  rpm per km/h';
  renderSysinfo();
}
document.querySelectorAll('.step').forEach(st => {
  const [minus, , plus] = st.children;
  const bump = d => {
    const k = st.dataset.k, step = +st.dataset.step;
    CFG[k] = clamp(CFG[k] + d * step, +st.dataset.min, +st.dataset.max);
    if (CFG.shiftAt > CFG.redline) { if (k === 'shiftAt') CFG.redline = CFG.shiftAt; else CFG.shiftAt = CFG.redline; }
    store.set('redline', CFG.redline); store.set('shiftAt', CFG.shiftAt); store.set('mass', CFG.mass);
    store.set('bright', CFG.bright); store.set('brightNight', CFG.brightNight); applyBrightness(true);
    buildSegs(); LANES[0].max = CFG.rpmMax; renderSettings();
  };
  minus.onclick = () => bump(-1);
  plus.onclick = () => bump(1);
});
const flashDone = b => { b.classList.add('done'); setTimeout(() => b.classList.remove('done'), 900); };
$('r-trip').onclick = e => { Object.assign(trip, { dist: 0, moveTime: 0, start: null, top: 0, lastT: null }); flashDone(e.currentTarget); };
$('r-zt').onclick = e => { zt.best = null; zt.run = null; store.set('zt_best', null); flashDone(e.currentTarget); };
$('r-g').onclick = e => { gPeak = 0; flashDone(e.currentTarget); };
$('r-pwr').onclick = e => { pwrPeak = 0; flashDone(e.currentTarget); };
$('r-gears').onclick = e => { gearCal = CFG.gearDefaults.slice(); store.set('gearCal', null); renderSettings(); flashDone(e.currentTarget); };
$('r-all').onclick = () => {
  SETTINGS = {};
  fetch('/api/settings', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })
    .finally(() => location.reload());
};
// ---------------------------------------------------------------- vehicle picker
function renderVehicles() {
  const box = $('vlist');
  if (!box) return;
  const esc = t => String(t).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  box.innerHTML = (VEH.list || []).map(v => {
    const on = v.id === VEH.active;
    const sub = v.error ? `<i class="bad">broken: ${esc(v.error)}</i>`
      : `${v.signals} signals · ${v.verified} verified · ${v.bitrate / 1000} kbit/s`;
    return `<button class="vrow${on ? ' on' : ''}" data-id="${esc(v.id)}"${v.error || VEH.locked ? ' disabled' : ''}>` +
      `<b>${esc(v.name)}</b><span>${sub}</span></button>`;
  }).join('') || '<span class="dim">No profiles found in pi/vehicles/</span>';
  box.querySelectorAll('.vrow').forEach(b => { b.onclick = () => switchVehicle(b.dataset.id); });
  const notes = [];
  if (VEH.locked) notes.push('Started with --signals: restart without it to switch cars here.');
  const need = VP.bitrate || 500000;
  if (VEH.can_bitrate && VEH.can_bitrate !== need)
    notes.push(`⚠ can0 is running at ${VEH.can_bitrate / 1000} kbit/s but this car uses ${need / 1000}. ` +
      `On the Pi: sudo BITRATE=${need} ./setup_pi.sh && sudo reboot`);
  if (VP.obd_pins) notes.push(`OBD pins ${VP.obd_pins}.`);
  if (VEH.signals && !VEH.signals.length) notes.push('No CAN decodes yet: turn on OBD mode (sudo OBD=1 ./setup_pi.sh) for standard data.');
  $('vinfo').innerHTML = notes.map(n => `<div>${n}</div>`).join('');
}
async function switchVehicle(id) {
  if (id === VEH.active) return;
  document.querySelectorAll('#vlist .vrow').forEach(b => b.classList.toggle('busy', b.dataset.id === id));
  clearTimeout(saveTimer);                  // flush this car's settings first; they're stashed per car on reload
  try {
    await fetch('/api/settings', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(SETTINGS) });
    const r = await fetch('/api/vehicle', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id }) });
    if (!r.ok) { const e = await r.json().catch(() => ({})); $('vinfo').textContent = 'Could not switch: ' + (e.error || r.status); renderVehicles(); return; }
  } catch { $('vinfo').textContent = 'Could not reach the dash backend.'; return; }
  location.reload();
}
if (VP.short) {
  document.querySelector('.brand').innerHTML = `${VP.short.replace(/[<&]/g, '')} <b>//</b> DASH`;
  document.title = `${VP.short} Dash`;
}

function renderSysinfo() {
  if (view !== 'settings') return;
  const n = Object.values(meta).filter(m => !m.verified).length;
  const rows = [
    ['Data source', !link ? 'no CAN link' : source === 'demo' ? 'demo (simulated)' : 'live CAN (can0)'],
    ['OBD-II polling', obdText()],
    ...screensRows(),
    ['CAN frames/s', $('fps').textContent],
    ['Vehicle', VP.name || VEH.active || '–'],
    ['Signals', `${Object.keys(meta).length} defined · ${n} unverified`],
    ['Car model', car.modelInfo],
    ['Screen', `${window.innerWidth} × ${window.innerHeight}`],
    ['Render', `${$('gfps').textContent} fps · effects ${hq ? 'high' : 'low'}`],
  ];
  $('sysinfo').innerHTML = rows.map(([k, v]) => `<span>${k}</span><b>${v}</b>`).join('');
}
setInterval(renderSysinfo, 1000);

let screens = [];
setInterval(async () => { if (view !== 'settings') return; try { screens = await (await fetch('/api/clients')).json(); } catch { screens = []; } }, 2000);
function screensRows() {
  return screens.map(c => [c.local ? 'Pi screen' : 'Remote (' + c.ip + ')',
    `${c.gpu} · ${c.fps} fps · 3D ${c.car3d}${c.errors.length ? ' · ' + c.errors[c.errors.length - 1] : ''}${c.id === CLIENT_ID ? ' (this one)' : ''}`]);
}

// ---------------------------------------------------------------- display brightness
let brightMethod = 'software', brightNow = null;
async function fetchBrightMethod() {
  try { brightMethod = (await (await fetch('/api/brightness')).json()).method; } catch { /* keep software */ }
  applyBrightness(true);
}
function brightInfo() {
  return { backlight: 'Using the screen backlight', ddc: 'Using the monitor backlight (DDC/CI)',
           software: 'Software dimming (this screen\'s backlight can\'t be controlled by the Pi; use its own buttons for more)' }[brightMethod];
}
function applyBrightness(force) {
  const night = store.get('brightAuto', false) && (V.low_beam === 1 || V.high_beam === 1);
  const pct = night ? CFG.brightNight : CFG.bright;
  if (!force && pct === brightNow) return;
  brightNow = pct;
  const hw = Math.min(pct, 100), boost = Math.max(0, pct - 100) / 50;   // 0..1
  if (brightMethod === 'software') {
    $('dim').style.opacity = String(Math.min(0.9, 1 - hw / 100));
  } else {
    $('dim').style.opacity = '0';
    fetch('/api/brightness', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ pct: hw }) }).catch(() => {});
  }
  applyBoost(boost);
}
// Boost: the screen can't go past full backlight, but the dash's dark greys, lines, panels and
// 3D glow can be lifted so everything reads brighter.
const mix = (a, b, t) => '#' + [0, 2, 4].map(i => Math.round(parseInt(a.slice(1 + i, 3 + i), 16) * (1 - t) + parseInt(b.slice(1 + i, 3 + i), 16) * t).toString(16).padStart(2, '0')).join('');
function applyBoost(b) {
  const st = document.documentElement.style;
  st.setProperty('--dim', mix('#6a707b', '#c2c8d2', b));
  st.setProperty('--line', mix('#1f232a', '#454d59', b));
  st.setProperty('--panel', mix('#0c0e11', '#171a20', b));
  st.setProperty('--panel2', mix('#101317', '#1e2229', b));
  car.boost = b;
}
fetchBrightMethod();
setTimeout(fetchBrightMethod, 20000);         // DDC detection on the Pi can take a few seconds
setInterval(() => applyBrightness(false), 1000);

// ---------------------------------------------------------------- CAN bus logging
const MARKS = ['MARK', 'IDLE', 'REV', 'BRAKE', 'CLUTCH', 'HANDBRAKE', 'STEER L', 'STEER R', 'CENTRE',
  'N', '1', '2', '3', '4', '5', '6', 'R', 'LOW BEAM', 'HIGH BEAM', 'INDIC L', 'INDIC R', 'DOOR', 'WIPERS',
  'A/C', 'FAN', 'TEMP', 'RECIRC', 'DEMIST'];
let logOn = false, logs = [];
for (const label of MARKS) {
  const b = document.createElement('button');
  b.textContent = label;
  b.onclick = () => {
    fetch('/api/log/mark', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ label }) });
    b.classList.add('hit'); setTimeout(() => b.classList.remove('hit'), 300);
  };
  $('marks').appendChild(b);
}
const kb = n => n > 1073741824 ? (n / 1073741824).toFixed(1) + ' GB' : n > 1048576 ? (n / 1048576).toFixed(1) + ' MB' : Math.round(n / 1024) + ' KB';
function onLogStatus(l) {
  const was = logOn;
  logOn = l.on;
  $('c-rec').classList.toggle('on', l.on);
  $('logbtn').classList.toggle('on', l.on);
  $('logbtn').innerHTML = l.on ? '&#9632; STOP' : '&#9679; RECORD';
  $('marks').classList.toggle('off', !l.on);
  setText('logstat', l.on ? `Recording ${fmtTime(l.secs)} · ${l.frames.toLocaleString()} frames · ${l.marks} markers`
    : l.reason ? `Stopped: ${l.reason}` : 'Not recording. Logs save to the Pi (pi/logs).');
  if (was !== l.on) refreshLogs();
}
$('logbtn').onclick = () => fetch('/api/log/' + (logOn ? 'stop' : 'start'), { method: 'POST' }).then(refreshLogs);
async function refreshLogs() {
  try { const r = await (await fetch('/api/logs')).json(); logs = r.logs; $('loghint').textContent =
    `${logs.length} logs · ${kb(r.free)} free · to download, open http://${location.hostname === '127.0.0.1' || location.hostname === 'localhost' ? '<pi-name>.local' : location.hostname}:${location.port || 80} on your phone or PC`; }
  catch { logs = []; }
  renderLogList();
}
function renderLogList() {
  const el = $('loglist');
  if (!logs.length) { el.innerHTML = '<div class="lrow"><span>No logs yet. Record from the BUS tab.</span></div>'; return; }
  el.innerHTML = logs.map(l => {
    const m = l.name.match(/can_(\d{4})(\d{2})(\d{2})_(\d{2})(\d{2})/);
    const when = m ? `${m[3]}/${m[2]} ${m[4]}:${m[5]}` : l.name;
    return `<div class="lrow"><span><b>${when}</b> · ${kb(l.bytes)} · ${l.marks} marks</span>` +
      `<a href="/logs/${l.name}.zip" download>ZIP</a><button data-del="${l.name}">&#10005;</button></div>`;
  }).join('');
  el.querySelectorAll('[data-del]').forEach(b => b.onclick = () => {
    if (b.dataset.armed) {
      fetch('/api/log/delete', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: b.dataset.del }) }).then(refreshLogs);
    } else { b.dataset.armed = 1; b.textContent = 'DELETE?'; setTimeout(() => { delete b.dataset.armed; b.innerHTML = '&#10005;'; }, 3000); }
  });
}
refreshLogs();
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

// Acceleration = slope of a least-squares line through the last 0.8 s of speed samples.
// Much less noisy than differencing two readings (OBD speed is whole km/h only).
function derive(now) {
  const kmh = V.speed;
  if (kmh == null) return;
  // the average of the 4 wheel speeds has finer resolution, but only use it once it's verified
  const w = [V.wheel_fl, V.wheel_fr, V.wheel_rl, V.wheel_rr].filter(x => x != null);
  const useWheels = w.length === 4 && meta.wheel_fl && meta.wheel_fl.verified;   // only once confirmed
  const v = (useWheels ? w.reduce((a, b) => a + b) / 4 : kmh) / 3.6;
  spdBuf.push([now, v]);
  while (spdBuf.length && now - spdBuf[0][0] > 800) spdBuf.shift();
  if (spdBuf.length >= 4) {
    const n = spdBuf.length, t0 = spdBuf[0][0];
    let sx = 0, sy = 0, sxx = 0, sxy = 0;
    for (const [t, y] of spdBuf) { const x = (t - t0) / 1000; sx += x; sy += y; sxx += x * x; sxy += x * y; }
    const den = n * sxx - sx * sx;
    if (den > 1e-6) accel += (clamp((n * sxy - sx * sy) / den, -15, 15) - accel) * 0.35;
  }
  longG = accel / 9.81;

  // wheel power (kW): only meaningful when driving forward under power
  const drag = 0.5 * 1.2 * CFG.cda * v * v, roll = CFG.crr * CFG.mass * 9.81;
  let p = v * (CFG.mass * accel + drag + roll) / 1000;
  if (v < 1.5 || (V.throttle ?? 100) < 3 || V.clutch === 1 || V.reverse) p = 0;
  wheelKw += (Math.max(0, p) - wheelKw) * 0.3;
  if (wheelKw > pwrPeak && v > 5) pwrPeak = wheelKw;
  V.wheel_kw = Math.round(wheelKw * 10) / 10;
  V.wheel_kw_peak = Math.round(pwrPeak);

  // calculated gear from rpm / speed
  const rpm = rpmOf(V), kmhNow = v * 3.6;
  let gear = 0;
  if (kmhNow > 4 && rpm > 600 && V.clutch !== 1) {
    const ratio = rpm / kmhNow;
    let best = -1, err = 1;
    for (let i = 0; i < gearCount; i++) { const e = Math.abs(ratio - gearCal[i]) / gearCal[i]; if (e < err) { err = e; best = i; } }
    if (err < CFG.gearTol) gear = best + 1;
    // auto-learn: a steady ratio for 1.2 s under light load nudges the nearest gear towards it
    if (Math.abs(ratio - learn.ratio) / ratio < 0.02) {
      if (now - learn.since > 1200 && kmhNow > 15 && rpm > 1200 && err < 0.12 && store.get('gearLearn', true)) {
        gearCal[best] += (ratio - gearCal[best]) * 0.05;
        learn.dirty = true;
      }
    } else { learn.ratio = ratio; learn.since = now; }
    if (learn.dirty && now - learn.saved > 20000) { store.set('gearCal', gearCal.map(x => Math.round(x * 10) / 10)); learn.dirty = false; learn.saved = now; }
  }
  if (V.gear === 7) gear = 0;                  // the car says neutral / between gears
  V.gear_calc = gear;
}

function onMsg(m) {
  if (m.meta) {
    if (m.vehicle && VEH.active && m.vehicle !== VEH.active) { location.reload(); return; }   // switched elsewhere
    meta = m.meta; applyMeta(); return;
  }
  const now = performance.now();
  lastMsg = now;
  V = m.v || {};
  source = m.source;
  if (m.log) onLogStatus(m.log);
  OBD = m.obd || null;
  $('fps').textContent = m.fps.toLocaleString();
  $('nids').textContent = m.nids;

  const wasLinked = link;
  link = !!m.link;
  if (link) everLinked = true;
  if (wasLinked && !link) trip.lostAt = new Date().toTimeString().slice(0, 5);

  const src = $('src');
  src.className = 'pill ' + (!link ? 'off' : source === 'demo' ? 'demo' : 'live');
  src.textContent = !link ? (m.error ? 'CAN ERROR' : 'NO CAN') : source === 'demo' ? 'DEMO' : 'LIVE CAN';

  const spd = V.speed;
  derive(now);

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
  const pwr = smooth('pwr', V.wheel_kw ?? 0, dt, 6);
  const lat = smooth('lat', V.lat_g ?? 0, dt, 8);
  const lng = smooth('lng', longG, dt, 6);

  setText('speed', Math.round(spd).toString());
  setText('rpm', Math.round(rpm).toLocaleString());
  const g = $('gear');
  const gv = gearMode === 'calc' ? V.gear_calc : V.gear;
  const gtxt = V.reverse ? 'R' : gv == null ? '–' : (gv === 0 || gv === 7) ? 'N' : String(gv);
  setText('gear', gtxt);
  g.classList.toggle('rev', gtxt === 'R');
  g.classList.toggle('dimgear', gearMode === 'can' && V.clutch === 1 && gtxt !== 'N');   // clutch in: the car's best guess

  const lit = Math.round(rpm / CFG.rpmMax * SEGS);
  for (let i = 0; i < SEGS; i++) { const c = i < lit ? segEls[i].dataset.cls : ''; if (segEls[i].className !== c) segEls[i].className = c; }
  $('segs').classList.toggle('flash', rpm >= CFG.shiftAt);

  setText('thr', Math.round(thr) + '%'); setW('b-thr', thr / 100);
  setText('brk', Math.round(brk) + '%'); setW('b-brk', brk / 100);
  setText('pwr', Math.round(pwr) + ' kW'); setW('b-pwr', pwr / 150);
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
  if (car3dState === 'on') {
    const r0 = performance.now();
    try { car.render(); } catch (e) { car3dFail(e); }
    const ms = performance.now() - r0;
    slow3d = ms > 120 ? slow3d + 1 : 0;              // ~8 fps or worse for 15 frames in a row
    if (slow3d >= 15) pause3d('too slow on this screen (' + Math.round(ms) + ' ms per frame)');
  }

  // wheel labels
  const pos = car.wheelScreen();
  const ref = Math.max(V.speed ?? 0, 1);
  for (const k of ['fl', 'fr', 'rl', 'rr']) {
    const el = $('wl-' + k), p = pos[k], w = wheels[k];
    el.style.left = p.x + 'px'; el.style.top = p.y + 'px';
    el.style.opacity = p.vis && car3dState === 'on' ? 1 : 0;
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
// No CAN never blocks the dash: a small notice on the 3D panel, and the "powered off" trip summary
// can be tapped away. Only a dead backend gets a full cover (nothing works without it).
let offDismissed = false;
$('off').addEventListener('click', () => { if (!(performance.now() - lastMsg > 3000)) { offDismissed = true; $('off').classList.remove('show'); } });
function renderOff() {
  const stale = performance.now() - lastMsg > 3000;        // backend not answering
  if (link) offDismissed = false;                          // next power-off shows the summary again
  $('nocan').classList.toggle('show', !link && !stale);
  setText('nocan-sub', everLinked ? 'Vehicle off. Everything else still works.' : 'Ignition on? Everything else still works.');
  const show = stale || (!link && everLinked && !offDismissed);
  $('off').classList.toggle('show', show);
  setText('off-tap', stale ? '' : 'TAP ANYWHERE TO CLOSE');
  if (!show) return;
  if (stale) { setText('off-title', 'DASH OFFLINE'); setText('off-sub', 'RECONNECTING TO BACKEND'); setText('off-lost', ''); }
  else { setText('off-title', 'VEHICLE POWERED OFF'); setText('off-sub', 'SYSTEM STANDBY'); setText('off-lost', trip.lostAt ? 'LINK LOST AT ' + trip.lostAt : ''); }
  setText('o-dist', trip.dist.toFixed(1) + ' KM');
  setText('o-time', Math.round(trip.start ? (performance.now() - trip.start) / 60000 : 0) + ' MIN');
  setText('o-top', Math.round(trip.top) + ' KM/H');
}

// ---------------------------------------------------------------- engine (OBD-II) view
const ETILES = [   // [signal, label, unit, decimals, barMin, barMax]
  ['rpm', 'RPM', '', 0, 0, 7000], ['speed', 'SPEED', 'km/h', 0, 0, 180],
  ['throttle', 'THROTTLE', '%', 0, 0, 100], ['engine_load', 'LOAD', '%', 0, 0, 100],
  ['map_kpa', 'MANIFOLD', 'kPa', 0, 0, 110], ['maf', 'AIR FLOW', 'g/s', 1, 0, 120],
  ['timing_adv', 'TIMING', '°', 1, -10, 50], ['intake_temp', 'INTAKE', '°C', 0, -10, 80],
  ['coolant', 'COOLANT', '°C', 0, 40, 120], ['oil_temp', 'OIL', '°C', 0, 40, 140],
  ['stft', 'SHORT TRIM', '%', 1, -25, 25], ['ltft', 'LONG TRIM', '%', 1, -25, 25],
  ['voltage', 'BATTERY', 'V', 2, 11, 15], ['fuel_level', 'FUEL', '%', 0, 0, 100],
  ['ambient', 'OUTSIDE', '°C', 0, -10, 50], ['gear_calc', 'GEAR (CALC)', '', 0, 0, 6],
  ['wheel_kw', 'WHEEL POWER', 'kW', 0, 0, 150], ['wheel_kw_peak', 'PEAK POWER', 'kW', 0, 0, 150],
];
const etEls = {};
for (const [k, label, unit] of ETILES) {
  const d = document.createElement('div');
  d.className = 'etile';
  d.innerHTML = `<div class="label">${label}</div><b>--<small>${unit}</small></b><div class="bar"><i></i></div>`;
  $('egrid').appendChild(d);
  etEls[k] = d;
}
function obdText() {
  if (!OBD) return 'off (start the backend with --obd)';
  const n = OBD.supported ? OBD.supported.length : 0;
  return `${OBD.status}${n ? ` · ${n} values · ${OBD.rate}/s` : ''}`;
}
function renderEngine() {
  setText('obdstate', 'OBD-II: ' + obdText());
  for (const [k, , unit, dp, lo, hi] of ETILES) {
    const el = etEls[k], v = V[k];
    const fromObd = meta[k] && meta[k].src === 'obd';
    el.classList.toggle('na', v == null);
    const txt = v == null ? '--' : Number(v).toFixed(dp);
    const b = el.querySelector('b');
    if (b.firstChild.textContent !== txt) b.firstChild.textContent = txt;
    el.querySelector('.bar > i').style.width = v == null ? '0%' : (clamp((v - lo) / (hi - lo), 0, 1) * 100).toFixed(1) + '%';
    el.querySelector('.label').classList.toggle('unv', !fromObd && meta[k] && !meta[k].verified);
  }
}

// ---------------------------------------------------------------- main loop
let lastT = performance.now(), frames = 0, fpsT = lastT, slowSecs = 0, slowCar = 0;
// ---------------------------------------------------------------- resilience + diagnostics
// One broken part (usually the 3D view on a weak or software-only GPU) must never freeze the
// gauges or the overlay. The Pi screen also reports its GPU and errors to the backend, so they can
// be seen from a phone (Settings > System) and in `journalctl -u impreza-dash`.
var car3dState = 'on', slow3d = 0, slowPage = 0;
const CLIENT_ID = Math.random().toString(36).slice(2, 8);
const clientErrors = [];
let reportTimer = null;
function noteError(where, e) {
  const msg = (where + ': ' + ((e && (e.message || e.reason)) || e || 'error')).slice(0, 300);
  if (clientErrors[clientErrors.length - 1] !== msg) clientErrors.push(msg);
  while (clientErrors.length > 10) clientErrors.shift();
  console.error(msg);
  clearTimeout(reportTimer); reportTimer = setTimeout(reportClient, 500);
}
const guardFails = {};
function guard(name, fn) {
  try { fn(); guardFails[name] = 0; }
  catch (e) { guardFails[name] = (guardFails[name] || 0) + 1; if (guardFails[name] <= 3) noteError(name, e); }
}
window.addEventListener('error', e => noteError('page', e.error || e.message));
window.addEventListener('unhandledrejection', e => noteError('promise', e.reason));
function car3dFail(e) { noteError('3d', e); pause3d('error: ' + (e && e.message || e)); }
function pause3d(why) {
  if (car3dState !== 'on') return;
  // first try the cheapest settings once, then give up on 3D for this session
  if (hq || (CAR.model === 'impreza' && CAR.detail === 'high')) {
    hq = false; applyFx(false);
    if (CAR.model === 'impreza' && CAR.detail === 'high') { CAR.detail = 'low'; loadCar(); }
    slow3d = 0; noteError('3d', 'slow, switched to low detail/effects: ' + why);
    return;
  }
  car3dState = 'paused';
  noteError('3d', 'paused: ' + why);
  $('c3d').style.visibility = 'hidden';
  let n = document.getElementById('nod3d');
  if (!n) {
    n = document.createElement('div'); n.id = 'nod3d'; n.className = 'nod3d';
    $('c3d').parentElement.appendChild(n);
  }
  n.innerHTML = `3D VIEW PAUSED<br><small>${why}${SOFTWARE_GPU ? '<br>Chromium is not using the GPU (' + GPU + ')' : ''}</small><br><button id="retry3d">TRY AGAIN</button>`;
  $('retry3d').onclick = () => { car3dState = 'on'; slow3d = 0; $('c3d').style.visibility = ''; n.remove(); };
}
function gpuName() {
  try {
    const gl = car.renderer.getContext();
    const ext = gl.getExtension('WEBGL_debug_renderer_info');
    return ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER);
  } catch { return 'unknown'; }
}
const GPU = gpuName();
const SOFTWARE_GPU = /swiftshader|llvmpipe|softpipe|software/i.test(GPU);
async function reportClient() {
  try {
    await fetch('/api/client', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({
      id: CLIENT_ID, gpu: GPU, fps: +$('gfps').textContent || 0, view, link, w: innerWidth, h: innerHeight,
      local: ['127.0.0.1', 'localhost'].includes(location.hostname), car3d: car3dState, errors: clientErrors,
    }) });
  } catch { /* backend restarting */ }
}
setInterval(reportClient, 5000);
setTimeout(reportClient, 1500);
if (SOFTWARE_GPU) noteError('gpu', 'no GPU acceleration (' + GPU + '): 3D will be slow');

function loop(t) {
  const dt = Math.min((t - lastT) / 1000, 0.1);
  lastT = t;
  guard('overlay', renderOff);                  // first, so it never waits on the 3D
  if (view === 'drive') guard('dash', () => renderDash(dt));
  else if (view === 'graphs') guard('graphs', drawGraphs);
  else if (view === 'engine') guard('engine', renderEngine);

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
    // whole page under 8 fps on the drive view even after the cheap settings: pause the 3D
    if (car3dState === 'on' && view === 'drive' && fps < 8) { if (++slowPage >= 8) { pause3d(`page at ${fps} fps`); slowPage = 0; } } else slowPage = 0;
    frames = 0; fpsT = t;
  }
  requestAnimationFrame(loop);
}
applyTheme(theme);
loadCar();
lastMsg = performance.now();
requestAnimationFrame(loop);
