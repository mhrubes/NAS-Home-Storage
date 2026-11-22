const express = require('express');
const path = require('path');
const fs = require('fs');
const fsp = fs.promises;
const { checkLogin, signToken, parseToken, tokenExpiry } = require('./auth');
const { LockStore } = require('./locks');
const { Trash } = require('./trash');
const { ShareStore } = require('./shares');
const { Uploads } = require('./uploads');
const { collectEntries, streamZip } = require('./zip');

// verze aplikace je jediny zdroj pravdy v package.json (zobrazuje se na strance a vraci /api/health)
const APP_VERSION = require('../package.json').version;

const PORT = parseInt(process.env.PORT, 10) || 3000;
const ROOT = path.resolve(process.env.STORAGE_DIR || './data');
const MAX_UPLOAD = (parseInt(process.env.MAX_UPLOAD_MB, 10) || 2048) * 1024 * 1024;
const CHUNK_SIZE = 8 * 1024 * 1024; // doporuceny blok pri nahravani po castech
const CHUNK_MAX = 16 * 1024 * 1024; // nejvetsi povoleny blok
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

// Kos: TRASH_DAYS dni (vychozi 30), 0 = kos vypnuty a mazani je trvale
const DEFAULT_TRASH_DAYS = 30;
function parseTrashDays(raw) {
  if (raw === undefined || raw === '') return DEFAULT_TRASH_DAYS;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 0 || n > 3650) {
    console.warn(`Neplatna hodnota TRASH_DAYS="${raw}", pouzivam ${DEFAULT_TRASH_DAYS}`);
    return DEFAULT_TRASH_DAYS;
  }
  return n;
}
const TRASH_DAYS = parseTrashDays(process.env.TRASH_DAYS);

fs.mkdirSync(ROOT, { recursive: true });

// Sluzebni data jsou v uloziste jako skryte polozky s predponou ".nas-" (neni je videt a nejde s nimi manipulovat):
// .nas-locks.json (zamky), .nas-shares.json (odkazy), .nas-trash/ (kos), .nas-uploads/ (rozpracovana nahravani)
const locks = new LockStore(path.join(ROOT, '.nas-locks.json'));
locks.load();
const shares = new ShareStore(path.join(ROOT, '.nas-shares.json'));
shares.load();
const trash = new Trash(ROOT, TRASH_DAYS);
trash.load();
const uploads = new Uploads(ROOT);
uploads.load();

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
const formBody = express.urlencoded({ extended: false, limit: '200kb' });

// --- pomocne funkce ---

// absolutni cesta -> relativni k ROOT s '/' ('' = koren)
const relOf = (full) => path.relative(ROOT, full).split(path.sep).join('/');
const isReserved = (full) => {
  const first = relOf(full).split('/')[0].toLowerCase();
  return first.startsWith('.nas-');
};

// relativni cesta -> absolutni uvnitr ROOT, jinak vyjimka (path traversal)
function safePath(rel) {
  const full = path.resolve(ROOT, '.' + path.sep + String(rel ?? ''));
  if (full !== ROOT && !full.startsWith(ROOT + path.sep)) throw new Error('Invalid path');
  if (isReserved(full)) throw new Error('Invalid path');
  return full;
}

// cil nove vytvarane polozky (upload, mkdir, presun) nesmi byt vyhrazena sluzebni polozka
function assertNotReserved(full) {
  if (isReserved(full)) throw new Error('Invalid name');
}

// jedna slozka/soubor, bez oddelovacu cesty
function safeName(name) {
  const n = path.basename(String(name ?? '')).trim();
  if (!n || n === '.' || n === '..' || n.includes('\0')) throw new Error('Invalid name');
  return n;
}

const exists = (p) => fsp.access(p).then(() => true, () => false);

// "nazev (1).ext", "nazev (2).ext"... prvni volny nazev ve slozce
async function uniqueName(dir, name) {
  const ext = path.extname(name);
  const base = ext ? name.slice(0, -ext.length) : name;
  for (let i = 1; i < 1000; i++) {
    const cand = `${base} (${i})${ext}`;
    if (!(await exists(path.join(dir, cand)))) return cand;
  }
  throw new Error('Cannot find free name');
}

// hledani bez ohledu na diakritiku a velikost pismen
const fold = (s) => String(s).normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();

// nahled v prohlizeci: typ podle pripony (jen bezpecne typy; html se zobrazi jako text)
const PREVIEW_TYPES = {
  png: ['image', 'image/png'], jpg: ['image', 'image/jpeg'], jpeg: ['image', 'image/jpeg'], gif: ['image', 'image/gif'],
  webp: ['image', 'image/webp'], bmp: ['image', 'image/bmp'], ico: ['image', 'image/x-icon'], svg: ['image', 'image/svg+xml'],
  pdf: ['pdf', 'application/pdf'],
  mp4: ['video', 'video/mp4'], webm: ['video', 'video/webm'], ogv: ['video', 'video/ogg'],
  mp3: ['audio', 'audio/mpeg'], wav: ['audio', 'audio/wav'], ogg: ['audio', 'audio/ogg'], m4a: ['audio', 'audio/mp4'], flac: ['audio', 'audio/flac'],
};
const TEXT_EXT = new Set(['txt', 'md', 'log', 'json', 'csv', 'tsv', 'xml', 'yml', 'yaml', 'ini', 'conf', 'cfg', 'env', 'js', 'mjs', 'ts', 'css',
  'html', 'htm', 'sh', 'py', 'sql', 'java', 'c', 'h', 'cpp', 'cs', 'go', 'rs', 'php', 'rb', 'toml', 'properties']);
function previewKind(name) {
  const ext = path.extname(name).slice(1).toLowerCase();
  if (PREVIEW_TYPES[ext]) return { kind: PREVIEW_TYPES[ext][0], mime: PREVIEW_TYPES[ext][1] };
  if (TEXT_EXT.has(ext)) return { kind: 'text', mime: 'text/plain; charset=utf-8' };
  return null;
}

const wrap = (fn) => async (req, res) => {
  try {
    await fn(req, res);
  } catch (err) {
    if (res.headersSent) return res.destroy();
    const status = err.status || (err.code === 'ENOENT' ? 404 : 400);
    res.status(status).json({ error: err.message, ...(err.received !== undefined ? { received: err.received } : {}) });
  }
};

// --- autentizace ---

const attempts = new Map(); // ip -> { n, t }
const MAX_ATTEMPTS = 5;
const BLOCK_MS = 15 * 60 * 1000;

const sessionInfo = (remainingSec) => ({
  ok: true, timeoutSec: TIMEOUT_SEC, remainingSec, trashDays: TRASH_DAYS, maxUploadMB: Math.round(MAX_UPLOAD / 1024 / 1024),
});

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
  res.json(sessionInfo(TIMEOUT_SEC));
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

// uklid: odemknuti zamku po relacich, ktere uz vyprsely; vyprsele odkazy; stara nahravani a stary kos
setInterval(() => locks.prune(COOKIE_MAX_AGE + 60 * 1000), 60 * 1000).unref();
setInterval(() => { shares.purgeExpired().catch((e) => console.error('Share cleanup failed: ', e)); }, 60 * 60 * 1000).unref();
setInterval(() => {
  uploads.cleanup().catch((e) => console.error('Upload cleanup failed: ', e));
  trash.purgeExpired().catch((e) => console.error('Trash cleanup failed: ', e));
}, 60 * 60 * 1000).unref();
uploads.cleanup().catch((e) => console.error('Upload cleanup failed: ', e));
trash.purgeExpired().catch((e) => console.error('Trash cleanup failed: ', e));
shares.purgeExpired().catch((e) => console.error('Share cleanup failed: ', e));

app.get('/api/health', (req, res) => res.json({ ok: true, version: APP_VERSION }));

app.get('/api/me', requireAuth, (req, res) => {
  const remaining = remainingSec(req);
  if (remaining <= 0) return res.status(401).json({ error: 'Unauthorized' });
  res.json(sessionInfo(remaining));
});

// obnoveni relace pri aktivite uzivatele (klouzave odhlaseni po necinnosti)
app.post('/api/keepalive', requireAuth, jsonBody, (req, res) => {
  if (remainingSec(req) <= 0) return res.status(401).json({ error: 'Unauthorized' });
  setAuthCookie(res, req.sid);
  res.json(sessionInfo(TIMEOUT_SEC));
});

// --- soubory ---

const itemInfo = (sid, full, name, isDir, st) => {
  const rel = relOf(full);
  return {
    name, dir: isDir, size: isDir ? null : st.size, mtime: st.mtimeMs,
    lock: locks.info(sid, rel), // null | { root, unlocked }
    shared: shares.hasPath(rel),
    preview: isDir ? null : (previewKind(name) || {}).kind || null,
  };
};

app.get('/api/files', requireAuth, wrap(async (req, res) => {
  const dir = safePath(req.query.path);
  locks.assertOpen(req.sid, relOf(dir)); // zamcenou slozku nejde otevrit
  const entries = await fsp.readdir(dir, { withFileTypes: true });
  const items = [];
  for (const e of entries) {
    if (!e.isDirectory() && !e.isFile()) continue; // symlinky apod. preskocit
    const full = path.join(dir, e.name);
    if (isReserved(full)) continue; // skryte sluzebni polozky
    const st = await fsp.stat(full);
    items.push(itemInfo(req.sid, full, e.name, e.isDirectory(), st));
  }
  items.sort((a, b) => b.dir - a.dir || a.name.localeCompare(b.name, 'cs'));
  res.json(items);
}));

// hledani v nazvech od zadane slozky dolu (zamcene a neodemcene slozky se neprohledavaji)
app.get('/api/search', requireAuth, wrap(async (req, res) => {
  const dir = safePath(req.query.path);
  locks.assertOpen(req.sid, relOf(dir));
  const q = fold(String(req.query.q ?? '').trim());
  if (!q) return res.json({ results: [], truncated: false });
  const LIMIT = 300;
  const SCAN_LIMIT = 100000;
  const results = [];
  let scanned = 0;
  const queue = [dir];
  while (queue.length && results.length < LIMIT && scanned < SCAN_LIMIT) {
    const d = queue.shift();
    let entries;
    try { entries = await fsp.readdir(d, { withFileTypes: true }); } catch { continue; }
    for (const e of entries) {
      if (!e.isDirectory() && !e.isFile()) continue;
      const full = path.join(d, e.name);
      if (isReserved(full)) continue;
      scanned++;
      const rel = relOf(full);
      if (fold(e.name).includes(q)) {
        const st = await fsp.stat(full).catch(() => null);
        if (st) results.push({ ...itemInfo(req.sid, full, e.name, e.isDirectory(), st), rel, parent: relOf(d) });
        if (results.length >= LIMIT) break;
      }
      if (e.isDirectory() && locks.isOpen(req.sid, rel)) queue.push(full);
    }
  }
  res.json({ results, truncated: results.length >= LIMIT || scanned >= SCAN_LIMIT });
}));

// volne misto na disku s uloztem
app.get('/api/space', requireAuth, wrap(async (req, res) => {
  const s = await fsp.statfs(ROOT);
  res.json({ free: Number(s.bavail) * Number(s.bsize), total: Number(s.blocks) * Number(s.bsize) });
}));

// celkova velikost slozky (rekurzivne, bez symlinku); cache 5 min, maze se pri kazde zmene
const sizeCache = new Map();
const SIZE_TTL = 5 * 60 * 1000;

async function dirSize(dir, honorReserved = true) {
  let total = 0;
  const stack = [dir];
  while (stack.length) {
    const d = stack.pop();
    const entries = await fsp.readdir(d, { withFileTypes: true });
    await Promise.all(entries.map(async (e) => {
      const p = path.join(d, e.name);
      if (honorReserved && isReserved(p)) return;
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

// nahled souboru primo v prohlizeci (obrazky, PDF, video, audio, text); podporuje Range kvuli prehravani
app.get('/api/preview', requireAuth, wrap(async (req, res) => {
  const file = safePath(req.query.path);
  locks.assertOpen(req.sid, relOf(file));
  const st = await fsp.stat(file);
  if (!st.isFile()) throw new Error('Not a file');
  const kind = previewKind(path.basename(file));
  if (!kind) throw Object.assign(new Error('Preview not supported'), { status: 415 });
  res.set('X-Frame-Options', 'SAMEORIGIN'); // nahled PDF je v iframe teto stranky
  res.set('Cache-Control', 'private, no-store');
  res.set('Content-Disposition', 'inline');
  if (kind.mime === 'image/svg+xml') res.set('Content-Security-Policy', 'sandbox'); // skripty v SVG se nespusti
  res.type(kind.mime);
  res.sendFile(file, { dotfiles: 'allow' }, (err) => { if (err && !res.headersSent) res.status(err.status || 500).end(); });
}));

// --- ZIP ke stazeni ---

// items: pole relativnich cest; vsechny (i obsah slozek) musi byt odemcene
async function sendZip(req, res, rels, zipName) {
  const items = [];
  const used = new Set();
  for (const rel of rels) {
    const full = safePath(rel);
    locks.assertRelatedOpen(req.sid, relOf(full));
    await fsp.stat(full);
    const base = full === ROOT ? 'NAS' : path.basename(full);
    let name = base;
    for (let i = 2; used.has(name.toLowerCase()); i++) name = `${base} (${i})`;
    used.add(name.toLowerCase());
    items.push({ full, name });
  }
  const entries = await collectEntries(items, isReserved); // kontrola limitu jeste pred odeslanim hlavicek
  if (req.query.dry === '1') { // jen overeni (zamky, limity) a odhad velikosti, nic se nestahuje
    const files = entries.filter((e) => !e.dir);
    return res.json({ ok: true, files: files.length, bytes: files.reduce((s, e) => s + e.size, 0) });
  }
  res.attachment(zipName);
  res.type('application/zip');
  res.set('Cache-Control', 'no-store');
  try { await streamZip(res, entries); } catch (err) { res.destroy(err); }
}

const MAX_ZIP_PATHS = 500;

// jedna slozka/soubor: GET /api/zip?path=slozka
app.get('/api/zip', requireAuth, wrap(async (req, res) => {
  const rel = String(req.query.path ?? '');
  const full = safePath(rel);
  await sendZip(req, res, [rel], `${full === ROOT ? 'NAS' : path.basename(full)}.zip`);
}));

// vyber vice polozek: formular s polem paths = JSON pole cest (stahuje se obycejnym odeslanim formulare)
app.post('/api/zip', requireAuth, formBody, wrap(async (req, res) => {
  let rels;
  try { rels = JSON.parse(String(req.body?.paths ?? '[]')); } catch { throw new Error('Invalid paths'); }
  if (!Array.isArray(rels) || !rels.length || rels.length > MAX_ZIP_PATHS || !rels.every((r) => typeof r === 'string')) throw new Error('Invalid paths');
  const d = new Date();
  const stamp = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`;
  await sendZip(req, res, rels, `vyber-${stamp}.zip`);
}));

// --- nahravani ---

// jednoduche nahravani jednim pozadavkem: PUT /api/upload?path=<slozka>&name=<soubor>, telo = obsah souboru
app.put('/api/upload', requireAuth, wrap(async (req, res) => {
  const dir = safePath(req.query.path);
  locks.assertOpen(req.sid, relOf(dir));
  const target = path.join(dir, safeName(req.query.name));
  assertNotReserved(target);
  if (!(await fsp.stat(dir)).isDirectory()) throw new Error('Target is not a directory');
  const declared = parseInt(req.headers['content-length'], 10);
  if (declared > MAX_UPLOAD) throw Object.assign(new Error('File too large'), { status: 413 });
  if (await exists(target)) throw Object.assign(new Error('File already exists'), { status: 409 });

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

// nahravani po castech s moznosti navazat. 1) init, 2) bloky PUT /api/upload/:id?offset=N, 3) finish.
// onConflict: bez hodnoty = chyba 409 pri existujicim souboru, "overwrite" = prepsat, "rename" = ulozit pod novym nazvem
app.post('/api/upload/init', requireAuth, jsonBody, wrap(async (req, res) => {
  const { path: dirPath, name, size, fp, onConflict } = req.body || {};
  const dir = safePath(dirPath);
  locks.assertOpen(req.sid, relOf(dir));
  const fname = safeName(name);
  const target = path.join(dir, fname);
  assertNotReserved(target);
  const sz = Number(size);
  if (!Number.isInteger(sz) || sz < 0) throw new Error('Invalid size');
  if (sz > MAX_UPLOAD) throw Object.assign(new Error('File too large'), { status: 413 });
  if (!(await fsp.stat(dir)).isDirectory()) throw new Error('Target is not a directory');
  if (await exists(target)) {
    if (onConflict !== 'overwrite' && onConflict !== 'rename') throw Object.assign(new Error('File already exists'), { status: 409 });
    if (onConflict === 'overwrite') {
      locks.assertOpen(req.sid, relOf(target));
      if ((await fsp.stat(target)).isDirectory()) throw Object.assign(new Error('Target is a directory'), { status: 409 });
    }
  }
  const fpStr = typeof fp === 'string' ? fp.slice(0, 300) : '';
  const { meta, received, resumed } = await uploads.init({ dirRel: relOf(dir), name: fname, size: sz, fp: fpStr });
  meta.onConflict = onConflict === 'overwrite' || onConflict === 'rename' ? onConflict : '';
  await uploads.saveMeta(meta);
  res.json({ id: meta.id, received, resumed, chunkSize: CHUNK_SIZE });
}));

const uploadId = (req) => {
  if (!Uploads.validId(req.params.id)) throw Object.assign(new Error('Upload not found'), { status: 404 });
  return req.params.id;
};

app.get('/api/upload/:id', requireAuth, wrap(async (req, res) => {
  const id = uploadId(req);
  const m = uploads.get(id);
  res.json({ received: await uploads.received(id), size: m.size });
}));

app.put('/api/upload/:id', requireAuth, wrap(async (req, res) => {
  const id = uploadId(req);
  const offset = Number(req.query.offset);
  if (!Number.isInteger(offset) || offset < 0) throw new Error('Invalid offset');
  const received = await uploads.append(id, offset, req, CHUNK_MAX);
  res.json({ received });
}));

app.post('/api/upload/:id/finish', requireAuth, jsonBody, wrap(async (req, res) => {
  const id = uploadId(req);
  const m = uploads.get(id);
  const have = await uploads.received(id);
  if (have !== m.size) throw Object.assign(new Error('Upload incomplete'), { status: 409, received: have });
  const dir = safePath(m.dirRel);
  locks.assertOpen(req.sid, relOf(dir));
  if (!(await fsp.stat(dir)).isDirectory()) throw new Error('Target is not a directory');
  let name = m.name;
  let target = path.join(dir, name);
  assertNotReserved(target);
  if (await exists(target)) {
    const mode = req.body?.onConflict || m.onConflict;
    if (mode === 'rename') {
      name = await uniqueName(dir, name);
      target = path.join(dir, name);
    } else if (mode === 'overwrite') {
      locks.assertOpen(req.sid, relOf(target));
      if ((await fsp.stat(target)).isDirectory()) throw Object.assign(new Error('Target is a directory'), { status: 409 });
    } else {
      throw Object.assign(new Error('File already exists'), { status: 409 });
    }
  }
  await fsp.rename(uploads.part(id), target);
  await uploads.forget(id);
  sizeCache.clear();
  res.status(201).json({ ok: true, name, size: m.size });
}));

app.delete('/api/upload/:id', requireAuth, wrap(async (req, res) => {
  const id = uploadId(req);
  uploads.get(id);
  await uploads.discard(id);
  res.json({ ok: true });
}));

app.post('/api/mkdir', requireAuth, jsonBody, wrap(async (req, res) => {
  const dir = safePath(req.body?.path);
  locks.assertOpen(req.sid, relOf(dir));
  const target = path.join(dir, safeName(req.body?.name));
  assertNotReserved(target);
  await fsp.mkdir(target, { recursive: !!req.body?.ensure }); // ensure: existujici slozka neni chyba (nahravani celych slozek)
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
  if (await exists(to)) throw Object.assign(new Error('Target already exists'), { status: 409 });
  await fsp.rename(from, to);
  await locks.rewrite(relOf(from), relOf(to)); // zamky se presunou spolu s polozkou
  await shares.rewrite(relOf(from), relOf(to)); // i sdilene odkazy
  sizeCache.clear();
  res.json({ ok: true });
}));

// smazani: do kose (pokud je zapnuty), jinak trvale
app.delete('/api/files', requireAuth, wrap(async (req, res) => {
  const target = safePath(req.query.path);
  if (target === ROOT) throw new Error('Cannot delete root');
  const rel = relOf(target);
  locks.assertRelatedOpen(req.sid, rel); // zamcene (i uvnitr) nejde smazat
  const st = await fsp.stat(target);
  if (trash.enabled) {
    const detached = await locks.detach(rel); // zamky odjedou do kose spolu s polozkou
    try { await trash.moveIn(target, rel, st.isDirectory(), detached); } catch (err) { await locks.attach(rel, detached); throw err; }
    await shares.removeUnder(rel);
    sizeCache.clear();
    return res.json({ ok: true, trashed: true });
  }
  await fsp.rm(target, { recursive: true });
  await locks.removeUnder(rel);
  await shares.removeUnder(rel);
  sizeCache.clear();
  res.json({ ok: true, trashed: false });
}));

// --- kos ---

app.get('/api/trash', requireAuth, wrap(async (req, res) => {
  const out = [];
  for (const it of trash.list()) {
    if (it.size == null) { // velikost se dopocita jednou a ulozi
      const p = trash.contentPath(it.id);
      const size = it.dir ? await dirSize(p, false).catch(() => 0) : (await fsp.stat(p).catch(() => ({ size: 0 }))).size;
      await trash.setSize(it.id, size);
    }
    out.push({ id: it.id, name: it.name, rel: it.rel, dir: it.dir, deletedAt: it.deletedAt, size: it.size, daysLeft: trash.daysLeft(it), locked: Object.keys(it.locks || {}).length > 0 });
  }
  res.json({ enabled: trash.enabled, days: TRASH_DAYS, items: out });
}));

const trashId = (req) => {
  if (!/^[0-9a-z]+$/.test(String(req.params.id ?? req.body?.id ?? ''))) throw Object.assign(new Error('Not in trash'), { status: 404 });
  return String(req.params.id ?? req.body?.id);
};

// obnoveni na puvodni misto; kdyz tam uz neco je, ulozi se pod nazvem "nazev (1)"
app.post('/api/trash/restore', requireAuth, jsonBody, wrap(async (req, res) => {
  const entry = trash.get(trashId(req));
  if (!entry) throw Object.assign(new Error('Not in trash'), { status: 404 });
  const origFull = safePath(entry.rel);
  const parent = path.dirname(origFull);
  locks.assertOpen(req.sid, relOf(parent)); // do zamcene slozky se obnovovat nejde
  await fsp.mkdir(parent, { recursive: true });
  let target = origFull;
  if (await exists(target)) target = path.join(parent, await uniqueName(parent, entry.name));
  await trash.restoreTo(entry.id, target);
  await locks.attach(relOf(target), entry.locks); // zamky se vrati s polozkou
  sizeCache.clear();
  res.json({ ok: true, rel: relOf(target) });
}));

// trvale smazani z kose
app.delete('/api/trash/:id', requireAuth, wrap(async (req, res) => {
  await trash.purge(trashId(req));
  res.json({ ok: true });
}));

app.delete('/api/trash', requireAuth, wrap(async (req, res) => {
  res.json({ ok: true, removed: await trash.empty() });
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

// --- sdilene odkazy ---
// Vytvoreni a sprava vyzaduje prihlaseni. Samotny odkaz (/s/<token>) funguje bez prihlaseni, ale jen do vyprseni
// nebo zruseni a nikdy pro zamcene polozky (ani polozky se zamcenou podslozkou).

const lockedForShare = (rel) => locks.covering(rel).length > 0 || locks.below(rel).length > 0;

app.post('/api/share', requireAuth, jsonBody, wrap(async (req, res) => {
  const full = safePath(req.body?.path);
  if (full === ROOT) throw new Error('Cannot share root');
  const rel = relOf(full);
  const st = await fsp.stat(full);
  if (lockedForShare(rel)) throw Object.assign(new Error('Locked items cannot be shared'), { status: 409 });
  const e = await shares.create(rel, path.basename(full), st.isDirectory(), req.body?.hours);
  res.status(201).json({ token: e.token, name: e.name, dir: e.dir, expires: e.expires });
}));

app.get('/api/shares', requireAuth, wrap(async (req, res) => {
  await shares.purgeExpired();
  res.json(shares.list().map((e) => ({ token: e.token, name: e.name, rel: e.rel, dir: e.dir, created: e.created, expires: e.expires })));
}));

app.delete('/api/share/:token', requireAuth, wrap(async (req, res) => {
  await shares.revoke(req.params.token);
  res.json({ ok: true });
}));

// verejna cast: jednoduchy limit pozadavku na IP (ochrana pred hadanim a zahlcenim)
const publicHits = new Map(); // ip -> { n, t }
function publicLimiter(req, res, next) {
  const now = Date.now();
  let rec = publicHits.get(req.ip);
  if (!rec || now - rec.t > 60 * 1000) { rec = { n: 0, t: now }; publicHits.set(req.ip, rec); }
  if (++rec.n > 120) return res.status(429).json({ error: 'Too many requests' });
  next();
}
setInterval(() => { const l = Date.now() - 120 * 1000; for (const [ip, r] of publicHits) if (r.t < l) publicHits.delete(ip); }, 120 * 1000).unref();

// platny sdileny odkaz + jeho existujici cil, jinak 404 (stejna odpoved pro vsechny pripady, nic se neprozradi)
async function resolveShare(token) {
  const e = shares.get(token);
  if (!e) return null;
  if (lockedForShare(e.rel)) return null;
  const full = safePath(e.rel);
  const st = await fsp.stat(full).catch(() => null);
  if (!st) return null;
  return { e, full, st };
}

app.get('/api/s/:token', publicLimiter, wrap(async (req, res) => {
  const r = await resolveShare(req.params.token);
  if (!r) throw Object.assign(new Error('Share not found'), { status: 404 });
  res.json({ name: r.e.name, dir: r.st.isDirectory(), size: r.st.isDirectory() ? null : r.st.size, expires: r.e.expires });
}));

app.get('/s/:token/download', publicLimiter, wrap(async (req, res) => {
  const r = await resolveShare(req.params.token);
  if (!r) throw Object.assign(new Error('Share not found'), { status: 404 });
  if (r.st.isDirectory()) {
    const entries = await collectEntries([{ full: r.full, name: r.e.name }], isReserved);
    res.attachment(`${r.e.name}.zip`);
    res.type('application/zip');
    res.set('Cache-Control', 'no-store');
    try { await streamZip(res, entries); } catch (err) { res.destroy(err); }
    return;
  }
  res.download(r.full, r.e.name);
}));

app.get('/s/:token', publicLimiter, (req, res) => {
  res.set('Cache-Control', 'no-store');
  res.sendFile(path.join(__dirname, '..', 'public', 'share.html'));
});

app.use(express.static(path.join(__dirname, '..', 'public')));

// chyby z parseru tela apod. vracet jako JSON, ne jako HTML
app.use((err, req, res, next) => {
  if (res.headersSent) return next(err);
  res.status(err.status || 400).json({ error: err.type === 'entity.too.large' ? 'Request too large' : (err.message || 'Bad request') });
});

app.listen(PORT, () => console.log(`nas-storage v${APP_VERSION} listening on :${PORT}, storage ${ROOT}, trash ${TRASH_DAYS ? TRASH_DAYS + ' days' : 'off'}`));
