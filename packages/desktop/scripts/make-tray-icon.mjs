/** A small terminal glyph for the macOS menu bar, with a Retina representation.
 * Pure Node, deterministic, and independent of platform fonts or Electron.
 * Run: node packages/desktop/scripts/make-tray-icon.mjs
 */
import { writeFileSync } from 'node:fs'
import { deflateSync } from 'node:zlib'

function crc32(bytes) {
  let crc = 0xffffffff
  for (const byte of bytes) {
    crc ^= byte
    for (let i = 0; i < 8; i++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0)
  }
  return (crc ^ 0xffffffff) >>> 0
}

function chunk(name, data) {
  const type = Buffer.from(name)
  const size = Buffer.alloc(4)
  size.writeUInt32BE(data.length)
  const checksum = Buffer.alloc(4)
  checksum.writeUInt32BE(crc32(Buffer.concat([type, data])))
  return Buffer.concat([size, type, data, checksum])
}

// Pixel coverage of three rounded line segments: >_ at 18 logical pixels.
const lines = [[3.5, 5, 7.5, 9], [7.5, 9, 3.5, 13], [9.5, 13, 14.5, 13]]
function ink(x, y) {
  return lines.some(([ax, ay, bx, by]) => {
    const dx = bx - ax, dy = by - ay
    const t = Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / (dx * dx + dy * dy)))
    return Math.hypot(x - ax - t * dx, y - ay - t * dy) <= 0.9
  })
}

for (const scale of [1, 2]) {
  const size = 18 * scale
  const header = Buffer.alloc(13)
  header.writeUInt32BE(size, 0)
  header.writeUInt32BE(size, 4)
  header[8] = 8
  header[9] = 6 // RGBA
  const pixels = Buffer.alloc(size * (1 + size * 4))
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    let coverage = 0
    for (let sy = 0; sy < 8; sy++) for (let sx = 0; sx < 8; sx++) {
      if (ink((x + (sx + 0.5) / 8) / scale, (y + (sy + 0.5) / 8) / scale)) coverage++
    }
    pixels[y * (1 + size * 4) + 1 + x * 4 + 3] = Math.round(coverage * 255 / 64)
  }
  const png = Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', header), chunk('IDAT', deflateSync(pixels)), chunk('IEND', Buffer.alloc(0)),
  ])
  writeFileSync(new URL(`../assets/trayTemplate${scale === 2 ? '@2x' : ''}.png`, import.meta.url), png)
}
