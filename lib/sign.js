// Signed requests: a phone's key never travels on the network, so someone listening on the
// venue's Wi-Fi learns nothing that lets them control Stagio, and can't replay what they recorded.
// (What they can still see: the slides, notes and state the phones are sent. Those are not
// encrypted; that would need HTTPS, which a computer on a local network can't offer without
// certificate warnings.)
//
// Getting a key (the key itself is never sent):
//   QR code  .../#pair=<code>   the code after # stays on the phone (128 bits, 10 minutes)
//   phone -> PC   { np, proof: HMAC(code, "pair|np") }        np: the phone's random value
//   PC -> phone   { ns, ok: HMAC(code, "pc|np|ns") }          ns: the PC's; ok proves the PC knows the code
//   both          key = HMAC(code, "key|np|ns")
//   The same with the PIN ("login|", weaker: someone who recorded that one sign-in can try all
//   million PINs afterwards; the Remote window says scanning is safer), and for the stage display
//   with the stage PIN ("stage|"), where the PC also sends the stage key masked with
//   HMAC(stage PIN, "wrap|np|ns").
//
// Every request then carries (headers):
//   X-Stagio-Dev    the device's reference (from its key; the stage display: "stage")
//   X-Stagio-Ts     the time on the PC's clock (ms), X-Stagio-Nonce  random, used once
//   X-Stagio-Sig    HMAC(key, "v1\n<METHOD>\n<path?query>\n<ts>\n<nonce>\n<sha256(body)>")
// Taken only within 2 minutes of the PC's clock, and each nonce only once.
// What the browser loads by itself (pictures, the live stream) can't carry headers: those GETs
// end in ?_d=<reference>&_e=<expiry>&_s=HMAC(key, "u1\n<path?query>\n<expiry>"), good for 30-60
// minutes (read only: a recorded one shows what the recording already showed).
//
// public/sign.js is the phone's side of the same rules; test/checks.js checks that both agree.
const crypto = require('crypto');

const WINDOW_MS = 2 * 60000;   // a signed request is taken this long before or after the PC's time
const URL_BUCKET_MS = 30 * 60000;
const URL_MAX_MS = 2 * URL_BUCKET_MS + 60000;

const b64u = (buf) => Buffer.from(buf).toString('base64url');
const fromB64u = (s) => Buffer.from(String(s || ''), 'base64url');
const sha256 = (x) => crypto.createHash('sha256').update(x).digest();
const hmac = (key, msg) => crypto.createHmac('sha256', key).update(msg).digest();
const nonce = () => crypto.randomBytes(16).toString('base64url');
/** A device's public reference, from its key (both sides work it out; the key stays secret). */
const refOf = (key) => b64u(sha256(`stagio-ref|${b64u(key)}`)).slice(0, 16);

/** Constant-time comparison of a base64url string sent by a phone with the expected bytes. */
function matches(sent, expected) {
  const a = fromB64u(sent);
  return typeof sent === 'string' && a.length === expected.length && crypto.timingSafeEqual(a, expected);
}
const validNonce = (n) => typeof n === 'string' && /^[A-Za-z0-9_-]{16,64}$/.test(n);

/** The PC's half of getting a key: null if the proof is wrong, else what to answer and the key. */
function exchange(secret, label, np, proof) {
  if (!validNonce(np) || !matches(proof, hmac(secret, `${label}|${np}`))) return null;
  const ns = nonce();
  return { ns, ok: b64u(hmac(secret, `pc|${np}|${ns}`)), key: hmac(secret, `key|${np}|${ns}`) };
}
const xor = (a, b) => Buffer.from(a.map((x, i) => x ^ b[i]));

const bodyHash = (raw) => b64u(sha256(raw || Buffer.alloc(0)));
const requestText = (method, url, ts, n, raw) => `v1\n${method}\n${url}\n${ts}\n${n}\n${bodyHash(raw)}`;
const urlText = (url, e) => `u1\n${url}\n${e}`;
const SIGNED_URL = /[?&]_d=([A-Za-z0-9_-]{1,32})&_e=(\d{1,15})&_s=([A-Za-z0-9_-]{43})$/;

class Verifier {
  /** @param lookup (ref) => the key (Buffer) and who it is, or null */
  constructor(lookup, now = () => Date.now()) {
    this.lookup = lookup;
    this.now = now;
    this.seen = new Map(); // ref -> Map(nonce -> ts)
  }

  /**
   * Who signed this request, or why not: { who } | { error, clock? } | null (not signed at all).
   * `raw` is the body exactly as received.
   */
  check(req, raw) {
    const sig = req.get('x-stagio-sig');
    if (sig) return this.checkHeaders(req, sig, raw);
    if ((req.method === 'GET' || req.method === 'HEAD') && SIGNED_URL.test(req.originalUrl)) return this.checkUrl(req);
    return null;
  }

  checkHeaders(req, sig, raw) {
    const ref = String(req.get('x-stagio-dev') || '');
    const ts = Number(req.get('x-stagio-ts'));
    const n = String(req.get('x-stagio-nonce') || '');
    const now = this.now();
    if (!Number.isFinite(ts) || Math.abs(ts - now) > WINDOW_MS) return { error: 'clock', clock: now };
    if (!/^[A-Za-z0-9_-]{8,64}$/.test(n)) return { error: 'bad' };
    const who = this.lookup(ref);
    if (!who) return { error: 'unknown' };
    if (!matches(sig, hmac(who.key, requestText(req.method, req.originalUrl, ts, n, raw)))) return { error: 'bad' };
    // Each nonce once: a recorded request sent again is refused.
    let mine = this.seen.get(ref);
    if (!mine) this.seen.set(ref, (mine = new Map()));
    if (mine.has(n)) return { error: 'replay' };
    mine.set(n, ts);
    if (mine.size > 2000 || Math.random() < 0.02) this.prune(now);
    return { who };
  }

  checkUrl(req) {
    const m = SIGNED_URL.exec(req.originalUrl);
    const [, ref, e, sig] = m;
    const now = this.now();
    if (Number(e) < now || Number(e) > now + URL_MAX_MS) return { error: 'expired' };
    const who = this.lookup(ref);
    if (!who) return { error: 'unknown' };
    if (!matches(sig, hmac(who.key, urlText(req.originalUrl.slice(0, m.index), e)))) return { error: 'bad' };
    return { who, url: true };
  }

  prune(now) {
    for (const [ref, mine] of this.seen) {
      for (const [n, ts] of mine) if (now - ts > 2 * WINDOW_MS + 60000) mine.delete(n);
      if (!mine.size) this.seen.delete(ref);
    }
  }

  /** Forgets one device's (or every) used nonce, e.g. when it is removed. */
  forget(ref) { if (ref) this.seen.delete(ref); else this.seen.clear(); }
}

// ---- the phone's side, for tests (public/sign.js does the same in the browser) ----
function signHeaders(key, method, url, body, ts = Date.now(), n = nonce()) {
  const raw = body === undefined || body === null ? Buffer.alloc(0) : Buffer.from(body);
  return {
    'X-Stagio-Dev': refOf(key), 'X-Stagio-Ts': String(ts), 'X-Stagio-Nonce': n,
    'X-Stagio-Sig': b64u(hmac(key, requestText(method, url, ts, n, raw))),
  };
}
function signUrl(key, url, now = Date.now(), ref = refOf(key)) {
  const e = (Math.floor(now / URL_BUCKET_MS) + 2) * URL_BUCKET_MS;
  return `${url}${url.includes('?') ? '&' : '?'}_d=${ref}&_e=${e}&_s=${b64u(hmac(key, urlText(url, e)))}`;
}

module.exports = {
  Verifier, exchange, matches, validNonce, refOf, hmac, sha256, nonce, b64u, fromB64u, xor,
  signHeaders, signUrl, requestText, urlText, WINDOW_MS, URL_BUCKET_MS,
};
