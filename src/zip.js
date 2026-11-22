// Streamovy ZIP (deflate, bez zavislosti): soubory se cetou a posilaji postupne, v pameti je jen maly buffer.
// Bez ZIP64, takze archiv je omezen na ~4 GB a 65 534 polozek; vetsi se odmitne driv, nez zacne stahovani.
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const zlib = require('zlib');

const MAX_ZIP_BYTES = 0xFFFFFFFF - 32 * 1024 * 1024; // rezerva na rezii a nekompresovatelna data
const MAX_ZIP_ENTRIES = 0xFFFE;

class ZipTooLargeError extends Error {
  constructor() { super('Archive too large for ZIP'); this.status = 413; }
}

function dosDateTime(ms) {
  const d = new Date(ms);
  if (d.getFullYear() < 1980) return { time: 0, date: (1 << 5) | 1 };
  return {
    time: (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1),
    date: ((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate(),
  };
}

// items: [{ full, name }] (name = nazev na nejvyssi urovni archivu). skip(full) = true vynecha cestu (skryte soubory).
// Vraci [{ name, full, dir, mtime, size }] a hlida limity.
async function collectEntries(items, skip = () => false) {
  const entries = [];
  let total = 0;
  const add = (e) => {
    entries.push(e);
    total += e.size;
    if (entries.length > MAX_ZIP_ENTRIES || total > MAX_ZIP_BYTES) throw new ZipTooLargeError();
  };
  const walk = async (full, name) => {
    const st = await fsp.stat(full);
    if (st.isDirectory()) {
      add({ name: name + '/', full, dir: true, mtime: st.mtimeMs, size: 0 });
      const children = (await fsp.readdir(full, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name));
      for (const c of children) {
        const cf = path.join(full, c.name);
        if (skip(cf) || (!c.isFile() && !c.isDirectory())) continue; // symlinky a podobne se preskoci
        await walk(cf, name + '/' + c.name);
      }
    } else if (st.isFile()) {
      add({ name, full, dir: false, mtime: st.mtimeMs, size: st.size });
    }
  };
  for (const it of items) await walk(it.full, it.name);
  return entries;
}

// zapisovac do odpovedi s respektovanim backpressure a odpojeni klienta
class Out {
  constructor(res) {
    this.res = res;
    this.offset = 0;
    this.closed = false;
    res.on('close', () => { this.closed = true; });
  }

  async write(buf) {
    if (this.closed) throw new Error('Client closed');
    this.offset += buf.length;
    if (this.res.write(buf)) return;
    await new Promise((resolve, reject) => {
      const onDrain = () => { this.res.off('close', onClose); resolve(); };
      const onClose = () => { this.res.off('drain', onDrain); reject(new Error('Client closed')); };
      this.res.once('drain', onDrain);
      this.res.once('close', onClose);
    });
  }
}

function localHeader(nameBuf, flags, method, time, date) {
  const b = Buffer.alloc(30 + nameBuf.length);
  b.writeUInt32LE(0x04034b50, 0);
  b.writeUInt16LE(20, 4); // verze potrebna k rozbaleni
  b.writeUInt16LE(flags, 6);
  b.writeUInt16LE(method, 8);
  b.writeUInt16LE(time, 10);
  b.writeUInt16LE(date, 12);
  // crc a velikosti jsou 0, platne hodnoty jsou v data descriptoru (flag bit 3)
  b.writeUInt16LE(nameBuf.length, 26);
  nameBuf.copy(b, 30);
  return b;
}

function dataDescriptor(crc, csize, usize) {
  const b = Buffer.alloc(16);
  b.writeUInt32LE(0x08074b50, 0);
  b.writeUInt32LE(crc >>> 0, 4);
  b.writeUInt32LE(csize, 8);
  b.writeUInt32LE(usize, 12);
  return b;
}

function centralHeader(e) {
  const b = Buffer.alloc(46 + e.nameBuf.length);
  b.writeUInt32LE(0x02014b50, 0);
  b.writeUInt16LE((3 << 8) | 20, 4); // vytvoreno na Unixu, verze 2.0
  b.writeUInt16LE(20, 6);
  b.writeUInt16LE(e.flags, 8);
  b.writeUInt16LE(e.method, 10);
  b.writeUInt16LE(e.time, 12);
  b.writeUInt16LE(e.date, 14);
  b.writeUInt32LE(e.crc >>> 0, 16);
  b.writeUInt32LE(e.csize, 20);
  b.writeUInt32LE(e.usize, 24);
  b.writeUInt16LE(e.nameBuf.length, 28);
  // extra, komentar, disk, interni atributy: 0
  b.writeUInt32LE(((e.dir ? 0o040755 : 0o100644) << 16 | (e.dir ? 0x10 : 0)) >>> 0, 38); // externi atributy (prava, adresar)
  b.writeUInt32LE(e.offset, 42);
  e.nameBuf.copy(b, 46);
  return b;
}

function endOfCentralDirectory(count, cdSize, cdOffset) {
  const b = Buffer.alloc(22);
  b.writeUInt32LE(0x06054b50, 0);
  b.writeUInt16LE(count, 8);
  b.writeUInt16LE(count, 10);
  b.writeUInt32LE(cdSize, 12);
  b.writeUInt32LE(cdOffset, 16);
  return b;
}

// Zapise cely archiv do res. Hlavicky odpovedi si nastavuje volajici. Pri chybe uprostred se spojeni zahodi.
async function streamZip(res, entries) {
  const out = new Out(res);
  const done = [];

  for (const e of entries) {
    const nameBuf = Buffer.from(e.name, 'utf8');
    const { time, date } = dosDateTime(e.mtime);
    const rec = { nameBuf, time, date, dir: e.dir, offset: out.offset, crc: 0, csize: 0, usize: 0, method: 0, flags: 0x0800 };

    if (e.dir) {
      await out.write(localHeader(nameBuf, rec.flags, 0, time, date));
    } else {
      rec.method = 8;
      rec.flags = 0x0808; // UTF-8 nazvy + data descriptor
      await out.write(localHeader(nameBuf, rec.flags, 8, time, date));
      const rs = fs.createReadStream(e.full);
      const def = zlib.createDeflateRaw({ level: 3 });
      rs.on('error', (err) => def.destroy(err));
      rs.on('data', (c) => { rec.crc = zlib.crc32(c, rec.crc); rec.usize += c.length; });
      rs.pipe(def);
      for await (const chunk of def) {
        rec.csize += chunk.length;
        await out.write(chunk);
      }
      if (rec.usize > 0xFFFFFFFF || rec.csize > 0xFFFFFFFF) throw new ZipTooLargeError();
      await out.write(dataDescriptor(rec.crc, rec.csize, rec.usize));
    }
    done.push(rec);
  }

  const cdOffset = out.offset;
  for (const rec of done) await out.write(centralHeader(rec));
  const cdSize = out.offset - cdOffset;
  if (out.offset > 0xFFFFFFFF) throw new ZipTooLargeError();
  await out.write(endOfCentralDirectory(done.length, cdSize, cdOffset));
  res.end();
}

module.exports = { collectEntries, streamZip, ZipTooLargeError };
