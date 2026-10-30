const { app, BrowserWindow, Menu, shell } = require('electron');
const http = require('http');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, 'app');
const PORT = 47831;
const TYPES = { '.html': 'text/html; charset=utf-8', '.png': 'image/png', '.jpg': 'image/jpeg', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.ico': 'image/x-icon' };

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

app.whenReady().then(async () => {
  const port = await startServer();
  Menu.setApplicationMenu(null);
  const win = new BrowserWindow({
    width: 1280, height: 860, minWidth: 420, minHeight: 600,
    backgroundColor: '#0f1217', title: 'ST Card Creator',
    icon: path.join(__dirname, 'build', 'icon.ico'),
    // L'app carica solo i suoi file locali. webSecurity disattivata: serve per chiamare le API (OpenRouter, server locali, ecc.) senza blocchi CORS.
    webPreferences: { webSecurity: false }
  });
  win.webContents.setWindowOpenHandler(({ url }) => { shell.openExternal(url); return { action: 'deny' }; });
  win.loadURL('http://127.0.0.1:' + port + '/');
});
app.on('window-all-closed', () => app.quit());
