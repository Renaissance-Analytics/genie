import { readFileSync, statSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

/**
 * THE GENIE ICON, EVERYWHERE A PERSON SEES ONE. 2.0.0-beta.7 shipped with electron-builder's default icon on the
 * window, the taskbar and the installer, and a generated gradient square in the tray. The icon is Genie's logo — since
 * 2026-10-18 the genie-logo-white art (test/genie-logo-white.test.ts holds that) — as `icon.ico` 7 sizes, `icon.png`
 * 1024², `tray-icon.png` 32², in `build/`, named by the builder config and shipped for the tray as an extra resource.
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

/**
 * THE ICON THE OWNER COULD NOT SEE (2026-10-15): a blank white page on the Windows taskbar for the installed Genie 2,
 * and nothing in the title bar's upper-left. Three causes, each held here:
 *
 *  1. The running process never claimed the installed shortcut's AppUserModelID (`ai.tynn.genie`, stamped on the
 *     Start-menu .lnk by electron-builder's NSIS template), so Windows grouped its windows as a different application
 *     — `electron.app.genie` — with no shortcut to take an icon from.
 *  2. The installed window carried no icon of its own: main.ts took `build/icon.png` only when it existed beside
 *     `dist/`, and the installed app packs `dist/**` alone. The icons now ship as extra resources.
 *  3. The title bar's "mark" was a gradient square, not the logo.
 *
 * On origin/main every test in this block is red: app-identity.ts does not exist, the builder ships no icon resource,
 * entry.ts sets no AppUserModelID, no window takes `genieWindowIcon`, and the title bar has no <img>.
 */
const stripComments = (src: string) => src.split(/\r?\n/).map((l) => l.replace(/^\s*(\/\/|\*|\/\*).*$/, '')).join('\n');

describe('the AppUserModelID is the installer’s appId', () => {
    it('the constant equals electron-builder.yml `appId` — read from both files, not restated', async () => {
        const { APP_USER_MODEL_ID } = await import('../src/main/app-identity.js');
        const yml = readFileSync('electron-builder.yml', 'utf8').replace(/\r\n/g, '\n');
        const appId = yml.match(/^appId:\s*(\S+)\s*$/m)?.[1];
        // Positive control: the builder's appId was found at all.
        expect(appId).toBe('ai.tynn.genie');
        expect(APP_USER_MODEL_ID).toBe(appId);
    });

    it('is claimed by an installed Windows app only — not a dev run, not another OS', async () => {
        const { APP_USER_MODEL_ID, appUserModelIdFor } = await import('../src/main/app-identity.js');
        expect(appUserModelIdFor('win32', true)).toBe(APP_USER_MODEL_ID);
        expect(appUserModelIdFor('win32', false)).toBeNull();
        expect(appUserModelIdFor('linux', true)).toBeNull();
        expect(appUserModelIdFor('darwin', true)).toBeNull();
    });

    it('entry.ts sets it before either side loads — so every window, doctor mode’s too, is created under it', () => {
        const entry = stripComments(readFileSync('src/main/entry.ts', 'utf8'));
        expect(entry).toMatch(/const appUserModelId = appUserModelIdFor\(process\.platform, app\.isPackaged\);/);
        expect(entry).toMatch(/if \(appUserModelId !== null\) app\.setAppUserModelId\(appUserModelId\);/);
        const set = entry.indexOf('app.setAppUserModelId(');
        // Positive controls: both lazy imports are there to be ordered against.
        expect(entry.indexOf("import('./doctor.js')")).toBeGreaterThan(set);
        expect(entry.indexOf("import('./main.js')")).toBeGreaterThan(set);
        expect(set).toBeGreaterThan(-1);
    });
});

describe('every Genie window carries the icon, installed and dev alike', () => {
    it('the builder ships icon.ico and icon.png as extra resources, from files that exist in the repo', () => {
        const yml = readFileSync('electron-builder.yml', 'utf8').replace(/\r\n/g, '\n');
        expect(yml).toMatch(/from: build\/icon\.ico\s*\n\s*to: icon\.ico/);
        expect(yml).toMatch(/from: build\/icon\.png\s*\n\s*to: icon\.png/);
        // Every icon the builder names or ships is a file in the repo — counted, so a new one cannot slip by.
        const named = [...yml.matchAll(/(?:icon|from): (build\/[\w.-]*icon[\w.-]*)/g)].map((m) => m[1]!);
        expect(new Set(named)).toEqual(new Set(['build/icon.ico', 'build/icon.png', 'build/tray-icon.png']));
        for (const f of named) expect(statSync(f).size).toBeGreaterThan(0);
    });

    it('windowIconPath: the shipped resource first, the repo’s build/ in a dev run, .ico on Windows, .png elsewhere, null when neither', async () => {
        const { windowIconPath } = await import('../src/main/app-identity.js');
        const { join } = await import('node:path');
        const res = join('/opt', 'Genie', 'resources');
        const build = join('/src', 'genie2', 'build');
        const all = () => true;
        expect(windowIconPath('win32', res, build, all)).toBe(join(res, 'icon.ico'));
        expect(windowIconPath('linux', res, build, all)).toBe(join(res, 'icon.png'));
        expect(windowIconPath('win32', res, build, (p) => p.startsWith(build))).toBe(join(build, 'icon.ico'));
        expect(windowIconPath('win32', undefined, build, (p) => p.startsWith(build))).toBe(join(build, 'icon.ico'));
        expect(windowIconPath('win32', res, build, () => false)).toBeNull();
    });

    for (const file of ['src/main/main.ts', 'src/main/doctor.ts', 'src/main/question-window-electron.ts']) {
        it(`${file}: every BrowserWindow it creates spreads genieWindowIcon — counted`, () => {
            const src = stripComments(readFileSync(file, 'utf8'));
            const windows = src.match(/new BrowserWindow\(/g)?.length ?? 0;
            // Positive control: the file does create windows.
            expect(windows).toBeGreaterThan(0);
            expect(src.match(/\.\.\.genieWindowIcon\((here|input\.here)\),/g)?.length ?? 0).toBe(windows);
            // The old dev-only path is gone: it could never be true in an installed app.
            expect(src).not.toMatch(/build', 'icon\.png'\)\) \?/);
        });
    }
});

describe('the title bar shows Genie’s logo', () => {
    it('the bundled logo is a PNG of the app icon’s 128 px art', () => {
        const png = readFileSync('src/renderer/assets/genie-logo.png');
        expect(png.subarray(0, 8)).toEqual(PNG);
        expect(png.readUInt32BE(16)).toBe(128);
    });

    it('the brand mark is the logo image, not a gradient square — in the title bar and the doctor window', async () => {
        const { renderToStaticMarkup } = await import('react-dom/server');
        const { createElement } = await import('react');
        const { TitleBar } = await import('../src/renderer/components/TitleBar.js');
        const html = renderToStaticMarkup(createElement(TitleBar, { route: 'genie://dashboard', workstation: null, onNavigate: () => {}, onOpenPalette: () => {} }));
        const marks = [...html.matchAll(/<(\w+)[^>]*data-brand-mark[^>]*>/g)];
        // Exactly one mark, and it is an <img> of the logo asset.
        expect(marks).toHaveLength(1);
        expect(marks[0]![1]).toBe('img');
        expect(marks[0]![0]).toMatch(/src="[^"]*genie-logo[^"]*\.png"/);
        expect(html).not.toMatch(/brand-grad-from/);
        expect(stripComments(readFileSync('src/renderer/DoctorApp.tsx', 'utf8'))).toMatch(/<GenieLogo \/>/);
    });
});
