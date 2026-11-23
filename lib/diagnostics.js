// "Save diagnostics" (Settings → About, on the Stagio computer only): a text file to send with a
// problem report. The PIN, the keys, pairing codes, the Wi-Fi password and the user's folder name
// are taken out of everything in it, the end of the log included.
const fs = require('fs');
const os = require('os');
const path = require('path');

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Takes secrets and personal folder names out of a text.
 * @param secrets  strings to hide wherever they appear (PIN, keys, codes, passwords)
 * @param home     the user's home folder (shown as ~)
 * @param user     the user's account name (hidden inside \Users\<name> and /Users/<name>)
 */
function mask(text, { secrets = [], home = '', user = '' } = {}) {
  let s = String(text || '');
  for (const v of secrets.map(String).filter((v) => v.length >= 4).sort((a, b) => b.length - a.length)) {
    s = s.split(v).join('[hidden]');
  }
  s = s.replace(/([?&](?:key|pair)=)[^&\s"'<>]+/gi, '$1[hidden]');
  s = s.replace(/(PIN\s*[:=]?\s*)\d{6}\b/gi, '$1[hidden]');
  if (home) {
    for (const h of new Set([home, home.replace(/\\/g, '/'), home.replace(/\//g, '\\')])) {
      s = s.replace(new RegExp(escapeRe(h), 'gi'), '~');
    }
  }
  if (user) s = s.replace(new RegExp(`([\\\\/]Users[\\\\/])${escapeRe(user)}(?=[\\\\/]|\\b)`, 'gi'), '$1<user>');
  return s;
}

/** The last `n` lines of a log file ('' if there is none). */
function tail(file, n = 300) {
  try {
    const text = fs.readFileSync(file, 'utf8');
    return text.split(/\r?\n/).slice(-n - 1).join('\n');
  } catch { return ''; }
}

const mb = (bytes) => `${Math.round(bytes / 1048576)} MB`;
const dur = (ms) => { const m = Math.round(ms / 60000); return m < 60 ? `${m} min` : `${Math.floor(m / 60)} h ${m % 60} min`; };

/**
 * The report. `info` holds what the server knows (see server.js /api/diagnostics); `logFile` the
 * path of Stagio's log.
 */
function report(info, { logFile, secrets, home = os.homedir(), user = safeUser() } = {}) {
  const L = [];
  const add = (k, v) => L.push(`${k.padEnd(18)} ${v}`);
  L.push(`Stagio diagnostics · ${new Date(info.now || Date.now()).toISOString()}`, '');
  add('Edition', `${info.edition.name} ${info.edition.label} (${info.edition.version})`);
  add('System', `${process.platform} ${os.release()} ${process.arch}${process.versions.electron ? ` · Electron ${process.versions.electron}` : ''} · Node ${process.versions.node}`);
  add('Running for', `${dur(process.uptime() * 1000)} · memory ${mb(process.memoryUsage().rss)}`);
  const p = info.ppt || {};
  add('PowerPoint', p.running ? `running · ${p.show ? `show on slide ${p.show.slide} of ${p.show.total} (${p.show.state})` : 'no show'} · ${p.presentations ?? 0} presentation(s) open${p.busy ? ' · BUSY' : ''}` : 'not running');
  add('Program picture', String(info.program ?? ''));
  add('Screens', `${info.screens ?? '?'} · display mode ${info.displayMode ?? '?'}`);
  add('Sound devices', `${info.audioDevices ?? '?'} · default: ${info.audioDefault || '?'}`);
  add('Music', info.music || 'off');
  add('Phones', `${info.devices} paired, ${info.connected} connected now · ${info.stageScreens ?? 0} stage display(s)`);
  if (info.run) add('Run of show', info.run);
  L.push('', 'Helpers (restarts · replaced · waiting · commands)');
  for (const [k, h] of Object.entries(info.helpers || {})) L.push(`  ${k.padEnd(10)} ${h.restarts} · ${h.recycles} · ${h.pending} · ${h.calls}${h.pid ? '' : ' (not running)'}`);
  const slow = Object.entries(info.timings || {}).sort((a, b) => b[1].maxMs - a[1].maxMs).slice(0, 12);
  if (slow.length) {
    L.push('', 'Slowest commands (count · average · longest, ms)');
    for (const [k, t] of slow) L.push(`  ${k.padEnd(24)} ${t.n} · ${t.avgMs} · ${t.maxMs}`);
  }
  const log = logFile ? tail(logFile) : '';
  L.push('', `--- End of the log (${logFile ? path.basename(logFile) : 'none'}) ---`, log || '(no log file: Stagio runs from source, or has not written one yet)');
  return mask(L.join('\n'), { secrets, home, user });
}

function safeUser() { try { return os.userInfo().username; } catch { return ''; } }

module.exports = { mask, report, tail };
