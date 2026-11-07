import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';
import { leftovers, required } from '../scripts/packed-tree-check.mjs';
import { shouldSignFile } from '../scripts/win-sign-plan.mjs';

/*
 * THE WINDOWS INSTALL DIRECTORY HOLDS WHAT THE APP RUNS, AND EVERY BINARY IN IT IS SIGNED (Tynn #437).
 *
 * Measured: v2.0.0-beta.60's installer, listed with 7-Zip and never run (test/fixtures/win-unpacked-beta60-files.json),
 * put 281 files in the install directory, 150 of them node-pty's and fancy-pty's build leftovers: macOS, Linux and
 * Windows-on-Arm binaries, winpty's sources and .bat/.ps1/.py/.sh scripts, node-pty's TypeScript sources and tests.
 * Get-AuthenticodeSignature on the same tree: the four Windows x64 .node files the app loads (PE DLLs) shipped unsigned.
 */
const require = createRequire(import.meta.url);
const read = (p: string) => readFileSync(p, 'utf8').replace(/\r\n/g, '\n');
const beta60 = (JSON.parse(read('test/fixtures/win-unpacked-beta60-files.json')) as { files: string[] }).files;
const yaml = (file: string) => require('js-yaml').load(read(file)) ?? {};

describe('what the Windows install directory holds', () => {
    it('CONTROL: beta.60\'s tree holds 150 files the app never uses, of every kind the rule names', () => {
        const found = leftovers(beta60);
        expect(found).toHaveLength(150);
        const names = found.map((f) => f.file);
        for (const kind of [
            'node-pty/prebuilds/darwin-arm64/pty.node', 'node-pty/prebuilds/win32-arm64/pty.node', 'fancy-pty/bin/linux-x64/fancy-pty-helper',
            'fancy-pty/bin/win32-arm64/fancy-pty-helper.exe', 'winpty/misc/ConinMode.ps1', 'winpty/vcbuild.bat', 'winpty/misc/Spew.py',
            'third_party/conpty/1.23.251008001/win10-x64/OpenConsole.exe', 'node-pty/src/index.ts', 'node-pty/lib/terminal.test.js', 'fancy-pty/native/helper.rs',
        ]) expect(names.some((n) => n.endsWith(kind)), kind).toBe(true);
    });

    it('what is left of beta.60\'s tree is clean, and has everything the app loads', () => {
        const extra = new Set(leftovers(beta60).map((f) => f.file));
        const kept = beta60.filter((f) => !extra.has(f));
        expect(leftovers(kept)).toEqual([]);
        const have = new Set(kept);
        expect(required().filter((f) => !have.has(f))).toEqual([]);
    });

    it('a tree missing a file the app loads is caught', () => {
        const without = new Set(beta60.filter((f) => !f.endsWith('prebuilds/win32-x64/conpty.node')));
        expect(required().filter((f) => !without.has(f))).toEqual(['resources/app.asar.unpacked/node_modules/node-pty/prebuilds/win32-x64/conpty.node']);
    });

    it('electron-builder.yml excludes the leftovers from the Windows build', () => {
        const win = (yaml('electron-builder.yml').win?.files ?? []) as string[];
        for (const pattern of [
            '!**/node_modules/node-pty/{deps,src,scripts,third_party}/**',
            '!**/node_modules/node-pty/prebuilds/{darwin-*,linux-*,win32-arm64}/**',
            '!**/node_modules/@particle-academy/fancy-pty/bin/{darwin-*,linux-*,win32-arm64}/**',
            '!**/node_modules/@particle-academy/fancy-pty/native/**',
            '!**/node_modules/node-pty/lib/**/*.test.{js,js.map}',
        ]) expect(win, pattern).toContain(pattern);
    });

    it('CI\'s Windows packaging runs the check on the built tree', () => {
        const ci = read('.github/workflows/ci.yml');
        const start = ci.indexOf('name: it packages');
        const next = ci.slice(start).search(/\n {2}[a-z][a-z0-9-]*:\n/);
        const job = ci.slice(start, next > 0 ? start + next : undefined);
        const build = job.indexOf('npx electron-builder --publish never');
        const check = job.search(/if: runner\.os == 'Windows'\s+run: node scripts\/packed-tree-check\.mjs release\/win-unpacked/);
        expect(build).toBeGreaterThan(-1);
        expect(check, 'after the build, in the same job').toBeGreaterThan(build);
    });
});

describe('every executable the Windows install directory holds is signed', () => {
    const signExts = (): string[] | null => yaml('electron-builder.yml').win?.signExts ?? null;

    it('every .node the app loads is signed by the build (a .node is a DLL)', () => {
        const nodes = beta60.filter((f) => f.endsWith('.node') && !leftovers([f]).length);
        expect(nodes).toHaveLength(4);
        expect(nodes.filter((f) => !shouldSignFile(f, signExts()))).toEqual([]);
    });

    it('the plan\'s --check and the release verifier count a .node with the .exe and .dll files', () => {
        expect(read('scripts/win-sign-plan.mjs')).toMatch(/const leftUnsigned = rows\.filter\(\(r\) => !r\.wouldSign && r\.kind === 'unsigned' && \/\\\.\(exe\|dll\|node\)\$\/i\.test\(r\.file\)\)/);
        expect(read('scripts/verify-windows-signatures.ps1')).toMatch(/-in @\('\.exe', '\.dll', '\.node'\)/);
    });
});
