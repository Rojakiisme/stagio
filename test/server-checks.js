// Server checks for every edition: starts a fresh Stagio server for each one (its own temporary
// data folder, port 7300), runs `node test/checks.js --server` against it, and prints the totals
// and any failures. Exits with 1 if anything failed.
//   node test/server-checks.js            all three editions
//   node test/server-checks.js extra lite  only those
const { spawn, spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const root = path.join(__dirname, '..');
// edition names pick which ones; flags (e.g. --no-helper on a computer without sound devices) go
// on to checks.js
const only = process.argv.slice(2).filter((a) => !a.startsWith('--'));
const flags = process.argv.slice(2).filter((a) => a.startsWith('--'));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  for (const ed of only.length ? only : ['extra', 'standard', 'lite']) {
    const data = fs.mkdtempSync(path.join(os.tmpdir(), `stagio-run-${ed}-`));
    const env = { ...process.env, STAGIO_EDITION: ed, STAGIO_DATA: data, STAGIO_THUMBS: path.join(data, 'thumbs') };
    const srv = spawn(process.execPath, ['server.js'], { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] });
    let log = '';
    srv.stdout.on('data', (d) => { log += d; });
    srv.stderr.on('data', (d) => { log += d; });
    let up = false;
    for (let i = 0; i < 60 && !up; i++) {
      await sleep(500);
      try { up = (await fetch('http://127.0.0.1:7300/api/ping')).status < 500; } catch { /* not yet */ }
    }
    if (!up) { console.log(`${ed}: server did not start\n${log.slice(-2000)}`); srv.kill(); process.exitCode = 1; continue; }
    const r = spawnSync(process.execPath, ['test/checks.js', '--server', ...flags], { cwd: root, env, encoding: 'utf8', timeout: 300000 });
    const out = `${r.stdout}${r.stderr}`;
    const fails = out.split('\n').filter((l) => l.startsWith('FAIL'));
    const total = (out.match(/(\d+)\/(\d+) passed/) || [])[0] || 'no total';
    console.log(`${ed}: ${total}${fails.length ? `\n  ${fails.join('\n  ')}` : ''}`);
    if (r.status !== 0) process.exitCode = 1;
    srv.kill();
    await sleep(1500);
    fs.rmSync(data, { recursive: true, force: true });
  }
})();
