// Generates placeholder tray + app icons until real artwork exists.
// Run once: `node resources/generate-icons.cjs`
const { writeFileSync } = require('fs');
const { join } = require('path');
const { deflateSync, crc32 } = require('zlib');

function chunk(type, data) {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length, 0);
    const typed = Buffer.concat([Buffer.from(type), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(typed) >>> 0, 0);
    return Buffer.concat([len, typed, crc]);
}

function png(width, height, rgba) {
    const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    const ihdr = Buffer.alloc(13);
    ihdr.writeUInt32BE(width, 0);
    ihdr.writeUInt32BE(height, 4);
    ihdr[8] = 8;  // bit depth
    ihdr[9] = 6;  // RGBA
    ihdr[10] = 0;
    ihdr[11] = 0;
    ihdr[12] = 0;
    const raw = Buffer.alloc(height * (1 + width * 4));
    let off = 0;
    for (let y = 0; y < height; y++) {
        raw[off++] = 0; // filter
        for (let x = 0; x < width; x++) {
            raw[off++] = rgba[0];
            raw[off++] = rgba[1];
            raw[off++] = rgba[2];
            raw[off++] = rgba[3];
        }
    }
    return Buffer.concat([
        sig,
        chunk('IHDR', ihdr),
        chunk('IDAT', deflateSync(raw)),
        chunk('IEND', Buffer.alloc(0)),
    ]);
}

writeFileSync(join(__dirname, 'tray-icon.png'), png(32, 32, [139, 92, 246, 255]));
writeFileSync(join(__dirname, 'icon.png'), png(256, 256, [139, 92, 246, 255]));
console.log('Wrote placeholder tray-icon.png + icon.png');
