// Stagio quick checks: things that can be verified without a slide show.
//   node test/checks.js            helper + config checks only
//   node test/checks.js --server   also checks a running Stagio (npm run dev) over HTTP
// Exits with code 1 if anything fails.
const fs = require('fs');
const os = require('os');
const path = require('path');

// The running server's data folder, when the caller says (the config checks below use their own).
const SERVER_DATA = process.env.STAGIO_DATA || '';

const results = [];
function check(name, pass, detail = '') {
  results.push(pass);
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------- helper process

async function helperChecks() {
  const { Helper } = require('../lib/helper');
  const h = new Helper('checks', { timeoutMs: 20000 });
  try {
    const t0 = Date.now();
    check('helper starts and answers', (await h.call('ping')) === 'pong', `${Date.now() - t0} ms`);

    const st = await h.call('ppt.state');
    check('ppt.state returns a state', typeof st.running === 'boolean', `running=${st.running}`);

    const audio = await h.call('audio.state');
    check('audio.state lists output devices', Array.isArray(audio.devices) && audio.devices.length > 0, `${audio.devices.length} devices, volume ${audio.volume}`);

    const displays = await h.call('display.list');
    check('display.list lists screens', displays.screens.length > 0, `${displays.screens.length} screen(s)`);

    // A file name in Chinese, with an emoji and accents, reaches PowerShell intact (UTF-8 both ways).
    const udir = fs.mkdtempSync(path.join(os.tmpdir(), 'od-uni-'));
    const ufile = path.join(udir, '春季聚会 🎉 Ünïcödé.pptx');
    fs.copyFileSync(path.join(__dirname, '..', 'demo', 'Looking Ahead.pptx'), ufile);
    const deck = await h.call('deck.slowText', { path: ufile }, { timeoutMs: 60000 }).catch((e) => ({ error: e.message }));
    check('a file name in Chinese with an emoji is read by the helper', deck && deck.total > 0, JSON.stringify(deck).slice(0, 120));
    fs.rmSync(udir, { recursive: true, force: true });

    // A command that waited past its deadline behind a slow one must be dropped, not run late.
    const before = await h.call('debug.mark');
    const slow = h.call('debug.sleep', { ms: 1500 });
    const late = h.call('debug.mark', {}, { timeoutMs: 400 }).then(() => 'ran', (e) => e.message);
    const lateResult = await late;
    await slow;
    const after = await h.call('debug.mark');
    check('command that timed out in the queue is reported', /timed out/.test(lateResult), lateResult);
    check('...and is not executed later', after === before + 1, `marks ${before} -> ${after} (expected +1 for this read only)`);
  } finally {
    h.stop();
  }
}

// ---------------------------------------------------------------- config

function configChecks() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'stagio-cfg-'));
  process.env.STAGIO_DATA = dir;
  delete require.cache[require.resolve('../lib/config')];
  const config = require('../lib/config');
  const file = path.join(dir, 'config.json');

  const a = config.load();
  check('first run creates a config with PIN and key', /^\d{6}$/.test(a.pin) && a.accessKey.length >= 10);
  check('...with presenter view hidden, auto cues on and an empty recent list', a.hidePresenterView === true && a.autoCues === true && Array.isArray(a.recent) && a.recent.length === 0);
  check('...and cues on plain 1–9 (not Shift) until changed', a.cueShift === false);
  a.cues[0].name = 'Renamed cue';
  config.save(a);
  check('settings survive a reload', config.load().cues[0].name === 'Renamed cue');

  // Simulate a half-written file (power loss, disk full).
  fs.writeFileSync(file, '{"pin":"12');
  const b = config.load();
  check('damaged config is restored from the backup', b.pin === a.pin && b.cues[0].name === 'Renamed cue', `pin kept: ${b.pin === a.pin}`);
  check('...and the damaged file is kept for inspection', fs.readdirSync(dir).some((f) => f.startsWith('config.damaged-')));
  check('no temporary files are left behind', !fs.readdirSync(dir).some((f) => f.endsWith('.tmp')));

  // Settings from before 1.2 / 1.3: Spotify Premium mode, its sign-in, "spotify.*" cue steps.
  const old = config.load();
  old.features = { music: 'spotify' };
  old.spotify = { clientId: 'abc', tokens: { access: 'x', refresh: 'y' } };
  old.cues = [{ id: 'z', name: 'Old cue', steps: [{ type: 'spotify.fadeOut', seconds: 4 }, { type: 'spotify.playUri', uri: 'spotify:playlist:1' }, { type: 'ppt.start', slide: 1 }] }];
  delete old.music;
  config.save(old);
  const m = config.load();
  check('an old Premium setting becomes music on, and the stored Spotify sign-in is dropped', m.features.music === 'local' && m.spotify === undefined && !JSON.stringify(m).includes('refresh'));
  check('old "spotify.*" cue steps become music steps; the Premium-only playlist step is removed',
    m.cues[0].steps.map((x) => x.type).join(' ') === 'music.fadeOut ppt.start', m.cues[0].steps.map((x) => x.type).join(' '));
  check('music follows whatever plays until an app is chosen', m.music && m.music.source === '' && m.music.lastApp === null);
  m.features.music = 'off';
  config.save(m);
  check('music switched off stays off', config.load().features.music === 'off');
  fs.rmSync(dir, { recursive: true, force: true });
}

// ---------------------------------------------------------------- auto cues

async function autoCueChecks() {
  const { AutoCues } = require('../lib/autocues');
  const cues = [
    { id: 'a', name: 'Opening · music out', steps: [], auto: { deck: 'Deck.pptx', slideId: 300, slide: 3 } },
    { id: 'b', name: 'Break · black', steps: [] },
    { id: 'c', name: 'Close', steps: [], auto: { deck: 'Other.pptx', slideId: 300, slide: 3 } },
  ];
  let show = null; let on = true; let ran = [];
  const ac = new AutoCues({
    cues: () => cues, enabled: () => on, current: () => show, isRunning: () => false,
    run: async (c) => { ran.push(c.id); return []; }, onFire: () => {}, dwellMs: 40, cooldownMs: 150,
  });
  const at = (slide, slideId, notes = '') => ({ path: 'C:\\decks\\Deck.pptx', name: 'Deck.pptx', slide, slideId, notes });
  const go = async (to, wait = 100, first = false) => { const before = show; show = to; ac.onSlideChange(before, to, first); await sleep(wait); };
  const fresh = async (start) => { await sleep(170); ran = []; show = start; };

  await go(at(2, 200));
  await go(at(3, 300));
  check('auto cue runs on arriving at its slide', ran.join() === 'a', `ran: ${ran.join() || 'nothing'}`);
  check('...and a cue bound to another presentation does not', !ran.includes('c'));

  await go(at(4, 400));
  await go(at(3, 300));
  check('stepping back onto the slide does not run it again', ran.join() === 'a', `ran: ${ran.join()}`);

  await fresh(at(2, 200));
  await go(at(3, 300), 5);  // passed through without stopping
  await go(at(4, 400));
  check('paging quickly past the slide runs nothing', ran.length === 0, `ran: ${ran.join() || 'nothing'}`);

  await fresh(at(2, 200));
  await go(at(9, 300));     // slides were inserted in front of it: same slide, new number
  check('the cue follows its slide when slides are inserted before it', ran.join() === 'a', `ran: ${ran.join() || 'nothing'}`);

  await fresh(null);
  await go(at(3, 300));     // show started straight on that slide
  check('starting the show on the slide runs it', ran.join() === 'a', `ran: ${ran.join() || 'nothing'}`);

  await fresh(null);
  await go(at(3, 300), 100, true);
  check('a show already running when Stagio starts runs nothing', ran.length === 0);

  await fresh(at(4, 400));
  await go(at(5, 500, 'Speaker notes\n[cue: break]'));
  check('[cue: name] in the slide notes runs that cue', ran.join() === 'b', `ran: ${ran.join() || 'nothing'}`);
  await fresh(at(5, 500));
  await go(at(6, 600, '【cue 3】'));
  check('[cue 3] in the notes runs the third cue', ran.join() === 'c', `ran: ${ran.join() || 'nothing'}`);

  await fresh(at(2, 200));
  ac.noteRun('a');          // the operator just ran it by hand
  await go(at(3, 300));
  check('a cue just run by hand is not repeated by its slide', ran.length === 0);

  await fresh(at(2, 200));
  on = false;
  await go(at(3, 300));
  check('auto cues switched off: nothing runs', ran.length === 0);
  ac.stop();
}




// ---------------------------------------------------------------- mixer (stand-in helper and music)

async function mixerChecks() {
  const { Mixer, cleanSettings } = require('../lib/mixer');
  const sleep2 = (ms) => new Promise((r) => setTimeout(r, ms));
  const calls = [];
  const helper = { onEvent: null, call: async (cmd, a) => { calls.push([cmd, a]); return cmd === 'mixer.appVolume' ? (a.value ?? 80) : cmd === 'mixer.inputs' ? [] : { running: !!a?.on, error: '', latencyMs: 30 }; } };
  const fades = [];
  const music = { state: { isPlaying: true, volume: 80 }, fading: null, level: 80,
    fadeTo: async (to, sec) => { fades.push(['fadeTo', to, sec]); music.state.volume = to; },
    setVolume: async (v) => { fades.push(['set', v]); music.state.volume = v; },
    rawVolume: async (v) => { fades.push(['raw', v]); music.state.volume = v; } };
  const make = (pro) => new Mixer({ helper, cfg: {}, save: () => {}, pro, music: () => music, musicApp: () => 'Spotify', outputs: () => [], onChange: () => {}, onMeters: () => {} });
  const mx = make(false);
  check('mixer starts with the microphone off (never live by itself)', mx.s.mic.on === false && mx.s.on === false);
  await mx.configure({ on: true, mic: { on: true, level: 90, preset: 'clear' } });
  const micCall = calls.filter((c) => c[0] === 'mixer.mic').pop()[1];
  check('Standard: the mic goes to the speakers with the chosen EQ preset, never to AUX', micCall.on && micCall.toMix && !micCall.toAux && micCall.level === 0.9 && micCall.eq.join() === '120,-3,4000,4,2', JSON.stringify(micCall));
  let err = null;
  try { await mx.configure({ aux: { device: 'x' } }); } catch (e) { err = e.message; }
  check('Standard: no AUX output (Extra)', /Extra/.test(err || ''));
  err = null; try { mx.saveScene('A'); } catch (e) { err = e.message; }
  check('Standard: no mixer scenes (Extra)', /Extra/.test(err || ''));
  helper.onEvent({ evt: 'voice', on: true });
  check('someone speaks: the music dips (60% down in Standard)', fades.at(-1)?.[0] === 'fadeTo' && fades.at(-1)[1] === 32, JSON.stringify(fades.at(-1)));
  helper.onEvent({ evt: 'voice', on: false });
  await sleep2(1700);
  check('...and comes back after a pause of 1.5 s', fades.at(-1)?.[0] === 'fadeTo' && fades.at(-1)[1] === 80, JSON.stringify(fades.at(-1)));
  helper.onEvent({ evt: 'voice', on: true });
  music.state.isPlaying = false;              // paused by hand while dipped
  helper.onEvent({ evt: 'voice', on: false });
  await sleep2(1700);
  check('music paused meanwhile: it is not started again, only its level is put back', fades.at(-1)?.[0] === 'raw' && fades.at(-1)[1] === 80, JSON.stringify(fades.at(-1)));
  music.state.isPlaying = true;
  await mx.configure({ mic: { on: false } });
  fades.length = 0;
  helper.onEvent({ evt: 'voice', on: true });
  check('mic off: nothing dips', fades.length === 0);
  const pro = make(true);
  await pro.configure({ on: true, mic: { on: true, toAux: true, eq: [80, 2, 2500, 4, 1] }, aux: { device: 'AUXDEV', music: true }, duck: { depth: 80, release: 0.5 } });
  const p2 = calls.filter((c) => c[0] === 'mixer.mic').pop()[1];
  check('Extra: the mic can go to MIX and AUX, with its own EQ', p2.toMix && p2.toAux && p2.aux === 'AUXDEV' && p2.eq.join() === '80,2,2500,4,1' && pro.s.mic.preset === 'custom', JSON.stringify(p2));
  check('Extra: the music app can be sent to AUX (per-app router)', JSON.stringify(pro.auxRoutes()) === '{"Spotify":"aux"}');
  const id = pro.saveScene('Speaker');
  await pro.configure({ mic: { level: 20, preset: 'warm' }, aux: { music: false } });
  await pro.recallScene('Speaker');
  check('Extra: a scene saves the mixer and brings it back', pro.s.mic.level === 80 && pro.s.mic.preset === 'custom' && pro.s.aux.music === true && !!id);
  const cs = cleanSettings({ mic: { level: 999, gainDb: -99, eq: [5000, 50, 1, 50, -50] } });
  check('mixer settings are kept in range', cs.mic.level === 150 && cs.mic.gainDb === -20, JSON.stringify(cs.mic));
}

// ---------------------------------------------------------------- opening countdown on its own

async function countdownChecks() {
  const { Countdown, cleanSettings } = require('../lib/countdown');
  let t = new Date(2026, 10, 22, 9, 50, 0).getTime();
  const screen = { shown: 0, hidden: 0, show() { this.shown++; }, hide() { this.hidden++; }, mode: () => 'window' };
  let faded = null;
  const music = { state: { isPlaying: true }, fadeOut: async (sec) => { faded = sec; } };
  let runBusy = false;
  const cd = new Countdown({ cfg: {}, save: () => {}, music: () => music, busy: () => runBusy, now: () => t });
  cd.setScreen(screen);
  check('countdown settings are cleaned (minutes kept between 1 and 180, bad clock refused)',
    cleanSettings({ minutes: 999 }).minutes === 180 && cleanSettings({ mode: 'clock', clock: '25:99' }).mode === 'minutes');
  cd.start({ title: 'Starting soon', minutes: 5, fadeOut: 4, notices: 'Welcome\n\nPhones on silent' });
  check('it starts: target 5 minutes ahead, window shown, notices split by line', cd.info().target === t + 300000 && screen.shown === 1 && cd.info().notices.length === 2);
  t += 296500; cd.tick();
  check('the music fades out so it ends at zero', faded !== null && faded <= 4, `fade ${faded}`);
  t += 4000; cd.tick();
  check('at zero it says done and keeps 0:00 up for a moment', cd.summary().active?.done === true && screen.hidden === 0);
  t += 6000; cd.tick();
  check('...then the window closes and the countdown ends', cd.active === null && screen.hidden === 1);
  cd.start({ mode: 'clock', clock: '10:00' });
  check('to a clock time: today at 10:00', cd.info().target === new Date(2026, 10, 22, 10, 0, 0).getTime());
  cd.stop();
  runBusy = true;
  let err = null;
  try { cd.start(); } catch (e) { err = e.message; }
  check('it does not start while the run of show shows its own countdown', /run of show/i.test(err || ''));
}

// ---------------------------------------------------------------- headphone preview (stand-in helper)

async function previewChecks() {
  const { Preview } = require('../lib/preview');
  const calls = [];
  let devices = [{ id: 'spk', name: 'Speakers', isDefault: true }];
  const control = { call: async (cmd, a) => {
    calls.push(a);
    // the helper reports which programs it sent somewhere
    return { available: true, changed: 0, apps: [{ name: 'chrome', label: 'Chrome', route: a.on ? 'phones' : 'default', active: true }], touched: a.on ? ['chrome'] : [] };
  } };
  const cfg = {};
  let saves = 0; let changes = 0;
  const pv = new Preview({ control, cfg, save: () => saves++, pro: false, musicApp: () => 'Spotify', devices: () => devices, onChange: () => changes++ });
  check('preview starts off, with its settings created', pv.on === false && cfg.preview && cfg.preview.phones === '' && Array.isArray(cfg.preview.touched));
  let err = null;
  try { await pv.setOn(true); } catch (e) { err = e.message; }
  check('it cannot be turned on before the headphones are chosen', /headphones/i.test(err || ''), err || 'no error');
  pv.devicesChanged();                                            // first poll: nothing happens
  devices = [...devices, { id: 'hp', name: 'USB Headset', isDefault: false }];
  pv.devicesChanged();
  check('a new sound device is offered as the headphones', pv.prompt?.kind === 'new' && pv.prompt.id === 'hp');
  await pv.configure({ phones: 'hp' });
  await pv.setOn(true);
  const last = calls[calls.length - 1];
  check('on: the music app and PowerPoint stay on the speakers, the rest goes to the headphones',
    last.on === true && last.phones === 'hp' && last.stay.includes('POWERPNT') && last.stay.includes('Spotify') && last.room === '', JSON.stringify(last.stay));
  check('programs it moved are remembered in the settings (to set them back later)', JSON.stringify(cfg.preview.touched) === '["chrome"]' && saves > 0);
  devices = devices.filter((d) => d.id !== 'hp');
  pv.devicesChanged();
  check('unplugging the headphones turns it off and says so', pv.on === false && /unplugged/i.test(pv.notice?.text || ''));
  await pv.tick();
  check('...and the next round sets the moved programs back', calls[calls.length - 1].on === false && JSON.stringify(cfg.preview.touched) === '[]');
  devices = [...devices, { id: 'hp', name: 'USB Headset', isDefault: false }];
  pv.devicesChanged();
  check('plugging the chosen headphones in again asks to turn it on', pv.prompt?.kind === 'plugged' && pv.on === false);
  err = null;
  try { await pv.setApp('chrome', 'room'); } catch (e) { err = e.message; }
  check('Standard has no per-app choices (Extra)', /Extra/.test(err || ''));
  const pro = new Preview({ control, cfg: { preview: { phones: 'hp' } }, save: () => {}, pro: true, musicApp: () => '', devices: () => devices });
  await pro.setApp('vlc', 'room');
  await pro.configure({ keep: ['Teams', 'Teams', ' obs64 '] });
  await pro.setOn(true);
  const l2 = calls[calls.length - 1];
  check('Extra: an app chosen for the speakers and the kept apps are passed on',
    l2.overrides.vlc === 'room' && l2.stay.includes('Teams') && l2.stay.includes('obs64') && l2.stay.filter((x) => x === 'Teams').length === 1, JSON.stringify(l2));
  await pro.shutdown();
  check('quitting turns it off first', calls[calls.length - 1].on === false && pro.on === false);
}

// ---------------------------------------------------------------- which slide image is shown

// ---------------------------------------------------------------- music fades (local mode)
// The order of steps around a fade, with a stand-in for the music helper (no sound is played).
// The smoothness itself was measured with a recorded test tone (README: 音乐淡入淡出).

async function fadeChecks() {
  const { LocalMusic } = require('../lib/localmusic');
  let calls = [];
  let playing = true; let vol = 80; let fadeId = 0; const fades = {};
  let stopReportedAt = 0; // after a pause, the stand-in music app still says "playing" until then
  const control = {
    async call(cmd, args = {}) {
      calls.push(cmd === 'music.do' ? `do:${args.action}` : cmd === 'music.volume' ? `volume:${args.value}${args.glideMs ? `:glide${args.glideMs}` : ''}` : cmd);
      switch (cmd) {
        case 'music.state': return { running: true, session: true, isPlaying: playing || Date.now() < stopReportedAt, volume: vol };
        case 'music.fade': { const id = ++fadeId; fades[id] = { state: 'running', to: args.to, from: args.from, until: Date.now() + args.ms }; return id; }
        case 'music.fadeStatus': {
          if (args.id !== fadeId) return { state: 'replaced', level: vol };
          const f = fades[args.id];
          if (f.state === 'running' && Date.now() >= f.until) { f.state = 'done'; vol = f.to; }
          return { state: f.state, level: vol };
        }
        case 'music.fadeStop': if (args.id === fadeId) { fades[args.id].state = 'stopped'; fadeId++; } return true;
        case 'music.volume': vol = args.value; return 1;
        case 'music.silenceWhenReady': vol = 0; return true;
        case 'music.do':
          if (args.action === 'pause') { playing = false; stopReportedAt = Date.now() + 250; }
          if (args.action === 'play') playing = true;
          return true;
        default: return null;
      }
    },
  };
  const m = new LocalMusic(control);
  await m.poll();

  // fade-out: one glide in the helper (from where it is now), pause, wait until really stopped, then the level back
  calls = [];
  const t0 = Date.now();
  await m.fadeOut(0.3);
  const seq = calls.filter((c) => c !== 'music.fadeStatus' && c !== 'music.state');
  check('fade-out runs as one glide in the helper, not as volume steps', seq[0] === 'music.fade' && !calls.some((c) => /^volume:\d+$/.test(c) && c !== 'volume:80'), seq.join(' '));
  const restoreAt = calls.indexOf('volume:80');
  check('...then pauses, and puts the level back only after the music app reports it stopped',
    seq.join(' ') === 'music.fade do:pause volume:80' && restoreAt > calls.lastIndexOf('music.state') && Date.now() - t0 >= 300 + 250 + 400, `${Date.now() - t0} ms`);

  // fade-in from paused: silent first, play, silenced the moment the audio exists, then one glide up
  calls = [];
  await m.fadeIn(0.3);
  const seq2 = calls.filter((c) => c !== 'music.fadeStatus' && c !== 'music.state');
  check('fade-in: level 0, play, silenced as soon as the audio exists, then one glide up',
    seq2.join(' ') === 'volume:0 do:play music.silenceWhenReady music.fade', seq2.join(' '));
  check('...ending at the normal level', vol === 80, `level ${vol}`);

  // a fade-out cut short by a fade-in: the first glide is stopped, by its own number only
  calls = [];
  const out = m.fadeOut(2);
  await sleep(300);
  await m.fadeIn(0.3);
  await out;
  const stops = calls.filter((c) => c === 'music.fadeStop').length;
  check('a fade cut short by another stops only the first glide', stops === 1 && vol === 80 && !calls.includes('do:pause'), `${stops} stop(s), level ${vol}, ${calls.includes('do:pause') ? 'paused (wrong)' : 'kept playing'}`);

  // the slider: a short glide, not a jump
  calls = [];
  await m.setVolume(40);
  check('a level set by hand glides over 0.3 s instead of jumping', calls.join(' ') === 'volume:40:glide300', calls.join(' '));

  // fade from a chosen level to a chosen level
  vol = 70; playing = true; await m.poll();
  calls = [];
  await m.fadeTo(30, 0.3, 50);
  const seq3 = calls.filter((c) => c !== 'music.fadeStatus' && c !== 'music.state');
  check('fade from 50 to 30 while playing: a short glide to 50, then the fade to 30, music keeps playing',
    seq3.join(' ') === 'music.fade music.fade' && vol === 30 && !calls.includes('do:pause'), `${seq3.join(' ')} · level ${vol}`);
  check('...30 becomes the level Fade in returns to', m.level === 30, `level ${m.level}`);
  calls = [];
  await m.fadeTo(0, 0.3);
  check('fade to 0: ends paused, level put back for the next play', calls.includes('do:pause') && vol === 30, `level ${vol}`);
  calls = [];
  await m.fadeTo(60, 0.3, 20);
  const seq4 = calls.filter((c) => c !== 'music.fadeStatus' && c !== 'music.state');
  check('fade from 20 to 60 while stopped: starts silent, rises to 20, then fades to 60',
    seq4.join(' ') === 'volume:0 do:play music.silenceWhenReady music.fade music.fade' && vol === 60, `${seq4.join(' ')} · level ${vol}`);
}

function imageChecks() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'stagio-thumbs-'));
  const before = process.env.STAGIO_THUMBS;
  process.env.STAGIO_THUMBS = dir;
  delete require.cache[require.resolve('../lib/powerpoint')];
  const { PowerPoint } = require('../lib/powerpoint');
  const idle = { call: async () => ({}) };
  const ppt = new PowerPoint(idle, idle);
  const deck = 'C:\\decks\\Sunday.pptx';
  ppt.state = { running: true, presentations: [{ path: deck }], active: deck };
  ppt.resetDeck(deck);
  ppt.ids = [256, 257];
  ppt.info.set(256, { title: 'One', hidden: false, sig: 'aaaa' });
  ppt.info.set(257, { title: 'Two', hidden: false, sig: 'bbbb' });
  const ui = () => ppt.slidesForUi().slides;

  ppt.fonts = { pdf: true, embedded: ['Bebas Neue Bold'], missing: ['Bebas Neue Bold'], at: Date.now() };
  ppt.ready.add('256-aaaa'); // made by the normal renderer: wrong fonts for this deck
  check('embedded fonts: an image with the wrong fonts is never shown', ui()[0].thumb === false);
  ppt.ready.add('256-aaaap');
  check('...the PDF-rendered one is', ui()[0].thumb && ui()[0].v === 'aaaap');
  ppt.ready.add('256-aaaac');
  check('a projector image from before 0.7.1 (may be cut off) is not used', ui()[0].v === 'aaaap');
  ppt.ready.add('256-aaaac2');
  check('an image saved from the projector wins over a rendered one', ui()[0].v === 'aaaac2');

  ppt.state.show = { path: deck, slide: 2, slideId: 257, total: 2, state: 'running', click: 0, clicks: 0 };
  check('during a show, a slide of such a deck with no image still gets one: a quick draft (PDF is slow here)',
    ppt.needsRender(257, ppt.info.get(257), true) === true && ppt.slidesForUi().waitShow === false);
  ppt.ready.add('257-bbbbq');
  check('...shown at once, marked as a draft', ui()[1].thumb === true && ui()[1].draft === true && ui()[1].v === 'bbbbq');
  check('...not made again during the show', ppt.needsRender(257, ppt.info.get(257), true) === false);
  check('...but the exact image is still wanted after the show', ppt.needsRender(257, ppt.info.get(257), false) === true);
  ppt.msPerSlide.pdf = 900;
  check('a deck whose PDF images are quick gets exact images during the show too', ppt.needsRender(257, ppt.info.get(257), true) === true);
  ppt.msPerSlide.pdf = undefined;
  ppt.msPerSlide.export = 150;
  check('quick images: rendering waits only ~1 s after a slide change (was 8 s)', ppt.showIdleMs() <= 1500, `${ppt.showIdleMs()} ms`);
  ppt.msPerSlide.export = 3000;
  check('slow images: it waits longer, so a slide change never queues behind one', ppt.showIdleMs() >= 5000, `${ppt.showIdleMs()} ms`);
  ppt.msPerSlide.export = undefined;
  ppt.ready.delete('257-bbbbq');
  ppt.steadySince = Date.now() - 2000;
  const target = ppt.captureTarget();
  check('a slide on the projector for a moment is saved from it', target?.name === '257-bbbbc2', target?.name);
  check('...once, not again right away', ppt.captureTarget() === null);
  ppt.captureTried.clear();
  ppt.state.show = { ...ppt.state.show, click: 1, clicks: 3 };
  check('not while animations are still to come', ppt.captureTarget() === null);
  ppt.state.show = { ...ppt.state.show, click: 3, state: 'black' };
  check('not on a black screen', ppt.captureTarget() === null);
  ppt.state.show = { ...ppt.state.show, state: 'running' };
  ppt.steadySince = Date.now();
  check('not right after the slide changed', ppt.captureTarget() === null);
  ppt.steadySince = Date.now() - 2000;
  const t2 = ppt.captureTarget();
  ppt.info.get(257).sig = 'cccc'; // edited while it was being captured
  ppt.captured(t2);
  check('a capture of a slide edited meanwhile is not kept', !ppt.ready.has('257-bbbbc2') && ui()[1].thumb === false);

  ppt.activity = { app: 'POWERPNT', idleMs: 600, at: Date.now() };
  check('someone working in PowerPoint pauses background work', ppt.userInPowerPoint() === true);
  ppt.activity = { app: 'POWERPNT', idleMs: 9000, at: Date.now() };
  check('...until they stop for a few seconds', ppt.userInPowerPoint() === false);
  ppt.activity = { app: 'Stagio', idleMs: 100, at: Date.now() };
  check('...and only when it is PowerPoint they are using', ppt.userInPowerPoint() === false);

  fs.rmSync(dir, { recursive: true, force: true });
  if (before === undefined) delete process.env.STAGIO_THUMBS; else process.env.STAGIO_THUMBS = before;
}

// ---------------------------------------------------------------- running server

// ---------------------------------------------------------------- editions (Beta 1.0)

function editionChecks() {
  const { versionLabel, FEATURES, current } = require('../lib/edition');
  const labels = ['1.0.0-beta', '1.1.0-beta', '1.2.1-beta', '2.0.0-beta', '1.0.0', '1.3.2', '0.8.1'].map(versionLabel);
  check('version labels read like Beta 1.0, Beta 1.2.1, 1.0', labels.join('|') === 'Beta 1.0|Beta 1.1|Beta 1.2.1|Beta 2.0|1.0|1.3.2|0.8.1', labels.join(' | '));
  const order = ['lite', 'standard', 'extra'];
  const nested = order.every((e, i) => i === 0 || Object.keys(FEATURES[e]).every((f) => !FEATURES[order[i - 1]][f] || FEATURES[e][f]));
  check('each edition has everything the smaller one has (Lite ⊂ Standard ⊂ Extra)', nested);
  const liteOn = Object.entries(FEATURES.lite).filter(([, v]) => v).map(([k]) => k).sort().join(',');
  check('Lite: only projector mode and the system volume on top of the slides (no music, output device, cues, countdown, run of show)', liteOn === 'displayMode,volume', liteOn);
  check('Standard: the countdown on its own, but no run of show or stage display', FEATURES.standard.countdown && !FEATURES.standard.run && !FEATURES.standard.stage);
  check('only Extra has the run of show', FEATURES.extra.run && !FEATURES.standard.run);
  const saved = process.env.STAGIO_EDITION;
  process.env.STAGIO_EDITION = 'extra';
  const e = current();
  process.env.STAGIO_EDITION = 'nonsense';
  const fallback = current();
  if (saved === undefined) delete process.env.STAGIO_EDITION; else process.env.STAGIO_EDITION = saved;
  check('the edition can be set for a test run, and an unknown one falls back to Standard', e.id === 'extra' && e.name === 'Stagio Extra' && fallback.id === 'standard', `${e.name} ${e.label}`);
  const eds = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'editions.json'), 'utf8'));
  check('every edition has a Windows and a Mac version number', order.every((x) => /^\d+\.\d+\.\d+/.test(eds[x]?.windows) && /^\d+\.\d+\.\d+/.test(eds[x]?.mac)));
}

// ---------------------------------------------------------------- run of show (Extra)
// The run of show with stand-ins for PowerPoint, the music, the countdown window and the clock.

async function runChecks() {
  const { RunOfShow, cleanPart } = require('../lib/runofshow');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'od-run-'));
  const fileA = path.join(tmp, 'A.pptx');
  const fileB = path.join(tmp, 'B.pptx');
  fs.writeFileSync(fileA, 'x');
  fs.writeFileSync(fileB, 'x');

  const c = cleanPart({ kind: 'weird', minutes: 9999, name: '' }, 0);
  const cd = cleanPart({ kind: 'countdown', until: '9:05', notices: 'Welcome\n\nPhones off\n', fadeOut: 99 }, 1);
  check('a part is stored cleaned up (unknown kind → manual, minutes capped, notices one per line)',
    c.kind === 'manual' && c.minutes === 600 && c.name === 'Manual 1' && cd.until === '09:05' && cd.notices.join('|') === 'Welcome|Phones off' && cd.fadeOut === 30);

  let clock = Date.parse('2026-11-20T09:00:00');
  const calls = [];
  const ppt = {
    state: { show: null, presentations: [] },
    focus: null,
    async cmd(name, a = {}) {
      calls.push(`${name}${a.path ? `:${path.basename(a.path)}` : ''}${a.background ? ':bg' : ''}`);
      if (name === 'ppt.open') {
        if (!fs.existsSync(a.path)) throw new Error(`File not found: ${a.path}`);
        if (!this.state.presentations.some((p) => p.path === a.path)) this.state.presentations.push({ path: a.path, name: path.basename(a.path) });
        return a.path;
      }
      if (name === 'ppt.start') this.state.show = { path: a.path, slide: a.slide, state: 'running' };
      if (name === 'ppt.setState') this.state.show.state = a.state;
      return true;
    },
    poll: async () => {},
  };
  const fades = [];
  const music = { fadeOut: async (s) => { fades.push(`out ${Math.round(s)}`); }, fadeIn: async (s, v) => { fades.push(`in ${s} ${v}`); } };
  const screen = { shown: 0, hidden: 0, focused: 0, show() { this.shown++; }, hide() { this.hidden++; }, focusConsole() { this.focused++; }, mode: () => 'full' };
  const cfg = {};
  const segments = [];
  const ros = new RunOfShow({
    cfg, save: () => {}, ppt, music: () => music, cues: { run: async () => [] }, cueList: () => [],
    onChange: () => {}, segment: (n) => segments.push(n), now: () => clock,
  });
  ros.setScreen(screen);
  ros.setShows([{ id: 'r1', name: 'Test', parts: [
    { id: 'c', kind: 'countdown', name: 'Countdown', minutes: 10, title: 'Soon', fadeOut: 5, autoNext: true, musicIn: { on: true, volume: 50, seconds: 3 } },
    { id: 'a', kind: 'slides', name: 'Speaker A', minutes: 20, file: fileA, slide: 1, musicOut: { on: true, seconds: 4 } },
    { id: 'm', kind: 'music', name: 'Break', minutes: 10, black: true, musicIn: { on: true, volume: 60, seconds: 4 } },
    { id: 'b', kind: 'slides', name: 'Speaker B', minutes: 20, file: fileB, slide: 3 },
    { id: 'x', kind: 'slides', name: 'Nobody', minutes: 5, file: '' },
  ] }]);

  await ros.start('r1');
  const info = ros.countdownInfo();
  check('start: the countdown goes on the projector with its music', screen.shown === 1 && info?.title === 'Soon' && info.target - clock === 600000 && fades.includes('in 3 50'), JSON.stringify(fades));
  await sleep(30);
  check('...and the first speaker\'s file is opened ahead, without a window', calls.includes(`ppt.open:A.pptx:bg`), calls.join(' '));
  clock += 600000 - 4000; ros.tick();
  check('the music fades out to end at zero (5 s before: only 4 s left, so over 4 s)', fades.includes('out 4'), JSON.stringify(fades));
  calls.length = 0;
  clock += 4000; ros.tick();
  await sleep(30);
  check('at zero the run goes on by itself to the next part', ros.run.index === 1 && segments.at(-1) === 'Speaker A');
  check('...opens the file, starts its show, then ends the others (no desktop in between)', calls.slice(0, 3).join(' ') === 'ppt.open:A.pptx:bg ppt.start:A.pptx ppt.endOthers:A.pptx', calls.join(' '));
  check('...and the countdown window goes once the show is up', screen.hidden === 1 && screen.focused === 1);

  await ros.next();
  check('a break: black screen and the music comes in', ppt.state.show.state === 'black' && fades.includes('in 4 60'));

  calls.length = 0;
  ppt.endBeforeStart = true; // PowerPoint for Mac: one show at a time
  await ros.next();
  check('on a Mac the old show ends before the next one starts', calls.slice(0, 3).join(' ') === 'ppt.open:B.pptx:bg ppt.endOthers:B.pptx ppt.start:B.pptx' && ppt.state.show.slide === 3, calls.join(' '));
  delete ppt.endBeforeStart;

  const segAtB = ros.run.segAt;
  const noFile = await ros.next().then(() => 'went', (e) => e.message);
  check('a part whose file is missing says so, and the run stays on the part still on screen (its timer goes on)',
    /has no file/.test(noFile) && ros.run.index === 3 && ros.run.segAt === segAtB && /did not start/.test(ros.summary().active.error) && !ros.summary().active.busy, noFile);
  ros.show('r1').parts[4].file = fileA;
  await ros.next();
  check('...and once the file is there, the same press goes on', ros.run.index === 4 && !ros.summary().active.error);
  const pastEnd = await ros.next().then(() => 'went', (e) => e.message);
  check('there is nothing after the last part', /last part/.test(pastEnd));

  // Planned 10 + 20 + 10 + 20 min before the last part; it started 10 min into the event.
  const sum = ros.summary().active;
  check('ahead/behind: the planned time of the parts before this one is known', sum.plannedBefore === 60 * 60000 && sum.planned.length === 5);

  let release;
  ppt.cmd = ((orig) => async function (name, a) { if (name === 'ppt.start') await new Promise((r) => { release = r; }); return orig.call(this, name, a); })(ppt.cmd);
  const first = ros.go(1);
  await sleep(10);
  const second = await ros.go(3);
  release();
  await first;
  check('a second press while a part is still starting is ignored (no skipping two parts)', second.busy === true && ros.run.index === 1);

  const again = new RunOfShow({ cfg, save: () => {}, ppt, music: () => music, cues: { run: async () => [] }, cueList: () => [], onChange: () => {}, segment: () => {}, now: () => clock });
  check('after a restart of Stagio the run carries on where it was', again.run?.index === 1 && again.current?.name === 'Speaker A');
  await ros.start('r1', 2);
  const mid = ros.summary().active;
  check('a run started part-way is on time from there (not ahead by the skipped parts)', mid.segAt - mid.startedAt === mid.plannedBefore && mid.plannedBefore === 30 * 60000);
  ros.setShows([]);
  check('deleting the run in progress stops it', ros.run === null);

  ros.setShows([{ id: 'r2', name: 'Broken', parts: [{ id: 'g', kind: 'slides', name: 'Gone', minutes: 5, file: path.join(tmp, 'gone.pptx') }] }]);
  const notStarted = await ros.start('r2').then(() => 'went', (e) => e.message);
  check('a run whose first part does not start is not left half-started', /did not start/.test(notStarted) && ros.run === null, notStarted);
  fs.rmSync(tmp, { recursive: true, force: true });
}

async function serverChecks() {
  const BASE = 'http://127.0.0.1:7300';
  const get = (p, opt) => fetch(BASE + p, opt);
  const post = (p, headers = {}, body = '{}') => fetch(BASE + p, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body });

  const ping = await get('/api/ping').then((r) => r.json()).catch((e) => ({ error: e.message }));
  if (!ping.ok) { check('server reachable on 127.0.0.1:7300', false, ping.error || 'start it with: npm run dev'); return; }
  check('server reachable on 127.0.0.1:7300', true);
  const st0 = await get('/api/state').then((r) => r.json());
  const ed = st0.edition || { id: 'standard', features: { music: true, cues: true, run: false } };
  console.log(`      (checking ${ed.name || 'Stagio'} ${ed.label || ''})`);

  // Requests from other web sites must be refused, even though they arrive from this PC.
  const cross = await post('/api/features', { Origin: 'https://example.com' });
  check('cross-site POST is refused', cross.status === 403, `status ${cross.status}`);
  // A hostile page that points its own domain at 127.0.0.1 still sends its own name as Host.
  // (fetch can't set Host, so this one is a raw request.)
  const raw = await new Promise((resolve) => {
    const req = require('http').request({ host: '127.0.0.1', port: 7300, path: '/api/state', headers: { Host: 'evil.example:7300' } }, (res) => resolve(res.statusCode));
    req.on('error', () => resolve(0));
    req.end();
  });
  check('request with a foreign Host header is refused (DNS rebinding)', raw === 403, `status ${raw}`);
  const sameOrigin = await post('/api/settings', { Origin: BASE });
  check('same-origin POST is accepted', sameOrigin.status === 200, `status ${sameOrigin.status}`);

  // Remote pairing details are for the PC console only.
  const remote = await get('/api/remote').then((r) => r.json());
  check('/api/remote works on the PC', remote.ok === true);
  const state = await get('/api/state').then((r) => r.json());
  check('live state does not carry the PIN or access key', !JSON.stringify(state).includes(remote.data?.pin || '\u0000') || !remote.data);
  if (remote.data) {
    const lan = remote.data.url.replace(/\/$/, '');
    const noKey = await fetch(`${lan}/api/state`).catch(() => null);
    check('LAN request without a key is refused', noKey?.status === 401, `status ${noKey?.status}`);
    // The QR code carries a pairing code, never a key; the phone swaps it for a key of its own.
    const code = new URL(remote.data.qrUrl).searchParams.get('pair');
    check('the QR code carries a pairing code, not a key', !!code && !new URL(remote.data.qrUrl).searchParams.get('key') && remote.data.pairUntil - Date.now() > 8 * 60000);
    const paired = await fetch(`${lan}/api/pair`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) Safari/604.1' }, body: JSON.stringify({ code }) }).then((r) => r.json()).catch(() => ({}));
    const key = paired.data?.key;
    check('scanning it gives the phone its own key', paired.ok === true && typeof key === 'string' && key.length >= 20);
    const wrongCode = await fetch(`${lan}/api/pair`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code: 'not-the-code' }) }).then((r) => r.status).catch(() => 0);
    check('a wrong pairing code gives nothing', wrongCode === 401, `status ${wrongCode}`);
    const withKey = await fetch(`${lan}/api/state`, { headers: { 'X-Stagio-Key': key } }).catch(() => null);
    check('LAN request with the key is accepted', withKey?.status === 200, `status ${withKey?.status}`);
    const remoteFromLan = await fetch(`${lan}/api/remote`, { headers: { 'X-Stagio-Key': key } }).catch(() => null);
    check('/api/remote is refused from other devices', remoteFromLan?.status === 403, `status ${remoteFromLan?.status}`);
    const page = await fetch(`${lan}/`).catch(() => null);
    check('sign-in page loads from the LAN without a key', page?.status === 200);
  } else {
    console.log('      (no LAN address: LAN checks skipped)');
  }

  // Headphone preview: Standard (basic) and Extra (full), on Windows; not in Lite.
  const pvStatus = await post('/api/preview', {}, JSON.stringify({ on: true })).then((r) => r.status);
  const stPv = await get('/api/state').then((r) => r.json());
  const types = await get('/api/cues/types').then((r) => (r.ok ? r.json() : {}));
  if (!ed.features.preview) {
    check('Lite has no headphone preview', pvStatus === 403 && !stPv.preview, `status ${pvStatus}`);
  } else if (stPv.preview) {
    check('headphone preview is there, and full only in Extra', stPv.preview.pro === !!ed.features.previewPro && stPv.preview.on === false);
    check('it does not turn on without headphones chosen', pvStatus >= 400, `status ${pvStatus}`);
    const perApp = await post('/api/preview/app', {}, JSON.stringify({ name: 'checks', route: 'room' })).then((r) => r.status);
    check(ed.features.previewPro ? 'Extra: per-app choices are accepted' : 'Standard: no per-app choices', ed.features.previewPro ? perApp === 200 : perApp >= 400, `status ${perApp}`);
    if (ed.features.previewPro) await post('/api/preview/app', {}, JSON.stringify({ name: 'checks', route: 'auto' }));
    check('the cue step for it only in Extra', !!types['audio.preview'] === !!ed.features.previewPro);
  }

  // Mixer: Standard (basic) and Extra (full), on Windows; not in Lite.
  const mxStatus = await post('/api/mixer', {}, JSON.stringify({ duck: { on: true } })).then((r) => r.status);
  const stMx = await get('/api/state').then((r) => r.json());
  if (!ed.features.mixer) check('Lite has no mixer', mxStatus === 403 && !stMx.mixer, `status ${mxStatus}`);
  else if (stMx.mixer) {
    check('the mixer is there, full only in Extra, the microphone off', stMx.mixer.pro === !!ed.features.mixerPro && stMx.mixer.mic.on === false);
    const auxStatus = await post('/api/mixer', {}, JSON.stringify({ aux: { device: '' } })).then((r) => r.status);
    check(ed.features.mixerPro ? 'Extra: the AUX output can be set' : 'Standard: no AUX output', ed.features.mixerPro ? auxStatus === 200 : auxStatus >= 400, `status ${auxStatus}`);
    check('the mixer-scene cue step only in Extra', !!types['mixer.scene'] === !!ed.features.mixerPro);
  }

  // No Spotify Web API (Premium) any more: its sign-in pages are gone.
  const gone = [await get('/spotify/login', { redirect: 'manual' }).then((r) => r.status), await get('/api/spotify/playlists').then((r) => r.status)];
  check('the Spotify Premium sign-in and its API are gone', gone.every((x) => x === 404), gone.join(' '));
  // Reordering checks what it is given.
  const badMove = await post('/api/ppt/move', {}, JSON.stringify({ path: '', id: 'x', to: 0 }));
  check('moving a slide needs a file, a slide and a place', badMove.status >= 400, `status ${badMove.status}`);
  if (ed.features.music) {
    const pick = await post('/api/music/source', {}, JSON.stringify({ id: 'Checks.exe' }));
    const st1 = await get('/api/state').then((r) => r.json());
    const back = await post('/api/music/source', {}, JSON.stringify({ id: '' }));
    const st2 = await get('/api/state').then((r) => r.json());
    check('the music app can be chosen, and set back to automatic',
      pick.status === 200 && back.status === 200 && st1.localMusic?.pinned === 'Checks.exe' && st2.localMusic?.pinned === '',
      `${st1.localMusic?.pinned} -> "${st2.localMusic?.pinned}"`);
    check('the state shows no program path of the music app', !JSON.stringify(st2.localMusic || {}).includes('\\\\') && !/"path"/.test(JSON.stringify(st2.localMusic || {})));
  }

  // Live stream: a full snapshot first, then only the parts that changed; rebuilt state must match.
  const ctrl = new AbortController();
  const res = await get('/api/events', { signal: ctrl.signal });
  let live = null; let messages = 0; let bytes = 0; let fulls = 0; let buf = '';
  (async () => {
    try {
      for await (const chunk of res.body) {
        bytes += chunk.length;
        buf += Buffer.from(chunk).toString();
        let i;
        while ((i = buf.indexOf('\n\n')) >= 0) {
          const block = buf.slice(0, i); buf = buf.slice(i + 2);
          const line = block.split('\n').find((l) => l.startsWith('data: '));
          if (!line) continue;
          const p = JSON.parse(line.slice(6));
          messages++;
          if (p._full) { fulls++; live = p; delete live._full; } else if (live) Object.assign(live, p);
        }
      }
    } catch { /* aborted */ }
  })();
  await sleep(1200);
  check('stream starts with one full snapshot', fulls === 1 && live && 'ppt' in live && 'cues' in live, `${messages} message(s)`);
  // Change something small and reversible (restored below): the music mode, or in Lite a setting.
  if (ed.features.music) {
    const modeBefore = live.features.music;
    const other = modeBefore === 'off' ? 'local' : 'off';
    await post('/api/features', {}, JSON.stringify({ music: other }));
    await sleep(700);
    check('a change arrives as a patch', live.features.music === other && fulls === 1);
    await post('/api/features', {}, JSON.stringify({ music: modeBefore }));
  } else {
    const before = live.settings.autoCues;
    await post('/api/settings', {}, JSON.stringify({ autoCues: !before }));
    await sleep(700);
    check('a change arrives as a patch', live.settings.autoCues === !before && fulls === 1);
    await post('/api/settings', {}, JSON.stringify({ autoCues: before }));
  }
  await sleep(6500); // long enough to see a heartbeat
  const now = await get('/api/state').then((r) => r.json());
  const strip = (s) => { const c = JSON.parse(JSON.stringify(s)); delete c.program; delete c.localMusic; delete c.audio; if (c.ppt) delete c.ppt.slides; return JSON.stringify(c); };
  check('state rebuilt from patches matches the server', strip(live) === strip(now));
  check('heartbeats keep the stream alive when nothing changes', messages >= 4, `${messages} messages, ${Math.round(bytes / 1024)} KB in ~8 s`);

  // Settings arrive over the same stream; cue "run by itself" bindings are stored cleaned up.
  const put = (body) => fetch(`${BASE}/api/cues`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const hideBefore = live.settings.hidePresenterView;
  await post('/api/settings', {}, JSON.stringify({ hidePresenterView: !hideBefore, autoCues: 'yes' }));
  await sleep(500);
  check('a settings change reaches the consoles', live.settings.hidePresenterView === !hideBefore && typeof live.settings.autoCues === 'boolean');
  await post('/api/settings', {}, JSON.stringify({ hidePresenterView: hideBefore }));
  if (now.cues.length && ed.features.cues) {
    const edited = JSON.parse(JSON.stringify(now.cues));
    edited[0].auto = { deck: 'C:\\somewhere\\Deck.pptx', slideId: '261', slide: 5, extra: 'x' };
    await put(edited);
    await sleep(500);
    const a = live.cues[0].auto;
    check('a cue\'s slide binding is saved (file name and slide ID only)', a && a.deck === 'Deck.pptx' && a.slideId === 261 && a.slide === 5 && !('extra' in a), JSON.stringify(a));
    await put(now.cues);
    await sleep(500);
    check('...and removed again', JSON.stringify(live.cues) === JSON.stringify(now.cues));
  }

  // Show timer, connected phones, cue keys, earlier versions (0.7.0).
  const fresh = await get('/api/ping').then((r) => r.json());
  check('ping carries the PC clock (show timer on phones)', Math.abs((fresh.now || 0) - Date.now()) < 2000, `${(fresh.now || 0) - Date.now()} ms`);
  check('state has the show timer and the count of connected phones', !!live.timer && 'segAt' in live.timer && typeof live.remotes === 'number');
  check('state says whether the slow-text check is done and lists earlier versions', 'checked' in live.fastCopy && Array.isArray(live.fastCopy.backups));
  const shiftBefore = !!live.settings.cueShift;
  await post('/api/settings', {}, JSON.stringify({ cueShift: !shiftBefore }));
  await sleep(500);
  check('the cue-key setting (Shift + 1–9) reaches the consoles', live.settings.cueShift === !shiftBefore);
  await post('/api/settings', {}, JSON.stringify({ cueShift: shiftBefore }));
  const segBefore = live.timer?.segAt || 0;
  await sleep(20);
  await post('/api/timer/segment');
  await sleep(500);
  check('restarting the segment timer reaches the consoles', live.timer.segAt > segBefore && live.timer.segBy === '');
  const bad = await post('/api/ppt/restoreBackup', {}, JSON.stringify({ file: '..\\config.json' })).then((r) => r.json());
  check('restoring anything but an earlier version of the deck in view is refused', !bad.ok, bad.error);

  // Bluetooth remote (0.8.0): every command carries the PIN; wrong PINs are ignored and a phone
  // that keeps guessing is locked out for 5 minutes.
  if (remote.data?.pin) {
    const bt = (command, phone = 'checks-phone') => post('/api/debug/bluetoothCommand', {}, JSON.stringify({ phone, command })).then((r) => r.json());
    const a0 = (await bt({ pin: remote.data.pin, c: 'hello' })).data.accepted;
    const wrong = await bt({ pin: '000000', c: 'hello' });
    check('Bluetooth: a command with a wrong PIN is ignored', wrong.data.accepted === a0, `accepted ${a0} -> ${wrong.data.accepted}`);
    const right = await bt({ pin: remote.data.pin, c: 'hello' });
    check('Bluetooth: with the right PIN it is accepted (the phone sees the count go up)', right.data.accepted === a0 + 1);
    check('Bluetooth: the state for phones stays small', JSON.stringify(right.data.state).length < 180, `${JSON.stringify(right.data.state).length} bytes`);
    for (let i = 0; i < 8; i++) await bt({ pin: '111111', c: 'hello' }, 'guessing-phone');
    const locked = await bt({ pin: remote.data.pin, c: 'hello' }, 'guessing-phone');
    check('Bluetooth: after 8 wrong PINs that phone is locked out, even with the right PIN', locked.data.accepted === right.data.accepted);
    const other = await bt({ pin: remote.data.pin, c: 'hello' }, 'another-phone');
    check('...other phones are not', other.data.accepted === right.data.accepted + 1);
  }
  // What this edition has, and refuses what it doesn't (Beta 1.0).
  const status = (p, body = '{}', method = 'POST') => fetch(BASE + p, { method, headers: { 'Content-Type': 'application/json' }, body }).then((r) => r.status);
  check('the state says which edition this is', ['lite', 'standard', 'extra'].includes(now.edition?.id) && /Stagio/.test(now.edition?.name || ''), `${now.edition?.name} ${now.edition?.label}`);
  if (!ed.features.music) {
    const refused = [await status('/api/music/toggle'), await status('/api/cues', '[]', 'PUT'), await status('/api/audio/device', '{"id":"x"}'), await status('/api/countdown', '{}'), await status('/api/display/mode', '{"mode":"extend"}')];
    refused.pop(); // display mode: part of Lite now (checked below)
    check('Lite refuses music, cues, choosing the output device and the countdown', refused.every((x) => x === 403), refused.join(' '));
    const liteHas = [await status('/api/audio/volume', '{"value":"x"}'), await status('/api/display/mode', '{"mode":"none"}')];
    check('Lite accepts the volume and projector mode (the requests are checked, not refused)', liteHas.every((x) => x !== 403), liteHas.join(' '));
  }
  // Stage display (Extra): its own PIN and key reach the stage display only (checked from the LAN
  // address, so this PC is not trusted as itself).
  if (ed.features.stage && remote.data?.stage?.pin && remote.data.url) {
    const lan = remote.data.url.replace(/\/$/, '');
    const lanPost = (p, body, key) => fetch(lan + p, { method: 'POST', headers: { 'Content-Type': 'application/json', ...(key ? { 'X-Stagio-Key': key } : {}) }, body: JSON.stringify(body || {}) });
    const wrong = await lanPost('/api/stage/login', { pin: remote.data.pin === '000000' ? '111111' : '000000' });
    check('Stage: a wrong stage PIN is refused', wrong.status === 401, `status ${wrong.status}`);
    const asConsole = await lanPost('/api/login', { pin: remote.data.stage.pin });
    check('Stage: the stage PIN does not open the console', asConsole.status === 401, `status ${asConsole.status}`);
    const login = await lanPost('/api/stage/login', { pin: remote.data.stage.pin }).then((r) => r.json());
    const sk = login.data?.key;
    check('Stage: the stage PIN gives the stage key', login.ok && !!sk && sk !== new URL(remote.data.qrUrl).searchParams.get('key'));
    const sget = (p) => fetch(lan + p, { headers: { 'X-Stagio-Key': sk } }).then((r) => r.status);
    const refused = [await sget('/api/state'), await sget('/api/remote'), (await lanPost('/api/ppt/next', {}, sk)).status, (await lanPost('/api/stage/message', { text: 'x' }, sk)).status, (await lanPost('/api/cues/open/run', {}, sk)).status];
    check('Stage: its key reaches nothing else (state, remote, slides, messages, cues)', refused.every((x) => x === 403 || x === 401), refused.join(' '));
    check('Stage: its key reaches ping', (await sget('/api/ping')) === 200);
    const flipOff = await lanPost('/api/stage/next', {}, sk);
    check('Stage: Prev/Next refused while the console has them off', flipOff.status === 400, `status ${flipOff.status}`);
    // the live stream: the message arrives, and the speaker's "seen" reaches the console
    const sctrl = new AbortController();
    const sres = await fetch(`${lan}/api/stage/events?key=${encodeURIComponent(sk)}`, { signal: sctrl.signal });
    let sv = null; let sbuf = '';
    (async () => {
      try {
        for await (const chunk of sres.body) {
          sbuf += Buffer.from(chunk).toString();
          let i;
          while ((i = sbuf.indexOf('\n\n')) >= 0) {
            const line = sbuf.slice(0, i).split('\n').find((l) => l.startsWith('data: '));
            sbuf = sbuf.slice(i + 2);
            if (line) { const d = JSON.parse(line.slice(6)); if ('show' in d) sv = d; }
          }
        }
      } catch { /* aborted */ }
    })();
    await sleep(800);
    check('Stage: the stream starts with the stage view (no keys, no PIN in it)', !!sv && 'notes' in sv && !JSON.stringify(sv).includes(remote.data.pin) && !JSON.stringify(sv).includes(sk));
    await sleep(300);
    check('Stage: the console counts the connected stage display', live.stage?.screens >= 1, `${live.stage?.screens}`);
    const t0 = Date.now();
    const sent = await post('/api/stage/message', {}, JSON.stringify({ text: '  5 minutes   left ' })).then((r) => r.json());
    while (Date.now() - t0 < 3000 && !(sv?.message && sv.message.id === sent.data)) await sleep(50);
    check('Stage: a message reaches the stage display within a second', sv?.message?.text === '5 minutes left' && Date.now() - t0 < 1000, `${Date.now() - t0} ms`);
    await lanPost('/api/stage/ack', { id: sent.data }, sk);
    await sleep(500);
    check('Stage: the speaker\'s "seen" reaches the console', !!live.stage?.message?.ackAt && sv?.message?.acked === true);
    await post('/api/stage/clear');
    await sleep(400);
    check('Stage: Clear removes it from the stage display', sv && sv.message === null);
    sctrl.abort();
  }

  if (ed.features.run) {
    const cd = await get('/api/run/countdown').then((r) => r.json());
    check('Extra: the countdown window gets its answer', cd.ok === true && 'data' in cd);
    check('Extra: the state carries the runs of show', Array.isArray(now.run?.shows));
  } else {
    check('the run of show is refused outside Extra', (await status('/api/run/next')) === 403 && now.run === null);
  }

  // A cue pressed again while it still runs is left out (its steps would happen twice).
  if (ed.features.cues) {
    const tmpCue = { id: 'checks-wait', name: 'Checks wait', color: 'green', steps: [{ type: 'wait', seconds: 1.5 }] };
    const cuesNow = (await get('/api/state').then((r) => r.json())).cues;
    await fetch(`${BASE}/api/cues`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify([...cuesNow, tmpCue]) });
    const firstRun = post('/api/cues/checks-wait/run').then((r) => r.json());
    await sleep(200);
    const secondRun = await post('/api/cues/checks-wait/run').then((r) => r.json());
    const firstDone = await firstRun;
    check('a cue pressed again while it runs is not run twice', secondRun.ok && secondRun.data?.skipped === true && firstDone.ok && !firstDone.data?.skipped, JSON.stringify(secondRun));
    await fetch(`${BASE}/api/cues`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(cuesNow) });
  }

  // Paired devices: each has its own key; one can be removed; a new PIN and keys put everyone out.
  if (remote.data?.url) {
    const lan = remote.data.url.replace(/\/$/, '');
    const pairNew = async (ua) => {
      const r = await get('/api/remote').then((x) => x.json());
      const code = new URL(r.data.qrUrl).searchParams.get('pair');
      const j = await fetch(`${lan}/api/pair`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'User-Agent': ua }, body: JSON.stringify({ code }) }).then((x) => x.json());
      return j.data?.key;
    };
    const lanStatus = (key) => fetch(`${lan}/api/state`, { headers: { 'X-Stagio-Key': key } }).then((r) => r.status).catch(() => 0);
    const k1 = await pairNew('Mozilla/5.0 (Linux; Android 15; Pixel 9) Chrome/131.0 Mobile Safari/537.36');
    const k2 = await pairNew('Mozilla/5.0 (iPad; CPU OS 18_0 like Mac OS X) Safari/604.1');
    check('two phones get two different keys', !!k1 && !!k2 && k1 !== k2);
    const list = await get('/api/devices').then((r) => r.json());
    const d1 = list.data?.find((d) => d.name === 'Android phone · Chrome');
    check('the Remote window lists them by kind of device (no keys in the list)', !!d1 && list.data.some((d) => d.name === 'iPad · Safari') && !JSON.stringify(list).includes(k1));
    const fromLan = await fetch(`${lan}/api/devices`, { headers: { 'X-Stagio-Key': k1 } }).then((r) => r.status).catch(() => 0);
    check('the device list is only for the Stagio PC', fromLan === 403, `status ${fromLan}`);
    const cfgFile = SERVER_DATA && path.join(SERVER_DATA, 'config.json');
    const cfgText = cfgFile && fs.existsSync(cfgFile) ? fs.readFileSync(cfgFile, 'utf8') : null;
    if (cfgText !== null) check('config.json keeps only a hash of each device key', !cfgText.includes(k1) && !cfgText.includes(k2));
    await post('/api/devices/remove', {}, JSON.stringify({ id: d1?.id }));
    check('a removed phone is out, the others stay in', (await lanStatus(k1)) === 401 && (await lanStatus(k2)) === 200);

    // Next from two devices for the same slide at once never moves two steps. (Without a slide
    // show both fail or one is left out; the logic itself is checked without PowerPoint above.)
    const nx1 = post('/api/ppt/next', {}, JSON.stringify({ from: '7.0' })).then((r) => r.json());
    const nx2 = await fetch(`${lan}/api/ppt/next`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Stagio-Key': k2 }, body: JSON.stringify({ from: '7.0' }) }).then((r) => r.json());
    const nx1r = await nx1;
    const moved = [nx1r, nx2].filter((r) => r.ok && !r.data?.skipped).length;
    check('Next for the same slide from two devices at once never moves two steps', moved <= 1, `${JSON.stringify(nx1r)} ${JSON.stringify(nx2)}`);

    const oldPin = (await get('/api/remote').then((r) => r.json())).data.pin;
    const reset = await post('/api/remote/reset').then((r) => r.json());
    const afterReset = await get('/api/remote').then((r) => r.json());
    check('New PIN and keys: a new PIN, and every phone has to connect again', reset.ok && afterReset.data.pin !== oldPin && (await lanStatus(k2)) === 401);
    const resetFromLan = await fetch(`${lan}/api/remote/reset`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Stagio-Key': k2 }, body: '{}' }).then((r) => r.status).catch(() => 0);
    check('...which only the Stagio PC can do', resetFromLan === 401 || resetFromLan === 403, `status ${resetFromLan}`);
  }
  ctrl.abort();
}

// ---------------------------------------------------------------- cues: stop, background fades
async function cueChecks() {
  const { CueRunner } = require('../lib/cues');
  const done = [];
  let cancelled = 0;
  let failFade = false;
  const music = {
    fadeOut: (s) => new Promise((resolve, reject) => setTimeout(() => (failFade ? reject(new Error('player gone')) : resolve()), s * 1000)),
    cancelFade: () => { cancelled++; },
    play: async () => { done.push('play'); },
  };
  const ppt = { state: { show: null }, cmd: async (name) => { done.push(name); } };
  const late = [];
  const cr = new CueRunner({ ppt, output: {}, music: () => music, onLate: (name, msg) => late.push(`${name}: ${msg}`) });

  const t0 = Date.now();
  const p = cr.run({ id: 'w', name: 'Wait then next', steps: [{ type: 'music.fadeOut', seconds: 0.4 }, { type: 'wait', seconds: 5 }, { type: 'ppt.next' }] });
  await sleep(60);
  check('a cue with a wait shows as running', cr.isRunning('w') && cr.running?.ids.includes('w'));
  check('Stop stops it', cr.stop('w') === 1);
  const errs = await p;
  check('...the wait ends at once and the steps after it are not done', Date.now() - t0 < 1000 && !done.includes('ppt.next') && errs.stopped === true, `${Date.now() - t0} ms, ${done.join(' ')}`);
  check('...and the fade it started stops where it is', cancelled === 1);
  await sleep(500);
  check('...and then it is no longer running', !cr.isRunning('w') && cr.running === null);

  failFade = true;
  const r2 = await cr.run({ id: 'f', name: 'Fade out', steps: [{ type: 'music.fadeOut', seconds: 0.2 }, { type: 'ppt.next' }] });
  check('a cue counts as running until the fade it left in the background is over', r2.length === 0 && cr.isRunning('f'));
  await sleep(400);
  check('a background fade that fails after the cue has finished is still reported', late.length === 1 && /Fade out: .*player gone/.test(late[0]) && !cr.isRunning('f'), late.join(' | '));
  check('Stop with nothing running does nothing', cr.stop() === 0);
}

// ---------------------------------------------------------------- diagnostics
function diagnosticsChecks() {
  const { report } = require('../lib/diagnostics');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'od-diag-'));
  const logFile = path.join(dir, 'stagio.log');
  const home = 'C:\\Users\\Jane Doe';
  fs.writeFileSync(logFile, [
    '2026-11-23T10:00:00Z LOG Remote (same Wi-Fi): http://192.168.1.5:7300/  PIN 482913',
    '2026-11-23T10:01:00Z LOG opened C:\\Users\\Jane Doe\\Documents\\Sunday.pptx',
    '2026-11-23T10:02:00Z LOG phone http://192.168.1.5:7300/?key=Ab3dEf9hIjKl&x=1 and ?pair=k7m2p9q4r8',
    '2026-11-23T10:03:00Z LOG wifi pass wifiPass123 key Zz9StageKeyQq',
  ].join('\n'));
  const text = report({
    edition: { name: 'Stagio Extra', label: 'Beta 1.6', version: '1.6.0-beta' }, ppt: { running: false }, program: 'none',
    devices: 2, connected: 1, helpers: { control: { pid: 1, restarts: 0, recycles: 1, pending: 0, calls: 9 } }, timings: { 'ppt.next': { n: 3, avgMs: 40, maxMs: 90 } },
  }, { logFile, secrets: ['482913', 'wifiPass123', 'Zz9StageKeyQq', 'k7m2p9q4r8'], home, user: 'Jane Doe' });
  check('diagnostics: version, helpers and the end of the log are in it', /Stagio Extra Beta 1\.6/.test(text) && /control/.test(text) && /Sunday\.pptx/.test(text) && /ppt\.next/.test(text));
  check('diagnostics: the PIN, keys, codes and Wi-Fi password are taken out',
    !/482913|wifiPass123|Zz9StageKeyQq|k7m2p9q4r8|Ab3dEf9hIjKl/.test(text) && /\?key=\[hidden\]/.test(text), text.split('\n').filter((l) => /hidden/.test(l)).join(' | '));
  check('diagnostics: the user\'s folder name is taken out', !/Jane Doe/.test(text) && /~\\Documents\\Sunday\.pptx/.test(text));
  fs.rmSync(dir, { recursive: true, force: true });
}

// ---------------------------------------------------------------- paired devices
function deviceChecks() {
  const { Devices, deviceName } = require('../lib/devices');
  let clock = Date.parse('2026-11-23T10:00:00');
  let saves = 0;
  const cfg = { accessKey: 'shared-key-from-before', pin: '123456', stagePin: '654321', stageKey: 'stage' };
  const dev = new Devices(cfg, () => { saves++; }, () => clock);
  check('an existing install: phones with the shared key from before stay in, as one entry', !!dev.check('shared-key-from-before')?.legacy && cfg.devices.length === 1);
  const fresh = new Devices({ accessKey: 'x', devicesSince: 1 }, () => {}, () => clock);
  check('a new install has no shared key entry', fresh.list().length === 0 && !fresh.check('x'));
  const p = dev.pairCode();
  check('a pairing code works for 10 minutes', p.until - clock === 10 * 60000 && /^[a-z2-9]{10}$/.test(p.code));
  check('a wrong code is useless', dev.pairWith('aaaaaaaaaa', 'x') === null && dev.pairWith('', 'x') === null);
  const a = dev.pairWith(p.code, 'iPhone · Safari');
  const b = dev.pairWith(p.code, 'Android phone · Chrome');
  check('every phone that uses the code gets its own key', a && b && a.key !== b.key && dev.check(a.key)?.id === a.device.id);
  check('only a hash of the keys is kept', !JSON.stringify(cfg).includes(a.key) && !JSON.stringify(cfg).includes(b.key));
  clock += 5 * 60000;
  check('the Remote window keeps the same code while it has time left', dev.pairCode().code === p.code);
  clock += 3.5 * 60000;
  const p2 = dev.pairCode();
  check('...and gets a new one when less than 2 minutes are left', p2.code !== p.code);
  check('...while the old one still works to the end of its 10 minutes (a phone may have just scanned it)', !!dev.pairWith(p.code, 'x'));
  clock += 2 * 60000;
  check('after its 10 minutes the old code is useless, the new one still works', dev.pairWith(p.code, 'x') === null && !!dev.pairWith(p2.code, 'x'));
  clock += 10 * 60000;
  check('after 10 minutes a code is useless', dev.pairWith(p2.code, 'x') === null);
  dev.remove(a.device.id);
  check('a removed device is out, the others stay in', !dev.check(a.key) && !!dev.check(b.key));
  dev.remove('before');
  check('removing the phones from before also changes the shared key (an older Stagio stops taking it)', cfg.accessKey !== 'shared-key-from-before' && !dev.check('shared-key-from-before'));
  const oldPin = cfg.pin;
  dev.reset();
  check('New PIN and keys: new PIN and stage PIN, no devices left', cfg.pin !== oldPin && /^\d{6}$/.test(cfg.pin) && cfg.stagePin !== cfg.pin && cfg.devices.length === 0 && !dev.check(b.key));
  const c = dev.add('Mac · Safari');
  clock += 91 * 24 * 3600000;
  dev.prune();
  check('a device not used for 90 days is forgotten', !dev.check(c.key));
  check('device names come from the browser', deviceName('Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Version/18.0 Mobile/15E148 Safari/604.1') === 'iPhone · Safari'
    && deviceName('Mozilla/5.0 (Linux; Android 15; SM-S921B) AppleWebKit/537.36 Chrome/131.0 Mobile Safari/537.36') === 'Android phone · Chrome');
  check('"last used" is saved now and then, not on every request', (() => { const n = saves; const d = dev.add('x'); for (let i = 0; i < 50; i++) dev.check(d.key); return saves - n === 1; })());

  // Wrong PINs: per address, and across the whole network for PINs (not for pairing codes).
  const { LoginGuard } = require('../lib/loginguard');
  let lt = 0;
  const lg = new LoginGuard({ now: () => lt });
  for (let i = 0; i < 8; i++) lg.failed('10.0.0.1', { pin: true });
  check('PIN: 8 wrong from one address lock that address out', lg.blocked('10.0.0.1', { pin: true }) === 'address' && lg.blocked('10.0.0.2', { pin: true }) === null);
  let tripped = 0;
  for (let i = 0; i < 22; i++) if (lg.failed(`10.0.1.${i}`, { pin: true })) tripped++;
  check('PIN: 30 wrong within a minute from many addresses refuse every PIN, and the console is told once', lg.blocked('10.0.9.9', { pin: true }) === 'network' && tripped === 1);
  check('PIN: meanwhile the QR code (pairing) still works for others', lg.blocked('10.0.9.9', { pin: false }) === null);
  lt += 61000;
  check('PIN: a minute later PINs are taken again', lg.blocked('10.0.9.9', { pin: true }) === null);
  lg.ok('10.0.0.1');
  check('PIN: a right PIN lets that address start over', lg.blocked('10.0.0.1', { pin: true }) === null);

  // The same Next from two devices at once is one step; one device's quick double press is two.
  const { StepGuard } = require('../lib/stepguard');
  let t = 1000;
  const g = new StepGuard(2000, () => t);
  const phoneA = g.begin('next', '5.0', 'A');
  check('Next: the first press goes', !!phoneA);
  check('Next: the same press from another device at the same time is left out', g.begin('next', '5.0', 'B') === null);
  check('Next: a quick second press on the same device goes (meant as two steps)', !!g.begin('next', '5.0', 'A'));
  check('Next: a press for the slide after goes', !!g.begin('next', '6.0', 'B'));
  t += 2500;
  check('Next: the same place 2 s later goes (someone pressed again on purpose)', !!g.begin('next', '6.0', 'C'));
  check('Next / Prev are told apart', !!g.begin('prev', '6.0', 'D'));
  const failing = g.begin('next', '9.0', 'A');
  g.failed(failing);
  check('Next: a step that failed does not hold back another device', !!g.begin('next', '9.0', 'B'));
  check('Next: a press without a place (stage display, Bluetooth) always goes', !!g.begin('next', null, 'A') && !!g.begin('next', null, 'B'));
}

(async () => {
  try {
    // --no-helper: on a Mac (GitHub's), where the Windows PowerShell helper doesn't exist.
    if (!process.argv.includes('--no-helper')) await helperChecks();
    configChecks();
    await autoCueChecks();
    await previewChecks();
    await countdownChecks();
    await mixerChecks();
    await fadeChecks();
    imageChecks();
    editionChecks();
    deviceChecks();
    diagnosticsChecks();
    await cueChecks();
    await runChecks();
    if (process.argv.includes('--server')) await serverChecks();
  } catch (e) {
    check('checks ran to the end', false, e.stack);
  }
  const failed = results.filter((r) => !r).length;
  console.log(`\n${results.length - failed}/${results.length} passed`);
  process.exit(failed ? 1 : 0);
})();
