# Security

## Reporting a vulnerability

Please report security problems privately: on GitHub, open the **Security** tab of this repository
and choose **Report a vulnerability**. Please do not open a public issue for them. You will get an
answer within a week; fixes go into the next beta of every edition that is affected.

Supported: the newest version of each edition (Lite, Standard, Extra) on the download page.

## How Stagio protects the desk

Stagio is a small web server on the presentation computer (port 7300, all network interfaces), so
phones on the same network can be remotes. What protects it:

- **The computer itself** (loopback) is trusted. Every other device has **a key of its own**
  (`lib/devices.js`), which it gets by scanning the QR code shown on the computer or by entering
  the 6-digit **PIN** shown there. The QR code carries a **pairing code** (128 bits) that works for
  10 minutes, never a key, so a photo of the screen is useless afterwards. Eight wrong PINs or codes
  from one address lock that address out for five minutes.
- **Signed requests** (`lib/sign.js`, `public/sign.js`): the key never travels. The pairing code
  sits after `#` in the QR code's address, so it stays on the phone; the phone proves it has the
  code (or the PIN), the computer proves it has it too, and both work out the phone's key from it.
  Every request then carries an HMAC-SHA256 signature over the method, address, time, a one-time
  value and the body. The computer takes a request only within 2 minutes of its own clock and each
  one-time value only once, so recorded requests can't be sent again or changed. Pictures and the
  live stream (which the browser loads by itself) use signed links that only read and expire within
  an hour. Pages from before signing, which sent the key itself, are refused (and told to reload).
- **Paired devices** are listed in the Remote window (kind of device, connected now, last used).
  **Remove** puts one out at once; **New PIN and keys** makes a new PIN, stage PIN and keys, so
  every phone, tablet and stage display has to connect again. A device not used for 90 days is
  forgotten. `config.json` keeps each device's signing key (for a phone paired before signing,
  that is the SHA-256 of its old key, which the phone works out the same way).
- **Pairing details** (`/api/remote`, `/api/devices`: PIN, codes, the list) are only given to the
  computer itself, and only the computer can remove devices or make new keys.
- **Cross-site requests and DNS rebinding**: requests whose `Host` is not this computer, or whose
  `Origin` / `Sec-Fetch-Site` shows another site, are refused, so a web page open in a browser on
  the same computer cannot drive the desk.
- **Stage display** (Extra): its own PIN and key, which reach only a short list of read-only paths
  (`STAGE_PATHS` in `server.js`); changing slides from there is off unless the desk allows it.
  Its key is after `#` in its QR code; signing in with the stage PIN sends it masked with the PIN.
  Its requests are signed like a phone's.
- **Pages**: every page may run only the scripts Stagio's own server sends and talk only to it
  (Content Security Policy, no inline scripts), so text that ends up in a page (a slide title, a
  song name) can't run as code. The desktop window only ever shows the console; other sites open
  in the normal browser.
- **Bluetooth remote**: its QR code carries a Bluetooth key after `#` (the remote page on the
  site never sends it anywhere). Every command is signed with it (HMAC-SHA256, 16 bytes, over the
  command, a random value the computer makes each time Bluetooth starts, and the page's own count),
  so neither the key nor the PIN goes over the air and a recorded command can't be sent again.
  Without the code, the typed PIN signs instead. Eight wrong commands from one phone lock it out for
  five minutes; more than 30 within a minute from all phones together and PIN-signed commands are
  refused for that minute. **New PIN and keys** also makes a new Bluetooth key.
- **Diagnostics** (Settings → About → Save diagnostics, on the computer itself): the PIN, keys,
  pairing codes, the Wi-Fi password and the user's folder name are taken out of the file.
- **Stored data**: settings, PIN and keys are kept in the user's own profile
  (`%APPDATA%\OneDesk\config.json`) and never leave the computer. Stagio signs in to no online
  service.
- **Update notice** (Settings → About, off by default): when turned on, Stagio fetches
  `versions.json` from this repository's `downloads` release once a day. Nothing else is sent, and
  nothing is downloaded or installed by itself. Only the computer itself can turn it on.

## Known limits

- The connection between phone and computer is **plain HTTP** on the local network. Requests are
  signed, so someone watching that network's traffic can't control Stagio or replay what they saw,
  but they can see what the phones are shown (slide pictures, notes, the state). Use a network you
  trust, or Stagio Wi-Fi (Windows; it has its own password). Encrypting it would need HTTPS, which a
  computer on a local network can't offer without certificate warnings on every phone.
- **Typing the PIN is weaker than scanning.** Someone who recorded the one sign-in with a typed PIN
  (or one Bluetooth command signed with the PIN) can try all million PINs afterwards and work out
  that phone's key. Scanning the code doesn't have this weakness. **New PIN and keys** ends it.
- Phones paired before signing sent their key with every request: anyone who recorded that traffic
  has it. They keep working (signing with it now), but pressing **New PIN and keys** once after
  updating, and pairing again, is safer.
- **Stagio Wi-Fi** with internet is Windows' own Mobile hotspot, with the name and password set in
  Windows: anyone who has that password can join it and use the computer's internet.
- Phones paired before this version (Windows Lite 1.4 / Standard 1.5 / Extra 1.6, Mac 1.4 / 1.4 /
  1.5) share one key from before;
  they keep working, listed as one entry, until it is removed or new keys are made. Remove it once
  those phones have scanned the new code.
- The stage display key is one key for all stage displays (they can only look); **New PIN and
  keys** changes it.
- Anyone who can use the presentation computer's Windows account can use Stagio.
- The Windows installers are not code-signed yet (see [CODE_SIGNING_POLICY.md](CODE_SIGNING_POLICY.md));
  the Mac version is not signed by Apple. Download only from this repository's releases or the
  official download page, and compare the SHA-256 shown in the release notes.
- Every installer and disk image has a **build provenance attestation**, signed by GitHub, that
  ties it to this repository's workflow and commit. Check one with
  `gh attestation verify <file> --repo Rojakiisme/stagio`.
