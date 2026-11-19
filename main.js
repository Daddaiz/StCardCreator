const { app, BrowserWindow, Menu, shell, screen, ipcMain, dialog, net } = require('electron');
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
ipcMain.handle('dl-cancel', (e, id) => { const d = DL[id]; if (d) { d.cancelled = true; try { if (d.req) d.req.abort(); } catch (err) { /* niente */ } } return true; });
ipcMain.handle('dl-start', (e, o) => {
  const url = String(o && o.url || '');
  if (!/^https:\/\/huggingface\.co\//.test(url)) return false;
  return dlRun(String(o && o.id || ''), url, String(o && o.dir || ''), String(o && o.file || ''));
});
// Download con avanzamento verso la pagina (Hugging Face e release di GitHub), con ripresa dei redirect
function dlRun(id, url, dir, file) {
  file = file.replace(/[^\w.-]/g, '_');
  const send = d => { if (DLWAIT[id] && (d.error || d.done)) DLWAIT[id](d); if (win && !win.isDestroyed()) win.webContents.send('dl-progress', Object.assign({ id }, d)); };
  if (!/^https:\/\/(huggingface\.co|github\.com)\//.test(url) || !dir || !file) { send({ error: 'bad request' }); return false; }
  const dest = path.join(dir, file), part = dest + '.part';
  const st = DL[id] = { cancelled: false, req: null };
  let received = 0, total = 0, last = 0;
  const fail = msg => { try { fs.unlinkSync(part); } catch (err) { /* niente */ } delete DL[id]; send({ error: msg }); };
  /* Rete di Chromium (net di Electron), come il browser: usa le impostazioni di rete di Windows (proxy, filtri
     dell'antivirus). Il modulo https di Node apre connessioni dirette, che alcuni PC bloccano subito (EACCES). */
  const get = u => {
    if (st.cancelled) return fail('cancelled');
    const req = st.req = net.request({ url: u, redirect: 'follow' });
    req.setHeader('User-Agent', 'ST-Card-Creator');
    req.on('response', res => {
      if (res.statusCode !== 200) { res.on('data', () => {}); return fail('HTTP ' + res.statusCode); }
      const cl = res.headers['content-length']; total = +(Array.isArray(cl) ? cl[0] : cl) || 0;
      const out = fs.createWriteStream(part);
      res.on('data', c => { received += c.length; if (!out.write(c)) { res.pause(); out.once('drain', () => res.resume()); } const now = Date.now(); if (now - last > 400) { last = now; send({ received, total }); } });
      res.on('error', err => { out.destroy(); fail(String(err && err.message || err)); });
      res.on('aborted', () => { out.destroy(); fail(st.cancelled ? 'cancelled' : 'connection interrupted'); });
      res.on('end', () => out.end());
      out.on('error', err => fail(String(err && err.message || err)));
      out.on('finish', () => {
        if (st.cancelled) return fail('cancelled');
        try { fs.renameSync(part, dest); } catch (err) { return fail(String(err && err.message || err)); }
        delete DL[id]; send({ received, total, done: true });
      });
    });
    req.on('abort', () => fail('cancelled'));
    req.on('error', err => fail(st.cancelled ? 'cancelled' : netErr(err, u)));
    req.end();
  };
  get(url);
  return true;
}

// ---------- Qwen Image 2.1 in locale (stable-diffusion.cpp) ----------
// Tutto sta nella cartella "qwen-image" accanto all'exe: il programma sd-cli, i modelli e gli encoder.
const { spawn, execFile } = require('child_process');
const appDir = () => process.env.PORTABLE_EXECUTABLE_DIR || (app.isPackaged ? path.dirname(process.execPath) : __dirname);
const QDIR = () => path.join(appDir(), 'qwen-image');
const HF = 'https://huggingface.co/';
// Solo questi file si possono scaricare: nome -> indirizzo
const QFILES = {
  'qwen-image-2.1-step90000-Q6_K.gguf': HF + 'chatrlabs/Qwen-Image-2.1-Uncensored-Omni-Quantized/resolve/main/qwen-image-2.1-step90000-Q6_K.gguf',
  'qwen-image-2.1-step90000-Q5_K_M.gguf': HF + 'chatrlabs/Qwen-Image-2.1-Uncensored-Omni-Quantized/resolve/main/qwen-image-2.1-step90000-Q5_K_M.gguf',
  'qwen-image-2.1-step90000-Q4_K_M.gguf': HF + 'chatrlabs/Qwen-Image-2.1-Uncensored-Omni-Quantized/resolve/main/qwen-image-2.1-step90000-Q4_K_M.gguf',
  'Qwen3-VL-8B-Instruct-IQ4_XS.gguf': HF + 'unsloth/Qwen3-VL-8B-Instruct-GGUF/resolve/main/Qwen3-VL-8B-Instruct-IQ4_XS.gguf',
  'Qwen3-VL-8B-Instruct-UD-Q4_K_XL.gguf': HF + 'unsloth/Qwen3-VL-8B-Instruct-GGUF/resolve/main/Qwen3-VL-8B-Instruct-UD-Q4_K_XL.gguf',
  'qwen_image_2.1_vae_bf16.safetensors': HF + 'Comfy-Org/Qwen-Image-2.1/resolve/main/vae/qwen_image_2.1_vae_bf16.safetensors',
  'mmproj-F16.gguf': HF + 'unsloth/Qwen3-VL-8B-Instruct-GGUF/resolve/main/mmproj-F16.gguf'
};
const QVAE = 'qwen_image_2.1_vae_bf16.safetensors', QVISION = 'mmproj-F16.gguf';
function findSdCli(dir, depth) {
  let list; try { list = fs.readdirSync(dir, { withFileTypes: true }); } catch (e) { return null; }
  for (const d of list) if (d.isFile() && /^sd(-cli)?(\.exe)?$/i.test(d.name) && (process.platform !== 'win32' || /\.exe$/i.test(d.name))) return path.join(dir, d.name);
  if (depth > 0) for (const d of list) if (d.isDirectory()) { const f = findSdCli(path.join(dir, d.name), depth - 1); if (f) return f; }
  return null;
}
// sd-cli scelto dall'utente (per esempio una copia che ha già): il percorso resta in qwen-image\sdcli-path.txt
const SDPATH = () => path.join(QDIR(), 'sdcli-path.txt');
const mySdCli = () => { try { const f = fs.readFileSync(SDPATH(), 'utf8').trim(); return f && fs.existsSync(f) ? f : null; } catch (e) { return null; } };
const sdCli = () => mySdCli() || findSdCli(path.join(QDIR(), 'sdcpp'), 3);
ipcMain.handle('qwen-pick-sdcli', async () => {
  const r = await dialog.showOpenDialog(win, { title: 'Choose sd-cli.exe (stable-diffusion.cpp)', properties: ['openFile'], filters: [{ name: 'sd-cli', extensions: ['exe'] }] });
  if (r.canceled || !r.filePaths.length) return null;
  const f = r.filePaths[0];
  if (!/^sd(-cli)?\.exe$/i.test(path.basename(f))) return { error: 'This is not sd-cli.exe' };
  try { fs.mkdirSync(QDIR(), { recursive: true }); fs.writeFileSync(SDPATH(), f, 'utf8'); } catch (e) { return { error: String(e.message || e) }; }
  return { path: f };
});
ipcMain.handle('qwen-forget-sdcli', () => { try { fs.unlinkSync(SDPATH()); } catch (e) { /* niente */ } return true; });
ipcMain.handle('qwen-info', () => {
  const dir = QDIR(), files = {};
  Object.keys(QFILES).forEach(n => { try { files[n] = fs.statSync(path.join(dir, n)).size; } catch (e) { files[n] = 0; } });
  return { dir, sdcli: !!sdCli(), sdcliPath: mySdCli() || '', files, win: process.platform === 'win32' };
});
ipcMain.handle('qwen-open-dir', () => { try { fs.mkdirSync(QDIR(), { recursive: true }); } catch (e) { /* niente */ } shell.openPath(QDIR()); return true; });
ipcMain.handle('qwen-dl', (e, o) => {
  const id = String(o && o.id || ''), file = String(o && o.file || '');
  if (!QFILES[file]) return false;
  try { fs.mkdirSync(QDIR(), { recursive: true }); } catch (err) { /* niente */ }
  return dlRun(id, QFILES[file], QDIR(), file);
});
// sd-cli: ultima release ufficiale di stable-diffusion.cpp, versione CUDA 12 (schede NVIDIA) con le sue librerie, altrimenti Vulkan
function getJson(u) {
  return new Promise((res, rej) => {
    const req = net.request({ url: u, redirect: 'follow' });
    req.setHeader('User-Agent', 'ST-Card-Creator'); req.setHeader('Accept', 'application/vnd.github+json');
    req.on('response', r => {
      let b = ''; r.on('data', c => { b += c.toString('utf8'); });
      r.on('end', () => { if (r.statusCode !== 200) return rej(new Error('GitHub HTTP ' + r.statusCode)); try { res(JSON.parse(b)); } catch (err) { rej(err); } });
    });
    req.on('error', err => rej(new Error(netErr(err, u))));
    req.end();
  });
}
/* Errore di rete leggibile, con il sito: "ERR_CONNECTION_REFUSED github.com · ..." */
function netErr(err, u) {
  const msg = String(err && err.message || err), m = /net::(ERR_[A-Z_]+)/.exec(msg);
  let host = ''; try { host = new URL(u).host; } catch (e) { /* niente */ }
  return (m ? m[1] : err && err.code ? err.code : 'ERR') + ' ' + host + ' · ' + msg;
}
const hasNvidia = () => new Promise(res => execFile('nvidia-smi', ['-L'], { windowsHide: true, timeout: 8000 }, (err, out) => res(!err && /GPU/i.test(String(out || '')))));
function dlWait(id, url, dir, file) {
  return new Promise((res, rej) => { DLWAIT[id] = d => { delete DLWAIT[id]; d.error ? rej(new Error(d.error)) : res(path.join(dir, file)); }; dlRun(id, url, dir, file); });
}
const DLWAIT = {};
ipcMain.handle('qwen-sdcli', async (e, o) => {
  const id = String(o && o.id || '');
  const send = d => { if (win && !win.isDestroyed()) win.webContents.send('dl-progress', Object.assign({ id }, d)); };
  try {
    if (process.platform !== 'win32') throw new Error('only on Windows');
    const rel = await getJson('https://api.github.com/repos/leejet/stable-diffusion.cpp/releases/latest');
    const assets = (rel && rel.assets) || [];
    const nv = await hasNvidia();
    const pick = re => assets.find(a => re.test(a.name));
    const main = nv ? pick(/-bin-win-cuda12-x64\.zip$/i) : pick(/-bin-win-vulkan-x64\.zip$/i);
    if (!main) throw new Error('no Windows build in the latest release');
    const parts = [main].concat(nv ? [pick(/^cudart-sd-bin-win-cu12-x64\.zip$/i)].filter(Boolean) : []);
    const dest = path.join(QDIR(), 'sdcpp');
    fs.mkdirSync(dest, { recursive: true });
    for (let i = 0; i < parts.length; i++) {
      const a = parts[i];
      send({ phase: 'Downloading ' + a.name + ' (' + (i + 1) + '/' + parts.length + ')' });
      const zip = await dlWait(id + '-' + i, a.browser_download_url, dest, a.name.replace(/[^\w.-]/g, '_'));
      send({ phase: 'Unpacking ' + a.name });
      await new Promise((res, rej) => execFile('tar', ['-xf', zip, '-C', dest], { windowsHide: true }, err => err ? rej(err) : res()));
      try { fs.unlinkSync(zip); } catch (err) { /* niente */ }
    }
    if (!sdCli()) throw new Error('sd-cli.exe not found after unpacking');
    send({ done: true, phase: (nv ? 'CUDA 12' : 'Vulkan') + ' build ' + (rel.tag_name || '') });
  } catch (err) { send({ error: String(err && err.message || err) }); }
  return true;
});
// Immagini delle scene: salvate nella cartella "images" accanto all'exe, poi l'utente le sposta dove vuole
const IMGDIR = () => path.join(appDir(), 'images');
ipcMain.handle('save-image', (e, o) => {
  try {
    const name = String(o && o.name || 'image').replace(/[^\w.-]+/g, '_').replace(/^\.+/, '').slice(0, 80) || 'image';
    fs.mkdirSync(IMGDIR(), { recursive: true });
    let f = path.join(IMGDIR(), name + '.png'), i = 2;
    while (fs.existsSync(f)) f = path.join(IMGDIR(), name + '-' + (i++) + '.png');
    fs.writeFileSync(f, Buffer.from(String(o.png || ''), 'base64'));
    return { path: f };
  } catch (err) { return { error: String(err && err.message || err) }; }
});
ipcMain.handle('show-image', (e, f) => { f = String(f || ''); if (f.startsWith(IMGDIR() + path.sep)) shell.showItemInFolder(f); else { try { fs.mkdirSync(IMGDIR(), { recursive: true }); } catch (err) { /* niente */ } shell.openPath(IMGDIR()); } return true; });
// Generazione: un processo sd-cli per immagine; l'avanzamento passa alla pagina riga per riga
const QJOBS = {};
ipcMain.handle('qwen-cancel', (e, id) => { const j = QJOBS[id]; if (j) { j.cancelled = true; try { j.p.kill(); } catch (err) { /* niente */ } } return true; });
ipcMain.handle('qwen-gen', (e, o) => new Promise(resolve => {
  const id = String(o && o.id || 'q'), dir = QDIR(), exe = sdCli();
  const fail = msg => resolve({ error: msg });
  if (!exe) return fail('nosdcli');
  const model = String(o.model || ''), llm = String(o.llm || '');
  if (!QFILES[model] || !QFILES[llm]) return fail('bad model');
  const need = [model, llm, QVAE].concat(o.ref ? [QVISION] : []);
  const miss = need.filter(n => !fs.existsSync(path.join(dir, n)));
  if (miss.length) return fail('missing:' + miss.join(','));
  const tmp = path.join(app.getPath('temp'), 'stcc-qwen-' + Date.now());
  fs.mkdirSync(tmp, { recursive: true });
  const out = path.join(tmp, 'out.png');
  const n = (v, lo, hi, d) => { v = Math.round(+v); return isFinite(v) ? Math.max(lo, Math.min(hi, v)) : d; };
  const w = n(o.w, 256, 2048, 768) >> 5 << 5, h = n(o.h, 256, 2048, 1152) >> 5 << 5;
  const args = ['--diffusion-model', path.join(dir, model), '--vae', path.join(dir, QVAE), '--llm', path.join(dir, llm),
    '-p', String(o.prompt || ''), '-n', String(o.neg || '') || ' ',
    '--steps', String(n(o.steps, 1, 100, 30)), '--cfg-scale', String(Math.max(1, Math.min(20, +o.cfg || 5))),
    '--sampling-method', 'euler', '--diffusion-fa', '--offload-to-cpu',
    '-W', String(w), '-H', String(h), '-s', String(n(o.seed, -1, 2147483647, -1)), '-o', out];
  if (o.ref) {
    const ref = path.join(tmp, 'ref.png');
    try { fs.writeFileSync(ref, Buffer.from(String(o.ref).replace(/^data:[^,]*,/, ''), 'base64')); } catch (err) { return fail(String(err.message || err)); }
    args.push('--llm_vision', path.join(dir, QVISION), '-r', ref);
  }
  const send = d => { if (win && !win.isDestroyed()) win.webContents.send('qwen-progress', Object.assign({ id }, d)); };
  const p = spawn(exe, args, { cwd: path.dirname(exe), windowsHide: true });
  const job = QJOBS[id] = { p, cancelled: false };
  const log = []; let buf = '';
  const line = s => {
    s = s.trim(); if (!s) return;
    const m = /(\d+)\/(\d+)\s*-/.exec(s);
    if (m && /\|/.test(s)) send({ step: +m[1], total: +m[2] });
    else { log.push(s); if (log.length > 30) log.shift(); if (/loading|load|vae|decod|encod|sampling|condition/i.test(s)) send({ phase: s.slice(0, 120) }); }
  };
  const read = c => { buf += c.toString('utf8'); const parts = buf.split(/[\r\n]/); buf = parts.pop(); parts.forEach(line); };
  p.stdout.on('data', read); p.stderr.on('data', read);
  const clean = () => { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (err) { /* niente */ } delete QJOBS[id]; };
  p.on('error', err => { clean(); fail(String(err && err.message || err)); });
  p.on('close', code => {
    if (buf) line(buf);
    if (job.cancelled) { clean(); return fail('cancelled'); }
    let png = null; try { png = fs.readFileSync(out).toString('base64'); } catch (err) { /* nessuna immagine */ }
    clean();
    if (!png) return fail('sd-cli exited with code ' + code + '\n' + log.slice(-6).join('\n'));
    resolve({ png });
  });
}));

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
