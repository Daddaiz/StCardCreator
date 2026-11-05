// Piccolo client HTTP per SillyTavern, eseguito nel processo principale di Electron.
// Gestisce da solo cookie di sessione e token CSRF, quindi non dipende da CORS né da SameSite.
const http = require('http');
const https = require('https');

const jar = new Map(); // base -> { cookies:{}, token:'' }

function state(base) {
  if (!jar.has(base)) jar.set(base, { cookies: {}, token: '' });
  return jar.get(base);
}

function raw(base, method, path, headers, body) {
  return new Promise((resolve, reject) => {
    const u = new URL(path, base);
    const lib = u.protocol === 'https:' ? https : http;
    const st = state(base);
    const h = Object.assign({}, headers);
    if (st.authHeader) h.Authorization = st.authHeader;
    const ck = Object.entries(st.cookies).map(([k, v]) => k + '=' + v).join('; ');
    if (ck) h.Cookie = ck;
    if (body && !h['Content-Length']) h['Content-Length'] = Buffer.byteLength(body);
    const req = lib.request(u, { method, headers: h, timeout: 15000 }, res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        for (const sc of res.headers['set-cookie'] || []) {
          const [kv] = sc.split(';'); const i = kv.indexOf('=');
          if (i > 0) st.cookies[kv.slice(0, i).trim()] = kv.slice(i + 1).trim();
        }
        resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) });
      });
    });
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

async function token(base, fresh) {
  const st = state(base);
  if (st.token && !fresh) return st.token;
  const r = await raw(base, 'GET', '/csrf-token', {}, null);
  if (r.status !== 200) throw new Error('csrf ' + r.status);
  st.token = JSON.parse(r.body.toString('utf8')).token || '';
  return st.token;
}

async function login(base, auth, force) {
  const st = state(base);
  const key = auth.user + '\n' + auth.pass;
  if (st.login === key && !force) return;
  st.login = key; // anche se fallisce: in "basic auth" puro l'accesso ad account non esiste, e non lo richiediamo a ogni chiamata
  const t = await token(base, true).catch(() => '');
  const h = { 'Content-Type': 'application/json', Authorization: 'Basic ' + Buffer.from(auth.user + ':' + auth.pass).toString('base64') };
  if (t) h['X-CSRF-Token'] = t;
  await raw(base, 'POST', '/api/users/login', h, JSON.stringify({ handle: auth.user, password: auth.pass }));
  st.token = ''; // la sessione può essere cambiata: nuovo token alla prossima richiesta
}

// req: { base, method, path, headers, body (Buffer|Uint8Array|string|null), auth: { user, pass } | null }
async function request(req) {
  const base = String(req.base || '').replace(/\/+$/, '');
  const method = (req.method || 'GET').toUpperCase();
  const headers = Object.assign({}, req.headers || {});
  const body = req.body == null ? null : (Buffer.isBuffer(req.body) ? req.body : Buffer.from(req.body));
  const auth = req.auth && req.auth.user ? { user: String(req.auth.user), pass: String(req.auth.pass || '') } : null;
  state(base).authHeader = auth ? 'Basic ' + Buffer.from(auth.user + ':' + auth.pass).toString('base64') : '';
  if (auth) await login(base, auth, false);
  const send = async () => {
    if (method !== 'GET' && method !== 'HEAD') headers['X-CSRF-Token'] = await token(base, false);
    return raw(base, method, req.path, headers, body);
  };
  const bad = r => r.status === 401 || r.status === 403;
  const key = auth ? auth.user + '\n' + auth.pass : '';
  let r = await send();
  if (r.status === 403 && method !== 'GET') { state(base).token = ''; r = await send(); } // token CSRF vecchio
  if (auth && bad(r) && state(base).ok === key) { // eravamo dentro: sessione scaduta, un solo nuovo accesso
    state(base).ok = ''; await login(base, auth, true); state(base).token = ''; r = await send();
  }
  if (auth && bad(r)) throw new Error('LOGIN_FAILED'); // niente altri tentativi: SillyTavern blocca dopo pochi errori
  if (auth) state(base).ok = key;
  return { status: r.status, contentType: r.headers['content-type'] || '', body: r.body };
}

module.exports = { request };
