// Nahravani po castech s moznosti navazat: klient posila bloky na sebe navazujici (offset = pocet jiz prijatych bajtu).
// Rozpracovane nahravani (data + metadata) jsou ve skryte slozce v uloziste a prezijou i restart serveru.
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const { randomBytes } = require('crypto');

const STALE_MS = 24 * 60 * 60 * 1000;
const ID_RE = /^[0-9a-f]{24}$/;

class Uploads {
  constructor(root) {
    this.dir = path.join(root, '.nas-uploads');
    this.metas = new Map(); // id -> { id, dirRel, name, size, fp, created, updated }
    this.busy = new Set(); // id, do kterych se prave zapisuje (jeden blok najednou)
  }

  load() {
    fs.mkdirSync(this.dir, { recursive: true });
    for (const f of fs.readdirSync(this.dir)) {
      if (!f.endsWith('.json')) continue;
      try {
        const m = JSON.parse(fs.readFileSync(path.join(this.dir, f), 'utf8'));
        if (ID_RE.test(m.id)) this.metas.set(m.id, m);
      } catch { /* poskozena metadata: sirotek se uklidi v cleanup() */ }
    }
  }

  static validId(id) { return ID_RE.test(String(id)); }

  part(id) { return path.join(this.dir, id + '.part'); }
  metaFile(id) { return path.join(this.dir, id + '.json'); }

  async saveMeta(m) {
    m.updated = Date.now();
    await fsp.writeFile(this.metaFile(m.id), JSON.stringify(m), 'utf8');
  }

  async received(id) {
    try { return (await fsp.stat(this.part(id))).size; } catch { return 0; }
  }

  // stejny soubor (otisk) do stejne slozky = navazani na rozpracovane nahravani
  async init({ dirRel, name, size, fp }) {
    if (fp) {
      for (const m of this.metas.values()) {
        if (m.fp === fp && m.dirRel === dirRel && m.name === name && m.size === size) {
          return { meta: m, received: await this.received(m.id), resumed: true };
        }
      }
    }
    const m = { id: randomBytes(12).toString('hex'), dirRel, name, size, fp: fp || '', created: Date.now(), updated: Date.now() };
    await fsp.writeFile(this.part(m.id), '');
    await this.saveMeta(m);
    this.metas.set(m.id, m);
    return { meta: m, received: 0, resumed: false };
  }

  get(id) {
    const m = this.metas.get(String(id));
    if (!m) throw Object.assign(new Error('Upload not found'), { status: 404 });
    return m;
  }

  // pripoji blok na konec; offset musi presne navazovat, jinak klient dostane aktualni stav a navaze od nej
  async append(id, offset, req, maxBytes) {
    const m = this.get(id);
    if (this.busy.has(id)) throw Object.assign(new Error('Upload busy'), { status: 409 });
    this.busy.add(id);
    try {
      const have = await this.received(id);
      if (offset !== have) throw Object.assign(new Error('Offset mismatch'), { status: 409, received: have });
      const allowed = Math.min(maxBytes, m.size - have);
      let written = 0;
      await new Promise((resolve, reject) => {
        const out = fs.createWriteStream(this.part(id), { flags: 'a' });
        const fail = (err) => { out.destroy(); reject(err); };
        req.on('data', (chunk) => {
          written += chunk.length;
          if (written > allowed) { req.unpipe(out); fail(Object.assign(new Error('Chunk too large'), { status: 413 })); }
        });
        req.on('error', fail);
        req.on('aborted', () => fail(new Error('Upload aborted')));
        out.on('error', reject);
        out.on('finish', resolve);
        req.pipe(out);
      }).catch(async (err) => {
        // castecne zapsany blok se zahodi, aby offset zustal konzistentni
        await fsp.truncate(this.part(id), have).catch(() => {});
        throw err;
      });
      m.updated = Date.now();
      return have + written;
    } finally {
      this.busy.delete(id);
    }
  }

  async discard(id) {
    this.metas.delete(id);
    await fsp.rm(this.part(id), { force: true });
    await fsp.rm(this.metaFile(id), { force: true });
  }

  // po uspesnem dokonceni: metadata pryc, hotovy soubor presune volajici
  async forget(id) {
    this.metas.delete(id);
    await fsp.rm(this.metaFile(id), { force: true });
  }

  // nedokoncena nahravani starsi nez 24 h se mazou, stejne jako sirotci bez metadat
  async cleanup() {
    const limit = Date.now() - STALE_MS;
    for (const m of [...this.metas.values()]) {
      if (m.updated < limit) await this.discard(m.id);
    }
    for (const f of await fsp.readdir(this.dir).catch(() => [])) {
      const id = f.replace(/\.(part|json)$/, '');
      if (!this.metas.has(id)) await fsp.rm(path.join(this.dir, f), { force: true });
    }
  }
}

module.exports = { Uploads };
