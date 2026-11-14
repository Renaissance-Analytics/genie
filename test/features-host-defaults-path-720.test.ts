import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SHELL_BEGIN, SHELL_END } from '../src/core/machine-path.js';
import { DEFAULT_LANGS, LANG_LABEL, langPathEntries, versionDir } from '../src/core/toolchain-defaults.js';
import type { FeatureAction, FeatureData } from '../src/renderer/features.js';
import { defaultsPathFixture, type DefaultsPathFixture } from './helpers/features-host-defaults-path.js';

let f: DefaultsPathFixture;
beforeEach(async () => { f = await defaultsPathFixture(); });
afterEach(async () => { await f?.close(); });
async function act(action: FeatureAction): Promise<FeatureData> {
    const answer = await f.outcome('features.act', [action]);
    expect(answer, answer.ok ? undefined : answer.reason).toMatchObject({ ok: true });
    if (!answer.ok) throw new Error('the preceding assertion failed');
    return answer.value as FeatureData;
}
const scan = () => act({ kind: 'toolchain.check', force: true });
const pathAction = (apply: boolean, consent = true) => act({ kind: 'toolchain.machinePath', apply, consent });

describe('host defaults use the canonical link planner without a window (Tynn #720)', () => {
    for (const lang of DEFAULT_LANGS) {
        it(`${lang}: Make default repoints the owned link and shows the measured choice`, async () => {
            await scan();
            const data = await act({ kind: 'toolchain.setDefault', lang, version: f.versions[lang] });
            expect(f.defaultTarget(lang)).toBe(versionDir(f.toolchainDir, lang, f.versions[lang]));
            expect(data.toolchain?.defaults?.[lang]).toBe(f.versions[lang]);
            expect(data.toolchain?.result).toBe(`${LANG_LABEL[lang]} ${f.versions[lang]} is now the default — what \`${lang}\` means for Genie's terminals, processes and agents.`);
            expect(f.environment.get('PATH')).toContain(langPathEntries(f.toolchainDir, lang, 'linux')[0]);
            expect(f.invokeWindow).not.toHaveBeenCalled();
        });
        it(`${lang}: Use the system clears only its default link and retains the installed version`, async () => {
            f.defaults.set(lang, f.versions[lang]); await scan();
            const data = await act({ kind: 'toolchain.setDefault', lang, version: null });
            expect(f.defaultTarget(lang)).toBeUndefined(); expect(f.managed.has(versionDir(f.toolchainDir, lang, f.versions[lang]))).toBe(true);
            expect(data.toolchain?.defaults?.[lang]).toBeNull();
            expect(data.toolchain?.result).toBe(`${LANG_LABEL[lang]}'s default is the one on your PATH again.`);
        });
        it(`${lang}: an unmanaged version keeps the current link and reports the real named refusal`, async () => {
            f.defaults.set(lang, f.versions[lang]); await scan(); const before = [...f.linkOps];
            const data = await act({ kind: 'toolchain.setDefault', lang, version: '0.0.0' });
            expect(f.linkOps).toEqual(before); expect(f.defaultTarget(lang)).toBe(versionDir(f.toolchainDir, lang, f.versions[lang]));
            expect(data.toolchain?.defaults?.[lang]).toBe(f.versions[lang]);
            expect(data.toolchain?.refusals).toEqual([{ tool: `${lang}-default`, reason: `${LANG_LABEL[lang]} 0.0.0 is not a version Genie manages here; install it in Toolchain first` }]);
        });
    }
});

describe('host machine PATH uses the real planner over inert OS ports (Tynn #720)', () => {
    it('Linux PATH without consent is a row refusal and writes no startup file', async () => {
        await scan(); const data = await pathAction(true, false);
        expect(f.writes).toEqual([]); expect(f.text).toEqual(f.originalText);
        expect(data.toolchain?.refusals).toEqual([{ tool: 'machine-path', reason: 'Genie changes your PATH only with your go-ahead; nothing was changed' }]);
    });
    it('Linux PATH applies the actual marked block once and measures every existing startup target', async () => {
        await scan(); const data = await pathAction(true);
        const entries = f.pathPorts().entries.join(':');
        expect(f.text.get(join(f.home, '.profile'))).toBe(`export FIXTURE=1\n${SHELL_BEGIN}\nexport PATH="${entries}:$PATH"\n${SHELL_END}\n`);
        // The planner records a newline it adds, so Undo can restore the original text without it.
        expect(f.text.get(join(f.home, '.bashrc'))).toBe(`alias fixture=true\n# >>> genie toolchain defaults (+newline) >>>\nexport PATH="${entries}:$PATH"\n${SHELL_END}\n`);
        expect(data.toolchain?.machinePath).toEqual({ applied: true, where: [...f.originalText.keys()], entries: f.pathPorts().entries, targets: [...f.originalText.keys()] });
        expect(f.writes).toHaveLength(2); await pathAction(true); expect(f.writes).toHaveLength(2);
    });
    it('Linux PATH Undo restores every original byte including a missing final newline', async () => {
        await f.machinePath.apply(true); await scan(); const data = await pathAction(false);
        expect(f.text).toEqual(f.originalText); expect(data.toolchain?.machinePath?.applied).toBe(false);
        expect(data.toolchain?.result).toBe(`Genie's defaults are off your PATH again (${[...f.originalText.keys()].join(', ')}); it is as it was.`);
    });
    it('Linux PATH exposes a real startup-write refusal without claiming it was applied', async () => {
        await scan(); f.io.readOnly = true; const data = await pathAction(true);
        expect(f.writes).toEqual([]); expect(f.text).toEqual(f.originalText);
        expect(data.toolchain?.machinePath?.applied).toBe(false);
        expect(data.toolchain?.refusals).toEqual([{ tool: 'machine-path', reason: `${join(f.home, '.profile')} could not be written (fixture startup file is read only)` }]);
    });
    it('Windows PATH without consent allows status reads but never writes the registry', async () => {
        f.pathPlatform('win32'); await scan(); const data = await pathAction(true, false);
        expect(f.registry.value).toBe(f.rawPath); expect(f.registry.writes).toBe(0); expect(f.registry.broadcasts).toBe(0);
        expect(data.toolchain?.refusals).toEqual([{ tool: 'machine-path', reason: 'Genie changes your PATH only with your go-ahead; nothing was changed' }]);
        expect(f.pathCommands.every(call => call.binary === 'powershell.exe' && call.args.join(' ').includes("GetValue('Path'"))).toBe(true);
    });
    it('Windows PATH applies ExpandString and broadcasts once while keeping raw user entries', async () => {
        f.pathPlatform('win32'); await scan(); const data = await pathAction(true);
        expect(f.registry).toMatchObject({ value: `${f.pathPorts().entries.join(';')};${f.rawPath}`, writes: 1, broadcasts: 1, type: 'ExpandString' });
        expect(data.toolchain?.machinePath).toEqual({ applied: true, where: ['the user PATH (HKCU\\Environment)'], entries: f.pathPorts().entries, targets: ['the user PATH (HKCU\\Environment)'] });
        expect(f.pathCommands.some(call => /\bsetx\b/i.test(call.args.join(' ')))).toBe(false);
        await pathAction(true); expect(f.registry.writes).toBe(1);
    });
    it('Windows PATH Undo restores the raw value and measures its absence', async () => {
        f.pathPlatform('win32'); await f.machinePath.apply(true); await scan(); const data = await pathAction(false);
        expect(f.registry.value).toBe(f.rawPath); expect(f.registry.writes).toBe(2); expect(f.registry.broadcasts).toBe(2);
        expect(data.toolchain?.machinePath?.applied).toBe(false);
        expect(data.toolchain?.result).toBe("Genie's defaults are off your PATH again (the user PATH (HKCU\\Environment)); it is as it was.");
    });
    it('Windows PATH preserves the actual registry-write failure as a row refusal', async () => {
        f.pathPlatform('win32'); await scan(); f.registry.fail = true; const data = await pathAction(true);
        expect(f.registry.value).toBe(f.rawPath); expect(data.toolchain?.machinePath?.applied).toBe(false);
        expect(data.toolchain?.refusals).toEqual([{ tool: 'machine-path', reason: 'your user PATH could not be written (PowerShell exited 5: fixture registry write denied); it was not changed' }]);
    });
    it('Windows PATH refuses a successful write whose read-back is different', async () => {
        f.pathPlatform('win32'); await scan(); f.registry.ignore = true; const data = await pathAction(true);
        expect(f.registry.value).toBe(f.rawPath); expect(f.registry.writes).toBe(1); expect(data.toolchain?.machinePath?.applied).toBe(false);
        expect(data.toolchain?.refusals).toEqual([{ tool: 'machine-path', reason: 'your user PATH was written, but it does not read back as Genie wrote it' }]);
    });
});

describe('independent controls for the default and PATH fixture (Tynn #720)', () => {
    it('CONTROL: the real default planner sets and clears each owned language link without host actions', () => {
        for (const lang of DEFAULT_LANGS) {
            expect(f.defaults.set(lang, f.versions[lang])).toEqual({ kind: 'set', lang, version: f.versions[lang] });
            expect(f.defaults.list()[lang]).toBe(f.versions[lang]);
            expect(f.defaultTarget(lang)).toBe(versionDir(f.toolchainDir, lang, f.versions[lang]));
            expect(f.environment.get('PATH')).toContain(langPathEntries(f.toolchainDir, lang, 'linux')[0]);
            expect(f.defaults.set(lang, null)).toEqual({ kind: 'cleared', lang }); expect(f.defaults.list()[lang]).toBeNull();
        }
        expect(f.environment.get('DOTNET_ROOT')).toBe(''); expect(f.environment.get('JAVA_HOME')).toBe('');
    });
    it('CONTROL: the real Linux PATH planner is reversible and idempotent without host actions', async () => {
        expect(await f.machinePath.apply(true)).toEqual({ kind: 'applied', where: [...f.originalText.keys()] });
        expect(f.writes).toHaveLength(2); await f.machinePath.apply(true); expect(f.writes).toHaveLength(2);
        expect((await f.machinePath.status()).applied).toBe(true);
        expect(await f.machinePath.remove()).toEqual({ kind: 'removed', where: [...f.originalText.keys()] });
        expect(f.text).toEqual(f.originalText);
    });
    it('CONTROL: the real Windows PATH planner preserves raw entries and Undo without host actions', async () => {
        f.pathPlatform('win32'); expect(await f.machinePath.apply(true)).toEqual({ kind: 'applied', where: ['the user PATH (HKCU\\Environment)'] });
        expect(f.registry).toMatchObject({ value: `${f.pathPorts().entries.join(';')};${f.rawPath}`, broadcasts: 1, type: 'ExpandString' });
        expect(await f.machinePath.remove()).toEqual({ kind: 'removed', where: ['the user PATH (HKCU\\Environment)'] });
        expect(f.registry.value).toBe(f.rawPath);
    });
    it('CONTROL: the existing host scan reads actual default links and machine PATH facts', async () => {
        f.defaults.set('go', f.versions.go); await f.machinePath.apply(true);
        const data = await scan();
        expect(data.toolchain?.defaults?.go).toBe(f.versions.go);
        expect(data.toolchain?.machinePath).toEqual(await f.machinePath.status());
        expect(f.invokeWindow).not.toHaveBeenCalled();
    });
});
