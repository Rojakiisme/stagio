// Stagio Bluetooth remote: talks to the Stagio PC over Bluetooth Low Energy (Web Bluetooth,
// Chrome on Android). The PC is the peripheral (see "Bluetooth remote" in ps/helper.ps1):
//   command  (write): {"c":"next","z":..,"r":..,"i":7,"d":"k","s":..}   signed (see sign() below)
//            to a Stagio from before signing (its state has no "z"): {"pin":"123456","c":"next"}
//   state    (read, notify): {"s":3,"t":40,"st":"running","b":"1/3","mu":1,"f":"","a":12,"z":".."}
//   cues     (read): ["Opening", "Break", ...]
'use strict';
const SVC = '6f6e6564-6573-6b00-0000-000000000001';
const CMD = '6f6e6564-6573-6b00-0000-000000000002';
const STATE = '6f6e6564-6573-6b00-0000-000000000003';
const CUES = '6f6e6564-6573-6b00-0000-000000000004';

const $ = (s) => document.querySelector(s);
const store = {
  get(k) { try { return localStorage.getItem(`stagio.bt.${k}`); } catch { return null; } },
  set(k, v) { try { if (v) localStorage.setItem(`stagio.bt.${k}`, v); else localStorage.removeItem(`stagio.bt.${k}`); } catch { /* private mode */ } },
};
const dec = new TextDecoder();
const enc = new TextEncoder();

let device = null;
let cmdChar = null;
let state = {};
let wantConnected = false;
let busy = false;

function setConn(cls, text) {
  $('#conn').className = `st ${cls}`;
  $('#conn em').textContent = text;
}
function msg(el, text, bad = true) { const m = $(el); m.textContent = text || ''; m.classList.toggle('bad', !!bad); }

// ---- connecting ----
// The Bluetooth code in Stagio's Remote window carries a key (#k=); typing the PIN is the other
// way (weaker: see sign()). Whichever was done last is used.

async function connect(choose) {
  if (busy) return;
  const pin = $('#pin').value.trim();
  if (pin && !/^\d{6}$/.test(pin)) { msg('#msg', 'The PIN has 6 digits.'); return; }
  if (pin && pin !== store.get('pin')) { store.set('pin', pin); store.set('k', ''); }
  if (!pin && !store.get('k')) { msg('#msg', 'Scan the Bluetooth code in Remote on the Stagio computer (or type the PIN shown next to it).'); return; }
  busy = true;
  msg('#msg', '');
  try {
    if (choose || !device) {
      device = await navigator.bluetooth.requestDevice({ filters: [{ services: [SVC] }] });
      device.addEventListener('gattserverdisconnected', onDisconnected);
    }
    wantConnected = true;
    setConn('warn', 'Connecting…');
    const server = await device.gatt.connect();
    const svc = await server.getPrimaryService(SVC);
    cmdChar = await svc.getCharacteristic(CMD);
    const stateChar = await svc.getCharacteristic(STATE);
    const cuesChar = await svc.getCharacteristic(CUES);
    stateChar.addEventListener('characteristicvaluechanged', (e) => render(read(e.target.value)));
    await stateChar.startNotifications();
    render(read(await stateChar.readValue()));
    renderCues(read(await cuesChar.readValue()) || []);
    setConn('ok', device.name || 'Connected');
    $('#setup').classList.add('hidden');
    $('#live').classList.remove('hidden');
    checkPin();
  } catch (e) {
    if (e.name === 'NotFoundError') msg('#msg', 'No Stagio computer chosen. On the computer, check that Bluetooth is started (Remote → No Wi-Fi…? → Bluetooth).');
    else msg('#msg', `Could not connect: ${e.message}`);
    setConn('bad', 'Not connected');
    wantConnected = false;
  } finally { busy = false; }
}

function read(view) {
  try { return JSON.parse(dec.decode(view)); } catch { return null; }
}

// Out of range, PC asleep, Stagio closed: try again every few seconds while the page is open.
function onDisconnected() {
  setConn('bad', 'Connection lost · retrying');
  cmdChar = null;
  if (!wantConnected) return;
  setTimeout(async function retry() {
    if (!wantConnected || cmdChar) return;
    try { await connect(false); } catch { /* next try */ }
    if (!cmdChar && wantConnected) setTimeout(retry, 3000);
  }, 1500);
}

// ---- commands ----

// Signed commands: neither the key nor the PIN goes over the air, and a recorded command can't
// be sent again or changed. The signature: the first 16 bytes of HMAC-SHA256(key,
// "b1|z|r|i|c|n|sec"), z from the computer's state (new each time Bluetooth starts there), r this
// page's own random value, i its count. key: the one from the code, or SHA-256("stagio-ble-pin|"
// + PIN) (someone who recorded a PIN-signed command can try all million PINs afterwards).
const b64u = (b) => btoa(String.fromCharCode(...b)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const fromB64u = (t) => Uint8Array.from(atob(t.replace(/-/g, '+').replace(/_/g, '/')), (x) => x.charCodeAt(0));
const PAGE_R = b64u(crypto.getRandomValues(new Uint8Array(6)));
let count = 0;
async function sign(c, extra) {
  const k = store.get('k');
  const pin = store.get('pin');
  const d = k ? 'k' : 'p';
  const raw = k ? fromB64u(k) : new Uint8Array(await crypto.subtle.digest('SHA-256', enc.encode(`stagio-ble-pin|${pin}`)));
  const m = { c, ...extra, z: state.z, r: PAGE_R, i: ++count, d };
  const key = await crypto.subtle.importKey('raw', raw, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const mac = new Uint8Array(await crypto.subtle.sign('HMAC', key, enc.encode(`b1|${m.z}|${m.r}|${m.i}|${m.c}|${m.n ?? ''}|${m.sec ?? ''}`)));
  m.s = b64u(mac.slice(0, 16));
  return m;
}

async function send(c, extra = {}) {
  if (!cmdChar) { msg('#liveMsg', 'Not connected'); return false; }
  let m;
  if (state.z) m = await sign(c, extra);
  else if (store.get('pin')) m = { pin: store.get('pin'), c, ...extra }; // a Stagio from before signing
  else { msg('#liveMsg', 'This Stagio is an older version: type the PIN shown under Remote on the computer.'); $('#setup').classList.remove('hidden'); return false; }
  try {
    await cmdChar.writeValueWithResponse(enc.encode(JSON.stringify(m)));
    return true;
  } catch (e) {
    msg('#liveMsg', `Not sent: ${e.message}`);
    return false;
  }
}

// The PC ignores commands with a wrong PIN; its count of accepted commands ("a") shows whether
// ours got through.
async function checkPin() {
  const before = state.a;
  await send('hello');
  setTimeout(() => {
    if (state.a === before) {
      msg('#liveMsg', store.get('k') && state.z
        ? 'The computer did not accept this phone. Scan the Bluetooth code on the computer again (its PIN and keys may have been renewed). After 8 refused tries the computer ignores this phone for 5 minutes, or until Bluetooth is stopped and started there.'
        : 'The computer did not accept the PIN. Use the PIN in the Bluetooth part of Remote on the computer (not the Stage PIN), or scan the code there. After 8 wrong PINs the computer ignores this phone for 5 minutes, or until Bluetooth is stopped and started there.');
      $('#setup').classList.remove('hidden');
    } else msg('#liveMsg', '');
  }, 1500);
}

document.addEventListener('click', (e) => {
  const b = e.target.closest('[data-c]');
  if (!b) return;
  if (navigator.vibrate) navigator.vibrate(15);
  send(b.dataset.c, b.dataset.n ? { n: Number(b.dataset.n) } : {});
});

// ---- showing the state ----

const STATES = { running: 'Live', paused: 'Live', black: 'Black', white: 'White', end: 'End', done: 'End', ready: 'Not live', off: 'PowerPoint off' };
function render(s) {
  if (!s) return;
  state = s;
  $('#slide').textContent = s.t ? `${s.s || '–'} / ${s.t}` : '–';
  const st = $('#state');
  st.textContent = STATES[s.st] || s.st || '';
  st.className = `tag ${s.st === 'running' || s.st === 'paused' ? 'live' : s.st === 'black' || s.st === 'white' ? 'warn' : ''}`;
  const live = ['running', 'paused', 'black', 'white', 'end', 'done'].includes(s.st);
  $('#startBtn').classList.toggle('hidden', live);
  $('#endBtn').classList.toggle('hidden', !live);
  $('#build').classList.toggle('hidden', !s.b);
  $('#build').textContent = s.b ? `Build ${s.b}` : '';
  $('#music').textContent = s.mu === -1 ? '· off' : s.f ? `· fading ${s.f}` : s.mu ? '· playing' : '· paused';
}
function renderCues(names) {
  const el = $('#cues');
  el.innerHTML = '';
  if (!names.length) { el.innerHTML = '<span class="dim">No cues</span>'; return; }
  names.forEach((n, i) => {
    const b = document.createElement('button');
    b.className = 'btn cue';
    b.dataset.c = 'cue';
    b.dataset.n = String(i + 1);
    b.innerHTML = `<span class="ck mono">${i + 1}</span><span class="cn"></span>`;
    b.querySelector('.cn').textContent = n;
    el.appendChild(b);
  });
}

// ---- keep the screen on ----
let lock = null;
async function awake(on) {
  try {
    if (on && 'wakeLock' in navigator) { lock = await navigator.wakeLock.request('screen'); lock.addEventListener('release', () => { lock = null; $('#awake').classList.remove('lit'); }); }
    else if (lock) { await lock.release(); lock = null; }
  } catch { /* not allowed now */ }
  $('#awake').classList.toggle('lit', !!lock);
  store.set('awake', on ? '1' : '');
}
$('#awake').onclick = () => awake(!lock);
document.addEventListener('visibilitychange', () => { if (!document.hidden && store.get('awake') === '1' && !lock) awake(true); });

// ---- start ----
// The code in Stagio's Remote window opens this page as .../remote/#k=<key>: the part after #
// never leaves the phone. It is kept here, then taken out of the address bar.
const fromCode = new URLSearchParams(location.hash.slice(1));
const codeKey = /^[A-Za-z0-9_-]{16,64}$/.test(fromCode.get('k') || '') ? fromCode.get('k') : null;
if (codeKey) { store.set('k', codeKey); store.set('pin', ''); }
if (location.hash) history.replaceState(null, '', location.pathname + location.search);
$('#pin').value = store.get('pin') || '';
if (navigator.bluetooth && store.get('k')) msg('#msg', codeKey ? 'Code scanned. Tap Connect and choose the computer.' : 'This phone has the code from the computer. Tap Connect.', false);
if (!navigator.bluetooth) {
  $('#unsupported').classList.remove('hidden');
  $('#setup').classList.add('hidden');
  setConn('bad', 'No Bluetooth');
} else {
  $('#connect').onclick = () => connect(true);
  // A PC chosen before can be reconnected without the list (where Chrome allows it).
  if (navigator.bluetooth.getDevices) {
    navigator.bluetooth.getDevices().then((list) => {
      const known = list[0];
      if (!known) return;
      device = known;
      device.addEventListener('gattserverdisconnected', onDisconnected);
      const b = $('#reconnect');
      b.textContent = `Reconnect to ${known.name || 'the Stagio computer'}`;
      b.classList.remove('hidden');
      b.onclick = () => connect(false);
    }).catch(() => {});
  }
}
if (store.get('awake') === '1') awake(true);
if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
