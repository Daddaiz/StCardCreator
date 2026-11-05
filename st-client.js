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

// req: { base, method, path, headers, body (Buffer|Uint8Array|string|null) }
async function request(req) {
  const base = String(req.base || '').replace(/\/+$/, '');
  const method = (req.method || 'GET').toUpperCase();
  const headers = Object.assign({}, req.headers || {});
  const body = req.body == null ? null : (Buffer.isBuffer(req.body) ? req.body : Buffer.from(req.body));
  if (method !== 'GET' && method !== 'HEAD') headers['X-CSRF-Token'] = await token(base, false);
  let r = await raw(base, method, req.path, headers, body);
  if (r.status === 403 && method !== 'GET') { // sessione scaduta o token vecchio: riprova una volta
    headers['X-CSRF-Token'] = await token(base, true);
    r = await raw(base, method, req.path, headers, body);
  }
  return { status: r.status, contentType: r.headers['content-type'] || '', body: r.body };
}

module.exports = { request };
