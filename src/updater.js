// Self-updater: checks GitHub Releases for a newer version, downloads the
// zipped .app, and swaps it in place after the app quits. Works without
// Apple code signing because files downloaded this way aren't quarantined.

const { app, net } = require('electron');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile, spawn } = require('child_process');

const ASSET_NAME = 'TDG-Timer-mac.zip';

function newer(a, b) {
  const pa = String(a).replace(/^v/, '').split('.').map(Number);
  const pb = String(b).replace(/^v/, '').split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    if ((pa[i] || 0) > (pb[i] || 0)) return true;
    if ((pa[i] || 0) < (pb[i] || 0)) return false;
  }
  return false;
}

async function check(currentVersion, repo) {
  if (!repo || repo.includes('OWNER')) return { available: false, reason: 'No update repo configured' };
  try {
    const res = await net.fetch(`https://api.github.com/repos/${repo}/releases/latest`, {
      headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'TDG-Timer' },
    });
    if (!res.ok) return { available: false, reason: `GitHub ${res.status}` };
    const rel = await res.json();
    const asset = (rel.assets || []).find((a) => a.name === ASSET_NAME);
    const version = rel.tag_name;
    if (!asset || !newer(version, currentVersion)) return { available: false, version };
    return { available: true, version, url: asset.browser_download_url, notes: rel.body || '' };
  } catch (e) {
    return { available: false, reason: e.message };
  }
}

function currentAppBundle() {
  // .../TDG Timer.app/Contents/MacOS/TDG Timer -> .../TDG Timer.app
  const p = path.resolve(process.execPath, '..', '..', '..');
  return p.endsWith('.app') ? p : null;
}

function run(cmd, args) {
  return new Promise((resolve, reject) =>
    execFile(cmd, args, (err, stdout, stderr) => (err ? reject(new Error(stderr || err.message)) : resolve(stdout))));
}

async function install(info) {
  const target = currentAppBundle();
  if (!app.isPackaged || !target) return { ok: false, error: 'Updates only work in the installed app' };
  try {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tdg-timer-update-'));
    const zip = path.join(dir, ASSET_NAME);
    const res = await net.fetch(info.url, { headers: { 'User-Agent': 'TDG-Timer' } });
    if (!res.ok) throw new Error(`Download failed (${res.status})`);
    fs.writeFileSync(zip, Buffer.from(await res.arrayBuffer()));
    const out = path.join(dir, 'new');
    await run('/usr/bin/ditto', ['-x', '-k', zip, out]);
    const appName = fs.readdirSync(out).find((n) => n.endsWith('.app'));
    if (!appName) throw new Error('Update package had no app inside');
    const fresh = path.join(out, appName);

    // Wait for this process to exit, swap the bundle, relaunch.
    const script = `
      while kill -0 ${process.pid} 2>/dev/null; do sleep 0.3; done
      rm -rf "${target}.old"
      mv "${target}" "${target}.old" && mv "${fresh}" "${target}" && rm -rf "${target}.old"
      xattr -dr com.apple.quarantine "${target}" 2>/dev/null
      open "${target}"
      rm -rf "${dir}"
    `;
    spawn('/bin/bash', ['-c', script], { detached: true, stdio: 'ignore' }).unref();
    setTimeout(() => app.quit(), 200);
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

module.exports = { check, install, newer };
