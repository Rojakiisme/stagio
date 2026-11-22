// Opening countdown without a run of show (Standard and Extra; Extra also has it as a part of the
// run of show). Full screen on the projector in the desktop app's countdown window (the same one
// the run of show uses), to a number of minutes or a clock time, with a title and notices that
// take turns. The music can fade out so it ends right at zero. At zero the countdown shows 0:00 for
// a few seconds and the window closes, so the slides behind it are on the projector.

const DONE_SHOWN_MS = 5000;

function cleanSettings(s = {}) {
  const minutes = Math.min(180, Math.max(1, Math.round(Number(s.minutes) || 5)));
  const clock = /^([01]?\d|2[0-3]):[0-5]\d$/.test(String(s.clock || '')) ? String(s.clock) : '';
  return {
    title: String(s.title ?? 'Starting soon').slice(0, 120),
    notices: (Array.isArray(s.notices) ? s.notices : String(s.notices || '').split('\n'))
      .map((x) => String(x).trim()).filter(Boolean).slice(0, 12).map((x) => x.slice(0, 200)),
    mode: s.mode === 'clock' && clock ? 'clock' : 'minutes',
    minutes,
    clock,
    fadeOut: Math.min(30, Math.max(0, Math.round(Number(s.fadeOut) || 0))), // 0 = no fade
  };
}

class Countdown {
  /**
   * @param o.cfg     shared settings (cfg.countdown)
   * @param o.save    saves them
   * @param o.music   () => music controller or null
   * @param o.busy    () => true while the run of show has the countdown window
   * @param o.onChange called when the state shown to consoles changes
   */
  constructor({ cfg, save, music, busy, onChange, now }) {
    Object.assign(this, { cfg, save, music: music || (() => null), busy: busy || (() => false), onChange: onChange || (() => {}) });
    this.now = now || Date.now;
    cfg.countdown = cleanSettings(cfg.countdown);
    this.active = null;  // { target, faded, doneAt }
    this.screen = null;
  }

  setScreen(screen) { this.screen = screen; if (this.active) screen?.show(); }

  /** The target time of the settings (a clock time today, or tomorrow if it has passed). */
  targetFor(s) {
    const now = this.now();
    if (s.mode !== 'clock') return now + s.minutes * 60000;
    const [h, m] = s.clock.split(':').map(Number);
    const d = new Date(now);
    d.setHours(h, m, 0, 0);
    if (d.getTime() <= now) d.setDate(d.getDate() + 1);
    return d.getTime();
  }

  configure(settings) {
    this.cfg.countdown = cleanSettings({ ...this.cfg.countdown, ...settings });
    this.save();
    this.onChange();
  }

  start(settings) {
    if (this.busy()) throw new Error('The run of show is showing its own countdown');
    if (settings) this.configure(settings);
    this.active = { target: this.targetFor(this.cfg.countdown), faded: false, doneAt: 0 };
    this.screen?.show();
    this.onChange();
  }

  stop() {
    if (!this.active) return;
    this.active = null;
    if (!this.busy()) this.screen?.hide();
    this.onChange();
  }

  /** Every half second: the music fade before zero, and closing the window after zero. */
  tick() {
    const a = this.active;
    if (!a) return;
    const left = a.target - this.now();
    const s = this.cfg.countdown;
    if (s.fadeOut && !a.faded && left <= s.fadeOut * 1000) {
      a.faded = true;
      const m = this.music();
      if (m?.state?.isPlaying) m.fadeOut(Math.max(1, Math.min(s.fadeOut, left / 1000 || s.fadeOut))).catch(() => {});
    }
    if (left <= 0 && !a.doneAt) { a.doneAt = this.now(); this.onChange(); }
    if (a.doneAt && this.now() - a.doneAt >= DONE_SHOWN_MS) this.stop();
  }

  summary() {
    return { ...this.cfg.countdown, active: this.active ? { target: this.active.target, done: !!this.active.doneAt } : null };
  }

  /** What the countdown window shows (null: nothing of this countdown). */
  info() {
    if (!this.active) return null;
    const s = this.cfg.countdown;
    return { target: this.active.target, title: s.title, notices: s.notices, now: this.now() };
  }
}

module.exports = { Countdown, cleanSettings };
