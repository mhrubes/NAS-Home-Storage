const express = require('express');
const path = require('path');
const fs = require('fs');
const fsp = fs.promises;
const { checkLogin, signToken, verifyToken } = require('./auth');

const PORT = parseInt(process.env.PORT, 10) || 3000;
const ROOT = path.resolve(process.env.STORAGE_DIR || './data');
const MAX_UPLOAD = (parseInt(process.env.MAX_UPLOAD_MB, 10) || 2048) * 1024 * 1024;
const COOKIE_SECURE = process.env.COOKIE_SECURE === 'true';
const SESSION_MS = 12 * 60 * 60 * 1000;

fs.mkdirSync(ROOT, { recursive: true });

const app = express();
app.disable('x-powered-by');
app.set('trust proxy', process.env.TRUST_PROXY === 'true' ? 1 : false);
app.use((req, res, next) => {
  res.set('X-Content-Type-Options', 'nosniff');
  res.set('X-Frame-Options', 'DENY');
  res.set('Referrer-Policy', 'no-referrer');
  next();
});
// JSON parser jen na ne-upload routy, jinak by upload .json souboru skoncil chybou
const jsonBody = express.json({ limit: '10kb' });

// --- pomocne funkce ---

// relativni cesta -> absolutni uvnitr ROOT, jinak vyjimka (path traversal)
function safePath(rel) {
  const full = path.resolve(ROOT, '.' + path.sep + String(rel ?? ''));
  if (full !== ROOT && !full.startsWith(ROOT + path.sep)) throw new Error('Invalid path');
  return full;
}

// jedna slozka/soubor, bez oddelovacu cesty
function safeName(name) {
  const n = path.basename(String(name ?? '')).trim();
  if (!n || n === '.' || n === '..' || n.includes('\0')) throw new Error('Invalid name');
  return n;
}

const wrap = (fn) => async (req, res) => {
  try {
    await fn(req, res);
  } catch (err) {
    if (res.headersSent) return res.destroy();
    const status = err.status || (err.code === 'ENOENT' ? 404 : 400);
    res.status(status).json({ error: err.message });
  }
};

// --- autentizace ---

const attempts = new Map(); // ip -> { n, t }
const MAX_ATTEMPTS = 5;
const BLOCK_MS = 15 * 60 * 1000;

app.post('/api/login', jsonBody, (req, res) => {
  const rec = attempts.get(req.ip);
  if (rec && rec.n >= MAX_ATTEMPTS && Date.now() - rec.t < BLOCK_MS) {
    return res.status(429).json({ error: 'Too many attempts, try later' });
  }
  const { user, password } = req.body || {};
  if (!checkLogin(user, password)) {
    attempts.set(req.ip, { n: (rec && Date.now() - rec.t < BLOCK_MS ? rec.n : 0) + 1, t: Date.now() });
    return res.status(401).json({ error: 'Invalid credentials' });
  }
  attempts.delete(req.ip);
  res.cookie('auth', signToken(SESSION_MS), {
    httpOnly: true, sameSite: 'strict', secure: COOKIE_SECURE, maxAge: SESSION_MS,
  });
  res.json({ ok: true });
});

app.post('/api/logout', (req, res) => {
  res.clearCookie('auth');
  res.json({ ok: true });
});

function requireAuth(req, res, next) {
  const m = /(?:^|;\s*)auth=([^;]+)/.exec(req.headers.cookie || '');
  if (m && verifyToken(m[1])) return next();
  res.status(401).json({ error: 'Unauthorized' });
}

app.get('/api/health', (req, res) => res.json({ ok: true }));
app.get('/api/me', requireAuth, (req, res) => res.json({ ok: true }));

// --- soubory ---

app.get('/api/files', requireAuth, wrap(async (req, res) => {
  const dir = safePath(req.query.path);
  const entries = await fsp.readdir(dir, { withFileTypes: true });
  const items = [];
  for (const e of entries) {
    if (!e.isDirectory() && !e.isFile()) continue; // symlinky apod. preskocit
    const st = await fsp.stat(path.join(dir, e.name));
    items.push({ name: e.name, dir: e.isDirectory(), size: e.isDirectory() ? null : st.size, mtime: st.mtimeMs });
  }
  items.sort((a, b) => b.dir - a.dir || a.name.localeCompare(b.name, 'cs'));
  res.json(items);
}));

app.get('/api/download', requireAuth, wrap(async (req, res) => {
  const file = safePath(req.query.path);
  const st = await fsp.stat(file);
  if (!st.isFile()) throw new Error('Not a file');
  res.download(file, path.basename(file));
}));

// upload streamem: PUT /api/upload?path=<slozka>&name=<soubor>, telo = obsah souboru
app.put('/api/upload', requireAuth, wrap(async (req, res) => {
  const dir = safePath(req.query.path);
  const target = path.join(dir, safeName(req.query.name));
  if (!(await fsp.stat(dir)).isDirectory()) throw new Error('Target is not a directory');
  const declared = parseInt(req.headers['content-length'], 10);
  if (declared > MAX_UPLOAD) throw Object.assign(new Error('File too large'), { status: 413 });
  if (await fsp.access(target).then(() => true, () => false)) {
    throw Object.assign(new Error('File already exists'), { status: 409 });
  }

  const tmp = `${target}.${process.pid}.part`;
  let size = 0;
  await new Promise((resolve, reject) => {
    const out = fs.createWriteStream(tmp, { flags: 'wx' });
    const fail = (err) => { out.destroy(); reject(err); };
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_UPLOAD) { req.unpipe(out); fail(Object.assign(new Error('File too large'), { status: 413 })); }
    });
    req.on('error', fail);
    req.on('aborted', () => fail(new Error('Upload aborted')));
    out.on('error', reject);
    out.on('finish', resolve);
    req.pipe(out);
  }).catch(async (err) => {
    await fsp.unlink(tmp).catch(() => {});
    throw err;
  });
  await fsp.rename(tmp, target);
  res.status(201).json({ ok: true, size });
}));

app.post('/api/mkdir', requireAuth, jsonBody, wrap(async (req, res) => {
  const dir = safePath(req.body?.path);
  await fsp.mkdir(path.join(dir, safeName(req.body?.name)));
  res.status(201).json({ ok: true });
}));

// presun / prejmenovani: {from, to} = plne relativni cesty (to = nova cesta vcetne nazvu)
app.post('/api/move', requireAuth, jsonBody, wrap(async (req, res) => {
  const from = safePath(req.body?.from);
  const to = safePath(req.body?.to);
  safeName(path.basename(to));
  if (from === ROOT || to === ROOT) throw new Error('Cannot move root');
  if (to === from) throw new Error('Source and target are the same');
  if (to.startsWith(from + path.sep)) throw new Error('Cannot move into itself');
  await fsp.stat(from);
  if (!(await fsp.stat(path.dirname(to))).isDirectory()) throw new Error('Target is not a directory');
  if (await fsp.access(to).then(() => true, () => false)) {
    throw Object.assign(new Error('Target already exists'), { status: 409 });
  }
  await fsp.rename(from, to);
  res.json({ ok: true });
}));

app.delete('/api/files',requireAuth, wrap(async (req, res) => {
  const target = safePath(req.query.path);
  if (target === ROOT) throw new Error('Cannot delete root');
  await fsp.rm(target, { recursive: true });
  res.json({ ok: true });
}));

app.use(express.static(path.join(__dirname, '..', 'public')));

app.listen(PORT, () => console.log(`nas-storage listening on :${PORT}, storage ${ROOT}`));
