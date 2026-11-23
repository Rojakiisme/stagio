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
  the 6-digit **PIN** shown there. The QR code carries a **pairing code** that works for 10 minutes,
  never a key, so a photo of the screen is useless afterwards. Eight wrong PINs or codes from one
  address lock that address out for five minutes.
- **Paired devices** are listed in the Remote window (kind of device, connected now, last used).
  **Remove** puts one out at once; **New PIN and keys** makes a new PIN, stage PIN and keys, so
  every phone, tablet and stage display has to connect again. A device not used for 90 days is
  forgotten. `config.json` keeps only a SHA-256 hash of each key.
- **Pairing details** (`/api/remote`, `/api/devices`: PIN, codes, the list) are only given to the
  computer itself, and only the computer can remove devices or make new keys.
- **Cross-site requests and DNS rebinding**: requests whose `Host` is not this computer, or whose
  `Origin` / `Sec-Fetch-Site` shows another site, are refused, so a web page open in a browser on
  the same computer cannot drive the desk.
- **Stage display** (Extra): its own PIN and key, which reach only a short list of read-only paths
  (`STAGE_PATHS` in `server.js`); changing slides from there is off unless the desk allows it.
- **Pages**: every page may run only the scripts Stagio's own server sends and talk only to it
  (Content Security Policy, no inline scripts), so text that ends up in a page (a slide title, a
  song name) can't run as code. The desktop window only ever shows the console; other sites open
  in the normal browser.
- **Bluetooth remote**: paired with the same PIN.
- **Diagnostics** (Settings → About → Save diagnostics, on the computer itself): the PIN, keys,
  pairing codes, the Wi-Fi password and the user's folder name are taken out of the file.
- **Stored data**: settings, PIN and keys are kept in the user's own profile
  (`%APPDATA%\OneDesk\config.json`) and never leave the computer. Stagio signs in to no online
  service.

## Known limits

- The connection between phone and computer is **plain HTTP** on the local network. Someone who can
  watch that network's traffic could see the access key. Use a network you trust, or Stagio's own
  Wi-Fi (Windows; it has its own password).
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
