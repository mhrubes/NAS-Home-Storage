'use strict';

// ============================================================================
// Pomocne funkce
// ============================================================================
const $ = (id) => document.getElementById(id);
const join = (a, b) => (a ? a + '/' + b : b);
const parentOf = (p) => p.split('/').slice(0, -1).join('/');
const baseName = (p) => p.split('/').pop();
const enc = encodeURIComponent;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function fmtSize(n) {
  if (n == null) return '';
  const u = ['B', 'KB', 'MB', 'GB', 'TB']; let i = 0;
  while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; }
  return (i ? n.toFixed(1) : n) + ' ' + u[i];
}

function fmtDate(ms) {
  if (!ms) return '';
  return new Date(ms).toLocaleString('cs-CZ', { day: 'numeric', month: 'numeric', year: 'numeric', hour: '2-digit', minute: '2-digit' });
}

function fmtAgo(ms) {
  const m = Math.floor((Date.now() - ms) / 60000);
  if (m < 1) return 'před chvílí';
  if (m < 60) return `před ${m} min`;
  const h = Math.floor(m / 60);
  if (h < 48) return `před ${h} h`;
  return `před ${Math.floor(h / 24)} dny`;
}

function plural(n, one, few, many) { return n === 1 ? one : n >= 2 && n <= 4 ? few : many; }

// ============================================================================
// Ikony (inline SVG, bez zavislosti) a ikonova tlacitka s tooltipem
// ============================================================================
const ICONS = {
  pencil: '<path d="M17 3a2.85 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z"/><path d="m15 5 4 4"/>',
  trash: '<path d="M3 6h18"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6"/><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/><line x1="10" y1="11" x2="10" y2="17"/><line x1="14" y1="11" x2="14" y2="17"/>',
  lock: '<rect width="18" height="11" x="3" y="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/>',
  unlock: '<rect width="18" height="11" x="3" y="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0 1 9.9-1"/>',
  download: '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/>',
  zip: '<rect width="20" height="5" x="2" y="3" rx="1"/><path d="M4 8v11a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8"/><path d="M10 12h4"/>',
  link: '<path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/>',
  move: '<path d="M2 9V5a2 2 0 0 1 2-2h3.9a2 2 0 0 1 1.69.9l.81 1.2a2 2 0 0 0 1.67.9H20a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2v-1"/><path d="M2 13h10"/><path d="m9 16 3-3-3-3"/>',
  restore: '<polyline points="1 4 1 10 7 10"/><path d="M3.51 15a9 9 0 1 0 2.13-9.36L1 10"/>',
  copy: '<rect width="14" height="14" x="8" y="8" rx="2" ry="2"/><path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"/>',
  x: '<line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>',
};

function svgIcon(name) { return `<svg viewBox="0 0 24 24" aria-hidden="true">${ICONS[name]}</svg>`; } // ICONS je konstanta v kodu, ne uzivatelsky vstup

function iconBtn(icon, label, cls = '') {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = ('ibtn ' + cls).trim();
  b.dataset.tip = label;
  b.setAttribute('aria-label', label);
  b.innerHTML = svgIcon(icon);
  return b;
}

// ============================================================================
// Automaticke odhlaseni pri necinnosti (jako v bankovnich aplikacich)
// Odpocet se pocita z casove znacky (deadline), takze je presny i v neaktivni zalozce.
// Aktivita (mys, klavesnice, dotyk, scroll, probihajici upload) odpocet vrati na plnou hodnotu;
// prepnuti na jinou zalozku ho neresetuje.
// ============================================================================
const RING_CIRC = 2 * Math.PI * 19;
const KEEPALIVE_EVERY_MS = 10000;
let timeoutMs = 0;
let deadline = 0;
let lastKeepalive = 0;
let tickTimer = null;
const conf = { trashDays: 30, maxUploadMB: 2048 };

function startSession(me) {
  timeoutMs = me.timeoutSec * 1000;
  deadline = Date.now() + me.remainingSec * 1000;
  lastKeepalive = Date.now();
  if (me.trashDays !== undefined) conf.trashDays = me.trashDays;
  if (me.maxUploadMB !== undefined) conf.maxUploadMB = me.maxUploadMB;
  $('ring').classList.remove('hidden');
  if (!tickTimer) tickTimer = setInterval(tick, 1000);
  tick();
}

function endSession() {
  clearInterval(tickTimer); tickTimer = null;
  $('ring').classList.add('hidden');
}

function tick() {
  if (!tickTimer) return;
  const left = deadline - Date.now();
  if (left <= 0) { sessionExpired(); return; }
  const s = Math.ceil(left / 1000);
  $('ringText').textContent = `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
  $('ringFg').style.strokeDasharray = RING_CIRC;
  $('ringFg').style.strokeDashoffset = RING_CIRC * (1 - Math.min(1, left / timeoutMs));
  $('ring').classList.toggle('warn', left <= 30000 && left > 10000);
  $('ring').classList.toggle('danger', left <= 10000);
}

function sessionExpired() {
  endSession();
  for (const id of ['dlg', 'panel', 'cnf', 'pick', 'pv']) { const d = $(id); if (d.open) d.close('cancel'); }
  cancelAllUploads();
  fetch('/api/logout', { method: 'POST' }).catch(() => {});
  showLogin();
  toast('Byl jsi odhlášen z důvodu nečinnosti', 'error');
}

function onActivity() {
  if (!tickTimer) return;
  const now = Date.now();
  if (now >= deadline) return; // vyprsela, rozhodne tick()
  deadline = now + timeoutMs;
  if (now - lastKeepalive >= KEEPALIVE_EVERY_MS) { // server obnovime nejvyse jednou za 10 s
    lastKeepalive = now;
    fetch('/api/keepalive', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })
      .then((r) => { if (r.status === 401) sessionExpired(); }).catch(() => {});
  }
}
for (const ev of ['mousemove', 'mousedown', 'keydown', 'touchstart', 'wheel', 'scroll']) {
  window.addEventListener(ev, onActivity, { passive: true, capture: true });
}
document.addEventListener('visibilitychange', () => { if (!document.hidden) tick(); });

// 401 z API: pri aktivni relaci jde o vyprseni, jinak jen zobrazit prihlaseni
function handleUnauthorized() { if (tickTimer) sessionExpired(); else showLogin(); }

// ============================================================================
// API, toasty
// ============================================================================
async function api(url, opts) {
  const res = await fetch(url, opts);
  if (res.status === 401 && !url.startsWith('/api/login')) { handleUnauthorized(); const e = new Error('Unauthorized'); e.status = 401; throw e; }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) { const e = new Error(data.error || res.statusText); e.status = res.status; e.data = data; throw e; }
  return data;
}
const jsonPost = (url, body) => api(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

const MSG = {
  'File already exists': 'Soubor se stejným názvem už existuje',
  'Target already exists': 'Cíl se stejným názvem už existuje',
  'Target is a directory': 'Cíl je složka, nelze ji přepsat souborem',
  'Cannot move into itself': 'Složku nelze přesunout do sebe sama',
  'Source and target are the same': 'Zdroj a cíl jsou stejné',
  'File too large': 'Soubor je příliš velký',
  'Invalid name': 'Neplatný název',
  'Invalid path': 'Neplatná cesta',
  'Too many attempts, try later': 'Příliš mnoho pokusů, zkus to později',
  'Network error': 'Chyba sítě',
  'Upload aborted': 'Nahrávání bylo přerušeno',
  'Upload not found': 'Nahrávání už neexistuje',
  'Item is locked': 'Položka je zamčená, nejdřív ji odemkni',
  'Wrong lock password': 'Špatné heslo',
  'Password required': 'Zadej heslo',
  'Already locked': 'Položka už je zamčená (nebo ji chrání nadřazená složka)',
  'Not locked': 'Tato položka už není zamčená',
  'Cannot lock root': 'Kořenovou složku nelze zamknout',
  'Archive too large for ZIP': 'Výběr je pro ZIP příliš velký (limit asi 4 GB nebo 65 000 položek)',
  'Locked items cannot be shared': 'Zamčené položky nejde sdílet',
  'Share not found': 'Odkaz neexistuje nebo vypršel',
  'Invalid share duration': 'Neplatná doba platnosti odkazu',
  'Too many shares': 'Příliš mnoho aktivních odkazů (nejvýše 200)',
  'Not in trash': 'Položka už v koši není',
  'Preview not supported': 'Náhled tohoto typu souboru není podporován',
  'Request too large': 'Požadavek je příliš velký',
  'Cannot share root': 'Kořenovou složku nelze sdílet',
  'Hesla se neshodují': 'Hesla se neshodují',
};
const tr = (m) => MSG[m] || m;

function toast(msg, type = 'ok') {
  const t = document.createElement('div');
  t.className = 'toast ' + type;
  t.textContent = type === 'error' ? tr(msg) : msg;
  $('toasts').append(t);
  requestAnimationFrame(() => t.classList.add('show'));
  setTimeout(() => { t.classList.remove('show'); setTimeout(() => t.remove(), 300); }, type === 'error' ? 5000 : 2500);
}

// ============================================================================
// Dialogy
// ============================================================================
// Jeden sdileny <dialog> pro potvrzeni a vstup; onSubmit (volitelne): async akce po potvrzeni;
// pri chybe se zobrazi v dialogu a dialog zustane otevreny. label2 = druhe pole s heslem pro kontrolu.
function openDialog({ title, text, label, label2, value, okText = 'OK', danger = false, input = false, selectName = false, type = 'text', onSubmit }) {
  const dlg = $('dlg'), form = $('dlgForm'), inp = $('dlgInput'), inp2 = $('dlgInput2'), ok = $('dlgOk');
  const isPassword = type === 'password';
  $('dlgLabel2').textContent = label2 || '';
  $('dlgLabel2').classList.toggle('hidden', !label2);
  inp2.classList.toggle('hidden', !label2);
  inp2.value = '';
  $('dlgTitle').textContent = title;
  $('dlgText').textContent = text || '';
  $('dlgText').classList.toggle('hidden', !text);
  $('dlgLabel').textContent = label || '';
  $('dlgLabel').classList.toggle('hidden', !input);
  inp.classList.toggle('hidden', !input);
  inp.type = type;
  if (isPassword) inp.removeAttribute('maxlength'); else inp.setAttribute('maxlength', '255'); // heslo bez omezeni delky
  inp.autocomplete = isPassword ? 'new-password' : 'off';
  inp.value = value || '';
  $('dlgErr').textContent = '';
  ok.disabled = false;
  ok.textContent = okText;
  ok.className = danger ? 'dangerSolid' : '';
  const readValue = () => (isPassword ? inp.value : inp.value.trim());
  return new Promise((resolve) => {
    const done = (result) => { dlg.removeEventListener('close', onClose); form.onsubmit = null; resolve(result); };
    const onClose = () => done(dlg.returnValue === 'ok' ? (input ? readValue() || null : true) : (input ? null : false));
    dlg.addEventListener('close', onClose);
    form.onsubmit = async (e) => {
      e.preventDefault();
      if (onSubmit) {
        ok.disabled = true; $('dlgErr').textContent = '';
        try { await onSubmit(input ? readValue() : true, inp2.value); }
        catch (err) { $('dlgErr').textContent = tr(err.message); ok.disabled = false; if (input) { inp.focus(); inp.select(); } return; }
      }
      dlg.close('ok');
    };
    dlg.returnValue = '';
    dlg.showModal();
    if (input) {
      inp.focus();
      const dot = selectName ? inp.value.lastIndexOf('.') : -1;
      inp.setSelectionRange(0, dot > 0 ? dot : inp.value.length);
    } else ok.focus();
  });
}
const askConfirm = (o) => openDialog(o);
const askInput = (o) => openDialog({ ...o, input: true });
$('dlgCancel').addEventListener('click', () => $('dlg').close('cancel'));
$('dlg').addEventListener('click', (e) => { if (e.target === $('dlg')) $('dlg').close('cancel'); }); // klik na pozadi

// Univerzalni panel (sdileni, seznam odkazu): build(body, close) naplni obsah
function openPanel(title, build) {
  const dlg = $('panel'), body = $('panelBody');
  $('panelTitle').textContent = title;
  body.textContent = '';
  const close = () => { if (dlg.open) dlg.close(); };
  $('panelClose').onclick = close;
  build(body, close);
  if (!dlg.open) dlg.showModal();
}
$('panel').addEventListener('click', (e) => { if (e.target === $('panel')) $('panel').close(); });

// Kolize pri nahravani: vraci { mode: 'overwrite' | 'rename' | 'skip', all } nebo null (zavreno = preskocit)
function askConflict(name, more) {
  const dlg = $('cnf');
  $('cnfText').textContent = `V cílové složce už existuje „${name}“. Co s tím?`;
  $('cnfAll').checked = false;
  $('cnfAllWrap').classList.toggle('hidden', !more);
  return new Promise((resolve) => {
    let result = null;
    const onClick = (e) => {
      const c = e.target.closest('[data-c]');
      if (!c) return;
      result = { mode: c.dataset.c, all: $('cnfAll').checked };
      dlg.close();
    };
    const onClose = () => { dlg.removeEventListener('click', onClick); dlg.removeEventListener('close', onClose); resolve(result); };
    dlg.addEventListener('click', onClick);
    dlg.addEventListener('close', onClose);
    dlg.showModal();
  });
}

// Vyber slozky (presun): vraci relativni cestu nebo null. exclude = cesty, do kterych (ani pod ne) se nesmi
function pickFolder({ title, okText, exclude = [], start = '' }) {
  const dlg = $('pick');
  let cur = start;
  $('pickTitle').textContent = title;
  const blocked = (p) => exclude.some((x) => p === x || p.startsWith(x + '/'));
  async function render() {
    const crumbs = $('pickCrumbs'); crumbs.textContent = '';
    const mk = (label, path) => { const a = document.createElement('a'); a.textContent = label; a.onclick = () => { cur = path; render(); }; return a; };
    crumbs.append(mk('Domů', ''));
    let acc = '';
    for (const part of cur.split('/').filter(Boolean)) { acc = join(acc, part); crumbs.append(' / ', mk(part, acc)); }
    const list = $('pickList'); list.textContent = '';
    let entries = [];
    try { entries = (await api('/api/files?path=' + enc(cur))).filter((i) => i.dir); }
    catch (err) { const d = document.createElement('div'); d.className = 'li disabled'; d.textContent = tr(err.message); list.append(d); }
    for (const it of entries) {
      const p = join(cur, it.name);
      const locked = !!(it.lock && !it.lock.unlocked);
      const li = document.createElement('div');
      li.className = 'li' + (locked || blocked(p) ? ' disabled' : '');
      li.textContent = '📁 ' + it.name + (locked ? ' (zamčená)' : '');
      if (!locked && !blocked(p)) li.onclick = () => { cur = p; render(); };
      list.append(li);
    }
    if (!entries.length && !list.children.length) { const d = document.createElement('div'); d.className = 'li disabled'; d.textContent = 'Žádné podsložky'; list.append(d); }
    $('pickOk').textContent = `${okText} do „${cur ? '/' + cur : 'Domů'}“`;
    $('pickOk').disabled = blocked(cur);
  }
  return new Promise((resolve) => {
    let result = null;
    $('pickOk').onclick = () => { result = cur; dlg.close(); };
    $('pickCancel').onclick = () => dlg.close();
    const onClose = () => { dlg.removeEventListener('close', onClose); resolve(result); };
    dlg.addEventListener('close', onClose);
    render();
    dlg.showModal();
  });
}

// ============================================================================
// Prihlaseni
// ============================================================================
function showLogin() {
  endSession();
  $('app').classList.add('hidden'); $('login').classList.remove('hidden');
  sel.clear(); view = 'files'; items = [];
}

function showApp(me) {
  $('login').classList.add('hidden'); $('app').classList.remove('hidden');
  if (me) startSession(me);
  view = 'files'; searchQ = ''; $('searchInput').value = '';
  load('');
  loadSpace();
  loadTrashCount();
}

$('loginForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  $('loginErr').textContent = '';
  try {
    const r = await jsonPost('/api/login', { user: $('user').value, password: $('pass').value });
    $('pass').value = '';
    showApp(r);
  } catch (err) { $('loginErr').textContent = err.message === 'Invalid credentials' ? 'Špatné jméno nebo heslo' : tr(err.message); }
});

$('logout').addEventListener('click', async () => { await api('/api/logout', { method: 'POST' }).catch(() => {}); cancelAllUploads(); showLogin(); });

// ============================================================================
// Stav a vykresleni
// ============================================================================
let cwd = '';
let view = 'files'; // 'files' | 'search' | 'trash'
let items = []; // zobrazene polozky (vypis nebo vysledky hledani), kazda ma .rel
let searchQ = '';
let searchTruncated = false;
let trashData = { enabled: true, days: 30, items: [] };
let trashCount = 0;
const sel = new Set(); // vybrane cesty (rel)
const byRel = new Map();

const SORT_KEY = 'nasfiles-sort';
function loadSort() {
  try {
    const s = JSON.parse(localStorage.getItem(SORT_KEY));
    if (s && ['name', 'size', 'date'].includes(s.col) && ['asc', 'desc'].includes(s.dir)) return s;
  } catch { /* localStorage nedostupny nebo poskozeny zaznam */ }
  return { col: 'name', dir: 'asc' };
}
let sort = loadSort();
function saveSort() { try { localStorage.setItem(SORT_KEY, JSON.stringify(sort)); } catch { /* jen pro tuto relaci */ } }

// slozky vzdy nahore; potom podle zvoleneho sloupce (velikost slozek se pocita az dodatecne, ty se radi podle nazvu)
function sortedItems() {
  const f = sort.dir === 'asc' ? 1 : -1;
  const byName = (a, b) => a.name.localeCompare(b.name, 'cs', { numeric: true, sensitivity: 'base' });
  return [...items].sort((a, b) => {
    if (a.dir !== b.dir) return a.dir ? -1 : 1;
    if (sort.col === 'size' && !a.dir) return (a.size - b.size) * f || byName(a, b);
    if (sort.col === 'date') return (a.mtime - b.mtime) * f || byName(a, b);
    return byName(a, b) * (sort.col === 'name' ? f : 1);
  });
}

async function load(path) {
  try {
    const list = await api('/api/files?path=' + enc(path));
    if (path !== cwd) sel.clear();
    cwd = path;
    view = 'files';
    items = list.map((it) => ({ ...it, rel: join(path, it.name) }));
    render();
  } catch (err) {
    if (err.message === 'Unauthorized') return;
    toast(err.message, 'error');
    if (err.status === 423 && path) load(''); // slozka je (zase) zamcena, zpet do korene
  }
}

async function refresh() {
  if (view === 'trash') return loadTrash();
  if (view === 'search') return runSearch();
  return load(cwd);
}

function renderCrumbs() {
  const c = $('crumbs'); c.textContent = '';
  if (view === 'trash') return;
  const root = document.createElement('a'); root.textContent = 'Domů'; root.onclick = () => { clearSearch(); load(''); };
  makeDropTarget(root, '');
  c.append(root);
  let acc = '';
  for (const part of cwd.split('/').filter(Boolean)) {
    acc = join(acc, part);
    const p = acc;
    c.append(' / ');
    const a = document.createElement('a'); a.textContent = part; a.onclick = () => { clearSearch(); load(p); };
    makeDropTarget(a, p);
    c.append(a);
  }
}

function render() {
  renderCrumbs();
  renderSelbar();
  $('drop').classList.toggle('hidden', view === 'trash');
  if (view === 'trash') return renderTrash();
  byRel.clear();
  for (const it of items) byRel.set(it.rel, it);
  renderViewHead();
  renderList();
}

function renderViewHead() {
  const h = $('viewhead'); h.textContent = '';
  if (view !== 'search') return;
  const box = document.createElement('div'); box.className = 'viewhead';
  const t = document.createElement('h2');
  t.textContent = `Výsledky hledání „${searchQ}“ ${cwd ? 've složce /' + cwd : 'v celém úložišti'}: ${items.length}${searchTruncated ? '+' : ''}`;
  const b = document.createElement('button'); b.className = 'ghost'; b.textContent = 'Zrušit hledání';
  b.onclick = () => { clearSearch(); load(cwd); };
  box.append(t, b); h.append(box);
}

function headCell(label, col) {
  const d = document.createElement('div');
  d.className = 'sortable'; d.textContent = label;
  if (sort.col === col) d.textContent += sort.dir === 'asc' ? ' ▲' : ' ▼';
  d.onclick = () => {
    sort = sort.col === col ? { col, dir: sort.dir === 'asc' ? 'desc' : 'asc' } : { col, dir: col === 'name' ? 'asc' : 'desc' };
    saveSort(); render();
  };
  return d;
}

function renderList() {
  const list = $('list'); list.textContent = '';
  const jobs = [];
  const rows = sortedItems();

  const head = document.createElement('div'); head.className = 'row head';
  const all = document.createElement('input'); all.type = 'checkbox'; all.title = 'Vybrat vše'; all.setAttribute('aria-label', 'Vybrat vše');
  all.checked = rows.length > 0 && rows.every((r) => sel.has(r.rel));
  all.onchange = () => { for (const r of rows) all.checked ? sel.add(r.rel) : sel.delete(r.rel); render(); };
  head.append(all, headCell('Název', 'name'), headCell('Velikost', 'size'), headCell('Datum přidání', 'date'), Object.assign(document.createElement('div'), { textContent: 'Operace' }));
  list.append(head);

  if (view === 'files' && cwd) { // radek ".." = o uroven vys (i cil pro presun)
    const parent = parentOf(cwd);
    const row = document.createElement('div'); row.className = 'row';
    const name = document.createElement('div'); name.className = 'name';
    const a = document.createElement('a'); a.textContent = '⬆️ ..'; a.onclick = () => load(parent);
    name.append(a);
    makeDropTarget(row, parent);
    row.append(document.createElement('div'), name, document.createElement('div'), document.createElement('div'), document.createElement('div'));
    list.append(row);
  }

  if (!rows.length) {
    const d = document.createElement('div'); d.className = 'empty';
    d.textContent = view === 'search' ? 'Nic nenalezeno' : 'Složka je prázdná';
    list.append(d);
    return;
  }
  for (const it of rows) list.append(buildRow(it, jobs));
  loadSizes(jobs);
}

function lockBadge(lock) {
  const s = document.createElement('span');
  const state = !lock.unlocked ? 'locked' : lock.root ? 'open' : 'inherit';
  s.className = 'badge ' + state;
  // nativni title (ne data-tip): .name ma overflow:hidden a vlastni tooltip by se oriznul
  s.title = !lock.unlocked ? 'Zamčeno' : lock.root ? 'Odemčeno do odhlášení' : 'Chráněno zamčenou složkou';
  s.setAttribute('aria-label', s.title);
  s.innerHTML = svgIcon(lock.unlocked ? 'unlock' : 'lock');
  return s;
}

function shareBadge() {
  const s = document.createElement('span');
  s.className = 'badge share'; s.title = 'Sdíleno odkazem'; s.setAttribute('aria-label', s.title);
  s.innerHTML = svgIcon('link');
  return s;
}

function buildRow(it, jobs) {
  const rel = it.rel;
  const locked = !!(it.lock && !it.lock.unlocked); // zamcena a zatim neodemcena
  const row = document.createElement('div');
  row.className = 'row' + (locked ? ' locked' : '') + (sel.has(rel) ? ' selected' : '');
  row.draggable = !locked && view === 'files';
  row.addEventListener('dragstart', (e) => {
    const paths = sel.has(rel) ? [...sel] : [rel];
    e.dataTransfer.setData(DRAG_TYPE, JSON.stringify(paths)); e.dataTransfer.effectAllowed = 'move'; row.classList.add('dragging');
  });
  row.addEventListener('dragend', () => row.classList.remove('dragging'));
  if (it.dir && !locked) makeDropTarget(row, rel);

  const chk = document.createElement('input'); chk.type = 'checkbox'; chk.checked = sel.has(rel);
  chk.setAttribute('aria-label', 'Vybrat ' + it.name);
  chk.onchange = () => { chk.checked ? sel.add(rel) : sel.delete(rel); row.classList.toggle('selected', chk.checked); renderSelbar(); syncSelectAll(); };

  const name = document.createElement('div'); name.className = 'name';
  const a = document.createElement('a');
  a.textContent = (it.dir ? '📁 ' : '📄 ') + it.name;
  if (locked) { a.href = '#'; a.onclick = (e) => { e.preventDefault(); unlockItem(it, false); }; } // klik = dialog s heslem
  else if (it.dir) a.onclick = () => { clearSearch(); load(rel); };
  else if (it.preview) { a.href = '#'; a.onclick = (e) => { e.preventDefault(); openPreview(it); }; }
  else a.href = '/api/download?path=' + enc(rel);
  name.append(a);
  if (it.lock) name.append(lockBadge(it.lock));
  if (it.shared) name.append(shareBadge());
  if (view === 'search') { // u vysledku hledani je videt, kde polozka lezi
    const p = document.createElement('div'); p.className = 'path';
    const pa = document.createElement('a'); pa.textContent = it.parent ? '/' + it.parent : 'Domů'; pa.href = '#';
    pa.onclick = (e) => { e.preventDefault(); clearSearch(); load(it.parent); };
    p.append('v ', pa);
    name.append(p);
  }

  const meta = document.createElement('div'); meta.className = 'meta size'; meta.textContent = fmtSize(it.size);
  const date = document.createElement('div'); date.className = 'meta date'; date.textContent = fmtDate(it.mtime);
  const sub = document.createElement('div'); sub.className = 'sub'; // jen na mobilu
  sub.textContent = [fmtSize(it.size), fmtDate(it.mtime)].filter(Boolean).join(' · ');
  name.append(sub);
  if (it.dir && view === 'files') { meta.textContent = '…'; jobs.push({ rel, meta, sub, date: fmtDate(it.mtime) }); } // velikost slozky se dopocita async

  const actions = document.createElement('div'); actions.className = 'actions';
  if (locked) {
    // zamcene: jedina operace je zruseni zamku (heslem); nic dalsiho nejde
    const perm = iconBtn('unlock', 'Odemknout natrvalo (zrušit zámek)', 'ghost tip-end');
    perm.onclick = () => unlockItem(it, true);
    actions.append(perm);
  } else {
    const dl = iconBtn(it.dir ? 'zip' : 'download', it.dir ? 'Stáhnout jako ZIP' : 'Stáhnout', 'ghost');
    dl.onclick = () => downloadItem(it);
    const share = iconBtn('link', 'Sdílet odkazem', 'ghost');
    share.onclick = () => shareItem(it);
    actions.append(dl, share);
    if (!it.lock) {
      const lock = iconBtn('lock', 'Zamknout', 'ghost');
      lock.onclick = () => lockItems([it]);
      actions.append(lock);
    } else if (it.lock.root) {
      const relock = iconBtn('lock', 'Zamknout znovu', 'ghost');
      relock.onclick = () => relockItem(it);
      const perm = iconBtn('unlock', 'Odemknout natrvalo (zrušit zámek)', 'ghost');
      perm.onclick = () => unlockItem(it, true);
      actions.append(relock, perm);
    }
    const ren = iconBtn('pencil', 'Přejmenovat', 'ghost');
    ren.onclick = () => renameItem(it);
    const del = iconBtn('trash', conf.trashDays ? 'Smazat (do koše)' : 'Smazat', 'danger tip-end');
    del.onclick = () => deleteItems([it]);
    actions.append(ren, del);
  }
  row.append(chk, name, meta, date, actions);
  return row;
}

function syncSelectAll() {
  const all = $('list').querySelector('.row.head input[type=checkbox]');
  if (all) all.checked = items.length > 0 && items.every((r) => sel.has(r.rel));
}

// soucty velikosti slozek: po jedne, aby se server nezahltil; zastarala davka se zahodi
let sizeJob = 0;
async function loadSizes(jobs) {
  const job = ++sizeJob;
  for (const j of jobs) {
    if (job !== sizeJob) return;
    try {
      const { size } = await api('/api/size?path=' + enc(j.rel));
      j.meta.textContent = fmtSize(size);
      j.sub.textContent = [fmtSize(size), j.date].filter(Boolean).join(' · ');
    } catch { j.meta.textContent = '–'; }
  }
}

// ============================================================================
// Volne misto, pocet v kosi, verze
// ============================================================================
async function loadSpace() {
  try {
    const s = await api('/api/space');
    const usedPct = s.total ? Math.round(((s.total - s.free) / s.total) * 100) : 0;
    $('spaceText').textContent = `Volné ${fmtSize(s.free)} z ${fmtSize(s.total)}`;
    $('spaceBar').style.width = usedPct + '%';
    $('space').classList.toggle('low', usedPct >= 85 && usedPct < 95);
    $('space').classList.toggle('crit', usedPct >= 95);
  } catch { $('spaceText').textContent = ''; }
}

async function loadTrashCount() {
  try {
    const t = await api('/api/trash');
    trashData = t; trashCount = t.items.length;
  } catch { /* nezobrazi se */ }
  const c = $('trashCount');
  c.textContent = trashCount > 99 ? '99+' : String(trashCount);
  c.classList.toggle('hidden', !trashCount);
  $('trashBtn').dataset.tip = conf.trashDays ? `Koš (${conf.trashDays} dní)` : 'Koš';
}

api('/api/health').then((h) => { if (h.version) $('ver').textContent = 'NAS Files v' + h.version; }).catch(() => {});

// ============================================================================
// Hledani
// ============================================================================
let searchTimer = null;
function clearSearch() {
  searchQ = ''; $('searchInput').value = ''; $('searchClear').classList.add('hidden');
  clearTimeout(searchTimer);
}

async function runSearch() {
  const q = searchQ;
  try {
    const r = await api(`/api/search?path=${enc(cwd)}&q=${enc(q)}`);
    if (q !== searchQ) return; // mezitim se zmenil dotaz
    view = 'search'; searchTruncated = r.truncated;
    items = r.results.map((x) => ({ ...x }));
    sel.clear();
    render();
  } catch (err) { if (err.message !== 'Unauthorized') toast(err.message, 'error'); }
}

$('searchInput').addEventListener('input', () => {
  searchQ = $('searchInput').value.trim();
  $('searchClear').classList.toggle('hidden', !searchQ);
  clearTimeout(searchTimer);
  if (!searchQ) { if (view === 'search') load(cwd); return; }
  searchTimer = setTimeout(runSearch, 250);
});
$('searchClear').addEventListener('click', () => { const was = view === 'search'; clearSearch(); if (was) load(cwd); $('searchInput').focus(); });

document.addEventListener('keydown', (e) => {
  const tag = (e.target.tagName || '').toLowerCase();
  const typing = tag === 'input' || tag === 'textarea' || tag === 'select';
  if (e.key === '/' && !typing && !$('app').classList.contains('hidden') && !document.querySelector('dialog[open]')) { e.preventDefault(); $('searchInput').focus(); return; }
  if (e.key === 'Escape') {
    if ($('pv').open) return; // zavre se sam
    if (e.target === $('searchInput') && searchQ) { const was = view === 'search'; clearSearch(); if (was) load(cwd); return; }
    if (!document.querySelector('dialog[open]') && sel.size) { sel.clear(); render(); }
  }
});

// ============================================================================
// Vyber vice polozek a hromadne akce
// ============================================================================
function renderSelbar() {
  const bar = $('selbar');
  bar.textContent = '';
  const n = sel.size;
  bar.classList.toggle('hidden', !n || view === 'trash');
  if (!n || view === 'trash') return;
  const st = document.createElement('strong');
  st.textContent = `${n} ${plural(n, 'položka vybrána', 'položky vybrány', 'položek vybráno')}`;
  const chosen = () => [...sel].map((r) => byRel.get(r)).filter(Boolean);
  const b = (label, cls, fn) => { const x = document.createElement('button'); x.className = cls; x.textContent = label; x.onclick = fn; return x; };
  bar.append(
    st,
    b('Stáhnout ZIP', 'ghost', () => downloadZip(chosen().map((i) => i.rel))),
    b('Přesunout', 'ghost', () => moveItems(chosen())),
    b('Zamknout', 'ghost', () => lockItems(chosen())),
    b(conf.trashDays ? 'Smazat (do koše)' : 'Smazat', 'danger', () => deleteItems(chosen())),
    b('Zrušit výběr', 'ghost', () => { sel.clear(); render(); }),
  );
}

// provede akci postupne nad polozkami a shrne vysledek (uspechy/chyby) do jednoho toastu
async function runBatch(list, fn, doneText) {
  let ok = 0; const errors = [];
  for (const it of list) {
    try { await fn(it); ok++; } catch (err) { if (err.message === 'Unauthorized') return; errors.push(`${it.name}: ${tr(err.message)}`); }
  }
  sel.clear();
  await refresh();
  loadSpace(); loadTrashCount();
  if (ok) toast(doneText(ok));
  if (errors.length) toast(`Selhalo ${errors.length}: ${errors[0]}${errors.length > 1 ? ' …' : ''}`, 'error');
}

async function deleteItems(list) {
  if (!list.length) return;
  const one = list.length === 1 ? list[0] : null;
  const toTrash = conf.trashDays > 0;
  const ok = await askConfirm({
    title: one ? (one.dir ? 'Smazat složku?' : 'Smazat soubor?') : `Smazat ${list.length} ${plural(list.length, 'položku', 'položky', 'položek')}?`,
    text: toTrash
      ? `${one ? `„${one.name}“ se` : 'Vybrané položky se'} přesune do koše a po ${conf.trashDays} dnech se smaže natrvalo. Do té doby ${one ? 'ji' : 'je'} jde vrátit.`
      : `${one ? `„${one.name}“${one.dir ? ' bude smazána včetně veškerého obsahu.' : ' bude trvale smazán.'}` : 'Vybrané položky budou trvale smazány včetně obsahu složek.'} Akci nelze vrátit zpět.`,
    okText: toTrash ? 'Do koše' : 'Smazat', danger: !toTrash,
  });
  if (!ok) return;
  await runBatch(list, (it) => api('/api/files?path=' + enc(it.rel), { method: 'DELETE' }), (n) => (toTrash ? `Do koše: ${n}` : `Smazáno: ${n}`));
}

async function moveItems(list) {
  if (!list.length) return;
  const target = await pickFolder({ title: `Přesunout ${list.length} ${plural(list.length, 'položku', 'položky', 'položek')}`, okText: 'Přesunout', exclude: list.filter((i) => i.dir).map((i) => i.rel), start: cwd });
  if (target === null) return;
  await runBatch(list, (it) => {
    const to = join(target, it.name);
    if (to === it.rel) throw new Error('Source and target are the same');
    return jsonPost('/api/move', { from: it.rel, to });
  }, (n) => `Přesunuto: ${n}`);
}

// zamknuti jedne nebo vice polozek: jedno heslo (zadava se dvakrat), kazda polozka ma ale vlastni zamek
async function lockItems(list) {
  const todo = list.filter((i) => !i.lock);
  if (!todo.length) { toast('Vybrané položky už jsou zamčené', 'error'); return; }
  const one = todo.length === 1 ? todo[0] : null;
  let password = '';
  const ok = await askInput({
    title: one ? (one.dir ? 'Zamknout složku' : 'Zamknout soubor') : `Zamknout ${todo.length} ${plural(todo.length, 'položku', 'položky', 'položek')}`,
    text: `Nastav heslo pro ${one ? `„${one.name}“` : 'vybrané položky'}. Bez něj ${one ? 'ji' : 'je'} nepůjde otevřít, přejmenovat, přesunout ani smazat. Heslo nejde obnovit, tak si ho zapamatuj.`,
    label: 'Heslo', label2: 'Heslo znovu', type: 'password', okText: 'Zamknout',
    onSubmit: async (pw, again) => {
      if (!pw) throw new Error('Password required');
      if (pw !== again) throw new Error('Hesla se neshodují');
      password = pw;
    },
  });
  if (!ok) return;
  await runBatch(todo, (it) => jsonPost('/api/lock', { path: it.rel, password }), (n) => (n === 1 ? 'Zamčeno' : `Zamčeno: ${n}`));
}

async function relockItem(it) {
  try { await jsonPost('/api/relock', { path: it.rel }); await refresh(); toast('Zamčeno'); }
  catch (err) { toast(err.message, 'error'); }
}

// permanent = false: odemknout do odhlaseni (klik na polozku); true: zrusit zamek natrvalo.
// Obojí vyzaduje heslo, ktere uzivatel nastavil pri zamknuti teto polozky.
async function unlockItem(it, permanent) {
  const ok = await askInput({
    title: permanent ? 'Zrušit zámek' : 'Odemknout',
    text: permanent
      ? `Zámek u „${it.name}“ bude trvale zrušen. Zadej heslo, které jsi pro ni nastavil.`
      : `„${it.name}“ je zamčená. Zadej její heslo, odemkne se, dokud se neodhlásíš.`,
    label: 'Heslo', type: 'password',
    okText: permanent ? 'Zrušit zámek' : 'Odemknout', danger: permanent,
    onSubmit: (password) => jsonPost(permanent ? '/api/lock/remove' : '/api/unlock', { path: it.rel, password }),
  });
  if (!ok) return;
  if (permanent) { await refresh(); toast('Zámek zrušen'); }
  else if (it.dir) { toast('Odemčeno do odhlášení'); clearSearch(); await load(it.rel); } // odemcenou slozku rovnou otevre
  else { await refresh(); toast('Odemčeno do odhlášení'); }
}

async function renameItem(it) {
  const nn = await askInput({ title: 'Přejmenovat', label: 'Nový název', value: it.name, okText: 'Přejmenovat', selectName: !it.dir });
  if (!nn || nn === it.name) return;
  try {
    await jsonPost('/api/move', { from: it.rel, to: join(parentOf(it.rel), nn) });
    await refresh(); toast('Přejmenováno');
  } catch (err) { toast(err.message, 'error'); }
}

$('mkdirBtn').addEventListener('click', async () => {
  const name = await askInput({ title: 'Nová složka', label: 'Název složky', okText: 'Vytvořit' });
  if (!name) return;
  try {
    await jsonPost('/api/mkdir', { path: cwd, name });
    clearSearch(); await load(cwd); toast('Složka vytvořena');
  } catch (err) { toast(err.message, 'error'); }
});

// ============================================================================
// Stahovani (soubor, slozka/vyber jako ZIP) a nahled
// ============================================================================
function triggerDownload(url) {
  const a = document.createElement('a');
  a.href = url; a.download = ''; a.rel = 'noopener';
  document.body.append(a); a.click(); a.remove();
}

async function downloadItem(it) {
  if (!it.dir) return triggerDownload('/api/download?path=' + enc(it.rel));
  await downloadZip([it.rel]);
}

// predem overi (zamky, limity), aby se chyba ukazala jako hlaska, a az pak spusti stahovani
async function downloadZip(rels) {
  try {
    const dry = rels.length === 1
      ? await api('/api/zip?dry=1&path=' + enc(rels[0]))
      : await api('/api/zip?dry=1', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: 'paths=' + enc(JSON.stringify(rels)) });
    toast(`Připravuji ZIP (${dry.files} ${plural(dry.files, 'soubor', 'soubory', 'souborů')}, ${fmtSize(dry.bytes)})`);
    if (rels.length === 1) triggerDownload('/api/zip?path=' + enc(rels[0]));
    else { $('zipPaths').value = JSON.stringify(rels); $('zipForm').submit(); }
  } catch (err) { toast(err.message, 'error'); }
}

// --- nahled ---
let pvList = [];
let pvIndex = -1;

function openPreview(it) {
  pvList = sortedItems().filter((i) => !i.dir && i.preview && !(i.lock && !i.lock.unlocked));
  pvIndex = pvList.findIndex((i) => i.rel === it.rel);
  if (pvIndex < 0) { pvList = [it]; pvIndex = 0; }
  if (!$('pv').open) $('pv').showModal();
  showPreview();
}

async function showPreview() {
  const it = pvList[pvIndex];
  const body = $('pvBody'), note = $('pvNote');
  body.textContent = ''; note.classList.add('hidden');
  $('pvTitle').textContent = it.name;
  $('pvDl').href = '/api/download?path=' + enc(it.rel);
  $('pvDl').setAttribute('download', '');
  $('pvPrev').disabled = pvIndex <= 0;
  $('pvNext').disabled = pvIndex >= pvList.length - 1;
  const url = '/api/preview?path=' + enc(it.rel);
  const fail = (msg) => { body.textContent = msg; };
  if (it.preview === 'image') { const i = document.createElement('img'); i.alt = it.name; i.onerror = () => fail('Obrázek se nepodařilo načíst'); i.src = url; body.append(i); }
  else if (it.preview === 'pdf') { const f = document.createElement('iframe'); f.title = it.name; f.src = url; body.append(f); }
  else if (it.preview === 'video' || it.preview === 'audio') {
    const m = document.createElement(it.preview); m.controls = true; m.src = url; m.onerror = () => fail('Soubor se nepodařilo přehrát'); body.append(m);
  } else if (it.preview === 'text') {
    const LIMIT = 512 * 1024;
    try {
      const res = await fetch(url, { headers: { Range: `bytes=0-${LIMIT - 1}` } });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const text = await res.text();
      if (pvList[pvIndex] !== it) return; // mezitim se prepnulo na jiny soubor
      const pre = document.createElement('pre'); pre.textContent = text; body.append(pre);
      if (res.status === 206 && it.size > LIMIT) { note.textContent = `Zobrazeno prvních ${fmtSize(LIMIT)} z ${fmtSize(it.size)}. Celý soubor si stáhni.`; note.classList.remove('hidden'); }
    } catch { fail('Soubor se nepodařilo načíst'); }
  }
}

function pvStep(d) { const n = pvIndex + d; if (n >= 0 && n < pvList.length) { pvIndex = n; showPreview(); } }
$('pvPrev').onclick = () => pvStep(-1);
$('pvNext').onclick = () => pvStep(1);
$('pvClose').onclick = () => $('pv').close();
$('pv').addEventListener('close', () => { $('pvBody').textContent = ''; }); // zastavi video/audio
$('pv').addEventListener('click', (e) => { if (e.target === $('pv')) $('pv').close(); });
$('pv').addEventListener('keydown', (e) => { if (e.key === 'ArrowLeft') pvStep(-1); else if (e.key === 'ArrowRight') pvStep(1); });

// ============================================================================
// Sdilene odkazy
// ============================================================================
const SHARE_HOURS = [[1, '1 hodina'], [24, '24 hodin'], [168, '7 dní'], [720, '30 dní']];
const shareUrl = (token) => `${location.origin}/s/${token}`;

async function copyText(text, inputEl) {
  try { await navigator.clipboard.writeText(text); return true; } catch { /* nezabezpecene spojeni: zkusit stary zpusob */ }
  try { if (inputEl) { inputEl.select(); return document.execCommand('copy'); } } catch { /* nic */ }
  return false;
}

function shareItem(it) {
  openPanel(`Sdílet „${it.name}“`, (body, close) => {
    const p = document.createElement('p');
    p.textContent = it.dir ? 'Složka se stáhne jako ZIP. Kdo má odkaz, může ji stáhnout bez přihlášení.' : 'Kdo má odkaz, může soubor stáhnout bez přihlášení.';
    const label = document.createElement('label'); label.textContent = 'Platnost odkazu'; label.htmlFor = 'shareHours';
    const select = document.createElement('select'); select.id = 'shareHours';
    for (const [h, l] of SHARE_HOURS) { const o = document.createElement('option'); o.value = String(h); o.textContent = l; if (h === 24) o.selected = true; select.append(o); }
    const err = document.createElement('div'); err.className = 'dlgErr';
    const go = document.createElement('button'); go.type = 'button'; go.textContent = 'Vytvořit odkaz';
    body.append(p, label, select, err, go);
    go.onclick = async () => {
      go.disabled = true; err.textContent = '';
      try {
        const r = await jsonPost('/api/share', { path: it.rel, hours: Number(select.value) });
        body.textContent = '';
        const t = document.createElement('p'); t.textContent = `Odkaz platí do ${fmtDate(r.expires)}.`;
        const box = document.createElement('div'); box.className = 'linkbox';
        const inp = document.createElement('input'); inp.type = 'text'; inp.readOnly = true; inp.value = shareUrl(r.token);
        inp.onfocus = () => inp.select();
        const cp = document.createElement('button'); cp.type = 'button'; cp.textContent = 'Kopírovat';
        cp.onclick = async () => { toast((await copyText(inp.value, inp)) ? 'Odkaz zkopírován' : 'Zkopíruj odkaz ručně (Ctrl+C)'); };
        box.append(inp, cp);
        const hint = document.createElement('p'); hint.textContent = 'Odkaz funguje jen tam, odkud je aplikace dostupná (např. v domácí síti). Zrušit ho můžeš kdykoli v seznamu sdílených odkazů.';
        body.append(t, box, hint);
        inp.select();
        refresh();
      } catch (e) { go.disabled = false; err.textContent = tr(e.message); }
    };
  });
}

async function openShares() {
  let list;
  try { list = await api('/api/shares'); } catch (e) { if (e.message !== 'Unauthorized') toast(e.message, 'error'); return; }
  openPanel('Sdílené odkazy', (body) => {
    const draw = (rows) => {
      body.textContent = '';
      if (!rows.length) { const p = document.createElement('p'); p.textContent = 'Žádné aktivní odkazy. Odkaz vytvoříš ikonou odkazu u souboru nebo složky.'; body.append(p); return; }
      for (const s of rows) {
        const row = document.createElement('div'); row.className = 'shrow';
        const info = document.createElement('div');
        const t = document.createElement('div'); t.className = 't'; t.textContent = (s.dir ? '📁 ' : '📄 ') + s.name;
        const m = document.createElement('div'); m.className = 'm';
        const left = Math.max(0, s.expires - Date.now());
        const h = Math.floor(left / 3600000);
        m.textContent = `${s.rel ? '/' + s.rel : ''} · platí ještě ${h >= 48 ? Math.floor(h / 24) + ' dní' : h >= 1 ? h + ' h' : Math.max(1, Math.floor(left / 60000)) + ' min'}`;
        info.append(t, m);
        const acts = document.createElement('div'); acts.style.display = 'flex'; acts.style.gap = '6px';
        const cp = iconBtn('copy', 'Kopírovat odkaz', 'ghost');
        cp.onclick = async () => { toast((await copyText(shareUrl(s.token))) ? 'Odkaz zkopírován' : shareUrl(s.token)); };
        const rv = iconBtn('x', 'Zrušit odkaz', 'danger tip-end');
        rv.onclick = async () => {
          try { await api('/api/share/' + enc(s.token), { method: 'DELETE' }); rows = rows.filter((x) => x.token !== s.token); draw(rows); toast('Odkaz zrušen'); refresh(); }
          catch (e) { toast(e.message, 'error'); }
        };
        acts.append(cp, rv);
        row.append(info, acts);
        body.append(row);
      }
    };
    draw(list);
  });
}
$('sharesBtn').addEventListener('click', openShares);

// ============================================================================
// Kos
// ============================================================================
async function loadTrash() {
  try {
    trashData = await api('/api/trash');
    trashCount = trashData.items.length;
    view = 'trash'; sel.clear();
    render();
    loadTrashCount();
  } catch (err) { if (err.message !== 'Unauthorized') toast(err.message, 'error'); }
}

function renderTrash() {
  renderCrumbs();
  const h = $('viewhead'); h.textContent = '';
  const box = document.createElement('div'); box.className = 'viewhead';
  const t = document.createElement('h2');
  t.textContent = `Koš (${trashData.items.length})`;
  const back = document.createElement('button'); back.className = 'ghost'; back.textContent = '← Zpět na soubory';
  back.onclick = () => load(cwd);
  const empty = document.createElement('button'); empty.className = 'danger'; empty.textContent = 'Vysypat koš';
  empty.disabled = !trashData.items.length;
  empty.onclick = emptyTrash;
  box.append(t, back, empty);
  h.append(box);
  if (trashData.days) {
    const info = document.createElement('p'); info.className = 'meta'; info.style.whiteSpace = 'normal'; info.style.margin = '0 0 10px';
    info.textContent = `Smazané položky se v koši uchovávají ${trashData.days} dní, pak se smažou natrvalo.`;
    h.append(info);
  }

  const list = $('list'); list.textContent = '';
  if (!trashData.items.length) { const d = document.createElement('div'); d.className = 'empty'; d.textContent = 'Koš je prázdný'; list.append(d); return; }
  const head = document.createElement('div'); head.className = 'row head';
  for (const l of ['', 'Název', 'Velikost', 'Smazáno', 'Operace']) head.append(Object.assign(document.createElement('div'), { textContent: l }));
  list.append(head);
  for (const e of trashData.items) {
    const row = document.createElement('div'); row.className = 'row';
    const name = document.createElement('div'); name.className = 'name';
    const a = document.createElement('span'); a.textContent = (e.dir ? '📁 ' : '📄 ') + e.name;
    name.append(a);
    if (e.locked) { name.append(lockBadge({ unlocked: false, root: true })); }
    const p = document.createElement('div'); p.className = 'path'; p.textContent = 'původně: ' + (parentOf(e.rel) ? '/' + parentOf(e.rel) : 'Domů');
    name.append(p);
    const size = document.createElement('div'); size.className = 'meta size'; size.textContent = fmtSize(e.size);
    const date = document.createElement('div'); date.className = 'meta date'; date.textContent = `${fmtAgo(e.deletedAt)} · zbývá ${e.daysLeft} ${plural(e.daysLeft, 'den', 'dny', 'dní')}`;
    date.title = fmtDate(e.deletedAt);
    const acts = document.createElement('div'); acts.className = 'actions';
    const rs = iconBtn('restore', 'Obnovit na původní místo', 'ghost');
    rs.onclick = async () => {
      try { const r = await jsonPost('/api/trash/restore', { id: e.id }); await loadTrash(); toast(r.rel === e.rel ? 'Obnoveno' : `Obnoveno jako „${baseName(r.rel)}“`); loadSpace(); }
      catch (err) { toast(err.message, 'error'); }
    };
    const dl = iconBtn('trash', 'Smazat natrvalo', 'danger tip-end');
    dl.onclick = async () => {
      const ok = await askConfirm({ title: 'Smazat natrvalo?', text: `„${e.name}“ bude trvale smazán${e.dir ? 'a včetně obsahu' : ''}. Akci nelze vrátit zpět.`, okText: 'Smazat natrvalo', danger: true });
      if (!ok) return;
      try { await api('/api/trash/' + enc(e.id), { method: 'DELETE' }); await loadTrash(); toast('Smazáno natrvalo'); loadSpace(); }
      catch (err) { toast(err.message, 'error'); }
    };
    acts.append(rs, dl);
    row.append(document.createElement('div'), name, size, date, acts);
    list.append(row);
  }
}

async function emptyTrash() {
  const n = trashData.items.length;
  const ok = await askConfirm({ title: 'Vysypat koš?', text: `Trvale se smaže ${n} ${plural(n, 'položka', 'položky', 'položek')}. Akci nelze vrátit zpět.`, okText: 'Vysypat koš', danger: true });
  if (!ok) return;
  try { const r = await api('/api/trash', { method: 'DELETE' }); await loadTrash(); toast(`Koš vysypán (${r.removed})`); loadSpace(); }
  catch (err) { toast(err.message, 'error'); }
}
$('trashBtn').addEventListener('click', () => { clearSearch(); loadTrash(); });

// ============================================================================
// Tazeni polozek v aplikaci (presun) a upust souboru/slozek z disku (upload)
// ============================================================================
const DRAG_TYPE = 'application/x-nas-path';

async function moveDragged(paths, dir) {
  const list = paths.map((p) => byRel.get(p) || { rel: p, name: baseName(p), dir: false }).filter((i) => parentOf(i.rel) !== dir); // uz v cili se preskoci
  if (!list.length) return;
  await runBatch(list, (it) => {
    if (it.rel === dir || dir.startsWith(it.rel + '/')) throw new Error('Cannot move into itself');
    return jsonPost('/api/move', { from: it.rel, to: join(dir, it.name) });
  }, (n) => `Přesunuto: ${n}`);
}

// prvek prijima presouvane polozky z aplikace i soubory/slozky z disku (-> upload do dir)
function makeDropTarget(el, dir) {
  const accepts = (e) => e.dataTransfer.types.includes(DRAG_TYPE) || e.dataTransfer.types.includes('Files');
  el.addEventListener('dragover', (e) => { if (!accepts(e)) return; e.preventDefault(); e.stopPropagation(); el.classList.add('over'); });
  el.addEventListener('dragleave', () => el.classList.remove('over'));
  el.addEventListener('drop', (e) => {
    if (!accepts(e)) return;
    e.preventDefault(); e.stopPropagation(); el.classList.remove('over');
    const raw = e.dataTransfer.getData(DRAG_TYPE);
    if (raw) { try { moveDragged(JSON.parse(raw), dir); } catch { /* neplatna data */ } return; }
    uploadDropped(e.dataTransfer, dir);
  });
}

// Z DataTransfer vytahne soubory vcetne obsahu slozek. Polozky se musi ziskat synchronne behem udalosti drop.
function entriesOf(dt) {
  return [...(dt.items || [])].map((i) => (i.webkitGetAsEntry ? i.webkitGetAsEntry() : null)).filter(Boolean);
}

async function readAllEntries(reader) {
  const out = [];
  for (;;) {
    const batch = await new Promise((res, rej) => reader.readEntries(res, rej));
    if (!batch.length) return out;
    out.push(...batch);
  }
}

async function walkEntries(entries, files, dirs, prefix = '') {
  for (const en of entries) {
    if (en.isFile) {
      const file = await new Promise((res, rej) => en.file(res, rej));
      files.push({ file, rel: prefix + en.name });
    } else if (en.isDirectory) {
      dirs.add(prefix + en.name);
      await walkEntries(await readAllEntries(en.createReader()), files, dirs, prefix + en.name + '/');
    }
  }
}

async function uploadDropped(dt, dir) {
  const entries = entriesOf(dt);
  const files = [], dirs = new Set();
  try {
    if (entries.length) await walkEntries(entries, files, dirs);
    else for (const f of dt.files) files.push({ file: f, rel: f.name });
  } catch { toast('Složku se nepodařilo přečíst', 'error'); return; }
  await startUpload(files, dirs, dir);
}

// files: [{ file, rel }] kde rel muze obsahovat podslozky; dirs: relativni cesty slozek, ktere je treba vytvorit
async function startUpload(files, dirs, baseDir) {
  const wanted = new Set(dirs);
  for (const f of files) { const d = parentOf(f.rel); if (d) { const parts = d.split('/'); for (let i = 1; i <= parts.length; i++) wanted.add(parts.slice(0, i).join('/')); } }
  try {
    for (const d of [...wanted].sort((a, b) => a.split('/').length - b.split('/').length)) {
      await jsonPost('/api/mkdir', { path: join(baseDir, parentOf(d)), name: baseName(d), ensure: true });
    }
  } catch (err) { toast(err.message, 'error'); return; }
  const tasks = files.map((f) => ({ file: f.file, dir: join(baseDir, parentOf(f.rel)), name: f.file.name }));
  if (!tasks.length && wanted.size) { await refresh(); toast('Složky vytvořeny'); return; }
  enqueue(tasks);
}

// vstupy "Nahrat soubory" a "Nahrat slozku"
$('upBtn').addEventListener('click', () => $('fileInput').click());
$('upDirBtn').addEventListener('click', () => $('dirInput').click());
$('fileInput').addEventListener('change', (e) => {
  const files = [...e.target.files].map((f) => ({ file: f, rel: f.name }));
  e.target.value = '';
  startUpload(files, new Set(), cwd);
});
$('dirInput').addEventListener('change', (e) => {
  const files = [...e.target.files].map((f) => ({ file: f, rel: f.webkitRelativePath || f.name }));
  e.target.value = '';
  startUpload(files, new Set(), cwd);
});

const drop = $('drop');
['dragenter', 'dragover'].forEach((ev) => drop.addEventListener(ev, (e) => { if (!e.dataTransfer.types.includes('Files')) return; e.preventDefault(); drop.classList.add('over'); }));
['dragleave', 'drop'].forEach((ev) => drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.remove('over'); }));
drop.addEventListener('drop', (e) => { if (e.dataTransfer.types.includes('Files')) uploadDropped(e.dataTransfer, cwd); });

// ============================================================================
// Nahravani po castech: fronta, prubeh, navazani po vypadku, kolize nazvu
// ============================================================================
const uq = { tasks: [], running: false, globalConflict: null, seq: 0 };

function enqueue(tasks) {
  for (const t of tasks) uq.tasks.push({ id: ++uq.seq, ...t, status: 'wait', pct: 0, received: 0, aborted: false, xhr: null, uploadId: null, note: '', error: '' });
  renderUploads();
  pump();
}

async function pump() {
  if (uq.running) return;
  uq.running = true;
  uq.globalConflict = null;
  let done = 0, failed = 0;
  for (;;) {
    const t = uq.tasks.find((x) => x.status === 'wait');
    if (!t) break;
    await runTask(t);
    if (t.status === 'done') done++; else if (t.status === 'error') failed++;
  }
  uq.running = false;
  uq.globalConflict = null;
  if (done) toast(done === 1 ? 'Soubor nahrán' : `Nahráno souborů: ${done}`);
  if (failed) toast(`Nahrávání selhalo u ${failed} ${plural(failed, 'souboru', 'souborů', 'souborů')}`, 'error');
  loadSpace();
  if (view === 'files' || view === 'search') await refresh();
  renderUploads();
  if (!failed) setTimeout(() => { if (!uq.running && !uq.tasks.some((x) => x.status === 'wait' || x.status === 'run')) { uq.tasks = []; renderUploads(); } }, 4000);
}

const fingerprint = (t) => `${t.name}|${t.file.size}|${t.file.lastModified}`;

async function runTask(t) {
  t.status = 'run'; renderUploads();
  try {
    let mode = uq.globalConflict;
    let init;
    for (;;) {
      if (t.aborted) throw new Error('aborted');
      if (mode === 'skip') { t.status = 'skip'; renderUploads(); return; }
      try {
        init = await jsonPost('/api/upload/init', {
          path: t.dir, name: t.name, size: t.file.size, fp: fingerprint(t),
          onConflict: mode === 'overwrite' || mode === 'rename' ? mode : undefined,
        });
        break;
      } catch (err) {
        if (err.status === 409 && err.message === 'File already exists') {
          const more = uq.tasks.some((x) => x.status === 'wait');
          const choice = await askConflict(t.name, more);
          if (!choice) { t.status = 'skip'; renderUploads(); return; } // zavreni dialogu = preskocit
          mode = choice.mode;
          if (choice.all) uq.globalConflict = mode;
          continue;
        }
        throw err;
      }
    }
    t.uploadId = init.id; t.received = init.received;
    if (init.resumed && init.received > 0) t.note = `Navazuji od ${fmtSize(init.received)}`;
    while (t.received < t.file.size) {
      if (t.aborted) throw new Error('aborted');
      await sendChunk(t, init.chunkSize);
    }
    await jsonPost(`/api/upload/${t.uploadId}/finish`, { onConflict: mode === 'overwrite' || mode === 'rename' ? mode : undefined });
    t.status = 'done'; t.pct = 100; t.note = '';
  } catch (err) {
    if (t.aborted) t.status = 'cancel';
    else { t.status = 'error'; t.error = tr(err.message); }
  }
  renderUploads();
}

function putChunk(t, url, blob, onProgress) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    t.xhr = xhr;
    xhr.open('PUT', url);
    xhr.setRequestHeader('Content-Type', 'application/octet-stream');
    xhr.upload.onprogress = (e) => { onActivity(); if (e.lengthComputable) onProgress(e.loaded); }; // probihajici upload drzi relaci
    xhr.onload = () => {
      let data = {}; try { data = JSON.parse(xhr.responseText); } catch { /* ne JSON */ }
      if (xhr.status >= 200 && xhr.status < 300) return resolve(data);
      if (xhr.status === 401) handleUnauthorized();
      const e = new Error(data.error || xhr.statusText || 'Network error'); e.status = xhr.status; e.received = data.received; reject(e);
    };
    xhr.onerror = () => { const e = new Error('Network error'); e.status = 0; reject(e); };
    xhr.onabort = () => { const e = new Error('Upload aborted'); e.status = -1; reject(e); };
    xhr.send(blob);
  });
}

// jeden blok s automatickym opakovanim po vypadku site (navazuje od skutecne prijateho mista)
async function sendChunk(t, chunkSize) {
  const start = t.received;
  const end = Math.min(start + chunkSize, t.file.size);
  const blob = t.file.slice(start, end);
  for (let attempt = 0; ; attempt++) {
    try {
      const r = await putChunk(t, `/api/upload/${t.uploadId}?offset=${start}`, blob, (loaded) => {
        t.pct = Math.min(99, Math.round(((start + loaded) / Math.max(1, t.file.size)) * 100)); renderUploadRow(t);
      });
      t.received = r.received; t.note = '';
      return;
    } catch (err) {
      if (t.aborted || err.status === -1) throw err;
      if (err.status === 409 && err.received !== undefined) { t.received = err.received; return; } // server ma jiny stav: navazat od nej
      if (err.status > 0 && err.status < 500 && err.status !== 429) throw err; // chyba aplikace, opakovani nepomuze
      if (attempt >= 5) throw err;
      t.note = `Spojení se přerušilo, zkouším znovu (${attempt + 1}/5)…`; renderUploadRow(t);
      await sleep(Math.min(1000 * 2 ** attempt, 15000));
      try { const s = await api(`/api/upload/${t.uploadId}`); if (s.received !== start) { t.received = s.received; return; } } catch { /* dalsi pokus */ }
    }
  }
}

function cancelTask(t) {
  t.aborted = true;
  if (t.xhr) t.xhr.abort();
  if (t.uploadId && t.status !== 'done') fetch(`/api/upload/${t.uploadId}`, { method: 'DELETE' }).catch(() => {});
  if (t.status === 'wait') { t.status = 'cancel'; renderUploads(); }
}

function cancelAllUploads() { for (const t of uq.tasks) if (t.status === 'wait' || t.status === 'run') cancelTask(t); }

const STATUS_TEXT = { wait: 'Čeká', run: 'Nahrávám', done: 'Hotovo', skip: 'Přeskočeno', cancel: 'Zrušeno', error: 'Chyba' };

function uploadRowEl(t) {
  const row = document.createElement('div');
  row.className = 'up ' + t.status; row.dataset.id = t.id;
  const n = document.createElement('div'); n.className = 'n';
  const b = document.createElement('b'); b.textContent = t.name; b.title = t.name;
  n.append(b);
  if (t.status === 'wait' || t.status === 'run') {
    const x = document.createElement('button'); x.type = 'button'; x.textContent = '✕'; x.title = 'Zrušit'; x.setAttribute('aria-label', 'Zrušit nahrávání ' + t.name);
    x.onclick = () => cancelTask(t); n.append(x);
  }
  const bar = document.createElement('div'); bar.className = 'bar'; const i = document.createElement('i'); i.style.width = (t.status === 'done' ? 100 : t.pct) + '%'; bar.append(i);
  const st = document.createElement('div'); st.className = 'st';
  st.textContent = t.status === 'error' ? t.error : [STATUS_TEXT[t.status] + (t.status === 'run' ? ` ${t.pct} %` : ''), t.note].filter(Boolean).join(' · ');
  row.append(n, bar, st);
  return row;
}

function renderUploadRow(t) {
  const el = $('uploads').querySelector(`.up[data-id="${t.id}"]`);
  if (!el) return renderUploads();
  el.replaceWith(uploadRowEl(t));
}

function renderUploads() {
  const box = $('uploads');
  const list = uq.tasks;
  box.classList.toggle('hidden', !list.length);
  box.textContent = '';
  if (!list.length) return;
  const finished = list.filter((t) => ['done', 'skip', 'cancel', 'error'].includes(t.status)).length;
  const h = document.createElement('div'); h.className = 'uh';
  const s = document.createElement('span'); s.textContent = `Nahrávání (${finished}/${list.length})`;
  const active = list.some((t) => t.status === 'wait' || t.status === 'run');
  const btn = document.createElement('button'); btn.className = 'ghost'; btn.textContent = active ? 'Zrušit vše' : 'Zavřít';
  btn.onclick = () => { if (active) cancelAllUploads(); else { uq.tasks = []; renderUploads(); } };
  h.append(s, btn);
  box.append(h);
  for (const t of list.slice(-30)) box.append(uploadRowEl(t));
}

// ============================================================================
// Start: pokud je relace platna, rovnou aplikace
// ============================================================================
fetch('/api/me').then(async (r) => (r.ok ? showApp(await r.json()) : showLogin())).catch(showLogin);
