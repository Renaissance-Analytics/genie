import { readFileSync, statSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

/**
 * THE GENIE ICON, EVERYWHERE A PERSON SEES ONE. 2.0.0-beta.7 shipped with electron-builder's default icon on the
 * window, the taskbar and the installer, and a generated gradient square in the tray. The icon is Genie 1's own
 * (`icon.ico` 7 sizes, `icon.png` 1024², `tray-icon.png` 32²), in `build/`, named by the builder config and shipped
 * for the tray as an extra resource.
 */
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

describe('app icon', () => {
    it('build/icon.ico is a Windows icon resource with several sizes', () => {
        const ico = readFileSync('build/icon.ico');
        expect(ico.readUInt16LE(0)).toBe(0); // reserved
        expect(ico.readUInt16LE(2)).toBe(1); // type: icon
        expect(ico.readUInt16LE(4)).toBeGreaterThanOrEqual(5); // image count
        expect(statSync('build/icon.ico').size).toBeGreaterThan(50_000);
    });

    it('build/icon.png is a large PNG (Linux, the dev window)', () => {
        const png = readFileSync('build/icon.png');
        expect(png.subarray(0, 8)).toEqual(PNG);
        expect(png.readUInt32BE(16)).toBeGreaterThanOrEqual(512);
    });

    it('build/tray-icon.png is a small PNG for the tray', () => {
        const png = readFileSync('build/tray-icon.png');
        expect(png.subarray(0, 8)).toEqual(PNG);
        expect(png.readUInt32BE(16)).toBeLessThanOrEqual(64);
    });

    it('the builder names the icons and ships the tray icon as an extra resource', () => {
        const yml = readFileSync('electron-builder.yml', 'utf8');
        expect(yml).toMatch(/win:[\s\S]*?icon: build\/icon\.ico/);
        expect(yml).toMatch(/linux:[\s\S]*?icon: build\/icon\.png/);
        expect(yml).toMatch(/from: build\/tray-icon\.png\s*\n\s*to: tray-icon\.png/);
    });
});
