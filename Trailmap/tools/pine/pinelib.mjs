// pinelib.mjs — READ-ONLY PINE client for PCSX2.
// Only opcodes 0..3 (Read8/16/32/64), 8 (Version), 0x0B (Title), 0x0C (ID) are ever emitted.
// There is deliberately NO write / savestate / loadstate path in this file.
import net from 'node:net';

export const OP = { R8: 0, R16: 1, R32: 2, R64: 3, VERSION: 8, TITLE: 0x0b, ID: 0x0c };

export class Pine {
  constructor(port = 28011, host = '127.0.0.1') { this.port = port; this.host = host; }

  connect() {
    return new Promise((resolve, reject) => {
      this.sock = net.createConnection({ host: this.host, port: this.port });
      this.sock.setNoDelay(true);
      this.sock.once('error', reject);
      this.sock.once('connect', () => resolve(this));
    });
  }
  close() { this.sock?.end(); }

  // Send one PINE message (which may hold many batched commands) and await the framed reply.
  raw(body, timeoutMs = 20000) {
    const msg = Buffer.alloc(4 + body.length);
    msg.writeUInt32LE(msg.length, 0);
    body.copy(msg, 4);
    return new Promise((resolve, reject) => {
      const chunks = []; let have = 0, want = -1;
      const to = setTimeout(() => { cleanup(); reject(new Error('PINE timeout')); }, timeoutMs);
      const onData = d => {
        chunks.push(d); have += d.length;
        if (want < 0 && have >= 4) want = Buffer.concat(chunks, 4).readUInt32LE(0);
        if (want >= 0 && have >= want) { cleanup(); resolve(Buffer.concat(chunks, have)); }
      };
      const onErr = e => { cleanup(); reject(e); };
      const cleanup = () => { clearTimeout(to); this.sock.off('data', onData); this.sock.off('error', onErr); };
      this.sock.on('data', onData); this.sock.on('error', onErr);
      this.sock.write(msg);
    });
  }

  async simple(op) {
    const r = await this.raw(Buffer.from([op]));
    if (r[4] !== 0) throw new Error(`PINE status ${r[4]}`);
    return r.subarray(9).toString('latin1').replace(/\0+$/, '');
  }
  async info() {
    return { version: await this.simple(OP.VERSION), title: await this.simple(OP.TITLE), id: await this.simple(OP.ID) };
  }

  // Batched Read64 of a contiguous region. addr must be 8-aligned; len a multiple of 8.
  // Returns a Buffer of the raw bytes.
  async readBlock(addr, len, chunkReads = 40000) {
    if (addr % 8 || len % 8) throw new Error('readBlock wants 8-aligned addr/len');
    const out = Buffer.alloc(len);
    let done = 0;
    while (done < len) {
      const n = Math.min(chunkReads, (len - done) / 8);
      const body = Buffer.alloc(n * 5);
      for (let i = 0; i < n; i++) { body[i * 5] = OP.R64; body.writeUInt32LE(addr + done + i * 8, i * 5 + 1); }
      const r = await this.raw(body);
      if (r[4] !== 0) throw new Error(`PINE batch status ${r[4]} at 0x${(addr + done).toString(16)}`);
      r.copy(out, done, 5, 5 + n * 8);
      done += n * 8;
    }
    return out;
  }

  async read32(a) { const b = await this.readBlock(a & ~7, 8); return b.readUInt32LE(a & 4); }
  async read32s(addrs, chunkReads = 40000) {
    const out = new Array(addrs.length);
    for (let off = 0; off < addrs.length; off += chunkReads) {
      const slice = addrs.slice(off, off + chunkReads);
      const body = Buffer.alloc(slice.length * 5);
      slice.forEach((a, i) => { body[i * 5] = OP.R32; body.writeUInt32LE(a, i * 5 + 1); });
      const r = await this.raw(body);
      if (r[4] !== 0) throw new Error(`PINE status ${r[4]}`);
      for (let i = 0; i < slice.length; i++) out[off + i] = r.readUInt32LE(5 + i * 4);
    }
    return out;
  }
}

export function bxStringHash(s) {
  let hash = 0 >>> 0;
  for (const ch of s) {
    hash = ((hash << 4) + ch.charCodeAt(0)) >>> 0;
    const high = (hash & 0xf0000000) >>> 0;
    if (high > 0) hash = (hash ^ (high >>> 23)) >>> 0;
    hash = (hash & ~high) >>> 0;
  }
  return hash >>> 0;
}
export const instanceHash = s => (bxStringHash(s) & 0x7fffffff) >>> 0;
