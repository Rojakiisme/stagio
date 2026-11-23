// Phones and tablets that may control Stagio. Each one has its own key, so one can be removed
// without the others having to sign in again. config.json keeps only a hash of each key.
//
// A phone gets its key by scanning the code in the Remote window (a pairing code that works for
// 10 minutes, so a photo of the screen is useless afterwards) or by entering the PIN.
// The one shared key from before this version keeps working, listed as one entry ("paired
// before"), until it is removed or a new PIN and key are made.
const crypto = require('crypto');

const PAIR_MS = 10 * 60000;            // a pairing code works for 10 minutes
const PAIR_RENEW_MS = 2 * 60000;       // the Remote window gets a fresh code when less is left
const UNUSED_MS = 90 * 24 * 3600000;   // a device not used for 90 days is forgotten
const SEEN_SAVE_MS = 5 * 60000;        // "last used" is saved at most this often per device
const MAX_DEVICES = 100;

const hash = (k) => crypto.createHash('sha256').update(String(k)).digest('base64url');
const newKey = () => crypto.randomBytes(18).toString('base64url');
const newPin = () => String(crypto.randomInt(0, 1000000)).padStart(6, '0');

/** "iPhone · Safari" from a browser's user agent (shown in the list; nothing else is kept). */
function deviceName(ua = '') {
  const s = String(ua);
  const os = /iPad/.test(s) ? 'iPad' : /iPhone/.test(s) ? 'iPhone' : /Android/.test(s) ? (/Mobile/.test(s) ? 'Android phone' : 'Android tablet')
    : /Macintosh/.test(s) ? 'Mac' : /Windows/.test(s) ? 'Windows PC' : /CrOS/.test(s) ? 'Chromebook' : /Linux/.test(s) ? 'Linux' : 'Device';
  const br = /EdgA?\//.test(s) ? 'Edge' : /SamsungBrowser/.test(s) ? 'Samsung Internet' : /FxiOS|Firefox\//.test(s) ? 'Firefox'
    : /CriOS|Chrome\//.test(s) ? 'Chrome' : /Safari\//.test(s) ? 'Safari' : '';
  return br ? `${os} · ${br}` : os;
}

class Devices {
  /**
   * @param cfg   the settings object (devices are kept in cfg.devices)
   * @param save  () => writes the settings
   */
  constructor(cfg, save, now = () => Date.now()) {
    this.cfg = cfg;
    this.save = save;
    this.now = now;
    this.pairs = []; // [{ code, until }]: in memory only, so a restart makes old codes useless
    if (!Array.isArray(cfg.devices)) cfg.devices = [];
    // First start of this version: the shared key that phones already have becomes one entry.
    if (!cfg.devicesSince && cfg.accessKey) {
      cfg.devices.push({ id: 'before', name: 'Phones paired before this version', legacy: true, keyHash: hash(cfg.accessKey), added: this.now(), lastSeen: this.now() });
    }
    if (!cfg.devicesSince) { cfg.devicesSince = this.now(); this.save(); }
    this.prune();
    this.index();
  }

  index() { this.byHash = new Map(this.cfg.devices.map((d) => [d.keyHash, d])); }

  /** Forgets devices not used for 90 days. */
  prune() {
    const before = this.cfg.devices.length;
    const cut = this.now() - UNUSED_MS;
    this.cfg.devices = this.cfg.devices.filter((d) => (d.lastSeen || d.added || 0) > cut);
    if (this.cfg.devices.length !== before) { this.index?.(); this.save(); }
  }

  /** The device a key belongs to, or null. Notes when it was last used. */
  check(key) {
    if (!key) return null;
    const d = this.byHash.get(hash(key));
    if (!d) return null;
    const now = this.now();
    if (now - (d.lastSeen || 0) > SEEN_SAVE_MS) { d.lastSeen = now; this.save(); }
    return d;
  }

  /** Adds a device and returns its key (the only time the key itself is known). */
  add(name) {
    const key = newKey();
    const d = { id: crypto.randomBytes(6).toString('base64url'), name: String(name || 'Device').slice(0, 60), keyHash: hash(key), added: this.now(), lastSeen: this.now() };
    this.cfg.devices.push(d);
    // A long list is trimmed from the least recently used end.
    if (this.cfg.devices.length > MAX_DEVICES) {
      this.cfg.devices.sort((a, b) => (b.lastSeen || 0) - (a.lastSeen || 0));
      this.cfg.devices.length = MAX_DEVICES;
    }
    this.index();
    this.save();
    return { key, device: d };
  }

  /**
   * The code for the QR code in the Remote window: a fresh one when the last is nearly used up.
   * An older code still works until its own 10 minutes are over (a phone may have just scanned it).
   */
  pairCode() {
    const now = this.now();
    this.pairs = (this.pairs || []).filter((p) => p.until > now);
    let p = this.pairs.at(-1);
    if (!p || p.until - now < PAIR_RENEW_MS) {
      // 10 characters from a set without look-alikes (no 0/O, 1/I/l): about 50 bits.
      const set = 'abcdefghijkmnopqrstuvwxyz23456789';
      const code = Array.from({ length: 10 }, () => set[crypto.randomInt(0, set.length)]).join('');
      p = { code, until: now + PAIR_MS };
      this.pairs.push(p);
    }
    return { ...p };
  }

  /** A pairing code from a QR code: a new device key if it is one of the codes still running. */
  pairWith(code, name) {
    const now = this.now();
    const a = Buffer.from(String(code || ''));
    const ok = (this.pairs || []).some((p) => {
      const b = Buffer.from(p.code);
      return now <= p.until && a.length === b.length && crypto.timingSafeEqual(a, b);
    });
    return ok ? this.add(name) : null;
  }

  remove(id) {
    const before = this.cfg.devices.length;
    const gone = this.cfg.devices.find((d) => d.id === id);
    this.cfg.devices = this.cfg.devices.filter((d) => d.id !== id);
    if (this.cfg.devices.length === before) return false;
    // The shared key from before: also changed, so an older Stagio on this PC stops taking it.
    if (gone?.legacy) this.cfg.accessKey = newKey();
    this.index();
    this.save();
    return true;
  }

  /** New PIN, stage PIN and keys: every phone, tablet and stage display has to connect again. */
  reset() {
    const c = this.cfg;
    c.pin = newPin();
    do { c.stagePin = newPin(); } while (c.stagePin === c.pin);
    c.accessKey = newKey();
    c.stageKey = newKey();
    c.devices = [];
    this.pairs = [];
    this.index();
    this.save();
  }

  /** For the Remote window on this PC (no keys). */
  list(online = new Set()) {
    return this.cfg.devices
      .map((d) => ({ id: d.id, name: d.name, legacy: !!d.legacy, added: d.added, lastSeen: d.lastSeen, online: online.has(d.id) }))
      .sort((a, b) => Number(b.online) - Number(a.online) || (b.lastSeen || 0) - (a.lastSeen || 0));
  }
}

module.exports = { Devices, deviceName, PAIR_MS };
