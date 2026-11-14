import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { nodeNpmCliRel } from '../src/core/node-versions.js';
import type { FeatureAction, FeatureData } from '../src/renderer/features.js';
import { LANGUAGE_PAIR, nodeGoVersionsFixture, type NodeGoVersionsFixture } from './helpers/features-host-versions-node-go.js';

let f: NodeGoVersionsFixture;
beforeEach(async () => { f = await nodeGoVersionsFixture(); });
afterEach(async () => { await f?.close(); });
async function act(action: FeatureAction): Promise<FeatureData> {
    const answer = await f.outcome('features.act', [action]);
    expect(answer, answer.ok ? undefined : answer.reason).toMatchObject({ ok: true });
    if (!answer.ok) throw new Error('the preceding assertion failed');
    return answer.value as FeatureData;
}
const scan = () => act({ kind: 'toolchain.check', force: true });

describe('host Node and Go versions use their real managers without a window (Tynn #720)', () => {
    for (const row of LANGUAGE_PAIR) {
        const { lang, label } = row;
        it(`${lang}: Install without consent refuses its row before downloads or filesystem writes`, async () => {
            await scan(); const data = await act({ kind: row.install, version: f.versions[lang], consent: false });
            expect(data.toolchain?.refusals).toEqual([{ tool: lang, version: f.versions[lang], reason: `Genie installs nothing without your go-ahead; ${label} ${f.versions[lang]} was not installed` }]);
            expect(f.downloads).toEqual([]); expect(f.writtenBytes).toEqual([]); expect(f.versionCommands.some(call => call.binary === 'tar')).toBe(false);
        });
        it(`${lang}: a consented Install verifies the archive and proves the owned binary before listing it`, async () => {
            await scan(); const data = await act({ kind: row.install, version: f.versions[lang], consent: true });
            expect(data.toolchain?.[lang]?.managed).toEqual([{ version: f.versions[lang], dir: join(f.roots[lang], f.versions[lang]) }]);
            expect(data.toolchain?.result).toBe(`${label} ${f.versions[lang]} is installed in Genie's toolchain.`);
            expect(f.downloads).toEqual([{ lang, url: f.urls[lang] }]); expect(f.metadata).toHaveLength(1);
            expect(f.writtenBytes).toEqual([{ path: join(f.roots[lang], `.${f.archives[lang]}`), bytes: f.bytes[lang] }]);
            expect(f.versionCommands).toContainEqual({ binary: f.binary(lang), args: [lang === 'node' ? '-v' : 'version'] });
            if (lang === 'node') expect(f.versionCommands).toContainEqual({ binary: f.binary('node'), args: [join(f.roots.node, f.versions.node, nodeNpmCliRel('linux')), '-v'] });
            expect(f.versionProgress.at(-1)).toBeNull(); expect(f.invokeWindow).not.toHaveBeenCalled();
        });
        it(`${lang}: a bad published checksum is a real row failure before any unpack or write`, async () => {
            await scan(); f.badHash[lang] = true; const data = await act({ kind: row.install, version: f.versions[lang], consent: true });
            expect(data.toolchain?.[lang]?.managed).toEqual([]); expect(f.writtenBytes).toEqual([]);
            expect(f.versionCommands.some(call => call.binary === 'tar')).toBe(false);
            expect(data.toolchain?.refusals).toEqual([{ tool: lang, version: f.versions[lang], reason: `${f.archives[lang]} does not match the sha256 ${row.publisher} publishes (expected ${'0'.repeat(64)}, got ${f.hashes[lang]}); it was discarded unopened. Nothing was installed` }]);
            expect(f.versionProgress.at(-1)).toBeNull();
        });
        it(`${lang}: a wrong binary version cleans the staged install and preserves the proof failure`, async () => {
            await scan(); f.proofVersion[lang] = '0.0.0'; const data = await act({ kind: row.install, version: f.versions[lang], consent: true });
            expect(data.toolchain?.[lang]?.managed).toEqual([]); expect(f.fs.exists(join(f.roots[lang], f.versions[lang]))).toBe(false);
            expect(f.fs.list(f.roots[lang])).toEqual([]); expect(f.writtenBytes).toHaveLength(1);
            expect(data.toolchain?.refusals).toEqual([{ tool: lang, version: f.versions[lang], reason: `${label} ${f.versions[lang]} was asked for, but ${f.binary(lang)} reports ${lang === 'node' ? 'v' : ''}0.0.0. Nothing was installed` }]);
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

describe('independent controls for the version manager fixture (Tynn #720)', () => {
    for (const row of LANGUAGE_PAIR) {
        it(`CONTROL ${row.lang}: the canonical manager installs, proves and removes through inert OS ports`, async () => {
            const outcome = await f.managers[row.lang].install(f.versions[row.lang], true);
            expect(outcome).toEqual({ kind: 'installed', version: f.versions[row.lang], dir: join(f.roots[row.lang], f.versions[row.lang]) });
            expect((await f.managers[row.lang].list()).managed.map(entry => entry.version)).toEqual([f.versions[row.lang]]);
            expect(f.versionCommands).toContainEqual({ binary: f.binary(row.lang), args: [row.lang === 'node' ? '-v' : 'version'] });
            expect(f.managers[row.lang].remove(f.versions[row.lang])).toEqual({ kind: 'removed', version: f.versions[row.lang] });
            expect((await f.managers[row.lang].list()).managed).toEqual([]);
        });
    }
    it('CONTROL: the existing host scan lists seeded Node and Go through the real managers', async () => {
        f.seed('node'); f.seed('go'); const data = await scan();
        for (const row of LANGUAGE_PAIR) {
            expect(data.toolchain?.[row.lang]?.managed).toEqual([{ version: f.versions[row.lang], dir: join(f.roots[row.lang], f.versions[row.lang]) }]);
            expect(data.toolchain?.[row.lang]?.available).toContainEqual(expect.objectContaining({ version: f.versions[row.lang], installed: true }));
        }
        expect(f.invokeWindow).not.toHaveBeenCalled();
    });
});
