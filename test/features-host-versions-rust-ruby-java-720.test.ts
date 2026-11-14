import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { RUBY_PROOF_ARGS } from '../src/core/ruby-versions.js';
import type { FeatureAction, FeatureData } from '../src/renderer/features.js';
import { LANGUAGE_TRIPLE, rustRubyJavaVersionsFixture, type RustRubyJavaVersionsFixture } from './helpers/features-host-versions-rust-ruby-java.js';

let f: RustRubyJavaVersionsFixture;
beforeEach(async () => { f = await rustRubyJavaVersionsFixture(); });
afterEach(async () => { await f?.close(); });
async function act(action: FeatureAction): Promise<FeatureData> {
    const answer = await f.outcome('features.act', [action]);
    expect(answer, answer.ok ? undefined : answer.reason).toMatchObject({ ok: true });
    if (!answer.ok) throw new Error('the preceding assertion failed');
    return answer.value as FeatureData;
}
const scan = () => act({ kind: 'toolchain.check', force: true });

describe('host Rust, Ruby and Java versions use their real managers without a window (Tynn #720)', () => {
    for (const row of LANGUAGE_TRIPLE) {
        const { lang, label } = row;
        it(`${lang}: Install without consent refuses its row before downloads or filesystem writes`, async () => {
            await scan(); const data = await act({ kind: row.install, version: f.versions[lang], consent: false });
            expect(data.toolchain?.refusals).toEqual([{ tool: lang, version: f.versions[lang], reason: `Genie installs nothing without your go-ahead; ${label} ${f.versions[lang]} was not installed` }]);
            expect(f.downloads).toEqual([]); expect(f.writtenBytes).toEqual([]); expect(f.versionCommands.some(call => [f.rustInit, f.rustup, f.windowsTar, 'powershell.exe'].includes(call.binary))).toBe(false);
        });
        it(`${lang}: a consented Install verifies the archive and proves the owned binary before listing it`, async () => {
            await scan(); const data = await act({ kind: row.install, version: f.versions[lang], consent: true });
            expect(data.toolchain?.[lang]?.managed).toEqual([{ version: f.versions[lang], dir: join(f.roots[lang], f.versions[lang]) }]);
            expect(data.toolchain?.result).toBe(`${label} ${f.versions[lang]} is installed in Genie's toolchain.`);
            expect(f.downloads).toEqual([{ lang, url: f.urls[lang] }]); expect(f.metadata).toHaveLength(1);
            expect(f.writtenBytes).toEqual([{ path: f.writePath(lang), bytes: f.bytes[lang] }]);
            if (lang === 'rust') {
                expect(f.versionCommands).toContainEqual({ binary: f.rustInit, args: f.rustInitArgs, env: f.homes });
                expect(f.versionCommands).toContainEqual({ binary: f.rustup, args: f.rustupArgs, env: f.homes });
                expect(f.rustupArgs[2]).toBe(f.versions.rust + '-x86_64-pc-windows-gnu');
                expect(f.versionCommands).toContainEqual({ binary: f.binary('rust'), args: ['-vV'] });
                expect(f.versionCommands).toContainEqual({ binary: join(f.roots.rust, f.versions.rust, 'bin', 'cargo.exe'), args: ['--version'] });
                expect(f.fs.exists(f.rustStage)).toBe(false);
            } else if (lang === 'ruby') {
                expect(f.versionCommands).toContainEqual({ binary: f.windowsTar, args: ['-xf', f.writePath('ruby'), '-C', join(f.roots.ruby, '.staging-' + f.versions.ruby)] });
                expect(f.versionCommands).toContainEqual({ binary: f.binary('ruby'), args: RUBY_PROOF_ARGS });
                expect(f.versionCommands).toContainEqual({ binary: f.binary('ruby'), args: ['-e', "require 'rubygems'; print Gem::VERSION"] });
            } else {
                expect(f.versionCommands).toContainEqual({ binary: f.binary('java'), args: ['-version'] });
                expect(f.versionCommands).toContainEqual({ binary: join(f.roots.java, f.versions.java, 'bin', 'javac.exe'), args: ['-version'] });
            }
            expect(f.versionProgress.at(-1)).toBeNull(); expect(f.invokeWindow).not.toHaveBeenCalled();
        });
        it(`${lang}: a bad published checksum is a real row failure before any unpack or write`, async () => {
            await scan(); f.badHash[lang] = true; const data = await act({ kind: row.install, version: f.versions[lang], consent: true });
            expect(data.toolchain?.[lang]?.managed).toEqual([]); expect(f.writtenBytes).toEqual([]);
            expect(f.versionCommands.some(call => [f.rustInit, f.rustup, f.windowsTar, 'powershell.exe'].includes(call.binary))).toBe(false);
            const name = lang === 'rust' ? 'rustup-init' : f.archives[lang];
            expect(data.toolchain?.refusals).toEqual([{ tool: lang, version: f.versions[lang], reason: `${name} does not match the sha256 ${row.publisher} publishes (expected ${'0'.repeat(64)}, got ${f.hashes[lang]}); it was discarded unopened. Nothing was installed` }]);
            expect(f.versionProgress.at(-1)).toBeNull();
        });
        it(`${lang}: a wrong binary version cleans the staged install and preserves the proof failure`, async () => {
            await scan(); f.proofVersion[lang] = '0.0.0'; const data = await act({ kind: row.install, version: f.versions[lang], consent: true });
            expect(data.toolchain?.[lang]?.managed).toEqual([]); expect(f.fs.exists(join(f.roots[lang], f.versions[lang]))).toBe(false);
            expect(f.fs.list(f.roots[lang])).toEqual([]); expect(f.writtenBytes).toHaveLength(1);
            const reason = lang === 'java' ? `Java ${f.versions.java} (Temurin) was asked for, but ${f.binary('java')} is Temurin-0.0.0. Nothing was installed`
                : `${label} ${f.versions[lang]} was asked for, but ${f.binary(lang)} reports 0.0.0. Nothing was installed`;
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
            expect(data.toolchain?.refusals).toEqual([{ tool: lang, version: f.versions[lang], reason: `${label} ${f.versions[lang]} is the default; make another version the default (or use the system's) first, then remove it` }]);
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
    it('rust: a toolchain for the wrong host is refused and its owned files are cleaned', async () => {
        await scan(); f.faults.rustHost = 'x86_64-pc-windows-msvc';
        const data = await act({ kind: 'toolchain.installRust', version: f.versions.rust, consent: true });
        expect(data.toolchain?.refusals).toEqual([{ tool: 'rust', version: f.versions.rust, reason: `Rust ${f.versions.rust} for x86_64-pc-windows-gnu was asked for, but ${f.binary('rust')} is for x86_64-pc-windows-msvc. Nothing was installed` }]);
        expect(f.fs.list(f.roots.rust)).toEqual([]); expect(f.versionProgress.at(-1)).toBeNull();
    });
    it('rust: a failing cargo proof refuses the version and leaves no staged or installed files', async () => {
        await scan(); f.faults.cargo = 'fixture cargo failed';
        const data = await act({ kind: 'toolchain.installRust', version: f.versions.rust, consent: true });
        expect(data.toolchain?.refusals).toEqual([{ tool: 'rust', version: f.versions.rust, reason: `Rust ${f.versions.rust} installed, but its cargo says: fixture cargo failed. Nothing was installed` }]);
        expect(f.fs.list(f.roots.rust)).toEqual([]);
    });
    it('ruby: a missing Windows tar is refused before extraction and all staging files are cleaned', async () => {
        await scan(); f.faults.missingTar = true;
        const data = await act({ kind: 'toolchain.installRuby', version: f.versions.ruby, consent: true });
        expect(data.toolchain?.refusals).toEqual([{ tool: 'ruby', version: f.versions.ruby, reason: `${f.archives.ruby} is a .7z, and no tar.exe that reads one was given. Nothing was installed` }]);
        expect(f.fs.list(f.roots.ruby)).toEqual([]); expect(f.versionCommands.some(call => call.binary === f.windowsTar)).toBe(false);
    });
    it('ruby: a different RubyInstaller platform is named and its failed install is cleaned', async () => {
        await scan(); f.faults.rubyPlatform = 'x64-mingw32';
        const data = await act({ kind: 'toolchain.installRuby', version: f.versions.ruby, consent: true });
        expect(data.toolchain?.refusals).toEqual([{ tool: 'ruby', version: f.versions.ruby, reason: `Ruby ${f.versions.ruby} for x64-mingw-ucrt was asked for, but ${f.binary('ruby')} reports x64-mingw32. Nothing was installed` }]);
        expect(f.fs.list(f.roots.ruby)).toEqual([]);
    });
    it('ruby: a failed RubyGems proof refuses and removes the otherwise valid version', async () => {
        await scan(); f.faults.gem = 'fixture gem failed';
        const data = await act({ kind: 'toolchain.installRuby', version: f.versions.ruby, consent: true });
        expect(data.toolchain?.refusals).toEqual([{ tool: 'ruby', version: f.versions.ruby, reason: `Ruby ${f.versions.ruby} unpacked, but its gem did not answer: fixture gem failed. Nothing was installed` }]);
        expect(f.fs.list(f.roots.ruby)).toEqual([]);
    });
    it('java: another vendor with the same version is refused and its JDK is cleaned', async () => {
        await scan(); f.faults.javaVendor = true;
        const data = await act({ kind: 'toolchain.installJava', version: f.versions.java, consent: true });
        expect(data.toolchain?.refusals).toEqual([{ tool: 'java', version: f.versions.java, reason: `Java ${f.versions.java} (Temurin) was asked for, but ${f.binary('java')} is another build of ${f.versions.java.split('+')[0]}. Nothing was installed` }]);
        expect(f.fs.list(f.roots.java)).toEqual([]);
    });
    it('java: a failed javac proof refuses and removes the otherwise valid Temurin build', async () => {
        await scan(); f.faults.javac = 'fixture compiler failed';
        const data = await act({ kind: 'toolchain.installJava', version: f.versions.java, consent: true });
        expect(data.toolchain?.refusals).toEqual([{ tool: 'java', version: f.versions.java, reason: `Java ${f.versions.java} unpacked, but its javac says: fixture compiler failed. Nothing was installed` }]);
        expect(f.fs.list(f.roots.java)).toEqual([]);
    });
});

describe('independent controls for the version manager fixture (Tynn #720)', () => {
    for (const row of LANGUAGE_TRIPLE) {
        it(`CONTROL ${row.lang}: the canonical manager installs, proves and removes through inert OS ports`, async () => {
            const outcome = await f.managers[row.lang].install(f.versions[row.lang], true);
            expect(outcome).toEqual({ kind: 'installed', version: f.versions[row.lang], dir: join(f.roots[row.lang], f.versions[row.lang]) });
            expect((await f.managers[row.lang].list()).managed.map(entry => entry.version)).toEqual([f.versions[row.lang]]);
            expect(f.versionCommands).toContainEqual({ binary: f.binary(row.lang), args: row.lang === 'rust' ? ['-vV'] : row.lang === 'ruby' ? RUBY_PROOF_ARGS : ['-version'] });
            expect(f.managers[row.lang].remove(f.versions[row.lang])).toEqual({ kind: 'removed', version: f.versions[row.lang] });
            expect((await f.managers[row.lang].list()).managed).toEqual([]);
        });
    }
    it('CONTROL: the existing host scan lists seeded Rust, Ruby and Java through the real managers', async () => {
        for (const row of LANGUAGE_TRIPLE) f.seed(row.lang); const data = await scan();
        for (const row of LANGUAGE_TRIPLE) {
            expect(data.toolchain?.[row.lang]?.managed).toEqual([{ version: f.versions[row.lang], dir: join(f.roots[row.lang], f.versions[row.lang]) }]);
            expect(data.toolchain?.[row.lang]?.available).toContainEqual(expect.objectContaining({ version: f.versions[row.lang], installed: true }));
        }
        expect(f.invokeWindow).not.toHaveBeenCalled();
    });
});
