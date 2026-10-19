import { readFileSync } from 'node:fs';
import { inflateSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { TRAY_ICON_PNG_BASE64 } from '../src/main/tray.js';

/**
 * GENIE'S NEW LOGO, EVERYWHERE IT IS DRAWN (the owner, 2026-10-18: "include a new logo for genie. use the
 * genie-logo-white"). The art is the lamp with a terminal prompt, teal to violet, on WHITE — `.ai/design/
 * genie-logo-white.png`, 1254² RGB. Every place Genie shows its mark carries it: the installer / taskbar / window icon
 * (build/icon.ico, build/icon.png), the tray (build/tray-icon.png and the 16 px fallback embedded in tray.ts), and the
 * title bar and doctor window (src/renderer/assets/genie-logo.png).
 *
 * What tells the new art from the old: the old icon was the mark on TRANSPARENT corners; the new one is on opaque
 * white. And it is not a blank white tile: a COUNT of saturated pixels says the art is there.
 */

interface Image { width: number; height: number; px: (x: number, y: number) => [number, number, number, number] }

/** A minimal PNG reader (8-bit RGB / RGBA, non-interlaced) — enough to read pixels without a dependency. */
function readPng(buf: Buffer): Image {
    expect(buf.subarray(0, 8)).toEqual(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
    let pos = 8;
    let width = 0, height = 0, colorType = 0, depth = 0, interlace = 0;
    const idat: Buffer[] = [];
    while (pos < buf.length) {
        const len = buf.readUInt32BE(pos);
        const type = buf.toString('latin1', pos + 4, pos + 8);
        const data = buf.subarray(pos + 8, pos + 8 + len);
        if (type === 'IHDR') { width = data.readUInt32BE(0); height = data.readUInt32BE(4); depth = data[8]!; colorType = data[9]!; interlace = data[12]!; }
        if (type === 'IDAT') idat.push(data);
        pos += 12 + len;
    }
    expect({ depth, interlace, rgb: colorType === 2 || colorType === 6 }).toEqual({ depth: 8, interlace: 0, rgb: true });
    const bpp = colorType === 6 ? 4 : 3;
    const raw = inflateSync(Buffer.concat(idat));
    const stride = width * bpp;
    const out = Buffer.alloc(height * stride);
    for (let y = 0; y < height; y++) {
        const filter = raw[y * (stride + 1)]!;
        for (let i = 0; i < stride; i++) {
            const v = raw[y * (stride + 1) + 1 + i]!;
            const a = i >= bpp ? out[y * stride + i - bpp]! : 0;
            const b = y > 0 ? out[(y - 1) * stride + i]! : 0;
            const c = i >= bpp && y > 0 ? out[(y - 1) * stride + i - bpp]! : 0;
            const p = a + b - c;
            const pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
            const pred = filter === 0 ? 0 : filter === 1 ? a : filter === 2 ? b : filter === 3 ? Math.floor((a + b) / 2) : pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
            out[y * stride + i] = (v + pred) & 0xff;
        }
    }
    return { width, height, px: (x, y) => { const o = y * stride + x * bpp; return [out[o]!, out[o + 1]!, out[o + 2]!, bpp === 4 ? out[o + 3]! : 255]; } };
}

/** The largest PNG layer of a Windows .ico. */
function largestIcoLayer(ico: Buffer): Buffer {
    const count = ico.readUInt16LE(4);
    let best = { size: 0, offset: 0, bytes: 0 };
    for (let i = 0; i < count; i++) {
        const e = 6 + i * 16;
        const w = ico[e] === 0 ? 256 : ico[e]!;
        if (w > best.size) best = { size: w, bytes: ico.readUInt32LE(e + 8), offset: ico.readUInt32LE(e + 12) };
    }
    return ico.subarray(best.offset, best.offset + best.bytes);
}

const white = ([r, g, b, a]: readonly number[]) => a === 255 && r! >= 240 && g! >= 240 && b! >= 240;
const saturated = ([r, g, b, a]: readonly number[]) => a! > 200 && Math.max(r!, g!, b!) - Math.min(r!, g!, b!) > 80;

function check(name: string, img: Image, minSize: number) {
    expect(img.width, name).toBe(img.height);
    expect(img.width, name).toBeGreaterThanOrEqual(minSize);
    const last = img.width - 1;
    // The new art's tile: opaque white in every corner (the old mark's corners were transparent).
    for (const [x, y] of [[0, 0], [last, 0], [0, last], [last, last]] as const) expect(white(img.px(x, y)), `${name} corner ${x},${y}`).toBe(true);
    // And the lamp is on it: a COUNT of saturated pixels, not a blank tile.
    let colour = 0;
    for (let y = 0; y < img.height; y++) for (let x = 0; x < img.width; x++) if (saturated(img.px(x, y))) colour++;
    expect(colour / (img.width * img.height), `${name} saturated share`).toBeGreaterThan(0.08);
}

describe('the genie-logo-white art everywhere Genie draws its mark (COUNTED: five places)', () => {
    it('build/icon.png — Linux and the window', () => check('icon.png', readPng(readFileSync('build/icon.png')), 512));
    it('build/icon.ico — the installer and the taskbar, its largest layer', () => check('icon.ico', readPng(largestIcoLayer(readFileSync('build/icon.ico'))), 256));
    it('build/tray-icon.png — the tray', () => check('tray-icon.png', readPng(readFileSync('build/tray-icon.png')), 32));
    it('the tray’s embedded 16 px fallback', () => check('TRAY_ICON_PNG_BASE64', readPng(Buffer.from(TRAY_ICON_PNG_BASE64, 'base64')), 16));
    it('src/renderer/assets/genie-logo.png — the title bar and the doctor window', () => check('genie-logo.png', readPng(readFileSync('src/renderer/assets/genie-logo.png')), 128));
});
