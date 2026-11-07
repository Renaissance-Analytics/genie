import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);
const version = '2.0.0-beta.60';
const installerName = `Genie-${version}-setup.exe`;
const baseline = JSON.parse(readFileSync('test/fixtures/windows-update-beta59.json', 'utf8'));
const sha512 = (bytes: string) => createHash('sha512').update(bytes).digest('base64');
const fixture = () => {
    const dir = mkdtempSync(join(tmpdir(), 'genie-update-proof-'));
    const bytes = 'installer plus final Authenticode bytes';
    const metadata = { version, files: [{ url: installerName, sha512: sha512(bytes), size: Buffer.byteLength(bytes) }],
        path: installerName, sha512: sha512(bytes) };
    writeFileSync(join(dir, installerName), bytes);
    writeFileSync(join(dir, `${installerName}.blockmap`), 'blockmap from the finished build');
    const save = () => writeFileSync(join(dir, 'latest.yml'), require('js-yaml').dump(metadata));
    save();
    const verify = () => {
        expect(existsSync('scripts/verify-windows-update.cjs')).toBe(true);
        return require('../scripts/verify-windows-update.cjs').verifyWindowsUpdate({ releaseDir: dir, version, baseline });
    };
    return { dir, bytes, metadata, save, verify, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
};

describe('Windows updater proof', () => {
    it('binds the finished installer to both metadata checksums and beta.59 asset naming, retaining review evidence', async () => {
        const f = fixture();
        try {
            const proof = await f.verify();
            expect(proof.installerSha512).toBe(sha512(f.bytes));
            expect(proof.metadataSha512).toBe(sha512(f.bytes));
            expect(proof.filesSha512).toBe(sha512(f.bytes));
            expect(proof.matches).toBe(true);
            expect(proof.assets.map((item: any) => item.name)).toEqual([installerName, `${installerName}.blockmap`, 'latest.yml']);
            expect(proof.baselineTag).toBe('v2.0.0-beta.59');
            expect(readFileSync(join(f.dir, 'signature-evidence/latest.yml'), 'utf8')).toBe(readFileSync(join(f.dir, 'latest.yml'), 'utf8'));
            const saved = JSON.parse(readFileSync(join(f.dir, 'signature-evidence/windows-update.json'), 'utf8'));
            expect(saved).toEqual(proof);
            expect(readFileSync(join(f.dir, 'signature-evidence/installer.sha512'), 'utf8')).toContain(`${sha512(f.bytes)}  ${installerName}`);
        } finally { f.cleanup(); }
    });

    it('refuses a checksum computed before signing and accepts only metadata for the final signed bytes', async () => {
        const f = fixture();
        try {
            writeFileSync(join(f.dir, installerName), f.bytes + ' appended signature');
            await expect(f.verify()).rejects.toThrow(/sha512/i);
            const digest = sha512(f.bytes + ' appended signature');
            f.metadata.sha512 = digest;
            f.metadata.files[0]!.sha512 = digest;
            f.metadata.files[0]!.size = Buffer.byteLength(f.bytes + ' appended signature');
            f.save();
            expect((await f.verify()).installerSha512).toBe(digest);
        } finally { f.cleanup(); }
    });

    it('refuses wrong legacy hash, file hash, size, version, URL and path', async () => {
        for (const change of [
            (f: ReturnType<typeof fixture>) => { f.metadata.sha512 = sha512('wrong'); },
            (f: ReturnType<typeof fixture>) => { f.metadata.files[0]!.sha512 = sha512('wrong'); },
            (f: ReturnType<typeof fixture>) => { f.metadata.files[0]!.size++; },
            (f: ReturnType<typeof fixture>) => { f.metadata.version = '2.0.0-beta.58'; },
            (f: ReturnType<typeof fixture>) => { f.metadata.files[0]!.url = '../outside.exe'; },
            (f: ReturnType<typeof fixture>) => { f.metadata.path = 'Genie-Setup-2.0.0-beta.60.exe'; },
        ]) {
            const f = fixture();
            try { change(f); f.save(); await expect(f.verify()).rejects.toThrow(); } finally { f.cleanup(); }
        }
    });

    it('requires the installer, blockmap and latest.yml, refusing missing or empty assets', async () => {
        for (const name of [installerName, `${installerName}.blockmap`, 'latest.yml']) {
            for (const empty of [true, false]) {
                const f = fixture();
                try {
                    if (empty) writeFileSync(join(f.dir, name), ''); else rmSync(join(f.dir, name));
                    await expect(f.verify()).rejects.toThrow();
                } finally { f.cleanup(); }
            }
        }
    });

    it('compares against the actual reference release list, not a guessed installer naming pattern', async () => {
        const f = fixture();
        try {
            expect(existsSync('scripts/verify-windows-update.cjs')).toBe(true);
            await expect(require('../scripts/verify-windows-update.cjs').verifyWindowsUpdate({ releaseDir: f.dir, version,
                baseline: { ...baseline, assets: [{ name: 'Genie-Setup-2.0.0-beta.59.exe' }, { name: 'latest.yml' }] } })).rejects.toThrow(/asset|baseline|name/i);
        } finally { f.cleanup(); }
    });

    it('the locked builder signs the installer before creating its blockmap and emitting update info', () => {
        const source = readFileSync(require.resolve('app-builder-lib/out/targets/nsis/NsisTarget.js'), 'utf8');
        const sign = source.indexOf('await Promise.all([packager.signIf(installerPath)');
        const blockmap = source.indexOf('createBlockmap)(installerPath', sign);
        const emit = source.indexOf('emitArtifactBuildCompleted({', blockmap);
        expect(sign).toBeGreaterThan(-1);
        expect(blockmap).toBeGreaterThan(sign);
        expect(emit).toBeGreaterThan(blockmap);
    });
});
