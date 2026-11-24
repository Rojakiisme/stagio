// "Tell me when a new version is out" (Settings → About). Off unless the user turns it on: Stagio
// otherwise never goes on the internet. When on, once a day (and on "Check now") it fetches one
// small file, versions.json, from the release the download page uses; it holds the newest version
// of each edition for Windows and Mac (a copy of editions.json, uploaded with the installers, so it
// never names a version whose files aren't there yet). Nothing is sent but the request itself.
const { versionLabel } = require('./edition');

const VERSIONS_URL = process.env.STAGIO_UPDATE_URL || 'https://github.com/Rojakiisme/stagio/releases/download/downloads/versions.json';
const DOWNLOAD_PAGE = 'https://rojakiisme.github.io/stagio/#download';
const DAY = 24 * 3600000;

/** [major, minor, patch] of "1.7.1-beta", or null. */
function parse(v) {
  const m = /^(\d+)\.(\d+)\.(\d+)/.exec(String(v || ''));
  return m ? m.slice(1).map(Number) : null;
}
/** Whether version a is newer than version b. */
function newer(a, b) {
  const x = parse(a);
  const y = parse(b);
  if (!x || !y) return false;
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] > y[i];
  return false;
}

class Updates {
  /**
   * @param o.edition   { id, version } of this Stagio
   * @param o.platform  'windows' | 'mac'
   * @param o.onChange  the state shown on the console changed
   */
  constructor({ cfg, save, edition, platform, onChange = () => {}, fetch = globalThis.fetch, now = () => Date.now() }) {
    Object.assign(this, { cfg, save, edition, platform, onChange, fetch, now });
    this.latest = null;    // a newer version, if there is one
    this.error = null;     // why the last check failed
    this.checking = false;
    this.timer = null;
    if (this.on) this.schedule(60000); // a minute after start, then daily
  }

  get on() { return !!this.cfg.updateCheck; }

  setOn(on) {
    this.cfg.updateCheck = !!on;
    this.save();
    clearTimeout(this.timer);
    if (this.on) this.schedule(1000);
    else { this.latest = null; this.error = null; }
    this.onChange();
  }

  schedule(ms) {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.check().finally(() => { if (this.on) this.schedule(DAY); });
    }, ms);
    this.timer.unref?.();
  }

  /** Fetches versions.json once. Never throws; the outcome is in summary(). */
  async check() {
    if (!this.on || this.checking) return this.summary();
    this.checking = true;
    this.onChange();
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 15000);
    try {
      const r = await this.fetch(VERSIONS_URL, { signal: ctrl.signal, cache: 'no-store' });
      if (!r.ok) throw new Error(`the download site answered ${r.status}`);
      const v = (await r.json())?.[this.edition.id]?.[this.platform];
      if (typeof v !== 'string' || !parse(v)) throw new Error('the download site has no version for this edition');
      this.latest = newer(v, this.edition.version) ? v : null;
      this.error = null;
    } catch (e) {
      this.error = e.name === 'AbortError' ? 'no answer from the download site' : (e.message || 'could not reach the download site');
    } finally {
      clearTimeout(t);
      this.checking = false;
      this.cfg.updateCheckedAt = this.now();
      this.save();
      this.onChange();
    }
    return this.summary();
  }

  summary() {
    return {
      on: this.on,
      latest: this.latest,
      label: this.latest ? versionLabel(this.latest) : null,
      checkedAt: this.cfg.updateCheckedAt || null,
      error: this.on ? this.error : null,
      checking: this.checking,
      url: DOWNLOAD_PAGE,
    };
  }

  stop() { clearTimeout(this.timer); }
}

module.exports = { Updates, newer, VERSIONS_URL };
