// TDG Timer — main process.
// Menu-bar app: tray icon + title, a popover window, ClickUp API proxy,
// idle detection, and self-update from GitHub Releases.

const { app, BrowserWindow, Tray, ipcMain, nativeImage, net, powerMonitor, screen, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const updater = require('./updater');

const API = 'https://api.clickup.com/api/v2';
const SETTINGS_FILE = () => path.join(app.getPath('userData'), 'settings.json');

let tray = null;
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

// ---------- window ----------
function createWindow() {
  win = new BrowserWindow({
    width: 380,
    height: 560,
    show: false,
    frame: false,
    resizable: false,
    movable: false,
    fullscreenable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    transparent: true,
    vibrancy: 'popover',
    visualEffectState: 'active',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  win.loadFile(path.join(__dirname, 'index.html'));
  win.on('blur', () => {
    if (win.webContents.isDevToolsOpened()) return;
    win.hide();
    lastHiddenAt = Date.now();
  });
  // Open any links (e.g. "open in ClickUp") in the default browser.
  win.webContents.setWindowOpenHandler(({ url }) => { shell.openExternal(url); return { action: 'deny' }; });
}

function showWindow() {
  const b = tray.getBounds();
  const { width, height } = win.getBounds();
  const display = screen.getDisplayNearestPoint({ x: b.x, y: b.y }).workArea;
  let x = Math.round(b.x + b.width / 2 - width / 2);
  x = Math.max(display.x + 8, Math.min(x, display.x + display.width - width - 8));
  const y = Math.round(b.y + b.height + 4);
  win.setPosition(x, y, false);
  win.show();
  win.focus();
  win.webContents.send('window-shown');
}

let lastHiddenAt = 0;
function toggleWindow() {
  // Clicking the tray icon blurs (and hides) the window first; don't reopen it.
  if (win.isVisible()) win.hide();
  else if (Date.now() - lastHiddenAt > 300) showWindow();
}

// ---------- tray ----------
function createTray() {
  const icon = nativeImage.createFromPath(path.join(__dirname, '..', 'assets', 'trayTemplate.png'));
  icon.setTemplateImage(true);
  tray = new Tray(icon);
  tray.setToolTip('TDG Timer');
  tray.on('click', toggleWindow);
  tray.on('right-click', toggleWindow);
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
  ipcMain.on('tray:title', (_e, title) => { tray.setTitle(title ? ' ' + title : ''); });
  ipcMain.on('timer:running', (_e, running) => { timerRunning = !!running; });
  ipcMain.on('window:hide', () => win.hide());
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
    if (app.dock) app.dock.hide();
    loadSettings();
    applyLoginItem();
    registerIpc();
    createTray();
    createWindow();
    setInterval(idleTick, 15 * 1000);
    // Show the window on first run so people can paste their token.
    if (!settings.token) win.once('ready-to-show', showWindow);
  });
  app.on('window-all-closed', (e) => e.preventDefault());
}
