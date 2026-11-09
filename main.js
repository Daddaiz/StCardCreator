const { app, BrowserWindow, Menu, shell, screen, ipcMain } = require('electron');
const stClient = require('./st-client.js');
const http = require('http');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, 'app');
const PORT = 47831;
const TYPES = { '.html': 'text/html; charset=utf-8', '.png': 'image/png', '.jpg': 'image/jpeg', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.ico': 'image/x-icon', '.webp': 'image/webp' };

// Piccolo server locale: serve i file su un'origine stabile, così il canvas non viene "tainted"
// e le impostazioni (lingua, tema, stile) restano salvate tra un avvio e l'altro.
function startServer() {
  return new Promise(resolve => {
    const srv = http.createServer((req, res) => {
      let p = decodeURIComponent((req.url || '/').split('?')[0]);
      if (p === '/') p = '/index.html';
      const f = path.normalize(path.join(ROOT, p));
      if (!f.startsWith(ROOT)) { res.writeHead(403); return res.end(); }
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

function start() { app.whenReady().then(async () => {
  const port = await startServer();
  Menu.setApplicationMenu(null);
  const saved = loadBounds();
  win = new BrowserWindow({
    width: 1280, height: Math.min(1075, screen.getPrimaryDisplay().workAreaSize.height), minWidth: 420, minHeight: 600,
    ...(saved ? { x: saved.x, y: saved.y, width: saved.width, height: saved.height } : {}),
    show: false, // appare solo quando la pagina è pronta: niente finestra vuota all'avvio
    backgroundColor: '#0f1217', title: 'ST Card Creator',
    icon: path.join(__dirname, 'build', 'icon.ico'),
    // L'app carica solo i suoi file locali. webSecurity disattivata: serve per chiamare le API (OpenRouter, server locali, ecc.) senza blocchi CORS.
    webPreferences: { webSecurity: false, preload: path.join(__dirname, 'preload.js') }
  });
  win.webContents.setWindowOpenHandler(({ url }) => { shell.openExternal(url); return { action: 'deny' }; });
  win.once('ready-to-show', () => { if (saved && saved.maximized) win.maximize(); win.show(); });
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
