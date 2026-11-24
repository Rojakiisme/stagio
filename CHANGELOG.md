# Changelog

What changed in each release, newest first. Each edition has its own version number (Lite,
Standard, Extra; Windows and Mac). The download page always has the newest of each:
https://rojakiisme.github.io/stagio/

## 2026-11-24 · Windows Lite 1.5.1 · Standard 1.6.1 · Extra 1.7.1 · Mac 1.5.1 · 1.5.1 · 1.6.1

- Wrong PINs are now also limited across the whole network: more than 30 within a minute, from any
  number of addresses, and PINs are refused for a minute (the QR code still works). The Stagio
  computer says so, and suggests New PIN and keys. A locked-out address no longer has its pairing
  code checked at all.
- With the mixer on, the system volume is shown once, as its Master fader; tooltips say which
  level each fader is (Music = the music app's own level, Master = the system volume).
- Privacy page on the site: what stays on the computer, what travels on the network, what reaches
  the internet (nothing from the app). The Mac version needs macOS 13 or later (now written down).
- Every installer and disk image has a build provenance attestation signed by GitHub
  (`gh attestation verify <file> --repo Rojakiisme/stagio`).

## 2026-11-23 · Windows Lite 1.5 · Standard 1.6 · Extra 1.7 · Mac 1.5 · 1.5 · 1.6

- **Try with sample slides**: on the empty console, opens two sample presentations that come with
  Stagio (Extra also gets a sample run of show), so everything can be tried without your own slides.
- **Stop a cue**: click a running cue to stop it. No further steps; a wait ends at once; a fade it
  started stops where it is. A fade that fails after its cue has finished is still reported.
- **Save diagnostics** (Settings → About, on the Stagio computer): a text file for a problem report,
  with the PIN, keys, pairing codes, the Wi-Fi password and your user name taken out.
- Pages run only the scripts Stagio itself sends (Content Security Policy); the desktop window only
  ever shows the console (other sites open in your browser).
- Checks: server checks for all three editions now run on every Windows build; a file name in
  Chinese with an emoji is checked end to end.
- Bug report and idea forms on GitHub.

## 2026-11-23 · Windows Lite 1.4 · Standard 1.5 · Extra 1.6 · Mac 1.4 · 1.4 · 1.5

- Every phone and tablet has a key of its own; the QR code carries a pairing code that works for
  10 minutes. The Remote window lists paired devices: Remove, and New PIN and keys.
- Next pressed on two phones at once moves one slide; a running cue is not started again.
- Run of show: moves on only once a part has started; a part that fails leaves the run where it was.
- The PIN is no longer written into the log.

## 2026-11-22 · Windows Lite 1.3.1 · Standard 1.4.1 · Extra 1.5.1 · Mac 1.3.1 · 1.3.1 · 1.4.1

- Settings (top right) in tabs: Layout, Projector, Sound (Extra), Keys, Screen, About. The top bar
  keeps Check, Countdown, Stage and Remote.

## 2026-11-22 · Windows Lite 1.3 · Standard 1.4 · Extra 1.5 · Mac 1.3 · 1.3 · 1.4

- Mixer (Windows; Standard basic, Extra full): the microphone to the speakers with EQ and a noise
  gate, faders and meters, the music dips while someone speaks; Extra adds an AUX output, the full
  EQ and scenes.
- Opening countdown in Standard; Lite got projector mode and the system volume.

## 2026-11-21 · Windows Lite 1.2.1 · Standard 1.3.1 · Extra 1.4.1

- Steadier and lighter: the state is rebuilt once per round, background checks slow down when
  nothing happens.

## 2026-11-21 · Windows Standard 1.3 · Extra 1.4

- Headphone preview (Windows; Standard basic, Extra full): other apps only in your headphones.

## 2026-11-21 · Lite 1.2 · Standard 1.2 · Extra 1.3

- Reorder slides by dragging; hidden slides marked; music from any player (no Spotify Premium mode).

## 2026-11-20 · Lite 1.1 · Standard 1.1 · Extra 1.2

- OneDesk is now **Stagio**, open source under the GPL-3.0. Installing over OneDesk keeps every
  setting.

## 2026-11-19 · Extra 1.1

- Stage display for the speaker, and messages from the console.

## 2026-11-18 · Beta 1.0 (all editions)

- Three editions: Lite, Standard, Extra. Extra: run of show and the opening countdown.

Before that: OneDesk 0.x (alpha).
