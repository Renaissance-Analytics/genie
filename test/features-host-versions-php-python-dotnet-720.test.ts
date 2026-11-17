import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { phpIniContents } from '../src/core/php-versions.js';
import { PYTHON_PROOF_ARGS } from '../src/core/python-versions.js';
import type { FeatureAction, FeatureData } from '../src/renderer/features.js';
import { LANGUAGE_TRIPLE, phpPythonDotnetVersionsFixture, type PhpPythonDotnetVersionsFixture } from './helpers/features-host-versions-php-python-dotnet.js';

let f: PhpPythonDotnetVersionsFixture;
beforeEach(async () => { f = await phpPythonDotnetVersionsFixture(); });
afterEach(async () => { await f?.close(); });
async function act(action: FeatureAction): Promise<FeatureData> {
    const answer = await f.outcome('features.act', [action]);
    expect(answer, answer.ok ? undefined : answer.reason).toMatchObject({ ok: true });
    if (!answer.ok) throw new Error('the preceding assertion failed');
    return answer.value as FeatureData;
}
const scan = () => act({ kind: 'toolchain.check', force: true });

describe('host PHP, Python and .NET versions use their real managers without a window (Tynn #720)', () => {
    for (const row of LANGUAGE_TRIPLE) {
        const { lang, label, defaultLabel } = row;
        it(`${lang}: Install without consent refuses its row before downloads or filesystem writes`, async () => {
            await scan(); const data = await act({ kind: row.install, version: f.versions[lang], consent: false });
            expect(data.toolchain?.refusals).toEqual([{ tool: lang, version: f.versions[lang], reason: `Genie installs nothing without your go-ahead; ${label} ${f.versions[lang]} was not installed` }]);
            expect(f.downloads).toEqual([]); expect(f.writtenBytes).toEqual([]); expect(f.versionCommands.some(call => call.binary === 'powershell.exe')).toBe(false);
        });
        it(`${lang}: a consented Install verifies the archive and proves the owned binary before listing it`, async () => {
            await scan(); const data = await act({ kind: row.install, version: f.versions[lang], consent: true });
            expect(data.toolchain?.[lang]?.managed).toEqual([{ version: f.versions[lang], dir: join(f.roots[lang], f.versions[lang]), ...(lang === 'php' ? { usedBy: [] } : {}) }]);
            expect(data.toolchain?.result).toBe(lang === 'php' ? `PHP ${f.versions.php} is installed; a php site can be pinned to it.` : `${label} ${f.versions[lang]} is installed in Genie's toolchain.`);
            expect(f.downloads).toEqual([{ lang, url: f.urls[lang] }]); expect(f.metadata).toHaveLength(1);
            expect(f.writtenBytes).toEqual([{ path: join(f.roots[lang], `.${f.archives[lang]}`), bytes: f.bytes[lang] }]);
            if (lang === 'php') {
                expect(f.fs.readText?.(join(f.roots.php, f.versions.php, 'php.ini'))).toBe(phpIniContents(join(f.roots.php, f.versions.php), 'win32'));
                expect(f.versionCommands).toContainEqual({ binary: f.binary('php'), args: ['-c', join(f.roots.php, f.versions.php, 'php.ini'), '-v'] });
                expect(f.versionCommands).toContainEqual({ binary: join(f.roots.php, f.versions.php, 'php.exe'), args: ['-c', join(f.roots.php, f.versions.php, 'php.ini'), '-m'] });
                expect(f.vcCalls()).toBe(1);
            } else if (lang === 'python') {
                expect(f.versionCommands).toContainEqual({ binary: f.binary('python'), args: f.pipArgs() });
                expect(f.versionCommands).toContainEqual({ binary: f.binary('python'), args: PYTHON_PROOF_ARGS });
                expect(f.fs.exists(join(f.roots.python, f.versions.python, 'Scripts', 'pip.exe'))).toBe(true);
            } else expect(f.versionCommands).toContainEqual({ binary: f.binary('dotnet'), args: ['--list-sdks'] });
            expect(f.versionProgress.at(-1)).toBeNull(); expect(f.invokeWindow).not.toHaveBeenCalled();
        });
        it(`${lang}: a bad published checksum is a real row failure before any unpack or write`, async () => {
            await scan(); f.badHash[lang] = true; const data = await act({ kind: row.install, version: f.versions[lang], consent: true });
            expect(data.toolchain?.[lang]?.managed).toEqual([]); expect(f.writtenBytes).toEqual([]);
            expect(f.versionCommands.some(call => call.binary === 'powershell.exe')).toBe(false);
            expect(data.toolchain?.refusals).toEqual([{ tool: lang, version: f.versions[lang], reason: `${f.archives[lang]} does not match the ${row.hash} ${row.publisher} publishes (expected ${'0'.repeat(row.hash === 'sha512' ? 128 : 64)}, got ${f.hashes[lang]}); it was discarded unopened. Nothing was installed` }]);
            expect(f.versionProgress.at(-1)).toBeNull();
        });
        it(`${lang}: a wrong binary version cleans the staged install and preserves the proof failure`, async () => {
            await scan(); f.proofVersion[lang] = '0.0.0'; const data = await act({ kind: row.install, version: f.versions[lang], consent: true });
            expect(data.toolchain?.[lang]?.managed).toEqual([]); expect(f.fs.exists(join(f.roots[lang], f.versions[lang]))).toBe(false);
            expect(f.fs.list(f.roots[lang])).toEqual([]); expect(f.writtenBytes).toHaveLength(1);
            const reason = lang === 'php' ? `PHP ${f.versions.php} was asked for, but the binary reports 0.0.0. Nothing was installed`
                : lang === 'python' ? `Python ${f.versions.python} was asked for, but ${f.binary('python')} reports 0.0.0. Nothing was installed`
                : `.NET SDK ${f.versions.dotnet} unpacked, but ${f.binary('dotnet')} does not list it in ${join(f.roots.dotnet, f.versions.dotnet, 'sdk')}: 0.0.0 [${join(f.roots.dotnet, f.versions.dotnet, 'sdk')}]. Nothing was installed`;
            expect(data.toolchain?.refusals).toEqual([{ tool: lang, version: f.versions[lang], reason }]);
            expect(f.versionProgress.at(-1)).toBeNull();
        });
        it(`${lang}: an already installed version is reported without downloading it again`, async () => {
            f.seed(lang); await scan(); const data = await act({ kind: row.install, version: f.versions[lang], consent: true });
            expect(data.toolchain?.result).toBe(`${label} ${f.versions[lang]} was already installed; nothing was downloaded.`);
            expect(data.toolchain?.[lang]?.managed.map(entry => entry.version)).toEqual([f.versions[lang]]);
            expect(f.downloads).toEqual([]); expect(f.writtenBytes).toEqual([]);
        });
        it(`${lang}: Remove deletes only its actual managed version and re-lists the result`, async () => {
            f.seed(lang); await scan(); const data = await act({ kind: row.remove, version: f.versions[lang] });
            expect(f.removals).toEqual([join(f.roots[lang], f.versions[lang])]); expect(data.toolchain?.[lang]?.managed).toEqual([]);
            expect(f.fs.exists(f.binary(lang))).toBe(false); expect(data.toolchain?.result).toBe(`${label} ${f.versions[lang]} was removed.`);
        });
        it(`${lang}: Remove refuses an unowned version with the canonical reason and no delete`, async () => {
            f.seed(lang); await scan(); const data = await act({ kind: row.remove, version: '0.0.0' });
            expect(f.removals).toEqual([]); expect(f.fs.exists(f.binary(lang))).toBe(true);
            expect(data.toolchain?.refusals).toEqual([{ tool: lang, version: '0.0.0', reason: `${label} 0.0.0 is not a version Genie manages here; Genie removes only what it installed` }]);
        });
        it(`${lang}: Remove refuses the real linked default before reaching the version manager`, async () => {
            f.seed(lang); expect(f.defaults.set(lang, f.versions[lang]).kind).toBe('set'); await scan();
            const data = await act({ kind: row.remove, version: f.versions[lang] });
            expect(f.removals).toEqual([]); expect(f.defaultTarget(lang)).toBe(join(f.roots[lang], f.versions[lang]));
            expect(data.toolchain?.refusals).toEqual([{ tool: lang, version: f.versions[lang], reason: `${defaultLabel} ${f.versions[lang]} is the default; make another version the default (or use the system's) first, then remove it` }]);
        });
        it(`${lang}: Remove of another managed version preserves the actual default and its files`, async () => {
            f.seed(lang); f.seed(lang, f.otherVersions[lang]); f.defaults.set(lang, f.versions[lang]); await scan();
            const data = await act({ kind: row.remove, version: f.otherVersions[lang] });
            expect(f.removals).toEqual([join(f.roots[lang], f.otherVersions[lang])]);
            expect(data.toolchain?.[lang]?.managed.map(entry => entry.version)).toEqual([f.versions[lang]]);
            expect(f.defaultTarget(lang)).toBe(join(f.roots[lang], f.versions[lang])); expect(f.fs.exists(f.binary(lang))).toBe(true);
        });
        it(`${lang}: a corrected Install retry clears its old row refusal and lists the proven version`, async () => {
            await scan(); f.badHash[lang] = true;
            expect((await act({ kind: row.install, version: f.versions[lang], consent: true })).toolchain?.refusals).toHaveLength(1);
            f.badHash[lang] = false; const data = await act({ kind: row.install, version: f.versions[lang], consent: true });
            expect(data.toolchain?.refusals).toBeUndefined(); expect(data.toolchain?.[lang]?.managed.map(entry => entry.version)).toEqual([f.versions[lang]]);
            expect(f.downloads).toHaveLength(2); expect(f.writtenBytes).toHaveLength(1);
        });
    }
});

describe('language-specific manager contracts still apply through the host (Tynn #720)', () => {
    it('php: Remove receives the live site pin, refuses by host name and leaves its files intact', async () => {
        f.seed('php'); const site = f.pinPhp();
        expect((await scan()).toolchain?.php?.managed[0]?.usedBy).toEqual([site.host]);
        const data = await act({ kind: 'toolchain.removePhp', version: f.versions.php });
        expect(data.toolchain?.refusals).toEqual([{ tool: 'php', version: f.versions.php, reason: `PHP ${f.versions.php} is pinned by ${site.host}; change that site’s PHP version first, then remove it` }]);
        expect(f.removals).toEqual([]); expect(f.fs.exists(f.binary('php'))).toBe(true);
    });
    it('php: a thread-safe build is refused with its canonical proof reason and removed', async () => {
        await scan(); f.faults.phpNts = false;
        const data = await act({ kind: 'toolchain.installPhp', version: f.versions.php, consent: true });
        expect(data.toolchain?.refusals).toEqual([{ tool: 'php', version: f.versions.php, reason: `PHP ${f.versions.php} is a thread-safe build, and Genie's php-cgi runs the NTS build. Nothing was installed` }]);
        expect(f.fs.list(f.roots.php)).toEqual([]); expect(f.versionProgress.at(-1)).toBeNull();
    });
    it('php: a missing required extension is named and the failed install is cleaned', async () => {
        await scan(); f.faults.phpModules = f.faults.phpModules.filter(name => name !== 'curl');
        const data = await act({ kind: 'toolchain.installPhp', version: f.versions.php, consent: true });
        expect(data.toolchain?.refusals).toEqual([{ tool: 'php', version: f.versions.php, reason: `PHP ${f.versions.php} installed, but it did not load curl. Nothing was installed` }]);
        expect(f.fs.list(f.roots.php)).toEqual([]);
    });
    it('php: a failed runtime prerequisite keeps its reason and prevents every download', async () => {
        await scan(); f.faults.vcReason = 'fixture runtime declined';
        const data = await act({ kind: 'toolchain.installPhp', version: f.versions.php, consent: true });
        expect(data.toolchain?.refusals).toEqual([{ tool: 'php', version: f.versions.php, reason: `PHP ${f.versions.php} needs the Microsoft Visual C++ runtime, and it could not be installed: fixture runtime declined. Nothing was downloaded` }]);
        expect(f.vcCalls()).toBe(1); expect(f.downloads).toEqual([]); expect(f.metadata).toEqual([]); expect(f.writtenBytes).toEqual([]);
    });
    it('python: a failed offline pip finish cleans the install before any version proof', async () => {
        await scan(); f.faults.pipFailure = true;
        const data = await act({ kind: 'toolchain.installPython', version: f.versions.python, consent: true });
        expect(data.toolchain?.refusals).toEqual([{ tool: 'python', version: f.versions.python, reason: `Python ${f.versions.python} unpacked, but pip could not be made a command (exit 1): fixture bundled pip failed. Nothing was installed` }]);
        expect(f.fs.list(f.roots.python)).toEqual([]);
        expect(f.versionCommands).not.toContainEqual({ binary: f.binary('python'), args: PYTHON_PROOF_ARGS });
    });
    it('dotnet: an SDK reported from another directory is refused and the staged install is cleaned', async () => {
        await scan(); f.faults.dotnetSdkPath = '/fixture/foreign/sdk';
        const data = await act({ kind: 'toolchain.installDotnet', version: f.versions.dotnet, consent: true });
        expect(data.toolchain?.refusals).toEqual([{ tool: 'dotnet', version: f.versions.dotnet, reason: `.NET SDK ${f.versions.dotnet} unpacked, but ${f.binary('dotnet')} does not list it in ${join(f.roots.dotnet, f.versions.dotnet, 'sdk')}: ${f.versions.dotnet} [/fixture/foreign/sdk]. Nothing was installed` }]);
        expect(f.fs.list(f.roots.dotnet)).toEqual([]);
    });
    it('dotnet: Remove shuts down its own build servers before deleting the owned SDK', async () => {
        f.seed('dotnet'); await scan(); const data = await act({ kind: 'toolchain.removeDotnet', version: f.versions.dotnet });
        const stopped = f.events.indexOf('run:' + f.binary('dotnet') + ':build-server shutdown');
        const deleted = f.events.indexOf('remove:' + join(f.roots.dotnet, f.versions.dotnet));
        expect(stopped).toBeGreaterThanOrEqual(0); expect(deleted).toBeGreaterThan(stopped);
        expect(data.toolchain?.dotnet?.managed).toEqual([]);
    });
});

describe('independent controls for the version manager fixture (Tynn #720)', () => {
    for (const row of LANGUAGE_TRIPLE) {
        it(`CONTROL ${row.lang}: the canonical manager installs, proves and removes through inert OS ports`, async () => {
            const outcome = await f.managers[row.lang].install(f.versions[row.lang], true);
            expect(outcome).toEqual({ kind: 'installed', version: f.versions[row.lang], dir: join(f.roots[row.lang], f.versions[row.lang]) });
            expect((await f.managers[row.lang].list()).managed.map(entry => entry.version)).toEqual([f.versions[row.lang]]);
            expect(f.versionCommands).toContainEqual({ binary: f.binary(row.lang), args: row.lang === 'php' ? ['-c', join(f.roots.php, f.versions.php, 'php.ini'), '-v'] : row.lang === 'python' ? PYTHON_PROOF_ARGS : ['--list-sdks'] });
            expect(await f.managers[row.lang].remove(f.versions[row.lang])).toEqual({ kind: 'removed', version: f.versions[row.lang] });
            expect((await f.managers[row.lang].list()).managed).toEqual([]);
        });
    }
    it('CONTROL: the existing host scan lists seeded PHP, Python and .NET through the real managers', async () => {
        for (const row of LANGUAGE_TRIPLE) f.seed(row.lang); const data = await scan();
        for (const row of LANGUAGE_TRIPLE) {
            expect(data.toolchain?.[row.lang]?.managed).toEqual([{ version: f.versions[row.lang], dir: join(f.roots[row.lang], f.versions[row.lang]), ...(row.lang === 'php' ? { usedBy: [] } : {}) }]);
            expect(data.toolchain?.[row.lang]?.available).toContainEqual(expect.objectContaining({ version: f.versions[row.lang], installed: true }));
        }
        expect(f.invokeWindow).not.toHaveBeenCalled();
    });
});
