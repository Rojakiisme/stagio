// Phones and tablets that may control Stagio. Each one has its own key, so one can be removed
// without the others having to sign in again. The key is never sent: phone and PC each work it
// out (lib/sign.js) and every request is signed with it. config.json keeps it as keyHash, the
// name it had when phones still sent a key and this was the key's SHA-256 (which is also how a
// phone paired before signing works out its key from the old one).
//
// A phone gets its key by scanning the code in the Remote window (a pairing code that works for
// 10 minutes, so a photo of the screen is useless afterwards) or by entering the PIN.
// The one shared key from before per-device keys keeps working, listed as one entry ("paired
// before"), until it is removed or a new PIN and key are made.
const crypto = require('crypto');
const sign = require('./sign');

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

  index() {
    this.byHash = new Map(this.cfg.devices.map((d) => [d.keyHash, d]));
    this.byRef = new Map(this.cfg.devices.map((d) => [sign.refOf(sign.fromB64u(d.keyHash)), d]));
  }

  /** Forgets devices not used for 90 days. */
  prune() {
    const before = this.cfg.devices.length;
    const cut = this.now() - UNUSED_MS;
    this.cfg.devices = this.cfg.devices.filter((d) => (d.lastSeen || d.added || 0) > cut);
    if (this.cfg.devices.length !== before) { this.index?.(); this.save(); }
  }

  /** The device and its signing key for a reference (X-Stagio-Dev), or null. */
  find(ref) {
    const d = ref ? this.byRef.get(ref) : null;
    return d ? { device: this.seen(d), key: sign.fromB64u(d.keyHash) } : null;
  }

  /** The device an old-style key belongs to (a phone page from before signing), or null. */
  checkOld(key) {
    const d = key ? this.byHash.get(hash(key)) : null;
    return d ? this.seen(d) : null;
  }

  /** Notes when a device was last used. */
  seen(d) {
    const now = this.now();
    if (now - (d.lastSeen || 0) > SEEN_SAVE_MS) { d.lastSeen = now; this.save(); }
    return d;
  }

  /** Adds a device with the key both sides worked out (a Buffer). */
  add(name, key) {
    const d = { id: crypto.randomBytes(6).toString('base64url'), name: String(name || 'Device').slice(0, 60), keyHash: sign.b64u(key), added: this.now(), lastSeen: this.now() };
    this.cfg.devices.push(d);
    // A long list is trimmed from the least recently used end.
    if (this.cfg.devices.length > MAX_DEVICES) {
      this.cfg.devices.sort((a, b) => (b.lastSeen || 0) - (a.lastSeen || 0));
      this.cfg.devices.length = MAX_DEVICES;
    }
    this.index();
    this.save();
    return d;
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
      // 128 bits. It only ever travels in the QR code (after #), never on the network.
      const code = crypto.randomBytes(16).toString('base64url');
      p = { code, until: now + PAIR_MS };
      this.pairs.push(p);
    }
    return { ...p };
  }

  /** The pairing codes still running (only to take them out of the diagnostics). */
  codes() { return (this.pairs || []).map((p) => p.code); }

  /**
   * A phone proving it scanned a code still running (lib/sign.js): adds it and returns what to
   * answer ({ ns, ok }), or null.
   */
  pairWith(np, proof, name) {
    const now = this.now();
    for (const p of this.pairs || []) {
      if (now > p.until) continue;
      const x = sign.exchange(p.code, 'pair', np, proof);
      if (x) { this.add(name, x.key); return { ns: x.ns, ok: x.ok }; }
    }
    return null;
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
    c.bleKey = newKey();
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
