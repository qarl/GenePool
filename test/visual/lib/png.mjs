// Minimal PNG encode/decode (8-bit RGBA, filter 0 per row, single IDAT) via node:zlib. Zero external deps.
// These are OUR own PNGs (goldens + diff artifacts); the decoder only handles what encode() writes.
import zlib from 'node:zlib';

const CRC = (() => { const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++){ let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; }
  return t; })();
function crc32(buf){ let c = 0xffffffff; for (const b of buf) c = CRC[(c ^ b) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; }
function chunk(type, data){ const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type), data]); const c = Buffer.alloc(4); c.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, c]); }

// Encode RGBA (top-down) to a PNG buffer. flip:true first flips bottom-up readPixels rows to upright.
export function encode(rgba, w, h, { flip = false } = {}){
  let src = rgba;
  if (flip){ src = Buffer.alloc(rgba.length); for (let y = 0; y < h; y++) rgba.copy(src, y*w*4, (h-1-y)*w*4, (h-y)*w*4); }
  const raw = Buffer.alloc((w*4 + 1) * h);
  for (let y = 0; y < h; y++){ raw[y*(w*4+1)] = 0; src.copy(raw, y*(w*4+1)+1, y*w*4, (y+1)*w*4); }
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 6;
  return Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]),
    chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

// Decode one of our PNGs -> { w, h, rgba } (rgba top-down as stored). Assumes 8-bit RGBA, filter 0.
export function decode(buf){
  let o = 8, w, h; const idat = [];
  while (o < buf.length){ const len = buf.readUInt32BE(o); const type = buf.toString('ascii', o+4, o+8); const data = buf.subarray(o+8, o+8+len);
    if (type === 'IHDR'){ w = data.readUInt32BE(0); h = data.readUInt32BE(4); }
    else if (type === 'IDAT') idat.push(data); else if (type === 'IEND') break; o += 12 + len; }
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const rgba = Buffer.alloc(w*h*4);
  for (let y = 0; y < h; y++){ const f = raw[y*(w*4+1)]; if (f !== 0) throw new Error(`png.decode: unexpected filter ${f} (only 0 supported)`);
    raw.copy(rgba, y*w*4, y*(w*4+1)+1, (y+1)*(w*4+1)); }
  return { w, h, rgba };
}
