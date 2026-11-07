import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';
import { ELECTRON_BUILDER_VERSION, classify, shouldSignFile } from '../scripts/win-sign-plan.mjs';

/*
 * A SIGNED WINDOWS BUILD SIGNS ONLY WHAT SHIPS UNSIGNED: never a file that already carries another publisher's valid
 * signature (Microsoft's conpty.dll, OpenConsole.exe and d3dcompiler_47.dll). signtool's default sign REPLACES an
 * existing signature, and electron-builder 26.15.3 signs every file its rule selects without looking for one.
 *
 * Measured (measure/sign-plan, run 42377299413; test/fixtures/win-packed-signatures.json): of the package's 34
 * .exe/.dll/.node files, signExts ['.dll'] signed 25, and 11 of those were Microsoft-signed. The rows below use
 * electron-builder's OWN WinPackager.shouldSignFile on those files, with the signExts electron-builder.yml sets.
 */
const require = createRequire(import.meta.url);
type Row = { file: string; kind: 'ours' | 'third-party' | 'unsigned' | 'invalid'; signer: string | null };
const measured = (JSON.parse(readFileSync('test/fixtures/win-packed-signatures.json', 'utf8')) as { files: Row[] }).files;
const yaml = (file: string) => require('js-yaml').load(readFileSync(file, 'utf8').replace(/\r\n/g, '\n')) ?? {};
const signExts = (): string[] | null => yaml('electron-builder.yml').win?.signExts ?? null;

/** What electron-builder itself would sign of `file` (relative to win-unpacked), by its own rule. */
function builderSigns(file: string, exts: string[] | null): boolean {
    require('app-builder-lib');
    const { WinPackager } = require('app-builder-lib/out/winPackager.js');
    const packager = Object.create(WinPackager.prototype);
    packager.platformSpecificBuildOptions = { signExts: exts };
    if (file === 'Genie.exe') return true; // signApp signs and edits the product executable whatever signExts says
    const atRoot = !file.includes('/');
    // The root is scanned with shouldSignFile's default; resources/ (extra files and app.asar.unpacked) likewise.
    return atRoot ? packager.shouldSignFile(file) : packager.shouldSignFile(`C:/out/win-unpacked/${file}`);
}

describe('a signed Windows build signs only what ships unsigned', () => {
    it('the pinned electron-builder is the one whose rule scripts/win-sign-plan.mjs copies', () => {
        expect(yaml('package-lock.json').packages['node_modules/app-builder-lib'].version).toBe(ELECTRON_BUILDER_VERSION);
    });

    it('scripts/win-sign-plan.mjs\'s shouldSignFile is electron-builder\'s, on every measured file, with this config and the old one', () => {
        require('app-builder-lib');
        const { WinPackager } = require('app-builder-lib/out/winPackager.js');
        for (const exts of [signExts(), ['.dll'], null]) {
            const packager = Object.create(WinPackager.prototype);
            packager.platformSpecificBuildOptions = { signExts: exts };
            for (const { file } of measured) expect(shouldSignFile(file, exts), `${file} with ${JSON.stringify(exts)}`).toBe(packager.shouldSignFile(file));
        }
    });

    it('CONTROL: the old signExts [".dll"] re-signed the 11 Microsoft-signed files (the measurement, by the builder\'s rule)', () => {
        const resigned = measured.filter((r) => r.kind === 'third-party' && builderSigns(r.file, ['.dll'])).map((r) => r.file);
        expect(resigned).toHaveLength(11);
    });

    it('with electron-builder.yml\'s signExts, no file signed by another publisher is signed again', () => {
        const resigned = measured.filter((r) => r.kind === 'third-party' && builderSigns(r.file, signExts())).map((r) => r.file);
        expect(resigned).toEqual([]);
    });

    it('and every .exe and .dll that ships unsigned is still signed (ours: Genie.exe and genie-launch.exe among them)', () => {
        const unsignedBinaries = measured.filter((r) => r.kind === 'unsigned' && /\.(exe|dll)$/.test(r.file));
        expect(unsignedBinaries.map((r) => r.file)).toEqual(expect.arrayContaining(['Genie.exe', 'resources/bin/genie-launch.exe']));
        const missed = unsignedBinaries.filter((r) => !builderSigns(r.file, signExts())).map((r) => r.file);
        expect(missed).toEqual([]);
    });

    it('classify: ours, another publisher\'s, unsigned, invalid', () => {
        expect(classify('Valid', 'CN=Renaissance Analytics, O=Renaissance Analytics, L=Austin, S=Texas, C=US')).toEqual({ kind: 'ours', signer: 'Renaissance Analytics' });
        expect(classify('Valid', 'CN=Microsoft Corporation, O=Microsoft Corporation, L=Redmond, S=Washington, C=US')).toEqual({ kind: 'third-party', signer: 'Microsoft Corporation' });
        expect(classify('NotSigned', '')).toEqual({ kind: 'unsigned', signer: null });
        expect(classify('HashMismatch', 'CN=Microsoft Corporation')).toMatchObject({ kind: 'invalid' });
    });
});

describe('the checks that hold it', () => {
    const read = (p: string) => readFileSync(p, 'utf8').replace(/\r\n/g, '\n');

    it('CI\'s Windows packaging fails if the build would sign a file another publisher signed (the unsigned package, before any signing)', () => {
        const ci = read('.github/workflows/ci.yml');
        const start = ci.indexOf('name: it packages');
        // To the next job: a line of two spaces, a key and a colon, after the start.
        const next = ci.slice(start).search(/\n {2}[a-z][a-z0-9-]*:\n/);
        const job = ci.slice(start, next > 0 ? start + next : undefined);
        const build = job.indexOf('npx electron-builder --publish never');
        const check = job.search(/if: runner\.os == 'Windows'\s+run: node scripts\/win-sign-plan\.mjs release\/win-unpacked electron-builder\.yml --check/);
        expect(build).toBeGreaterThan(-1);
        expect(check, 'after the unsigned build, in the same job').toBeGreaterThan(build);
    });

    it('the release\'s verifier takes the plan: what the build does not sign must keep its own publisher\'s valid signature', () => {
        const release = read('.github/workflows/release.yml');
        const plan = release.indexOf('node scripts/win-sign-plan.mjs release/win-unpacked electron-builder.yml --json release/signature-evidence/win-sign-plan.json');
        const verify = release.indexOf('verify-windows-signatures.ps1');
        expect(plan).toBeGreaterThan(-1);
        expect(verify).toBeGreaterThan(plan);
        const ps = read('scripts/verify-windows-signatures.ps1');
        expect(ps).toMatch(/win-sign-plan\.json/);
        // Not signed by the build: Valid, and NOT ours (signed again by us, or stripped, fails).
        expect(ps).toMatch(/keeps its publisher's signature/);
    });
});
