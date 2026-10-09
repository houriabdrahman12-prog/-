'use strict';
// Minimal ustar writer so the admin can download a whole backup (database + images) as ONE .tar.gz and keep it off-server.
const fs = require('node:fs');
const zlib = require('node:zlib');
function header(name, size, mtime) {
  const b = Buffer.alloc(512); if (Buffer.byteLength(name) > 100) throw new Error('name too long');
  b.write(name, 0, 100, 'utf8'); b.write('0000644\0', 100); b.write('0000000\0', 108); b.write('0000000\0', 116);
  b.write(size.toString(8).padStart(11, '0') + '\0', 124); b.write(Math.floor(mtime / 1000).toString(8).padStart(11, '0') + '\0', 136);
  b.fill(0x20, 148, 156); b.write('0', 156); b.write('ustar\0', 257); b.write('00', 263);
  let sum = 0; for (const x of b) sum += x; b.write(sum.toString(8).padStart(6, '0') + '\0 ', 148);
  return b;
}
/** files: [{ name, path }] -> writes a gzip-compressed tar to the writable stream `out`. */
function streamTarGz(out, files) {
  const gz = zlib.createGzip(); gz.pipe(out);
  for (const f of files) {
    const st = fs.statSync(f.path); const data = fs.readFileSync(f.path);
    gz.write(header(f.name, data.length, st.mtimeMs)); gz.write(data); const pad = (512 - (data.length % 512)) % 512; if (pad) gz.write(Buffer.alloc(pad));
  }
  gz.write(Buffer.alloc(1024)); gz.end();
}
/** Test/helper: parse a tar buffer -> [{ name, size }] */
function listTar(buf) { const out = []; for (let o = 0; o + 512 <= buf.length;) { const h = buf.subarray(o, o + 512); if (h.every((x) => x === 0)) break; const name = h.toString('utf8', 0, 100).replace(/\0.*$/, ''); const size = parseInt(h.toString('utf8', 124, 135), 8); out.push({ name, size }); o += 512 + Math.ceil(size / 512) * 512; } return out; }
module.exports = { streamTarGz, listTar };
