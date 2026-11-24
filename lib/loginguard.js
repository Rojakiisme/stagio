// Wrong PINs and pairing codes.
// - Per address: 8 wrong tries in a row lock that address out for 5 minutes.
// - The whole network (PINs only): more than 30 wrong PINs within a minute, from any number of
//   addresses, and every PIN is refused for that minute. A 6-digit PIN would otherwise fall to
//   many addresses guessing at once. Pairing codes are long and random, so the QR code keeps
//   working meanwhile, and the console is told that someone is guessing.
class LoginGuard {
  constructor({ perAddress = 8, lockMs = 5 * 60000, networkMax = 30, networkMs = 60000, now = () => Date.now() } = {}) {
    Object.assign(this, { perAddress, lockMs, networkMax, networkMs, now });
    this.addresses = new Map(); // ip -> { n, until }
    this.pinFails = [];         // times of wrong PINs, any address
  }

  /** Why this attempt is refused before it is checked ('address' | 'network'), or null. */
  blocked(ip, { pin = false } = {}) {
    const f = this.addresses.get(ip);
    if (f && this.now() < f.until) return 'address';
    if (pin && this.recentPinFails() >= this.networkMax) return 'network';
    return null;
  }

  /** A wrong try. Returns true when this one made the network-wide limit trip (tell the console). */
  failed(ip, { pin = false } = {}) {
    const f = this.addresses.get(ip) || { n: 0, until: 0 };
    f.n++;
    if (f.n >= this.perAddress) { f.n = 0; f.until = this.now() + this.lockMs; }
    if (this.addresses.size > 1000) this.addresses.clear(); // very many addresses: start over
    this.addresses.set(ip, f);
    if (!pin) return false;
    this.pinFails.push(this.now());
    return this.recentPinFails() === this.networkMax;
  }

  /** A right PIN or code: that address starts over. */
  ok(ip) { this.addresses.delete(ip); }

  /** Wrong PINs within the last minute, any address. */
  recentPinFails() {
    const cut = this.now() - this.networkMs;
    while (this.pinFails.length && this.pinFails[0] <= cut) this.pinFails.shift();
    return this.pinFails.length;
  }

  clear() { this.addresses.clear(); this.pinFails = []; }
}

module.exports = { LoginGuard };
