// Two phones (or a phone and the PC) pressing Next for the same slide at about the same time mean
// one step, not two. Each press says which slide and animation step it saw (`from`); a press from
// another device for that same place, within 2 s of one already sent, is left out. Presses from
// one device all count: a quick double press there is meant.
class StepGuard {
  constructor(sameMs = 2000, now = () => Date.now()) {
    this.sameMs = sameMs;
    this.now = now;
    this.last = null; // { dir, from, device, at }
  }

  /** A token if the step should go ahead, or null to leave it out. */
  begin(dir, from, device) {
    if (!from) return {}; // no place given (stage display, Bluetooth, an older console): it goes
    const t = this.now();
    const l = this.last;
    if (l && l.dir === dir && l.from === from && l.device !== device && t - l.at < this.sameMs) return null;
    // Noted before the step is sent, so a press arriving while it runs already sees it.
    this.last = { dir, from, device, at: t };
    return this.last;
  }

  /** The step failed: it doesn't count, so another press may go. */
  failed(token) {
    if (token && this.last === token) this.last = null;
  }
}

module.exports = { StepGuard };
