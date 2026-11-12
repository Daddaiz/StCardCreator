const { app, BrowserWindow, Menu, shell, screen, ipcMain, dialog } = require('electron');
const https = require('https');
const stClient = require('./st-client.js');
const http = require('http');
const fs = require('fs');
const path = require('path');
// Con la finestra coperta o in secondo piano le animazioni e i timer non devono fermarsi (barra di generazione, controllo di coerenza)
app.commandLine.appendSwitch('disable-renderer-backgrounding');
app.commandLine.appendSwitch('disable-background-timer-throttling');
app.commandLine.appendSwitch('disable-backgrounding-occluded-windows');
app.commandLine.appendSwitch('disable-features', 'CalculateNativeWinOcclusion');

const ROOT = path.join(__dirname, 'app');
const PORT = 47831;
const TYPES = { '.html': 'text/html; charset=utf-8', '.png': 'image/png', '.jpg': 'image/jpeg', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.ico': 'image/x-icon', '.webp': 'image/webp' };

// Piccolo server locale: serve i file su un'origine stabile, così il canvas non viene "tainted"
// e le impostazioni (lingua, tema, stile) restano salvate tra un avvio e l'altro.
function startServer() {
  return new Promise(resolve => {
    const srv = http.createServer((req, res) => {
      let p;
      try { p = decodeURIComponent((req.url || '/').split('?')[0]); } catch (e) { res.writeHead(400); return res.end(); }
      if (p === '/') p = '/index.html';
      const f = path.normalize(path.join(ROOT, p));
      if (f !== path.join(ROOT, 'index.html') && !f.startsWith(ROOT + path.sep)) { res.writeHead(403); return res.end(); }
      fs.readFile(f, (err, data) => {
        if (err) { res.writeHead(404); return res.end(); }
        res.writeHead(200, { 'Content-Type': TYPES[path.extname(f).toLowerCase()] || 'application/octet-stream' });
        res.end(data);
      });
    });
    srv.once('error', () => srv.listen(0, '127.0.0.1', () => resolve(srv.address().port)));
    srv.listen(PORT, '127.0.0.1', () => resolve(PORT));
  });
}

// Una sola istanza: se l'app è già aperta, la seconda copia si chiude e porta in primo piano la prima.
let win = null;
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (!win) return;
    if (win.isMinimized()) win.restore();
    win.show(); win.focus();
  });
  start();
}

// Richieste verso SillyTavern (solo http/https, solo dalla nostra pagina).
ipcMain.handle('st-request', async (e, req) => {
  try {
    const u = new URL(String(req && req.base));
    if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new Error('bad protocol');
    if (!e.senderFrame || !String(e.senderFrame.url).startsWith('http://127.0.0.1:')) throw new Error('bad sender');
    const r = await stClient.request(req);
    return { ok: true, status: r.status, contentType: r.contentType, body: r.body };
  } catch (err) {
    return { ok: false, error: String((err && err.message) || err) };
  }
});

// Copia di sicurezza di una carta di SillyTavern prima della prima modifica: Documenti\ST Card Creator backups
ipcMain.handle('save-backup', async (e, o) => {
  try {
    if (!e.senderFrame || !String(e.senderFrame.url).startsWith('http://127.0.0.1:')) throw new Error('bad sender');
    const data = Buffer.from(o && o.data ? o.data : []);
    if (!data.length || data.length > 64 * 1024 * 1024) throw new Error('empty or too large');
    const dir = path.join(app.getPath('documents'), 'ST Card Creator backups');
    fs.mkdirSync(dir, { recursive: true });
    const base = String((o && o.name) || 'card').replace(/\.png$/i, '').replace(/[^\p{L}\p{N}._ -]/gu, '_').trim().slice(0, 80) || 'card';
    const d = new Date(), z = n => String(n).padStart(2, '0');
    const stamp = d.getFullYear() + '-' + z(d.getMonth() + 1) + '-' + z(d.getDate()) + '_' + z(d.getHours()) + '-' + z(d.getMinutes()) + '-' + z(d.getSeconds());
    const file = path.join(dir, base + '_' + stamp + '.png');
    fs.writeFileSync(file, data, { flag: 'wx' });
    return { ok: true, path: file };
  } catch (err) {
    return { ok: false, error: String((err && err.message) || err) };
  }
});

// Download dei checkpoint (file grandi da huggingface.co) nella cartella scelta dall'utente.
const DL = {};
ipcMain.handle('pick-dir', async () => {
  const r = await dialog.showOpenDialog(win, { title: 'Folder for the checkpoint (models\\Stable-diffusion of your WebUI)', properties: ['openDirectory', 'createDirectory'] });
  return r.canceled || !r.filePaths.length ? null : r.filePaths[0];
});
ipcMain.handle('dl-cancel', (e, id) => { const d = DL[id]; if (d) { d.cancelled = true; if (d.req) d.req.destroy(); } return true; });
ipcMain.handle('dl-start', (e, o) => {
  const id = String(o && o.id || ''), url = String(o && o.url || ''), dir = String(o && o.dir || ''), file = String(o && o.file || '').replace(/[^\w.-]/g, '_');
  const send = d => { if (win && !win.isDestroyed()) win.webContents.send('dl-progress', Object.assign({ id }, d)); };
  if (!/^https:\/\/huggingface\.co\//.test(url) || !dir || !file) { send({ error: 'bad request' }); return false; }
  const dest = path.join(dir, file), part = dest + '.part';
  const st = DL[id] = { cancelled: false, req: null };
  let received = 0, total = 0, last = 0;
  const fail = msg => { try { fs.unlinkSync(part); } catch (err) { /* niente */ } delete DL[id]; send({ error: msg }); };
  const get = (u, hops) => {
    if (st.cancelled) return fail('cancelled');
    st.req = https.get(u, { headers: { 'User-Agent': 'ST-Card-Creator' } }, res => {
      if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location && hops < 6) { res.resume(); return get(new URL(res.headers.location, u).toString(), hops + 1); }
      if (res.statusCode !== 200) { res.resume(); return fail('HTTP ' + res.statusCode); }
      total = +res.headers['content-length'] || 0;
      const out = fs.createWriteStream(part);
      res.on('data', c => { received += c.length; const now = Date.now(); if (now - last > 400) { last = now; send({ received, total }); } });
      res.on('error', err => fail(String(err && err.message || err)));
      out.on('error', err => fail(String(err && err.message || err)));
      out.on('finish', () => {
        if (st.cancelled) return fail('cancelled');
        try { fs.renameSync(part, dest); } catch (err) { return fail(String(err && err.message || err)); }
        delete DL[id]; send({ received, total, done: true });
      });
      res.pipe(out);
    });
    st.req.on('error', err => fail(st.cancelled ? 'cancelled' : String(err && err.message || err)));
  };
  get(url, 0);
  return true;
});

// Logo trasparente mostrato appena l'app parte, mentre la finestra vera si carica: sparisce in dissolvenza quando questa compare.
let splash = null;
function showSplash(b) {
  try {
    const d = (b && typeof b.x === 'number' ? screen.getDisplayMatching({ x: b.x, y: b.y, width: b.width, height: b.height }) : screen.getPrimaryDisplay()).workArea;
    const w = 374, h = 320;
    splash = new BrowserWindow({
      width: w, height: h, x: Math.round(d.x + (d.width - w) / 2), y: Math.round(d.y + (d.height - h) / 2),
      frame: false, transparent: true, resizable: false, movable: false, minimizable: false, maximizable: false, fullscreenable: false,
      alwaysOnTop: true, skipTaskbar: true, focusable: false, hasShadow: false, show: false, backgroundColor: '#00000000'
    });
    splash.setIgnoreMouseEvents(true);
    splash.once('ready-to-show', () => { if (splash && !splash.isDestroyed()) splash.showInactive(); });
    splash.on('closed', () => { splash = null; });
    splash.loadFile(path.join(__dirname, 'splash.html'));
    setTimeout(hideSplash, 20000); // rete di sicurezza: non resta mai sullo schermo
  } catch (e) { splash = null; }
}
function hideSplash() {
  const s = splash; if (!s || s.isDestroyed()) return;
  splash = null;
  s.webContents.executeJavaScript("document.body.classList.add('out')").catch(() => {});
  setTimeout(() => { try { if (!s.isDestroyed()) s.destroy(); } catch (e) { /* ignora */ } }, 550);
}

function start() { app.whenReady().then(async () => {
  const saved = loadBounds();
  showSplash(saved);
  const port = await startServer();
  Menu.setApplicationMenu(null);
  win = new BrowserWindow({
    width: 1280, height: Math.min(1075, screen.getPrimaryDisplay().workAreaSize.height), minWidth: 420, minHeight: 600,
    ...(saved ? { x: saved.x, y: saved.y, width: saved.width, height: saved.height } : {}),
    show: false, // appare solo quando la pagina è pronta: niente finestra vuota all'avvio
    backgroundColor: '#0f1217', title: 'ST Card Creator',
    icon: path.join(__dirname, 'build', 'icon.ico'),
    // L'app carica solo i suoi file locali. webSecurity disattivata: serve per chiamare le API (OpenRouter, server locali, ecc.) senza blocchi CORS.
    webPreferences: { webSecurity: false, backgroundThrottling: false, preload: path.join(__dirname, 'preload.js') }
  });
  win.webContents.setWindowOpenHandler(({ url }) => { shell.openExternal(url); return { action: 'deny' }; });
  win.once('ready-to-show', () => { if (saved && saved.maximized) win.maximize(); win.show(); hideSplash(); });
  let bt = null;
  const remember = () => { clearTimeout(bt); bt = setTimeout(saveBounds, 400); };
  win.on('resize', remember); win.on('move', remember); win.on('maximize', remember); win.on('unmaximize', remember);
  win.on('close', saveBounds);
  win.loadURL('http://127.0.0.1:' + port + '/');
}); }

// Posizione e dimensione della finestra: ricordate tra un avvio e l'altro (file nella cartella dati dell'app).
const BOUNDS = () => path.join(app.getPath('userData'), 'window.json');
function loadBounds() {
  try {
    const b = JSON.parse(fs.readFileSync(BOUNDS(), 'utf8'));
    if (!b || typeof b.width !== 'number' || typeof b.height !== 'number') return null;
    // Solo se la finestra cade ancora dentro uno schermo collegato (es. monitor esterno scollegato)
    const d = screen.getDisplayMatching({ x: b.x, y: b.y, width: b.width, height: b.height }).workArea;
    const inside = b.x + b.width > d.x + 40 && b.x < d.x + d.width - 40 && b.y >= d.y - 10 && b.y < d.y + d.height - 40;
    const o = { width: Math.min(b.width, d.width), height: Math.min(b.height, d.height), maximized: !!b.maximized };
    if (inside) { o.x = b.x; o.y = b.y; }
    return o;
  } catch (e) { return null; }
}
function saveBounds() {
  if (!win || win.isDestroyed()) return;
  try {
    const b = win.isMaximized() ? win.getNormalBounds() : win.getBounds();
    fs.writeFileSync(BOUNDS(), JSON.stringify({ ...b, maximized: win.isMaximized() }));
  } catch (e) { /* ignora */ }
}
app.on('window-all-closed', () => app.quit());
