const express = require('express');
const path = require('path');
const fs = require('fs');
const fsp = fs.promises;
const { checkLogin, signToken, parseToken, tokenExpiry } = require('./auth');
const { LockStore } = require('./locks');

const PORT = parseInt(process.env.PORT, 10) || 3000;
const ROOT = path.resolve(process.env.STORAGE_DIR || './data');
const MAX_UPLOAD = (parseInt(process.env.MAX_UPLOAD_MB, 10) || 2048) * 1024 * 1024;
const COOKIE_SECURE = process.env.COOKIE_SECURE === 'true';

// Odhlaseni po necinnosti: SESSION_TIMEOUT_MIN z .env (vychozi 10 minut, povolena i desetinna cisla)
const DEFAULT_TIMEOUT_MIN = 10;
const MAX_TIMEOUT_MIN = 24 * 60;
function parseTimeoutMin(raw) {
  if (raw === undefined || raw === '') return DEFAULT_TIMEOUT_MIN;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0 || n > MAX_TIMEOUT_MIN) {
    console.warn(`Neplatna hodnota SESSION_TIMEOUT_MIN="${raw}", pouzivam ${DEFAULT_TIMEOUT_MIN} min`);
    return DEFAULT_TIMEOUT_MIN;
  }
  return n;
}
const SESSION_TIMEOUT_MS = Math.round(parseTimeoutMin(process.env.SESSION_TIMEOUT_MIN) * 60 * 1000);
const SESSION_GRACE_MS = 15 * 1000; // rezerva, aby server neodhlasil drive nez stranka (prodleva keepalive)
const COOKIE_MAX_AGE = SESSION_TIMEOUT_MS + SESSION_GRACE_MS;
const TIMEOUT_SEC = Math.round(SESSION_TIMEOUT_MS / 1000);

fs.mkdirSync(ROOT, { recursive: true });

// seznam zamku je v uloziste jako skryty soubor (neni videt ve vypisu a nejde s nim nijak manipulovat)
const LOCKS_NAME = '.nas-locks.json';
const locks = new LockStore(path.join(ROOT, LOCKS_NAME));
locks.load();

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

// absolutni cesta -> relativni k ROOT s '/' ('' = koren)
const relOf = (full) => path.relative(ROOT, full).split(path.sep).join('/');
const isReserved = (full) => relOf(full).toLowerCase() === LOCKS_NAME;

// relativni cesta -> absolutni uvnitr ROOT, jinak vyjimka (path traversal)
function safePath(rel) {
  const full = path.resolve(ROOT, '.' + path.sep + String(rel ?? ''));
  if (full !== ROOT && !full.startsWith(ROOT + path.sep)) throw new Error('Invalid path');
  if (isReserved(full)) throw new Error('Invalid path');
  return full;
}

// cil nove vytvarane polozky (upload, mkdir, presun) nesmi byt vyhrazeny soubor se zamky
function assertNotReserved(full) {
  if (isReserved(full)) throw new Error('Invalid name');
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
  setAuthCookie(res);
  res.json({ ok: true, timeoutSec: TIMEOUT_SEC, remainingSec: TIMEOUT_SEC });
});

const authCookieToken = (req) => { const m = /(?:^|;\s*)auth=([^;]+)/.exec(req.headers.cookie || ''); return m ? m[1] : ''; };

app.post('/api/logout', (req, res) => {
  const t = parseToken(authCookieToken(req));
  if (t) locks.dropSession(t.sid); // odhlaseni zrusi i odemknuti zamku v teto relaci
  res.clearCookie('auth');
  res.json({ ok: true });
});

// sid: stejna relace pri obnoveni (keepalive), nova relace pri prihlaseni
function setAuthCookie(res, sid) {
  res.cookie('auth', signToken(COOKIE_MAX_AGE, sid), {
    httpOnly: true, sameSite: 'strict', secure: COOKIE_SECURE, maxAge: COOKIE_MAX_AGE,
  });
}

// zbyvajici cas relace v sekundach (bez rezervy); 0 = vyprsela nebo neplatna
function remainingSec(req) {
  const exp = tokenExpiry(authCookieToken(req));
  return exp ? Math.max(0, Math.floor((exp - SESSION_GRACE_MS - Date.now()) / 1000)) : 0;
}

function requireAuth(req, res, next) {
  const t = parseToken(authCookieToken(req));
  if (!t) return res.status(401).json({ error: 'Unauthorized' });
  req.sid = t.sid;
  locks.session(t.sid); // aktivita drzi odemknuti zamku pri zivote
  next();
}

// uklid odemknuti zamku po relacich, ktere uz vyprsely
setInterval(() => locks.prune(COOKIE_MAX_AGE + 60 * 1000), 60 * 1000).unref();

app.get('/api/health', (req, res) => res.json({ ok: true }));

app.get('/api/me', requireAuth, (req, res) => {
  const remaining = remainingSec(req);
  if (remaining <= 0) return res.status(401).json({ error: 'Unauthorized' });
  res.json({ ok: true, timeoutSec: TIMEOUT_SEC, remainingSec: remaining });
});

// obnoveni relace pri aktivite uzivatele (klouzave odhlaseni po necinnosti)
app.post('/api/keepalive', requireAuth, jsonBody, (req, res) => {
  if (remainingSec(req) <= 0) return res.status(401).json({ error: 'Unauthorized' });
  setAuthCookie(res, req.sid);
  res.json({ ok: true, timeoutSec: TIMEOUT_SEC, remainingSec: TIMEOUT_SEC });
});

// --- soubory ---

app.get('/api/files', requireAuth, wrap(async (req, res) => {
  const dir = safePath(req.query.path);
  locks.assertOpen(req.sid, relOf(dir)); // zamcenou slozku nejde otevrit
  const entries = await fsp.readdir(dir, { withFileTypes: true });
  const items = [];
  for (const e of entries) {
    if (!e.isDirectory() && !e.isFile()) continue; // symlinky apod. preskocit
    const full = path.join(dir, e.name);
    if (isReserved(full)) continue; // skryty soubor se zamky
    const st = await fsp.stat(full);
    items.push({
      name: e.name, dir: e.isDirectory(), size: e.isDirectory() ? null : st.size, mtime: st.mtimeMs,
      lock: locks.info(req.sid, relOf(full)), // null | { root, unlocked }
    });
  }
  items.sort((a, b) => b.dir - a.dir || a.name.localeCompare(b.name, 'cs'));
  res.json(items);
}));

// celkova velikost slozky (rekurzivne, bez symlinku); cache 5 min, maze se pri kazde zmene
const sizeCache = new Map();
const SIZE_TTL = 5 * 60 * 1000;

async function dirSize(dir) {
  let total = 0;
  const stack = [dir];
  while (stack.length) {
    const d = stack.pop();
    const entries = await fsp.readdir(d, { withFileTypes: true });
    await Promise.all(entries.map(async (e) => {
      const p = path.join(d, e.name);
      if (isReserved(p)) return;
      if (e.isDirectory()) stack.push(p);
      else if (e.isFile()) {
        const st = await fsp.stat(p).catch(() => null);
        total += st ? st.size : 0; // plus po awaitu, jinak se pri paralelnim behu ztraceji soucty
      }
    }));
  }
  return total;
}

app.get('/api/size', requireAuth, wrap(async (req, res) => {
  const dir = safePath(req.query.path);
  const hit = sizeCache.get(dir);
  if (hit && Date.now() - hit.t < SIZE_TTL) return res.json({ size: hit.size });
  if (!(await fsp.stat(dir)).isDirectory()) throw new Error('Not a directory');
  const size = await dirSize(dir);
  sizeCache.set(dir, { size, t: Date.now() });
  res.json({ size });
}));

app.get('/api/download', requireAuth, wrap(async (req, res) => {
  const file = safePath(req.query.path);
  locks.assertOpen(req.sid, relOf(file));
  const st = await fsp.stat(file);
  if (!st.isFile()) throw new Error('Not a file');
  res.download(file, path.basename(file));
}));

// upload streamem: PUT /api/upload?path=<slozka>&name=<soubor>, telo = obsah souboru
app.put('/api/upload', requireAuth, wrap(async (req, res) => {
  const dir = safePath(req.query.path);
  locks.assertOpen(req.sid, relOf(dir));
  const target = path.join(dir, safeName(req.query.name));
  assertNotReserved(target);
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
  sizeCache.clear();
  res.status(201).json({ ok: true, size });
}));

app.post('/api/mkdir', requireAuth, jsonBody, wrap(async (req, res) => {
  const dir = safePath(req.body?.path);
  locks.assertOpen(req.sid, relOf(dir));
  const target = path.join(dir, safeName(req.body?.name));
  assertNotReserved(target);
  await fsp.mkdir(target);
  sizeCache.clear();
  res.status(201).json({ ok: true });
}));

// presun / prejmenovani: {from, to} = plne relativni cesty (to = nova cesta vcetne nazvu)
app.post('/api/move', requireAuth, jsonBody, wrap(async (req, res) => {
  const from = safePath(req.body?.from);
  const to = safePath(req.body?.to);
  safeName(path.basename(to));
  assertNotReserved(to);
  if (from === ROOT || to === ROOT) throw new Error('Cannot move root');
  if (to === from) throw new Error('Source and target are the same');
  if (to.startsWith(from + path.sep)) throw new Error('Cannot move into itself');
  locks.assertRelatedOpen(req.sid, relOf(from)); // zamcene (i uvnitr) nejde presunout
  locks.assertOpen(req.sid, relOf(path.dirname(to))); // ani presunout do zamcene slozky
  await fsp.stat(from);
  if (!(await fsp.stat(path.dirname(to))).isDirectory()) throw new Error('Target is not a directory');
  if (await fsp.access(to).then(() => true, () => false)) {
    throw Object.assign(new Error('Target already exists'), { status: 409 });
  }
  await fsp.rename(from, to);
  await locks.rewrite(relOf(from), relOf(to)); // zamky se presunou spolu s polozkou
  sizeCache.clear();
  res.json({ ok: true });
}));

app.delete('/api/files',requireAuth, wrap(async (req, res) => {
  const target = safePath(req.query.path);
  if (target === ROOT) throw new Error('Cannot delete root');
  locks.assertRelatedOpen(req.sid, relOf(target)); // zamcene (i uvnitr) nejde smazat
  await fsp.rm(target, { recursive: true });
  await locks.removeUnder(relOf(target)); // se smazanou polozkou zanikaji i jeji zamky
  sizeCache.clear();
  res.json({ ok: true });
}));

// --- zamky ---
// kazdy zamek ma vlastni heslo (nastavi se pri zamknuti); odemykani a ruseni zamku ho overuje, s limitem pokusu

const lockAttempts = new Map(); // ip -> { n, t }
function verifyLockPassword(req, full) {
  const rec = lockAttempts.get(req.ip);
  const active = rec && Date.now() - rec.t < BLOCK_MS;
  if (active && rec.n >= MAX_ATTEMPTS) throw Object.assign(new Error('Too many attempts, try later'), { status: 429 });
  if (!locks.verify(relOf(full), req.body?.password)) {
    lockAttempts.set(req.ip, { n: (active ? rec.n : 0) + 1, t: Date.now() });
    throw Object.assign(new Error('Wrong lock password'), { status: 403 });
  }
  lockAttempts.delete(req.ip);
}

// cesta musi existovat a byt presne koren zamku
function lockRootPath(req) {
  const full = safePath(req.body?.path);
  if (full === ROOT || !locks.has(relOf(full))) throw Object.assign(new Error('Not locked'), { status: 404 });
  return full;
}

// zamknout: {path, password} nastavi vlastni heslo teto polozky; zamek plati hned i pro tuto relaci
app.post('/api/lock', requireAuth, jsonBody, wrap(async (req, res) => {
  const full = safePath(req.body?.path);
  if (full === ROOT) throw new Error('Cannot lock root');
  locks.assertOpen(req.sid, relOf(full)); // i rodicovske zamky musi byt odemcene
  await fsp.stat(full);
  await locks.add(relOf(full), req.body?.password);
  res.status(201).json({ ok: true });
}));

// docasne odemknuti (do odhlaseni)
app.post('/api/unlock', requireAuth, jsonBody, wrap(async (req, res) => {
  const full = lockRootPath(req);
  verifyLockPassword(req, full);
  locks.unlock(req.sid, relOf(full));
  res.json({ ok: true });
}));

// znovu zamknout v teto relaci (bez hesla)
app.post('/api/relock', requireAuth, jsonBody, wrap(async (req, res) => {
  const full = lockRootPath(req);
  locks.relock(req.sid, relOf(full));
  res.json({ ok: true });
}));

// zruseni zamku natrvalo (heslo)
app.post('/api/lock/remove', requireAuth, jsonBody, wrap(async (req, res) => {
  const full = lockRootPath(req);
  const rel = relOf(full);
  locks.assertParentsOpen(req.sid, rel);
  verifyLockPassword(req, full);
  await locks.remove(rel);
  res.json({ ok: true });
}));

app.use(express.static(path.join(__dirname, '..', 'public')));

app.listen(PORT, () => console.log(`nas-storage listening on :${PORT}, storage ${ROOT}`));
