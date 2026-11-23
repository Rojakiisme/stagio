// The opening countdown on the projector. Loaded by countdown.html.
'use strict';
const $ = (s) => document.querySelector(s);
let info = null;   // { target, title, notices, now }
let offset = 0;    // the Stagio computer's clock minus this page's
let noticeAt = 0;
let noticeIdx = -1;

async function load() {
  try {
    const t0 = Date.now();
    const r = await fetch('/api/countdown-screen', { cache: 'no-store' });
    const j = await r.json();
    info = j.ok ? j.data : null;
    if (info) offset = info.now - (t0 + Date.now()) / 2;
  } catch { /* keep the last one: a missed answer must not blank the screen */ }
}

function fmt(ms) {
  const s = Math.max(0, Math.ceil(ms / 1000));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = String(s % 60).padStart(2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`;
}

function draw() {
  document.body.classList.toggle('blank', !info);
  if (!info) return;
  const left = info.target - (Date.now() + offset);
  const time = $('#time');
  time.textContent = fmt(left);
  time.classList.toggle('done', left <= 0);
  if ($('#title').textContent !== info.title) $('#title').textContent = info.title;
  // Notices take turns every 8 seconds, fading between them.
  const list = info.notices || [];
  const n = $('#notice');
  if (!list.length) { n.textContent = ''; noticeIdx = -1; return; }
  if (noticeIdx < 0 || noticeIdx >= list.length || Date.now() - noticeAt > 8000) {
    noticeAt = Date.now();
    const nextIdx = (noticeIdx + 1) % list.length;
    if (list.length === 1 || noticeIdx < 0) { n.textContent = list[nextIdx]; n.classList.remove('out'); }
    else { n.classList.add('out'); setTimeout(() => { n.textContent = list[nextIdx]; n.classList.remove('out'); }, 600); }
    noticeIdx = nextIdx;
  }
}

load().then(draw);
setInterval(load, 1000);
setInterval(draw, 200);
