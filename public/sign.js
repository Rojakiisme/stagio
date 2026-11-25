// The phone's side of signed requests (lib/sign.js explains the rules). Plain JavaScript SHA-256
// and HMAC: browsers only offer crypto.subtle on https pages, and Stagio is reached over plain
// http on the local network. Loaded before app.js and stage.js.
(function () {
  'use strict';
  const K = new Uint32Array([
    0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
    0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
    0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
    0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
    0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
    0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
    0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
    0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
  ]);
  const enc = new TextEncoder();
  const bytes = (x) => (typeof x === 'string' ? enc.encode(x) : x || new Uint8Array(0));
  const rotr = (x, n) => (x >>> n) | (x << (32 - n));

  function sha256(input) {
    const data = bytes(input);
    const len = data.length;
    const padded = new Uint8Array(((len + 9 + 63) >> 6) << 6);
    padded.set(data);
    padded[len] = 0x80;
    const view = new DataView(padded.buffer);
    view.setUint32(padded.length - 8, Math.floor(len / 0x20000000));
    view.setUint32(padded.length - 4, (len * 8) >>> 0);
    const h = new Uint32Array([0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19]);
    const w = new Uint32Array(64);
    for (let off = 0; off < padded.length; off += 64) {
      for (let i = 0; i < 16; i++) w[i] = view.getUint32(off + i * 4);
      for (let i = 16; i < 64; i++) {
        const s0 = rotr(w[i - 15], 7) ^ rotr(w[i - 15], 18) ^ (w[i - 15] >>> 3);
        const s1 = rotr(w[i - 2], 17) ^ rotr(w[i - 2], 19) ^ (w[i - 2] >>> 10);
        w[i] = w[i - 16] + s0 + w[i - 7] + s1;
      }
      let [a, b, c, d, e, f, g, hh] = h;
      for (let i = 0; i < 64; i++) {
        const t1 = (hh + (rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25)) + ((e & f) ^ (~e & g)) + K[i] + w[i]) | 0;
        const t2 = ((rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22)) + ((a & b) ^ (a & c) ^ (b & c))) | 0;
        hh = g; g = f; f = e; e = (d + t1) | 0; d = c; c = b; b = a; a = (t1 + t2) | 0;
      }
      h[0] += a; h[1] += b; h[2] += c; h[3] += d; h[4] += e; h[5] += f; h[6] += g; h[7] += hh;
    }
    const out = new Uint8Array(32);
    const ov = new DataView(out.buffer);
    for (let i = 0; i < 8; i++) ov.setUint32(i * 4, h[i]);
    return out;
  }

  function hmac(key, msg) {
    let k = bytes(key);
    if (k.length > 64) k = sha256(k);
    const block = new Uint8Array(64);
    block.set(k);
    const inner = new Uint8Array(64);
    const outer = new Uint8Array(64);
    for (let i = 0; i < 64; i++) { inner[i] = block[i] ^ 0x36; outer[i] = block[i] ^ 0x5c; }
    const m = bytes(msg);
    const a = new Uint8Array(64 + m.length); a.set(inner); a.set(m, 64);
    const ih = sha256(a);
    const b = new Uint8Array(96); b.set(outer); b.set(ih, 64);
    return sha256(b);
  }

  function b64u(buf) {
    let s = '';
    for (const x of buf) s += String.fromCharCode(x);
    return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  }
  function fromB64u(str) {
    const s = atob(String(str).replace(/-/g, '+').replace(/_/g, '/'));
    return Uint8Array.from(s, (c) => c.charCodeAt(0));
  }
  function nonce() {
    const r = new Uint8Array(16);
    crypto.getRandomValues(r);
    return b64u(r);
  }
  const refOf = (key) => b64u(sha256(`stagio-ref|${b64u(key)}`)).slice(0, 16);
  /** The path and query exactly as the browser will send them. */
  const canonical = (u) => { const x = new URL(u, location.href); return x.pathname + x.search; };
  const URL_BUCKET_MS = 30 * 60000;

  /**
   * A device's signer. key: the 32-byte key (base64url). clock(): the time on the PC's clock.
   */
  function signer(keyText, clock) {
    const key = fromB64u(keyText);
    const ref = refOf(key);
    return {
      ref,
      /** Headers for fetch(url, { method, body }). */
      headers(method, url, body) {
        const ts = Math.round(clock());
        const n = nonce();
        const text = `v1\n${method}\n${canonical(url)}\n${ts}\n${n}\n${b64u(sha256(body || ''))}`;
        return { 'X-Stagio-Dev': ref, 'X-Stagio-Ts': String(ts), 'X-Stagio-Nonce': n, 'X-Stagio-Sig': b64u(hmac(key, text)) };
      },
      /** A URL the browser loads by itself (picture, live stream): signed, for a GET. */
      url(u) {
        if (!u || !u.startsWith('/')) return u;
        const c = canonical(u);
        const e = (Math.floor(clock() / URL_BUCKET_MS) + 2) * URL_BUCKET_MS;
        return `${c}${c.includes('?') ? '&' : '?'}_d=${ref}&_e=${e}&_s=${b64u(hmac(key, `u1\n${c}\n${e}`))}`;
      },
    };
  }

  /**
   * Getting a key without sending it: `secret` is the code from the QR code or a PIN.
   * Returns the key (base64url) once the PC has proved it knows the secret too, else throws.
   */
  async function exchange(path, label, secret, extra = {}) {
    const np = nonce();
    const r = await fetch(path, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ np, proof: b64u(hmac(secret, `${label}|${np}`)), ...extra }),
    });
    const j = await r.json();
    if (!j.ok) { const e = new Error(j.error || 'Refused'); e.status = r.status; throw e; }
    const { ns, ok } = j.data || {};
    if (typeof ns !== 'string' || ok !== b64u(hmac(secret, `pc|${np}|${ns}`))) {
      const e = new Error('The answer did not come from the Stagio computer. Check that this is its address.');
      e.notPC = true;
      throw e;
    }
    const key = hmac(secret, `key|${np}|${ns}`);
    // The stage display also gets the shared stage key, masked with the stage PIN.
    if (j.data.wrapped) {
      const mask = hmac(secret, `wrap|${np}|${ns}`);
      return b64u(fromB64u(j.data.wrapped).map((x, i) => x ^ mask[i]));
    }
    return b64u(key);
  }

  /** The key for an old-style key (a link, or a phone paired before signing): its SHA-256. */
  const keyFromOld = (raw) => b64u(sha256(raw));

  window.StagioSign = { sha256, hmac, b64u, fromB64u, nonce, refOf, signer, exchange, keyFromOld };
}());
