// The stage display (Extra): the slide on the projector, the next one, the notes, the time left
// and messages from the console. View only. Loaded by stage.html.
  'use strict';
  const $ = (s) => document.querySelector(s);
  const store = {
    get(k) { try { return localStorage.getItem(`onedesk.${k}`); } catch { return null; } },
    set(k, v) { try { if (v) localStorage.setItem(`onedesk.${k}`, v); else localStorage.removeItem(`onedesk.${k}`); } catch { /* private mode */ } },
  };

  // ---- access: the stage key from the QR code (?key=), kept on this device ----
  const qs = new URLSearchParams(location.search);
  if (qs.get('key')) { store.set('stageKey', qs.get('key')); history.replaceState(null, '', location.pathname); }
  let KEY = store.get('stageKey') || '';
  const withKey = (u) => (KEY ? `${u}${u.includes('?') ? '&' : '?'}key=${encodeURIComponent(KEY)}` : u);
  const post = (p, body) => fetch(withKey(p), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}) });

  function showLogin(msg) {
    for (const id of ['#bar', '#stage', '#wait', '#flip', '#msg', '#lost']) $(id).classList.add('hidden');
    $('#login').classList.remove('hidden');
    $('#loginErr').textContent = msg || '';
    $('#pin').focus();
  }
  $('#loginForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    try {
      const r = await fetch('/api/stage/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ pin: $('#pin').value }) });
      const j = await r.json();
      if (!j.ok) { $('#loginErr').textContent = j.error || 'Wrong PIN'; return; }
      KEY = j.data.key; store.set('stageKey', KEY);
      $('#login').classList.add('hidden');
      connect();
    } catch { $('#loginErr').textContent = 'No connection to the Stagio computer'; }
  });

  // ---- live state ----
  let S = null;
  let offset = 0;        // the Stagio computer's clock minus this device's
  let lastMsgAt = 0;
  let es = null;
  async function connect() {
    try {
      const r = await fetch(withKey('/api/ping'), { cache: 'no-store' });
      if (r.status === 401 || r.status === 403) { store.set('stageKey', ''); KEY = ''; showLogin(); return; }
    } catch { /* not reachable yet: the stream keeps trying */ }
    if (es) es.close();
    es = new EventSource(withKey('/api/stage/events'));
    lastMsgAt = Date.now();
    es.onmessage = (e) => {
      lastMsgAt = Date.now();
      const d = JSON.parse(e.data);
      if (d.now) offset = d.now - Date.now();
      if ('show' in d) { S = d; render(); }
      setLost(false);
    };
    es.onerror = () => { if (es.readyState === EventSource.CLOSED) setTimeout(connect, 2000); };
  }
  function setLost(on) { $('#lost').classList.toggle('hidden', !on); }
  setInterval(() => { if (es && Date.now() - lastMsgAt > 9000) { setLost(true); connect(); } }, 3000);
  document.addEventListener('visibilitychange', () => { if (!document.hidden && es && Date.now() - lastMsgAt > 6000) connect(); });

  // ---- drawing ----
  const fmt = (ms) => {
    const s = Math.max(0, Math.round(ms / 1000));
    const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), ss = String(s % 60).padStart(2, '0');
    return h ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`;
  };
  function pic(img, ph, p) {
    const src = S.show && p && p.v ? withKey(`/api/ppt/thumb?path=${encodeURIComponent(S.show.path)}&id=${p.id}&v=${encodeURIComponent(p.v)}`) : '';
    if (src) { if (img.getAttribute('src') !== src) img.src = src; img.classList.remove('hidden'); ph.textContent = ''; }
    else { img.removeAttribute('src'); img.classList.add('hidden'); ph.textContent = p ? `Slide ${p.index}${p.title ? ` · ${p.title}` : ''}` : 'End of the presentation'; }
  }
  let seenMsg = store.get('stageSeenMsg') || '';
  function render() {
    $('#bar').classList.remove('hidden');
    const show = S.show && S.show.slide ? S.show : null;
    $('#stage').classList.toggle('hidden', !show);
    $('#wait').classList.toggle('hidden', !!show);
    $('#flip').classList.toggle('hidden', !(show && S.canFlip));
    if (!show) {
      $('#waitTitle').textContent = S.show ? 'The slide show has ended' : 'Waiting for the slide show';
      $('#waitSub').textContent = S.run ? `Now: ${S.run.part}${S.run.next ? ` · next: ${S.run.next}` : ''}` : 'This screen follows the projector once the show starts.';
    } else {
      $('#nowNum').textContent = `${show.slide} / ${show.total}${show.clicks ? ` · step ${show.click}/${show.clicks}` : ''}`;
      pic($('#nowImg'), $('#nowPh'), S.current);
      pic($('#nextImg'), $('#nextPh'), S.next);
      $('#nextNum').textContent = S.next ? String(S.next.index) : '';
      const st = $('#nowState');
      st.classList.toggle('hidden', !['black', 'white'].includes(show.state));
      st.className = `state ${show.state === 'black' ? 'black' : show.state === 'white' ? 'white' : 'hidden'}`;
      st.textContent = show.state === 'black' ? 'BLACK' : show.state === 'white' ? 'WHITE' : '';
      const n = $('#notes');
      if (n.textContent !== (S.notes || '').trim()) { n.textContent = (S.notes || '').trim(); n.scrollTop = 0; }
    }
    // message
    const m = S.message;
    $('#msg').classList.toggle('hidden', !m);
    if (m) {
      $('#msgText').textContent = m.text;
      $('#msg').classList.toggle('seen', m.acked);
      $('#msgHint').textContent = m.acked ? 'Seen' : 'Tap when seen';
      if (String(m.id) !== seenMsg) {
        seenMsg = String(m.id); store.set('stageSeenMsg', seenMsg);
        if (!m.acked) { $('#flashText').textContent = m.text; $('#flash').classList.remove('hidden'); clearTimeout(render.flashT); render.flashT = setTimeout(() => $('#flash').classList.add('hidden'), 6000); }
      }
    } else $('#flash').classList.add('hidden');
    tick();
  }
  function ack() {
    $('#flash').classList.add('hidden');
    if (S?.message && !S.message.acked) post('/api/stage/ack', { id: S.message.id }).catch(() => {});
  }
  $('#flash').onclick = ack;
  $('#msg').onclick = ack;

  /** The time line in the bar: the run of show's part and its time left, or how long this part has run. */
  function tick() {
    const now = Date.now() + offset;
    const d = new Date(now);
    $('#clock').textContent = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
    if (!S) return;
    const left = $('#left');
    left.className = 'left';
    const r = S.run;
    if (r) {
      $('#partLabel').textContent = `Part ${r.index + 1} of ${r.count}${r.next ? ` · next: ${r.next}` : ''}`;
      $('#partName').textContent = r.part;
      if (r.countdown) left.textContent = fmt(r.countdown - now);
      else if (r.planned) {
        const rest = r.planned - (now - r.segAt);
        left.textContent = rest >= 0 ? `${fmt(rest)} left` : `+${fmt(-rest)} over`;
        if (rest < 0) left.classList.add(rest < -120000 ? 'late' : 'over');
      } else left.textContent = fmt(now - r.segAt);
    } else {
      const t = S.timer || {};
      $('#partLabel').textContent = t.segBy ? 'Segment' : 'Show';
      $('#partName').textContent = t.segBy || S.show?.name || 'Stagio';
      left.textContent = t.segAt && S.show ? fmt(now - t.segAt) : '–';
    }
  }
  setInterval(tick, 1000);

  // ---- notes size (this device) ----
  const SIZES = [18, 22, 26, 30, 36, 44, 54, 64];
  let size = SIZES.includes(Number(store.get('stageNotes'))) ? Number(store.get('stageNotes')) : 30;
  const applySize = () => { document.documentElement.style.setProperty('--notes', `${size}px`); };
  $('#smaller').onclick = () => { size = SIZES[Math.max(0, SIZES.indexOf(size) - 1)]; store.set('stageNotes', String(size)); applySize(); };
  $('#bigger').onclick = () => { size = SIZES[Math.min(SIZES.length - 1, SIZES.indexOf(size) + 1)]; store.set('stageNotes', String(size)); applySize(); };
  applySize();

  // ---- Prev / Next (only when the console allows it) ----
  const flip = (p) => post(p).then((r) => r.json()).then((j) => { if (!j.ok) alert(j.error); }).catch(() => {});
  $('#btnNext').onclick = () => flip('/api/stage/next');
  $('#btnPrev').onclick = () => flip('/api/stage/prev');

  // ---- keep the screen on (as in the phone remote): Wake Lock, or a silent video ----
  const awake = { want: store.get('stageAwake') !== '0', lock: null, video: null, audio: null };
  const awakeActive = () => !!awake.lock || (!!awake.video && !awake.video.paused);
  const renderAwake = () => $('#btnAwake').classList.toggle('lit', awakeActive());
  function silentVideo() {
    const c = document.createElement('canvas'); c.width = c.height = 16;
    const g = c.getContext('2d'); let n = 0;
    const draw = () => { g.fillStyle = n++ % 2 ? '#000' : '#010101'; g.fillRect(0, 0, 16, 16); };
    draw(); setInterval(draw, 1000);
    const stream = c.captureStream(1);
    try {
      const ac = new (window.AudioContext || window.webkitAudioContext)();
      const osc = ac.createOscillator(); const gain = ac.createGain(); gain.gain.value = 0;
      const out = ac.createMediaStreamDestination(); osc.connect(gain).connect(out); osc.start();
      stream.addTrack(out.stream.getAudioTracks()[0]); awake.audio = ac;
    } catch { /* no sound track */ }
    const v = document.createElement('video');
    v.setAttribute('playsinline', ''); v.disableRemotePlayback = true; v.srcObject = stream; v.className = 'awake-video';
    v.addEventListener('pause', renderAwake); v.addEventListener('playing', renderAwake);
    document.body.appendChild(v);
    return v;
  }
  async function awakeOn() {
    if (awakeActive()) return true;
    if (navigator.wakeLock) {
      try { awake.lock = await navigator.wakeLock.request('screen'); awake.lock.addEventListener('release', () => { awake.lock = null; renderAwake(); }); return true; } catch { /* try the video */ }
    }
    try { awake.video ||= silentVideo(); awake.audio?.resume?.(); await awake.video.play(); return true; } catch { return false; }
  }
  function awakeOff() { awake.lock?.release().catch(() => {}); awake.lock = null; awake.video?.pause(); awake.audio?.suspend?.(); }
  $('#btnAwake').onclick = async () => {
    awake.want = !awakeActive();
    store.set('stageAwake', awake.want ? '' : '0');
    if (!awake.want) awakeOff();
    else if (!(await awakeOn())) alert('This browser cannot keep the screen on. Set the screen timeout (Auto-Lock) to the longest setting for the event.');
    renderAwake();
  };
  // Starting it needs a tap: on by default, it starts on the first tap anywhere and comes back
  // when the page does.
  const resume = (e) => { if (e?.target?.closest?.('#btnAwake')) return; if (awake.want && !document.hidden && !awakeActive()) awakeOn().then(renderAwake); };
  document.addEventListener('pointerdown', resume);
  document.addEventListener('visibilitychange', resume);
  renderAwake();

  // ---- full screen ----
  const root = document.documentElement;
  const fsReq = root.requestFullscreen || root.webkitRequestFullscreen;
  const fsExit = document.exitFullscreen || document.webkitExitFullscreen;
  const fsNow = () => document.fullscreenElement || document.webkitFullscreenElement;
  if (fsReq && (document.fullscreenEnabled || document.webkitFullscreenEnabled)) {
    $('#btnFull').classList.remove('hidden');
    $('#btnFull').onclick = () => { (fsNow() ? fsExit.call(document) : fsReq.call(root, { navigationUI: 'hide' }))?.catch?.(() => {}); };
    const sync = () => $('#btnFull').classList.toggle('lit', !!fsNow());
    document.addEventListener('fullscreenchange', sync);
    document.addEventListener('webkitfullscreenchange', sync);
  }

  if (KEY) connect(); else showLogin();
