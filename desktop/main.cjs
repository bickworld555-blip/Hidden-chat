// Hidden Messenger for Windows: a small native window around the web companion (hiddenmessenger.com/app).
// It signs in only by linking with the phone (QR code), like the website, and keeps its chats in its own private
// browser storage on this computer (IndexedDB, end-to-end encrypted history sent by the phone).
// The page runs sandboxed without Node.js; links to other sites open in the default browser.
const { app, BrowserWindow, Menu, session, shell } = require('electron');
const path = require('node:path');
const { appUrl, staysInApp, permissionAllowed } = require('./config.cjs');

const APP_URL = appUrl();
const PARTITION = 'persist:hidden-messenger';

if (!app.requestSingleInstanceLock()) app.quit();

let mainWindow = null;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    minWidth: 760,
    minHeight: 520,
    title: 'Hidden Messenger',
    backgroundColor: '#0b1628',
    icon: path.join(__dirname, 'build', 'icon.png'),
    autoHideMenuBar: true,
    show: false,
    webPreferences: {
      partition: PARTITION,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: true,
    },
  });
  mainWindow.once('ready-to-show', () => mainWindow.show());

  const contents = mainWindow.webContents;
  contents.setWindowOpenHandler(({ url }) => {
    if (!staysInApp(url, APP_URL)) shell.openExternal(url);
    return { action: 'deny' };
  });
  contents.on('will-navigate', (event, url) => {
    if (staysInApp(url, APP_URL)) return;
    event.preventDefault();
    shell.openExternal(url);
  });
  mainWindow.loadURL(APP_URL);
  mainWindow.on('closed', () => { mainWindow = null; });
}

app.on('second-instance', () => {
  if (!mainWindow) return;
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.focus();
});

app.whenReady().then(() => {
  // Windows shows notifications only for an app with an id (the installer registers the same one).
  app.setAppUserModelId('com.hiddenmessenger.desktop');
  Menu.setApplicationMenu(null);
  const appSession = session.fromPartition(PARTITION);
  appSession.setPermissionRequestHandler((contents, permission, callback, details) => {
    callback(permissionAllowed(permission, details.requestingUrl || contents.getURL(), APP_URL));
  });
  appSession.setPermissionCheckHandler((contents, permission, requestingOrigin) => permissionAllowed(permission, requestingOrigin, APP_URL));
  createWindow();
});

app.on('window-all-closed', () => app.quit());
