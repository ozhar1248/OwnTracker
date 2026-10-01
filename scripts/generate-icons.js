// Rasterize the existing three-bar logo for Android launchers, without build dependencies.
// The maskable version keeps the entire symbol inside Android's central safe circle.
import { deflateSync } from 'node:zlib';
import { mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const output = fileURLToPath(new URL('../public/icons/', import.meta.url));
mkdirSync(output, { recursive: true });
const crcTable = Array.from({ length: 256 }, (_, value) => {
  for (let bit = 0; bit < 8; bit++) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
  return value >>> 0;
});
function chunk(type, data) {
  const name = Buffer.from(type);
  let crc = 0xffffffff;
  for (const byte of Buffer.concat([name, data])) crc = crcTable[(crc ^ byte) & 255] ^ (crc >>> 8);
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const checksum = Buffer.alloc(4);
  checksum.writeUInt32BE((crc ^ 0xffffffff) >>> 0);
  return Buffer.concat([length, name, data, checksum]);
}
function render(size, maskable) {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0);
  header.writeUInt32BE(size, 4);
  header[8] = 8;
  header[9] = 6;
  const pixels = Buffer.alloc(size * (size * 4 + 1));
  const green = [35, 107, 89];
  const cream = [225, 240, 204];
  const bars = maskable ? [[16, 24, 31], [24, 19, 31], [32, 14, 31]] : [[13, 23, 30], [24, 17, 30], [35, 11, 30]];
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    let coverage = 0;
    for (let sy = 0; sy < 4; sy++) for (let sx = 0; sx < 4; sx++) {
      const px = (x + (sx + .5) / 4) * 48 / size;
      const py = (y + (sy + .5) / 4) * 48 / size;
      if (bars.some(([center, top, bottom]) => (px - center) ** 2 + (py - Math.max(top, Math.min(bottom, py))) ** 2 <= (maskable ? 2.5 : 3) ** 2)) coverage++;
    }
    const offset = y * (size * 4 + 1) + 1 + x * 4;
    for (let channel = 0; channel < 3; channel++) pixels[offset + channel] = Math.round(green[channel] + (cream[channel] - green[channel]) * coverage / 16);
    pixels[offset + 3] = 255;
  }
  return Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]), chunk('IHDR', header), chunk('IDAT', deflateSync(pixels)), chunk('IEND', Buffer.alloc(0))]);
}
for (const [name, size, maskable] of [['icon-192.png', 192, false], ['icon-512.png', 512, false], ['maskable-512.png', 512, true]]) {
  writeFileSync(new URL(name, new URL('../public/icons/', import.meta.url)), render(size, maskable));
}
