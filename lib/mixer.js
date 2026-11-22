// Mixer (Windows; basic in Standard, full in Extra): stands in for part of a PA when there is none.
//   Microphone: carried by Stagio itself (helper: [Stagio.Mixer]) with gain, EQ and a noise gate,
//   to the speakers (MIX) and, in Extra, to a second output (AUX) as well.
//   Faders, mutes and level meters for the microphone, the music, the slide videos and the master.
//   The music dips while someone speaks into the microphone, and comes back after a pause.
// Extra adds: an AUX output (the mic, the music and the slide videos can each go there instead of,
// or with the mic as well as, the speakers), the full EQ and gate, how far and how fast the music
// dips, and scenes: saved mixer settings, recalled by hand or from a cue.
//
// Music and slide videos are other programs: their level is their own volume (as in the Windows
// volume mixer), and an EQ for them would need an extra audio driver, so they have none here.

// EQ: [low cut Hz (0 = off), low shelf dB (150 Hz), mid Hz, mid dB, high shelf dB (7 kHz)]
const PRESETS = {
  off: [0, 0, 1000, 0, 0],
  voice: [100, -2, 3000, 3, 0],   // speech: rumble and boom out, a little presence
  clear: [120, -3, 4000, 4, 2],   // a dull microphone or a big room
  warm: [80, 3, 1000, 0, -2],     // a thin or harsh microphone
};
const PRESET_NAMES = { off: 'Off', voice: 'Voice', clear: 'Clear', warm: 'Warm' };

const clamp = (v, lo, hi, d) => { const n = Number(v); return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : d; };

function cleanMic(m = {}) {
  const preset = PRESETS[m.preset] ? m.preset : (m.preset === 'custom' ? 'custom' : 'voice');
  const eq = Array.isArray(m.eq) && m.eq.length === 5
    ? [clamp(m.eq[0], 0, 300, 0), clamp(m.eq[1], -12, 12, 0), clamp(m.eq[2], 100, 10000, 1000), clamp(m.eq[3], -12, 12, 0), clamp(m.eq[4], -12, 12, 0)]
    : [...(PRESETS[preset] || PRESETS.voice)];
  return {
    on: !!m.on,
    device: typeof m.device === 'string' ? m.device : '',
    gainDb: clamp(m.gainDb, -20, 30, 0),
    level: clamp(m.level, 0, 150, 80),
    mute: !!m.mute,
    preset,
    eq: preset === 'custom' ? eq : [...PRESETS[preset]],
    gateDb: clamp(m.gateDb, -90, -10, -50),
    toMix: m.toMix !== false,
    toAux: !!m.toAux,
  };
}

function cleanSettings(s = {}) {
  return {
    on: !!s.on,
    mic: cleanMic(s.mic),
    slides: { mute: !!s.slides?.mute, before: Number.isFinite(s.slides?.before) ? s.slides.before : null },
    music: { mute: !!s.music?.mute, before: Number.isFinite(s.music?.before) ? s.music.before : null },
    duck: { on: s.duck?.on !== false, depth: clamp(s.duck?.depth, 10, 95, 60), release: clamp(s.duck?.release, 0.3, 10, 1.5) },
    aux: { device: typeof s.aux?.device === 'string' ? s.aux.device : '', music: !!s.aux?.music, slides: !!s.aux?.slides },
    scenes: (Array.isArray(s.scenes) ? s.scenes : []).filter((x) => x && x.name).slice(0, 30),
  };
}

class Mixer {
  /**
   * @param o.helper    the mixer helper process (lib/helper.js)
   * @param o.cfg       shared settings (cfg.mixer)
   * @param o.save      saves them
   * @param o.pro       Extra: AUX, full EQ, ducking settings, scenes
   * @param o.music     () => the music controller, or null
   * @param o.musicApp  () => process name of the music app Stagio follows, or ''
   * @param o.outputs   () => output devices [{ id, name, isDefault }] or null
   * @param o.setVolume (v) => system volume; o.setMute (bool) => system mute
   * @param o.onChange  state shown to consoles changed
   * @param o.onMeters  (meters) => push the level meters to the consoles
   */
  constructor(o) {
    Object.assign(this, o);
    this.pro = !!o.pro;
    this.cfg.mixer = cleanSettings(this.cfg.mixer);
    this.cfg.mixer.mic.on = false;    // the microphone is never live by itself after a start
    this.engine = { running: false, error: '', latencyMs: 0 };
    this.inputs = null;               // microphones [{ id, name, isDefault }]
    this.slidesLevel = null;          // PowerPoint's own volume (0-100), -1 = no sound yet
    this.voice = false;
    this.ducked = null;               // { from } while the music is dipped
    this.releaseTimer = null;
    this.meters = null;
    this.helper.onEvent = (m) => this.onEvent(m);
    this.lastApply = 0;
  }

  get s() { return this.cfg.mixer; }

  summary() {
    const s = this.s;
    return {
      on: s.on,
      pro: this.pro,
      mic: { ...s.mic, ...(this.pro ? {} : { toAux: false }) },
      presets: PRESET_NAMES,
      slides: { mute: s.slides.mute, level: this.slidesLevel },
      music: { mute: s.music.mute },
      duck: this.pro ? s.duck : { on: s.duck.on, depth: 60, release: 1.5 },
      aux: this.pro ? s.aux : { device: '', music: false, slides: false },
      scenes: this.pro ? s.scenes.map((x) => ({ id: x.id, name: x.name })) : [],
      engine: this.engine,
      inputs: this.inputs,
      ducked: !!this.ducked,
    };
  }

  /** Process names the AUX output takes (Extra), for the per-app router (lib/preview.js). */
  auxRoutes() {
    const s = this.s;
    if (!this.pro || !s.on || !s.aux.device) return {};
    const r = {};
    const m = this.musicApp();
    if (s.aux.music && m) r[m] = 'aux';
    if (s.aux.slides) r.POWERPNT = 'aux';
    return r;
  }

  // ---------------- the engine in the helper ----------------

  micArgs() {
    const s = this.s;
    const m = s.mic;
    const on = s.on && m.on;
    return {
      on,
      device: m.device,
      mix: '',                                    // the speakers: Windows' output (Output section)
      aux: this.pro ? s.aux.device : '',
      toMix: m.toMix || !(this.pro && m.toAux),   // somewhere, at least
      toAux: this.pro && m.toAux && !!s.aux.device,
      gainDb: m.gainDb,
      level: m.level / 100,
      mute: m.mute,
      eq: m.eq,
      gateDb: m.gateDb,
    };
  }

  async apply() {
    this.lastApply = Date.now();
    try {
      const st = await this.helper.call('mixer.mic', this.micArgs());
      await this.helper.call('mixer.meters', { on: this.s.on, apps: [this.musicApp() || '', 'POWERPNT'] });
      this.setEngine(st);
    } catch (e) {
      this.engine = { ...this.engine, error: e.message };
      this.onChange();
    }
  }

  setEngine(st) {
    const next = { running: !!st.running, error: st.error || '', latencyMs: st.latencyMs || 0 };
    if (JSON.stringify(next) !== JSON.stringify(this.engine)) { this.engine = next; this.onChange(); }
  }

  /** Every few seconds: keep the engine as wanted (a helper that restarted, a mic plugged back in). */
  async tick() {
    const s = this.s;
    if (!s.on) return;
    if (!this.inputs) this.refreshInputs().catch(() => {});
    try {
      const v = await this.helper.call('mixer.appVolume', { name: 'POWERPNT' });
      if (v !== this.slidesLevel) { this.slidesLevel = v; this.onChange(); }
    } catch { /* next time */ }
    if (s.mic.on && !this.engine.running && Date.now() - this.lastApply > 4000) { await this.apply(); return; }
    if (s.mic.on) { try { this.setEngine(await this.helper.call('mixer.state')); } catch { /* next time */ } }
    // the meters follow the music app if it changes
    const app = this.musicApp() || '';
    if (app !== this.metersApp) { this.metersApp = app; this.helper.call('mixer.meters', { on: true, apps: [app, 'POWERPNT'] }).catch(() => {}); }
  }

  async refreshInputs() {
    this.inputs = await this.helper.call('mixer.inputs');
    this.onChange();
  }

  // ---------------- what the helper reports by itself ----------------

  onEvent(m) {
    if (m.evt === 'meters') {
      this.meters = m;
      this.onMeters({ mic: m.mic, voice: m.voice, master: Math.min(1, m.master || 0), music: Math.min(1, m.apps?.[this.musicApp()] || 0), slides: Math.min(1, m.apps?.POWERPNT || 0) });
    } else if (m.evt === 'voice') {
      this.onVoice(!!m.on);
    } else if (m.evt === 'mixerError') {
      this.engine = { running: false, error: m.error || 'The microphone stopped', latencyMs: 0 };
      this.onChange();
    }
  }

  // ---------------- the music dips while someone speaks ----------------

  onVoice(on) {
    this.voice = on;
    const d = this.s.duck;
    if (!d.on || !this.s.on || !this.s.mic.on) return;
    clearTimeout(this.releaseTimer);
    if (on) { if (!this.ducked) this.duckDown(); return; }
    this.releaseTimer = setTimeout(() => this.duckUp(), (this.pro ? d.release : 1.5) * 1000);
  }

  duckDown() {
    const m = this.music();
    const st = m?.state;
    if (!m || !st?.isPlaying || m.fading || !(st.volume >= 0)) return;
    const depth = this.pro ? this.s.duck.depth : 60;
    this.ducked = { from: st.volume };
    m.fadeTo(Math.max(1, Math.round(st.volume * (1 - depth / 100))), 0.4).catch(() => {});
    this.onChange();
  }

  duckUp() {
    const d = this.ducked;
    if (!d) return;
    this.ducked = null;
    const m = this.music();
    if (m) {
      // a fade started by hand meanwhile wins; a later "Fade in" still returns to the normal level
      if (m.fading) m.level = d.from;
      // fadeTo would start stopped music, so only while it plays
      else if (m.state?.isPlaying) m.fadeTo(d.from, 1.0).catch(() => {});
      // paused meanwhile: back to the normal level, silently, for the next play
      else { m.level = d.from; Promise.resolve(m.rawVolume?.(d.from)).catch(() => {}); }
    }
    this.onChange();
  }

  // ---------------- settings from the desk ----------------

  async configure(b = {}) {
    const s = this.s;
    if (typeof b.on === 'boolean') {
      s.on = b.on;
      if (!b.on) { s.mic.on = false; this.duckUp(); }
    }
    if (b.mic && typeof b.mic === 'object') {
      const next = { ...s.mic, ...b.mic };
      if (!this.pro) { next.toAux = false; next.toMix = true; if (next.preset === 'custom') next.preset = 'voice'; }
      if (b.mic.preset && b.mic.preset !== 'custom') next.eq = [...(PRESETS[b.mic.preset] || PRESETS.voice)];
      if (b.mic.eq && this.pro) next.preset = 'custom';
      s.mic = cleanMic(next);
      if (!s.mic.on) this.duckUp();
    }
    if (b.duck && typeof b.duck === 'object') {
      s.duck = { ...s.duck, on: b.duck.on !== undefined ? !!b.duck.on : s.duck.on };
      if (this.pro) s.duck = { ...s.duck, depth: clamp(b.duck.depth, 10, 95, s.duck.depth), release: clamp(b.duck.release, 0.3, 10, s.duck.release) };
      if (!s.duck.on) this.duckUp();
    }
    if (b.aux && typeof b.aux === 'object') {
      if (!this.pro) throw new Error('The AUX output is part of Stagio Extra');
      s.aux = { ...s.aux, ...b.aux, device: typeof b.aux.device === 'string' ? b.aux.device : s.aux.device };
      s.aux.music = !!s.aux.music; s.aux.slides = !!s.aux.slides;
    }
    this.save();
    await this.apply();
    this.onChange();
  }

  /** Slide videos: PowerPoint's own volume (as in the Windows volume mixer). */
  async setSlides({ level, mute }) {
    const s = this.s;
    if (typeof mute === 'boolean' && mute !== s.slides.mute) {
      if (mute) { s.slides.before = this.slidesLevel >= 0 ? this.slidesLevel : 100; level = 0; } else level = s.slides.before ?? 100;
      s.slides.mute = mute;
      this.save();
    }
    if (level !== undefined) {
      const v = Math.round(clamp(level, 0, 100, 100));
      this.slidesLevel = await this.helper.call('mixer.appVolume', { name: 'POWERPNT', value: v });
      if (this.slidesLevel === -1) throw new Error('PowerPoint has not played any sound yet (a video in the slides)');
    }
    this.onChange();
  }

  /** Music mute: its level to 0 and back (the music keeps playing). */
  async setMusicMute(mute) {
    const s = this.s;
    const m = this.music();
    if (!m) throw new Error('Music control is off');
    if (mute === s.music.mute) return;
    if (mute) { s.music.before = m.state?.volume >= 0 ? m.state.volume : 60; await m.setVolume(0); } else await m.setVolume(s.music.before ?? 60);
    s.music.mute = mute;
    this.save();
    this.onChange();
  }

  // ---------------- scenes (Extra) ----------------

  saveScene(name) {
    if (!this.pro) throw new Error('Mixer scenes are part of Stagio Extra');
    const n = String(name || '').trim().slice(0, 40);
    if (!n) throw new Error('Give the scene a name');
    const s = this.s;
    const m = this.music();
    const scene = {
      id: s.scenes.find((x) => x.name === n)?.id || `scene${Date.now()}`,
      name: n,
      mic: { level: s.mic.level, gainDb: s.mic.gainDb, mute: s.mic.mute, preset: s.mic.preset, eq: s.mic.eq, gateDb: s.mic.gateDb, toMix: s.mic.toMix, toAux: s.mic.toAux, on: s.mic.on },
      musicLevel: m?.state?.volume >= 0 ? m.state.volume : null,
      slidesLevel: this.slidesLevel >= 0 ? this.slidesLevel : null,
      duck: { ...s.duck },
      aux: { music: s.aux.music, slides: s.aux.slides },
    };
    s.scenes = [...s.scenes.filter((x) => x.id !== scene.id), scene];
    this.save();
    this.onChange();
    return scene.id;
  }

  deleteScene(id) {
    if (!this.pro) throw new Error('Mixer scenes are part of Stagio Extra');
    this.s.scenes = this.s.scenes.filter((x) => x.id !== id && x.name !== id);
    this.save();
    this.onChange();
  }

  /** Recall by id or name: levels glide there, the rest is set at once. */
  async recallScene(idOrName) {
    if (!this.pro) throw new Error('Mixer scenes are part of Stagio Extra');
    const sc = this.s.scenes.find((x) => x.id === idOrName || x.name === idOrName);
    if (!sc) throw new Error(`No mixer scene “${idOrName}”`);
    const s = this.s;
    s.on = true;
    s.mic = cleanMic({ ...s.mic, ...sc.mic });
    s.duck = { ...s.duck, ...sc.duck };
    s.aux = { ...s.aux, ...sc.aux };
    this.save();
    await this.apply();
    const m = this.music();
    if (m && sc.musicLevel !== null && sc.musicLevel !== undefined && m.state?.isPlaying) await m.fadeTo(sc.musicLevel, 0.8).catch(() => {});
    if (sc.slidesLevel !== null && sc.slidesLevel !== undefined) await this.setSlides({ level: sc.slidesLevel }).catch(() => {});
    this.onChange();
  }

  async shutdown() {
    try { await this.helper.call('mixer.mic', { on: false }, { timeoutMs: 3000 }); } catch { /* quitting anyway */ }
    try { await this.helper.call('mixer.meters', { on: false }, { timeoutMs: 2000 }); } catch { /* quitting anyway */ }
  }
}

module.exports = { Mixer, PRESETS, cleanSettings, cleanMic };
