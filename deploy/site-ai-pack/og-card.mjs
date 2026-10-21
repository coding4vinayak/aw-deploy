// The company's share card, generated from the company's own logo.
//
// The site had no Open Graph image at all, so a link to any of its pages
// rendered as a bare URL: no card, no picture, no description. The two images
// in the repository were not usable — one is a stock robot handshake, and the
// other is somebody else's office (you can read the name on the ceiling) — and
// a share card that shows a stock photo of another company's office is a lie
// about who you are.
//
// So the card is composed from the site's own mark: the blue square with the
// knocked-out "AW", on the brand's gold. It is generated, not drawn by hand, so
// it can be regenerated when the logo changes.
//
// Dependency-free on purpose: PNG in and out with nothing but `zlib`, which
// Node ships. The alternative — a build step with an image library — is a
// toolchain the site does not have and would not keep.

import { deflateSync, inflateSync } from "node:zlib";
import { readFileSync, writeFileSync } from "node:fs";

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** CRC-32, the PNG chunk checksum. */
const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, body) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(body.length, 0);
  const typed = Buffer.concat([Buffer.from(type, "ascii"), body]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(typed), 0);
  return Buffer.concat([len, typed, crc]);
}

/** Reverse a PNG scanline filter, in place on `line`. */
function unfilter(filter, line, prev, bpp) {
  for (let x = 0; x < line.length; x++) {
    const a = x >= bpp ? line[x - bpp] : 0;
    const b = prev[x];
    const c = x >= bpp ? prev[x - bpp] : 0;
    switch (filter) {
      case 0: break;
      case 1: line[x] = (line[x] + a) & 0xff; break;
      case 2: line[x] = (line[x] + b) & 0xff; break;
      case 3: line[x] = (line[x] + ((a + b) >> 1)) & 0xff; break;
      case 4: {
        const p = a + b - c;
        const pa = Math.abs(p - a);
        const pb = Math.abs(p - b);
        const pc = Math.abs(p - c);
        line[x] = (line[x] + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c)) & 0xff;
        break;
      }
      default: throw new Error(`unknown PNG filter ${filter}`);
    }
  }
}

/**
 * Decode a PNG into RGBA pixels.
 *
 * Only what the site's own logo needs: 8-bit, non-interlaced, palette or true
 * colour, with or without transparency. A logo that needed more than that would
 * fail loudly here rather than produce a subtly wrong card.
 */
export function decodePng(buffer) {
  if (!buffer.subarray(0, 8).equals(PNG_SIGNATURE)) throw new Error("not a PNG");
  let i = 8;
  let width = 0;
  let height = 0;
  let depth = 0;
  let colourType = 0;
  let interlace = 0;
  const idat = [];
  let palette = null;
  let transparency = null;

  while (i < buffer.length) {
    const length = buffer.readUInt32BE(i);
    const type = buffer.toString("ascii", i + 4, i + 8);
    const body = buffer.subarray(i + 8, i + 8 + length);
    if (type === "IHDR") {
      width = body.readUInt32BE(0);
      height = body.readUInt32BE(4);
      depth = body[8];
      colourType = body[9];
      interlace = body[12];
    } else if (type === "IDAT") idat.push(body);
    else if (type === "PLTE") palette = body;
    else if (type === "tRNS") transparency = body;
    else if (type === "IEND") break;
    i += 12 + length;
  }

  if (depth !== 8) throw new Error(`unsupported PNG depth ${depth}`);
  if (interlace !== 0) throw new Error("interlaced PNG is not supported");

  const channels = colourType === 3 ? 1 : colourType === 2 ? 3 : colourType === 6 ? 4 : colourType === 0 ? 1 : 0;
  if (!channels) throw new Error(`unsupported PNG colour type ${colourType}`);

  const raw = inflateSync(Buffer.concat(idat));
  const bpp = channels;
  const stride = width * channels;
  const pixels = Buffer.alloc(width * height * 4);
  let prev = Buffer.alloc(stride);

  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)];
    const line = Buffer.from(raw.subarray(y * (stride + 1) + 1, y * (stride + 1) + 1 + stride));
    unfilter(filter, line, prev, bpp);
    for (let x = 0; x < width; x++) {
      const o = (y * width + x) * 4;
      if (colourType === 3) {
        const idx = line[x];
        pixels[o] = palette[idx * 3];
        pixels[o + 1] = palette[idx * 3 + 1];
        pixels[o + 2] = palette[idx * 3 + 2];
        pixels[o + 3] = transparency && idx < transparency.length ? transparency[idx] : 255;
      } else if (colourType === 0) {
        pixels[o] = pixels[o + 1] = pixels[o + 2] = line[x];
        pixels[o + 3] = 255;
      } else {
        pixels[o] = line[x * channels];
        pixels[o + 1] = line[x * channels + 1];
        pixels[o + 2] = line[x * channels + 2];
        pixels[o + 3] = channels === 4 ? line[x * channels + 3] : 255;
      }
    }
    prev = line;
  }

  return { width, height, pixels };
}

/** Encode RGBA pixels as an RGB PNG (colour type 2, filter 0). */
export function encodePng(width, height, rgba) {
  const stride = width * 3;
  const raw = Buffer.alloc(height * (stride + 1));
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0;
    for (let x = 0; x < width; x++) {
      const s = (y * width + x) * 4;
      const d = y * (stride + 1) + 1 + x * 3;
      raw[d] = rgba[s];
      raw[d + 1] = rgba[s + 1];
      raw[d + 2] = rgba[s + 2];
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // colour type: truecolour
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;
  return Buffer.concat([
    PNG_SIGNATURE,
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

/** Scale RGBA pixels by an integer factor, nearest neighbour. */
export function scalePixels(image, factor) {
  const { width, height, pixels } = image;
  const w = width * factor;
  const h = height * factor;
  const out = Buffer.alloc(w * h * 4);
  for (let y = 0; y < h; y++) {
    const sy = Math.floor(y / factor);
    for (let x = 0; x < w; x++) {
      const sx = Math.floor(x / factor);
      const s = (sy * width + sx) * 4;
      const d = (y * w + x) * 4;
      out[d] = pixels[s];
      out[d + 1] = pixels[s + 1];
      out[d + 2] = pixels[s + 2];
      out[d + 3] = pixels[s + 3];
    }
  }
  return { width: w, height: h, pixels: out };
}

/**
 * Compose the share card: the brand's gold field with the mark centred.
 *
 * The mark's knocked-out letters show the gold through, so the card is the
 * company's own blue square on the company's own gold — no stock photography,
 * no other company's office, and nothing invented about the company.
 */
export function composeCard(
  logo,
  { width = 1200, height = 630, gold = [255, 196, 81], field = [255, 255, 255], scale = 2 } = {},
) {
  const card = Buffer.alloc(width * height * 4);
  for (let i = 0; i < width * height; i++) {
    card[i * 4] = field[0];
    card[i * 4 + 1] = field[1];
    card[i * 4 + 2] = field[2];
    card[i * 4 + 3] = 255;
  }

  // The mark, centred — the company's own blue square with the knocked-out
  // letters, so the field shows through them.
  const mark = scalePixels(logo, scale);
  const offsetX = Math.floor((width - mark.width) / 2);
  const offsetY = Math.floor((height - mark.height) / 2) - 10;
  for (let y = 0; y < mark.height; y++) {
    for (let x = 0; x < mark.width; x++) {
      const s = (y * mark.width + x) * 4;
      const alpha = mark.pixels[s + 3] / 255;
      if (alpha === 0) continue;
      const d = ((y + offsetY) * width + (x + offsetX)) * 4;
      for (let c = 0; c < 3; c++) {
        card[d + c] = Math.round(mark.pixels[s + c] * alpha + card[d + c] * (1 - alpha));
      }
    }
  }

  // The brand's gold as a rule along the bottom.
  const rule = 14;
  for (let y = height - rule; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const d = (y * width + x) * 4;
      card[d] = gold[0];
      card[d + 1] = gold[1];
      card[d + 2] = gold[2];
    }
  }
  return { width, height, pixels: card };
}

/**
 * The CLI: read the logo, write the card.
 *
 *   node og-card.mjs <logo.png> <out.png>
 */
function main(argv) {
  const [logoPath, outPath] = argv;
  if (!logoPath || !outPath) {
    console.error("usage: node og-card.mjs <logo.png> <out.png>");
    process.exit(2);
  }
  const logo = decodePng(readFileSync(logoPath));
  const card = composeCard(logo);
  writeFileSync(outPath, encodePng(card.width, card.height, card.pixels));
  console.log(`wrote ${outPath} (${card.width}x${card.height})`);
}

if (process.argv[1] && process.argv[1].endsWith("og-card.mjs")) {
  main(process.argv.slice(2));
}
