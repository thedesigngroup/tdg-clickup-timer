// TDG Timer — main process.
// Standalone window app (Dock icon), ClickUp API proxy, idle detection,
// and self-update from GitHub Releases.

const { app, BrowserWindow, ipcMain, nativeTheme, net, powerMonitor, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const updater = require('./updater');

const API = 'https://api.clickup.com/api/v2';
const SETTINGS_FILE = () => path.join(app.getPath('userData'), 'settings.json');

let win = null;
let settings = {};

// ---------- settings (plain JSON, owner-only permissions) ----------
function loadSettings() {
  try { settings = JSON.parse(fs.readFileSync(SETTINGS_FILE(), 'utf8')); } catch { settings = {}; }
  settings = { idleMinutes: 10, launchAtLogin: true, recents: [], favorites: [], ...settings };
}
function saveSettings() {
  fs.mkdirSync(path.dirname(SETTINGS_FILE()), { recursive: true });
  fs.writeFileSync(SETTINGS_FILE(), JSON.stringify(settings, null, 2), { mode: 0o600 });
}

function log(line) {
  const msg = `${new Date().toISOString()} ${line}\n`;
  if (process.env.TDG_DEBUG) process.stdout.write(msg);
  try { fs.appendFileSync(path.join(app.getPath('userData'), 'log.txt'), msg); } catch {}
}

// ---------- window ----------
// A normal app window with a Dock icon. Closing the window just hides it
// (the app keeps running so idle detection works); Cmd+Q quits.
let quitting = false;
function createWindow() {
  const b = settings.windowBounds || {};
  win = new BrowserWindow({
    width: b.width || 420,
    height: b.height || 640,
    x: b.x,
    y: b.y,
    minWidth: 360,
    minHeight: 460,
    show: false,
    title: 'TDG Timer',
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#1e1e20' : '#f6f6f8',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  // Keep a small log of page errors so problems on someone's Mac can be diagnosed.
  win.webContents.on('preload-error', (_e, p, err) => log(`preload-error ${p}: ${err && err.stack}`));
  win.webContents.on('console-message', (e) => {
    const level = e.level ?? '';
    if (level === 'error' || level === 'warning' || level === 3 || level === 2) log(`console ${level}: ${e.message} (${e.sourceId}:${e.lineNumber})`);
  });
  win.webContents.on('render-process-gone', (_e, d) => log(`renderer gone: ${d.reason}`));
  win.loadFile(path.join(__dirname, 'index.html'));
  win.once('ready-to-show', () => win.show());
  win.on('focus', () => win.webContents.send('window-shown'));
  win.on('close', (e) => {
    settings.windowBounds = win.getBounds();
    saveSettings();
    if (!quitting && process.platform === 'darwin') { e.preventDefault(); win.hide(); }
  });
  // Open any links (e.g. "open in ClickUp") in the default browser.
  win.webContents.setWindowOpenHandler(({ url }) => { shell.openExternal(url); return { action: 'deny' }; });
}

function showWindow() {
  if (!win) return;
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
  app.focus({ steal: true });
}

// Running time shows in the window title and on the Dock icon.
function setTimerTitle(t) {
  if (!win) return;
  win.setTitle(t ? `TDG Timer — ${t}` : 'TDG Timer');
  if (app.dock) app.dock.setBadge(t || '');
}

// ---------- ClickUp API proxy (runs in main to avoid CORS) ----------
async function clickup(method, apiPath, body) {
  if (!settings.token) throw new Error('No ClickUp token set');
  const res = await net.fetch(API + apiPath, {
    method,
    headers: { Authorization: settings.token, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = { raw: text }; }
  if (!res.ok) {
    const msg = (data && (data.err || data.error)) || `ClickUp error ${res.status}`;
    const err = new Error(msg);
    err.status = res.status;
    throw err;
  }
  return data;
}

// ---------- idle detection ----------
// While a timer runs, if the machine has been idle longer than the limit,
// remember when idling began. When the user comes back, ask the renderer.
let idleSince = null;
let timerRunning = false;
function idleTick() {
  if (!timerRunning) { idleSince = null; return; }
  const idleSec = powerMonitor.getSystemIdleTime();
  const limit = (settings.idleMinutes || 0) * 60;
  if (!limit) return;
  if (idleSec >= limit && !idleSince) {
    idleSince = Date.now() - idleSec * 1000;
  } else if (idleSec < 5 && idleSince) {
    const since = idleSince;
    idleSince = null;
    showWindow();
    win.webContents.send('idle-returned', { idleSince: since, now: Date.now() });
  }
}

// ---------- IPC ----------
function registerIpc() {
  ipcMain.handle('api', async (_e, { method, path: p, body }) => {
    try { return { ok: true, data: await clickup(method, p, body) }; }
    catch (err) { return { ok: false, error: err.message, status: err.status }; }
  });
  ipcMain.handle('settings:get', () => ({ ...settings, version: app.getVersion() }));
  ipcMain.handle('settings:set', (_e, patch) => {
    settings = { ...settings, ...patch };
    saveSettings();
    if ('launchAtLogin' in patch) applyLoginItem();
    return { ...settings, version: app.getVersion() };
  });
  ipcMain.on('tray:title', (_e, title) => setTimerTitle(title));
  ipcMain.on('timer:running', (_e, running) => { timerRunning = !!running; });
  ipcMain.on('window:hide', () => win.minimize());
  ipcMain.on('app:quit', () => app.quit());
  ipcMain.on('open:url', (_e, url) => { if (/^https:\/\//.test(url)) shell.openExternal(url); });
  ipcMain.handle('update:check', () => updater.check(app.getVersion(), updateRepo()));
  ipcMain.handle('update:install', (_e, info) => updater.install(info));
}

function updateRepo() {
  try { return require('../package.json').updateRepo; } catch { return null; }
}

function applyLoginItem() {
  if (app.isPackaged) app.setLoginItemSettings({ openAtLogin: !!settings.launchAtLogin });
}

// ---------- boot ----------
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => showWindow());
  app.whenReady().then(() => {
    loadSettings();
    applyLoginItem();
    registerIpc();
    createWindow();
    setInterval(idleTick, 15 * 1000);
  });
  app.on('activate', () => showWindow());          // clicking the Dock icon
  app.on('before-quit', () => { quitting = true; });
  app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
}
